/**
 * 平台身份键迁移：把「一个 handle 一行」改成「一个平台账号一行」。
 *
 * 背景：
 * - tiktok_influencer 原来有 uk_username（username 全局唯一），导致同一个 @handle
 *   在 TikTok / Instagram / YouTube 各有一份资料时被合并成一行，且 platform 与
 *   influencer_id 会互相错配（例如 platform=tiktok 但 influencer_id 是 UC 开头的
 *   YouTube id，全表 7 万+ 行）。
 * - candidates / execution 也是 (campaign_id, tiktok_username) 唯一，同一个 handle
 *   跨平台在同一个 campaign 内会互相覆盖。
 *
 * 做法：
 * 1. 主档加 UNIQUE(platform, username)，同时保留一个普通 username 索引（原
 *    uk_username 顺带承担了 username 查询索引的职责，删掉后要补一个）；
 * 2. candidates / execution 用 VIRTUAL 生成列从 influencer_snapshot.platform 派生
 *    platform（无需回填、不会与快照漂移），再加 UNIQUE(campaign_id, platform, tiktok_username)；
 * 3. 最后删掉旧的 username 唯一键。先加新键再删旧键，全程 INPLACE/LOCK=NONE。
 *
 * 用法：
 *   node scripts/migrate-platform-identity-keys.mjs                # 只打印当前状态
 *   node scripts/migrate-platform-identity-keys.mjs --apply        # 执行全部步骤
 *   node scripts/migrate-platform-identity-keys.mjs --apply --from 3   # 从第 3 步开始
 *   node scripts/migrate-platform-identity-keys.mjs --apply --only 3   # 只执行第 3 步
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });
dotenv.config({ path: path.join(root, ".env.local"), quiet: true });

const { queryTikTok, tiktokPool } = await import("../lib/db/mysql-tiktok.js");

// 快照缺少 platform 时回退到系统的默认平台 slug（与 normalizePlatformSlug 的
// 默认值一致）。两个坑都要挡：
//   1) 路径不存在 → JSON_EXTRACT 返回 SQL NULL → COALESCE 兜底；
//   2) 显式 null  → JSON_UNQUOTE 会返回字符串 'null'（不是 SQL NULL），
//      所以先 NULLIF(...,'null') 归一，否则唯一键会拿到 platform='null'。
const CAND_PLATFORM_EXPR =
  "LOWER(COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(influencer_snapshot,'$.platform')),'null'),'tiktok'))";

const STEPS = [
  {
    n: 1,
    desc: "candidates 增加 platform 生成列（虚拟列，元数据变更）",
    sql: `ALTER TABLE tiktok_campaign_influencer_candidates
            ADD COLUMN platform VARCHAR(32)
            GENERATED ALWAYS AS (${CAND_PLATFORM_EXPR}) VIRTUAL`,
    verify: async () =>
      (await queryTikTok(
        `SELECT COUNT(*) c FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA='tiktok' AND TABLE_NAME='tiktok_campaign_influencer_candidates'
            AND COLUMN_NAME='platform'`
      ))[0]?.c === 1,
  },
  {
    n: 2,
    desc: "execution 增加 platform 生成列（虚拟列，元数据变更）",
    sql: `ALTER TABLE tiktok_campaign_execution
            ADD COLUMN platform VARCHAR(32)
            GENERATED ALWAYS AS (${CAND_PLATFORM_EXPR}) VIRTUAL`,
    verify: async () =>
      (await queryTikTok(
        `SELECT COUNT(*) c FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA='tiktok' AND TABLE_NAME='tiktok_campaign_execution'
            AND COLUMN_NAME='platform'`
      ))[0]?.c === 1,
  },
  {
    n: 3,
    desc: "主档加 UNIQUE(platform, username) + 补 username 普通索引（重操作，在线）",
    sql: `ALTER TABLE tiktok_influencer
            ADD UNIQUE KEY uk_platform_username (platform, username),
            ADD KEY idx_username (username),
            ALGORITHM=INPLACE, LOCK=NONE`,
    verify: async () => hasIndex("tiktok_influencer", "uk_platform_username"),
  },
  {
    n: 4,
    desc: "candidates 加 UNIQUE(campaign_id, platform, tiktok_username)（重操作，在线）",
    sql: `ALTER TABLE tiktok_campaign_influencer_candidates
            ADD UNIQUE KEY uk_campaign_platform_handle (campaign_id, platform, tiktok_username),
            ALGORITHM=INPLACE, LOCK=NONE`,
    verify: async () =>
      hasIndex("tiktok_campaign_influencer_candidates", "uk_campaign_platform_handle"),
  },
  {
    n: 5,
    desc: "execution 加 UNIQUE(campaign_id, platform, tiktok_username)（在线）",
    sql: `ALTER TABLE tiktok_campaign_execution
            ADD UNIQUE KEY uk_campaign_platform_handle (campaign_id, platform, tiktok_username),
            ALGORITHM=INPLACE, LOCK=NONE`,
    verify: async () => hasIndex("tiktok_campaign_execution", "uk_campaign_platform_handle"),
  },
  {
    n: 6,
    desc: "主档删除旧 uk_username（新键已就位后才删）",
    sql: `ALTER TABLE tiktok_influencer DROP INDEX uk_username, ALGORITHM=INPLACE, LOCK=NONE`,
    verify: async () => !(await hasIndex("tiktok_influencer", "uk_username")),
  },
  {
    n: 7,
    desc: "candidates 删除旧 uk_campaign_influencer",
    sql: `ALTER TABLE tiktok_campaign_influencer_candidates
            DROP INDEX uk_campaign_influencer, ALGORITHM=INPLACE, LOCK=NONE`,
    verify: async () =>
      !(await hasIndex("tiktok_campaign_influencer_candidates", "uk_campaign_influencer")),
  },
  {
    n: 8,
    desc: "execution 删除旧 uk_campaign_influencer",
    sql: `ALTER TABLE tiktok_campaign_execution
            DROP INDEX uk_campaign_influencer, ALGORITHM=INPLACE, LOCK=NONE`,
    verify: async () => !(await hasIndex("tiktok_campaign_execution", "uk_campaign_influencer")),
  },
  {
    n: 9,
    desc: "candidates 重建 platform 生成列（补 NULL 兜底，重操作在线）",
    sql: [
      `ALTER TABLE tiktok_campaign_influencer_candidates
         DROP INDEX uk_campaign_platform_handle`,
      `ALTER TABLE tiktok_campaign_influencer_candidates
         DROP COLUMN platform,
         ADD COLUMN platform VARCHAR(32)
           GENERATED ALWAYS AS (${CAND_PLATFORM_EXPR}) VIRTUAL,
         ALGORITHM=INSTANT`,
      `ALTER TABLE tiktok_campaign_influencer_candidates
         ADD UNIQUE KEY uk_campaign_platform_handle (campaign_id, platform, tiktok_username),
         ALGORITHM=INPLACE, LOCK=NONE`,
    ],
    verify: async () => {
      const rows = await queryTikTok(
        `SELECT COUNT(*) c FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA='tiktok' AND TABLE_NAME='tiktok_campaign_influencer_candidates'
            AND COLUMN_NAME='platform' AND GENERATION_EXPRESSION LIKE '%nullif%'`
      );
      return Number(rows?.[0]?.c || 0) > 0 &&
        (await hasIndex("tiktok_campaign_influencer_candidates", "uk_campaign_platform_handle"));
    },
  },
  {
    n: 10,
    desc: "execution 重建 platform 生成列（补 NULL 兜底，重操作在线）",
    sql: [
      `ALTER TABLE tiktok_campaign_execution
         DROP INDEX uk_campaign_platform_handle`,
      `ALTER TABLE tiktok_campaign_execution
         DROP COLUMN platform,
         ADD COLUMN platform VARCHAR(32)
           GENERATED ALWAYS AS (${CAND_PLATFORM_EXPR}) VIRTUAL,
         ALGORITHM=INSTANT`,
      `ALTER TABLE tiktok_campaign_execution
         ADD UNIQUE KEY uk_campaign_platform_handle (campaign_id, platform, tiktok_username),
         ALGORITHM=INPLACE, LOCK=NONE`,
    ],
    verify: async () => {
      const rows = await queryTikTok(
        `SELECT COUNT(*) c FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA='tiktok' AND TABLE_NAME='tiktok_campaign_execution'
            AND COLUMN_NAME='platform' AND GENERATION_EXPRESSION LIKE '%nullif%'`
      );
      return Number(rows?.[0]?.c || 0) > 0 &&
        (await hasIndex("tiktok_campaign_execution", "uk_campaign_platform_handle"));
    },
  },
];

async function hasIndex(table, keyName) {
  const rows = await queryTikTok(
    `SELECT COUNT(*) c FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA='tiktok' AND TABLE_NAME=? AND INDEX_NAME=?`,
    [table, keyName]
  );
  return Number(rows?.[0]?.c || 0) > 0;
}

async function snapshotIndexes() {
  const rows = await queryTikTok(
    `SELECT TABLE_NAME, INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) cols, NON_UNIQUE
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA='tiktok'
        AND TABLE_NAME IN ('tiktok_influencer','tiktok_campaign_influencer_candidates','tiktok_campaign_execution')
      GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE
      ORDER BY TABLE_NAME, INDEX_NAME`
  );
  return rows || [];
}

async function counts() {
  const main = await queryTikTok("SELECT COUNT(*) c FROM tiktok_influencer");
  const cand = await queryTikTok(
    "SELECT COUNT(*) c FROM tiktok_campaign_influencer_candidates"
  );
  const exe = await queryTikTok("SELECT COUNT(*) c FROM tiktok_campaign_execution");
  return {
    tiktok_influencer: Number(main?.[0]?.c || 0),
    candidates: Number(cand?.[0]?.c || 0),
    execution: Number(exe?.[0]?.c || 0),
  };
}

function argValue(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const only = Number(argValue("only") || 0);
  const from = Number(argValue("from") || 0);

  const before = await snapshotIndexes();
  console.log("[migrate] 当前索引：");
  for (const r of before) {
    console.log(
      `  ${r.TABLE_NAME} | ${r.INDEX_NAME} | ${r.NON_UNIQUE ? "KEY" : "UNIQUE"} (${r.cols})`
    );
  }
  console.log("[migrate] 行数（迁移前）:", JSON.stringify(await counts()));

  if (!apply) {
    console.log("\n[migrate] dry-run。加 --apply 才会执行。将依次执行：");
    for (const s of STEPS) {
      const done = await s.verify().catch(() => null);
      console.log(`  ${s.n}. ${done ? "[已完成] " : ""}${s.desc}`);
    }
    await tiktokPool.end();
    return;
  }

  const logPath = path.join(
    root,
    "logs",
    `migrate-platform-identity-keys-${Date.now()}.log`
  );
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    fs.appendFileSync(logPath, line + "\n");
  };
  log(`migration start (only=${only || "-"} from=${from || "-"})`);

  for (const step of STEPS) {
    if (only && step.n !== only) continue;
    if (from && step.n < from) continue;
    const already = await step.verify().catch(() => false);
    if (already) {
      log(`step ${step.n} 已是目标状态，跳过：${step.desc}`);
      continue;
    }
    log(`step ${step.n} 开始：${step.desc}`);
    const startedAt = Date.now();
    try {
      const statements = Array.isArray(step.sql) ? step.sql : [step.sql];
      for (const sqlStatement of statements) {
        await queryTikTok(sqlStatement);
      }
      log(
        `step ${step.n} 完成，用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
      );
    } catch (err) {
      log(`step ${step.n} 失败：${err?.message || err}`);
      log(
        `  SQL: ${(Array.isArray(step.sql) ? step.sql : [step.sql])
          .map((s) => s.replace(/\s+/g, " ").trim())
          .join(" || ")}`
      );
      log("中止后续步骤。");
      await tiktokPool.end();
      process.exit(1);
    }
    const ok = await step.verify().catch(() => false);
    if (!ok) {
      log(`step ${step.n} 执行后校验未通过，中止。`);
      await tiktokPool.end();
      process.exit(1);
    }
  }

  log("[migrate] 迁移后索引：");
  for (const r of await snapshotIndexes()) {
    log(
      `  ${r.TABLE_NAME} | ${r.INDEX_NAME} | ${r.NON_UNIQUE ? "KEY" : "UNIQUE"} (${r.cols})`
    );
  }
  log("[migrate] 行数（迁移后）: " + JSON.stringify(await counts()));
  log(`migration done; log=${logPath}`);
  await tiktokPool.end();
}

main().catch(async (err) => {
  console.error("[migrate] 运行失败:", err);
  try {
    await tiktokPool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
