/**
 * 修复「执行行/候选行引用的平台账号在主档表里缺失」的历史脏数据。
 *
 * 背景：2026-09-13 之前 tiktok_influencer 的唯一键是 username 全局唯一，
 * 同一个 @handle 在第二个平台被抓到时，会原地覆盖第一平台的主档行，
 * 导致执行行的 (platform, influencer_id) 在主档里查不到。
 *
 * 本脚本只做一件事：对「按 influencer_id 查不到主档、且该平台在该 handle 下
 * 确实没有主档」的执行行，从 campaign 候选快照重建一条缺失的平台主档。
 *
 * 安全约束：
 * - 默认 dry-run，只有显式 --apply 才写库；
 * - 只 INSERT，从不 UPDATE / DELETE 既有主档行；
 * - 同 (platform, username) 已有主档的行一律跳过并单独归类（不自动改）；
 * - 写入前导出完整分类 CSV，apply 后再写一份结果 CSV，便于回滚（删除新增行即可）。
 *
 * 用法：
 *   node scripts/repair-missing-platform-master-rows.mjs                    # 全量 dry-run
 *   node scripts/repair-missing-platform-master-rows.mjs --campaign=xxx      # 限定 campaign
 *   node scripts/repair-missing-platform-master-rows.mjs --handle=ginodepolocreations
 *   node scripts/repair-missing-platform-master-rows.mjs --status=running    # 只处理 running campaign
 *   node scripts/repair-missing-platform-master-rows.mjs --apply             # 执行插入
 *   node scripts/repair-missing-platform-master-rows.mjs --apply --batch=200 --sleep-ms=150
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });
dotenv.config({ path: path.join(root, ".env.local"), quiet: true });

const { queryTikTok, tiktokPool } = await import("../lib/db/mysql-tiktok.js");

const REPAIR_SOURCE = "repair_missing_platform_master";

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = (process.argv || []).find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return (process.argv || []).includes(`--${name}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizePlatform(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "tiktok";
  if (raw.includes("instagram") || raw === "ig" || raw === "ins") return "instagram";
  if (raw.includes("youtube") || raw === "yt" || raw === "ytb") return "youtube";
  if (raw === "x" || raw.includes("twitter")) return "x";
  if (raw.includes("tiktok")) return "tiktok";
  return raw;
}

function normalizeHandle(value) {
  const h = String(value ?? "").replace(/^@+/, "").trim();
  return h || null;
}

function buildProfileUrl(platform, username) {
  const u = String(username || "").trim();
  if (!u) return null;
  if (platform === "instagram") return `https://www.instagram.com/${u}/`;
  if (platform === "youtube") return `https://www.youtube.com/@${u}`;
  if (platform === "x") return `https://x.com/${u}`;
  return `https://www.tiktok.com/@${u}`;
}

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function num(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

function csvEscape(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function writeCsv(filePath, rows, columns) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(row[c])).join(","));
  }
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
}

function buildWhere() {
  const where = [
    "e.influencer_id IS NOT NULL",
    "TRIM(e.influencer_id) <> ''",
    "m.id IS NULL",
  ];
  const params = [];

  const campaign = argValue("campaign");
  if (campaign) {
    where.push("e.campaign_id = ?");
    params.push(campaign);
  }

  const handle = argValue("handle");
  if (handle) {
    where.push("LOWER(TRIM(LEADING '@' FROM e.tiktok_username)) = ?");
    params.push(String(handle).replace(/^@+/, "").trim().toLowerCase());
  }

  const stage = argValue("stage");
  if (stage) {
    where.push("e.stage = ?");
    params.push(stage);
  }

  const status = argValue("status");
  if (status) {
    const list = String(status)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length === 1) {
      where.push("c.status = ?");
      params.push(list[0]);
    } else if (list.length > 1) {
      where.push(`c.status IN (${list.map(() => "?").join(",")})`);
      params.push(...list);
    }
  }

  const platform = argValue("platform");
  if (platform) {
    where.push("LOWER(TRIM(e.platform)) = ?");
    params.push(normalizePlatform(platform));
  }

  return { whereSql: where.join(" AND "), params };
}

async function loadRows() {
  const { whereSql, params } = buildWhere();
  const limit = argValue("limit");
  const limitSql = limit ? `LIMIT ${Math.max(1, Number(limit) || 1)}` : "";

  return queryTikTok(
    `
    SELECT
      e.id AS execution_id,
      e.campaign_id,
      e.influencer_id AS exec_influencer_id,
      e.platform AS exec_platform,
      e.tiktok_username AS exec_username,
      e.stage,
      e.updated_at AS exec_updated_at,
      c.status AS campaign_status,
      cs.title AS campaign_title,
      cand.id AS candidate_id,
      cand.email AS candidate_email,
      cand.influencer_id AS candidate_influencer_id,
      cand.platform AS candidate_platform,
      cand.influencer_snapshot,
      sp.id AS same_platform_master_id,
      sp.influencer_id AS same_platform_master_influencer_id,
      0 AS has_any_platform_master
    FROM tiktok_campaign_execution e
    INNER JOIN tiktok_campaign c ON c.id = e.campaign_id
    LEFT JOIN tiktok_campaign_sessions cs ON cs.id = c.session_id
    LEFT JOIN tiktok_influencer m ON m.influencer_id = e.influencer_id
    LEFT JOIN tiktok_influencer sp
      ON sp.platform = LOWER(TRIM(e.platform))
     AND sp.username = TRIM(LEADING '@' FROM e.tiktok_username)
    LEFT JOIN tiktok_campaign_influencer_candidates cand
      ON cand.campaign_id = e.campaign_id
     /* 候选表唯一键 (campaign_id, platform, tiktok_username)；
        右侧列不能包函数，否则唯一键失效退化成全表扫描。
        列 collation 大小写不敏感，直接等值即可。 */
     AND cand.platform = LOWER(TRIM(e.platform))
     AND cand.tiktok_username = TRIM(LEADING '@' FROM e.tiktok_username)
    WHERE ${whereSql}
    ORDER BY e.id ASC
    ${limitSql}
    `,
    params
  );
}

function classify(row) {
  const platform = normalizePlatform(row.exec_platform);
  const username = normalizeHandle(row.exec_username);
  const snapshot = parseJson(row.influencer_snapshot);

  const base = {
    execution_id: row.execution_id,
    campaign_id: row.campaign_id,
    campaign_title: row.campaign_title || "",
    campaign_status: row.campaign_status || "",
    stage: row.stage || "",
    exec_platform: platform,
    exec_username: username || "",
    exec_influencer_id: str(row.exec_influencer_id) || "",
    candidate_id: row.candidate_id ?? "",
    candidate_platform: row.candidate_platform
      ? normalizePlatform(row.candidate_platform)
      : "",
    candidate_influencer_id: str(row.candidate_influencer_id) || "",
    same_platform_master_id: row.same_platform_master_id ?? "",
    same_platform_master_influencer_id:
      str(row.same_platform_master_influencer_id) || "",
    has_any_platform_master: Number(row.has_any_platform_master) ? 1 : 0,
    action: "",
    reason: "",
  };

  if (!username) {
    return { ...base, kind: "invalid", reason: "execution 缺少 username" };
  }
  if (row.same_platform_master_id) {
    return {
      ...base,
      kind: "same_platform_conflict",
      reason: `同平台已存在主档但 id 不同：${base.same_platform_master_influencer_id}`,
    };
  }
  if (!row.candidate_id) {
    return {
      ...base,
      kind: "no_candidate",
      reason: "找不到同 (campaign, platform, handle) 的候选行",
    };
  }
  if (!snapshot || typeof snapshot !== "object") {
    return { ...base, kind: "no_snapshot", reason: "候选快照为空或不是 JSON" };
  }
  if (
    base.candidate_influencer_id &&
    base.candidate_influencer_id !== base.exec_influencer_id
  ) {
    return {
      ...base,
      kind: "candidate_id_mismatch",
      reason: `候选 id ${base.candidate_influencer_id} != 执行 id ${base.exec_influencer_id}`,
    };
  }
  const snapshotPlatform = normalizePlatform(snapshot.platform);
  if (snapshot.platform && snapshotPlatform !== platform) {
    return {
      ...base,
      kind: "snapshot_platform_mismatch",
      reason: `快照平台 ${snapshotPlatform} != 执行平台 ${platform}`,
    };
  }

  const profileUrl =
    str(snapshot.profileUrl || snapshot.profile_url) ||
    buildProfileUrl(platform, username);
  if (!profileUrl) {
    return { ...base, kind: "not_repairable", reason: "无法得到 profile_url" };
  }

  const email =
    str(row.candidate_email) ||
    str(snapshot.email) ||
    str(snapshot.userInfo?.email) ||
    null;

  return {
    ...base,
    kind: "insertable",
    action: "insert_master",
    reason: "从候选快照重建缺失平台主档",
    platform,
    username,
    display_name:
      str(snapshot.displayName || snapshot.name || snapshot.userInfo?.displayName) ||
      username,
    profile_url: profileUrl,
    avatar_url: str(snapshot.avatarUrl || snapshot.userInfo?.avatarUrl) || null,
    email,
    followers_count: num(
      snapshot.followers?.count ??
        snapshot.followers_count ??
        snapshot.userInfo?.followers?.count
    ),
    avg_views: num(
      snapshot.views?.avg ??
        snapshot.avgViews ??
        snapshot.avg_views
    ),
    posts_count: num(snapshot.postsCount ?? snapshot.posts_count),
    avg_likes: num(snapshot.engagement?.avgLikes ?? snapshot.avgLikes),
    avg_comments: num(snapshot.engagement?.avgComments ?? snapshot.avgComments),
    engagement_rate: num(snapshot.engagement?.rate ?? snapshot.engagementRate),
    bio: str(snapshot.bio) || null,
    verified: snapshot.verified ? 1 : 0,
    country: str(snapshot.country || snapshot.videoPublishCountry) || null,
    snapshot,
  };
}

function buildInsertParams(item) {
  const sourcePayload = {
    origin: REPAIR_SOURCE,
    campaignId: item.campaign_id,
    executionId: item.execution_id,
    candidateId: item.candidate_id,
    reason: "repair missing platform master row",
  };
  return [
    item.exec_influencer_id,
    item.platform,
    item.username,
    item.display_name,
    item.profile_url,
    item.avatar_url,
    item.followers_count,
    item.avg_views,
    item.email,
    item.posts_count,
    item.avg_likes,
    item.avg_comments,
    item.engagement_rate,
    item.bio,
    item.verified,
    item.country,
    REPAIR_SOURCE,
    item.campaign_id,
    JSON.stringify(sourcePayload),
    JSON.stringify(item.snapshot),
  ];
}

const INSERT_SQL = `
  INSERT INTO tiktok_influencer (
    influencer_id, platform, username, display_name, profile_url, avatar_url,
    followers_count, avg_views, influencer_email, posts_count, avg_likes,
    avg_comments, engagement_rate, bio, verified, country,
    source, source_ref, source_payload, profile_data, last_fetched_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
  ON DUPLICATE KEY UPDATE id = id
`;

function summarize(items) {
  const byKind = {};
  for (const it of items) byKind[it.kind] = (byKind[it.kind] || 0) + 1;
  return byKind;
}

async function main() {
  const apply = hasFlag("apply");
  const batch = Math.max(1, Number(argValue("batch", 200)) || 200);
  const sleepMs = Math.max(0, Number(argValue("sleep-ms", 100)) || 100);

  console.log(
    `[repair] 模式=${apply ? "APPLY(写库)" : "DRY-RUN(只读)"} batch=${batch} sleep=${sleepMs}ms`
  );

  const rows = await loadRows();
  const items = rows.map(classify);
  const byKind = summarize(items);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  console.log(`[repair] 命中执行行：${items.length}`);
  console.log(`[repair] 分类：${JSON.stringify(byKind)}`);

  const reportPath = path.join(
    root,
    "exports",
    `repair-platform-master-${apply ? "apply" : "dryrun"}-${stamp}.csv`
  );
  const columns = [
    "execution_id",
    "campaign_id",
    "campaign_title",
    "campaign_status",
    "stage",
    "exec_platform",
    "exec_username",
    "exec_influencer_id",
    "candidate_id",
    "candidate_platform",
    "candidate_influencer_id",
    "same_platform_master_id",
    "same_platform_master_influencer_id",
    "has_any_platform_master",
    "kind",
    "action",
    "reason",
    "profile_url",
    "email",
  ];
  writeCsv(reportPath, items, columns);
  console.log(`[repair] 报告已写入：${reportPath}`);

  const insertable = items.filter((it) => it.kind === "insertable");
  if (!apply) {
    if (insertable.length) {
      console.log("[repair] 可新建示例（前 10 条）：");
      for (const it of insertable.slice(0, 10)) {
        console.log(
          `  - exec#${it.execution_id} ${it.exec_platform} @${it.exec_username} id=${it.exec_influencer_id} <- candidate#${it.candidate_id} ${it.profile_url}`
        );
      }
    }
    const conflicts = items.filter((it) => it.kind === "same_platform_conflict");
    if (conflicts.length) {
      console.log(`[repair] 同平台冲突（不自动处理）：${conflicts.length} 条`);
      for (const it of conflicts.slice(0, 10)) {
        console.log(
          `  - exec#${it.execution_id} ${it.exec_platform} @${it.exec_username} exec_id=${it.exec_influencer_id} master_id=${it.same_platform_master_influencer_id}`
        );
      }
    }
    await tiktokPool.end?.();
    return;
  }

  let inserted = 0;
  let duplicated = 0;
  let failed = 0;
  const appliedRows = [];

  for (let i = 0; i < insertable.length; i += 1) {
    const item = insertable[i];
    try {
      const result = await queryTikTok(INSERT_SQL, buildInsertParams(item));
      const affected = Number(result?.affectedRows ?? 0);
      if (affected > 0) {
        inserted += 1;
        appliedRows.push({
          ...item,
          action: "inserted",
          reason: "已新建主档",
        });
      } else {
        duplicated += 1;
        appliedRows.push({
          ...item,
          action: "skipped_duplicate",
          reason: "唯一键冲突（主档已存在），未改动",
        });
      }
    } catch (error) {
      failed += 1;
      appliedRows.push({
        ...item,
        action: "failed",
        reason: error?.message || String(error),
      });
      console.error(
        `[repair] 插入失败 exec#${item.execution_id} @${item.exec_username}:`,
        error?.message || error
      );
    }
    if ((i + 1) % batch === 0) {
      console.log(
        `[repair] 进度 ${i + 1}/${insertable.length}（inserted=${inserted} duplicated=${duplicated} failed=${failed}）`
      );
      if (sleepMs) await sleep(sleepMs);
    }
    if (inserted && inserted % 500 === 0) {
      console.log(`[repair] 已新建 ${inserted} 条`);
    }
  }

  const resultPath = path.join(
    root,
    "exports",
    `repair-platform-master-result-${stamp}.csv`
  );
  writeCsv(resultPath, appliedRows, [...columns, "kind", "action", "reason"]);
  console.log(
    `[repair] 完成：inserted=${inserted} duplicated=${duplicated} failed=${failed}`
  );
  console.log(`[repair] 结果明细：${resultPath}`);

  await tiktokPool.end?.();
}

main().catch(async (error) => {
  console.error("[repair] 失败：", error);
  try {
    await tiktokPool.end?.();
  } catch {}
  process.exitCode = 1;
});
