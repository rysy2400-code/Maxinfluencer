/**
 * 红人邀约动态发信池 + IMAP 分批 + 首封冷却 本地验证（默认不发真实邮件）
 *
 * 用法:
 *   node scripts/test-outbound-email-pool.mjs
 *   node scripts/test-outbound-email-pool.mjs --with-poll   # 额外跑一轮 IMAP（只读拉取）
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import {
  EXCLUDED_OUTREACH_EMAILS,
  IMAP_POLL_BATCH_SIZE,
  accountHasImapConfig,
  accountMatchesTemporaryOutboundPool,
  getOpContactEmail,
  normalizePoolEmail,
  selectImapPollBatch,
} from "../lib/email/temporary-outbound-pool.js";
import {
  OutboundCooldownError,
  getOutreachPoolAccounts,
  pickOutboundAccountForNewOutreach,
} from "../lib/email/enterprise-mail-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const WITH_POLL = process.argv.includes("--with-poll");
const COOLDOWN_MS = 60_000;

function accountEmail(account) {
  return normalizePoolEmail(getOpContactEmail(account));
}

function ok(label) {
  console.log(`  ✓ ${label}`);
}

function fail(label, detail = "") {
  console.error(`  ✗ ${label}${detail ? `: ${detail}` : ""}`);
  process.exitCode = 1;
}

async function countEligibleFromDb() {
  const rows = await queryTikTok(
    `
    SELECT
      LOWER(TRIM(from_email)) AS email,
      MAX(COALESCE(sent_at, created_at)) AS last_at
    FROM (
      SELECT
        influencer_id,
        from_email,
        sent_at,
        created_at,
        ROW_NUMBER() OVER (
          PARTITION BY influencer_id
          ORDER BY COALESCE(sent_at, created_at) ASC, id ASC
        ) AS rn
      FROM tiktok_influencer_conversation_messages
      WHERE
        direction = 'bin'
        AND channel = 'email'
        AND from_email IS NOT NULL
        AND TRIM(from_email) <> ''
    ) first_outreach
    WHERE rn = 1
    GROUP BY LOWER(TRIM(from_email))
  `
  );
  const lastByEmail = new Map();
  for (const row of rows || []) {
    const email = String(row.email || "").trim().toLowerCase();
    if (email) lastByEmail.set(email, row.last_at);
  }

  const pool = await getOutreachPoolAccounts();
  const now = Date.now();
  let eligible = 0;
  let cooling = 0;
  let neverUsed = 0;

  for (const acc of pool) {
    const email = accountEmail(acc);
    if (!email) continue;
    const lastAt = lastByEmail.get(email);
    if (!lastAt) {
      neverUsed++;
      eligible++;
      continue;
    }
    const lastMs = new Date(lastAt).getTime();
    if (Number.isFinite(lastMs) && now - lastMs >= COOLDOWN_MS) {
      eligible++;
    } else {
      cooling++;
    }
  }

  return { poolSize: pool.length, eligible, cooling, neverUsed };
}

async function testPoolBasics() {
  console.log("\n=== 1. 动态池基础 ===");
  const pool = await getOutreachPoolAccounts();
  const allContacts = await queryTikTok("SELECT * FROM op_contacts");

  if (pool.length < 200) {
    fail("发信池数量偏低", String(pool.length));
  } else {
    ok(`发信池 ${pool.length} 个`);
  }

  const hasExcluded = pool.some((a) =>
    EXCLUDED_OUTREACH_EMAILS.includes(accountEmail(a))
  );
  if (hasExcluded) {
    fail("排除邮箱仍出现在发信池");
  } else {
    ok(`已排除 ${EXCLUDED_OUTREACH_EMAILS.join(", ")}`);
  }

  const expectedMin = allContacts.length - EXCLUDED_OUTREACH_EMAILS.length;
  if (pool.length !== expectedMin) {
    fail("发信池与 op_contacts 数量不一致", `pool=${pool.length} expected≈${expectedMin}`);
  } else {
    ok("发信池与 op_contacts（减排除项）一致");
  }
}

async function testImapBatches() {
  console.log("\n=== 2. IMAP 分批轮转 ===");
  const allContacts = await queryTikTok("SELECT * FROM op_contacts");
  const eligible = allContacts.filter(
    (a) => accountMatchesTemporaryOutboundPool(a) && accountHasImapConfig(a)
  );

  const { numBatches, totalAccounts } = selectImapPollBatch(eligible);
  if (totalAccounts !== eligible.length) {
    fail("IMAP 池计数异常");
  } else {
    ok(`IMAP 池 ${totalAccounts} 个`);
  }

  if (numBatches < 4 || numBatches > 6) {
    fail("批次数不在预期范围", String(numBatches));
  } else {
    ok(`约 ${numBatches} 批（每批 ~${IMAP_POLL_BATCH_SIZE}）`);
  }

  const seen = new Set();
  const base = Date.UTC(2026, 0, 1, 0, 0, 0);
  for (let m = 0; m < numBatches; m++) {
    const { batch, batchIndex } = selectImapPollBatch(eligible, {
      now: base + m * 60_000,
    });
    if (batch.length === 0 || batch.length > IMAP_POLL_BATCH_SIZE) {
      fail(`第 ${m + 1} 分钟批次大小异常`, String(batch.length));
      return;
    }
    for (const acc of batch) {
      seen.add(accountEmail(acc));
    }
    if (batchIndex !== m) {
      fail("批次索引与分钟偏移不一致", `m=${m} idx=${batchIndex}`);
      return;
    }
  }

  if (seen.size !== eligible.length) {
    fail("5 轮未覆盖全部 IMAP 账号", `covered=${seen.size} total=${eligible.length}`);
  } else {
    ok(`${numBatches} 轮覆盖全部 IMAP 账号`);
  }
}

async function testLruPicker() {
  console.log("\n=== 3. 首封 LRU 选号 ===");
  const first = await pickOutboundAccountForNewOutreach();
  const emailA = accountEmail(first);
  if (!emailA) {
    fail("首次选号失败");
    return;
  }
  ok(`首次选中 ${emailA}`);

  const second = await pickOutboundAccountForNewOutreach();
  const emailB = accountEmail(second);
  if (!emailB) {
    fail("第二次选号失败");
    return;
  }
  ok(`再次选中 ${emailB}（LRU，可与首次相同）`);
}

async function testCooldownWithFixture() {
  console.log("\n=== 4. 首封 60s 冷却（DB 夹具，不发信） ===");
  const picked = await pickOutboundAccountForNewOutreach();
  const fromEmail = accountEmail(picked);
  const testInfluencerId = `__pool_test_${Date.now()}`;
  const testCampaignId = `__pool_test_campaign_${Date.now()}`;

  try {
    await queryTikTok(
      `
      INSERT INTO tiktok_influencer_conversation_messages (
        influencer_id, campaign_id, direction, channel,
        from_email, to_email, subject, body_text,
        source_type, sent_at, created_at
      ) VALUES (?, ?, 'bin', 'email', ?, 'cooldown-test@example.com',
                'Pool cooldown test', 'fixture', 'seed_outreach', NOW(), NOW())
    `,
      [testInfluencerId, testCampaignId, fromEmail]
    );

    let blockedSameEmail = false;
    try {
      const again = await pickOutboundAccountForNewOutreach();
      if (accountEmail(again) === fromEmail) {
        blockedSameEmail = false;
      } else {
        blockedSameEmail = true;
      }
    } catch (err) {
      if (err instanceof OutboundCooldownError) {
        blockedSameEmail = true;
      } else {
        throw err;
      }
    }

    if (!blockedSameEmail) {
      fail("冷却未生效", `仍可选中 ${fromEmail}`);
    } else {
      ok(`刚用于首封的 ${fromEmail} 在 60s 内不可再选`);
    }
  } finally {
    await queryTikTok(
      `DELETE FROM tiktok_influencer_conversation_messages
       WHERE influencer_id = ? AND campaign_id = ?`,
      [testInfluencerId, testCampaignId]
    );
    ok("已清理测试夹具");
  }
}

async function testEligibilityStats() {
  console.log("\n=== 5. 当前可发首封容量 ===");
  const stats = await countEligibleFromDb();
  console.log(
    `  池内 ${stats.poolSize}，可发 ${stats.eligible}（从未首封 ${stats.neverUsed}），冷却中 ${stats.cooling}`
  );
  const capacityPerMin = stats.eligible;
  if (capacityPerMin >= 100) {
    ok(`当前可支撑约 ${capacityPerMin} 封/分钟（目标 100）`);
  } else {
    fail("当前可发邮箱不足 100", `eligible=${capacityPerMin}`);
  }
}

function testPollScript() {
  console.log("\n=== 6. IMAP 脚本试跑（--with-poll） ===");
  const r = spawnSync("node", ["scripts/poll-influencer-replies.js"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: { ...process.env },
  });
  if (r.status !== 0) {
    fail("poll-influencer-replies.js 退出码非 0", String(r.status));
  } else {
    ok("poll-influencer-replies.js 执行成功");
  }
}

async function main() {
  console.log("========== 邮件池本地验证 ==========");
  await testPoolBasics();
  await testImapBatches();
  await testLruPicker();
  await testCooldownWithFixture();
  await testEligibilityStats();
  if (WITH_POLL) {
    testPollScript();
  } else {
    console.log("\n（跳过 IMAP 实连；加 --with-poll 可试跑 poll-influencer-replies.js）");
  }

  console.log("\n========== 结果 ==========");
  if (process.exitCode) {
    console.log("存在失败项，请勿部署。");
  } else {
    console.log("全部通过，可 push + 部署 Worker。");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
