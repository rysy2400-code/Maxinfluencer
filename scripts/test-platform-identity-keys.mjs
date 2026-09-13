/**
 * 平台身份键改造的行为测试。
 *
 * 不碰生产数据：用 CREATE TABLE ... LIKE 复制三张表结构到一个临时库，
 * 让连接池指向临时库后跑真实 DAO，验证：
 *   1. 同 handle 跨平台 = 两行（不再互相覆盖）
 *   2. 同平台同 handle 改名/换 id = 原地更新，不产生新行
 *   3. 按 (platform, handle) 查询能命中正确平台
 *   4. 发信主档解析的三级回退（id → platform+handle → handle）
 *   5. candidates / execution 的 (campaign, platform, handle) 唯一键语义
 *
 * 用法：node scripts/test-platform-identity-keys.mjs
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mysql from "mysql2/promise.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });
dotenv.config({ path: path.join(root, ".env.local"), quiet: true });

const TEST_DB = "tiktok_idtest";
process.env.TIKTOK_DB_NAME = TEST_DB;

const dbConfig = {
  host: process.env.TIKTOK_DB_HOST || process.env.MYSQL_HOST,
  port: Number(process.env.TIKTOK_DB_PORT || process.env.MYSQL_PORT || 3306),
  user: process.env.TIKTOK_DB_USER || process.env.MYSQL_USER,
  password: process.env.TIKTOK_DB_PASSWORD || process.env.MYSQL_PASSWORD,
};

let passed = 0;
let failed = 0;

function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const admin = await mysql.createConnection({
    ...dbConfig,
    multipleStatements: true,
  });

  console.log(`[test] 准备临时库 ${TEST_DB}`);
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.query(
    `CREATE TABLE ${TEST_DB}.tiktok_influencer LIKE tiktok.tiktok_influencer`
  );
  await admin.query(
    `CREATE TABLE ${TEST_DB}.tiktok_campaign_influencer_candidates LIKE tiktok.tiktok_campaign_influencer_candidates`
  );
  await admin.query(
    `CREATE TABLE ${TEST_DB}.tiktok_campaign_execution LIKE tiktok.tiktok_campaign_execution`
  );

  const { queryTikTok, tiktokPool } = await import("../lib/db/mysql-tiktok.js");
  const { upsertInfluencer, getInfluencerByHandle } = await import(
    "../lib/db/influencer-dao.js"
  );
  const { saveTikTokInfluencer } = await import("../lib/db/tiktok-influencer-dao.js");
  const { resolveInfluencerForOutreach } = await import(
    "../lib/agents/influencer-agent.js"
  );

  // ---------- 1. 主档：同 handle 跨平台 ----------
  console.log("\n[test] 1. 同 handle 跨平台必须两行");
  await upsertInfluencer({
    influencerId: "UC_shared_handle",
    platform: "youtube",
    username: "sharedhandle",
    displayName: "Shared (YT)",
    profileUrl: "https://www.youtube.com/@sharedhandle",
    influencerEmail: "shared@yt.com",
  });
  await upsertInfluencer({
    influencerId: "7111535719642858542",
    platform: "tiktok",
    username: "sharedhandle",
    displayName: "Shared (TT)",
    profileUrl: "https://www.tiktok.com/@sharedhandle",
    influencerEmail: "shared@tt.com",
  });
  let rows = await queryTikTok(
    "SELECT platform, influencer_id, influencer_email FROM tiktok_influencer WHERE username='sharedhandle' ORDER BY platform"
  );
  check("跨平台同 handle 落成 2 行", rows.length === 2, `实际 ${rows.length}`);
  const ytRow = rows.find((r) => r.platform === "youtube");
  const ttRow = rows.find((r) => r.platform === "tiktok");
  check(
    "YouTube 行未被 TikTok 写入覆盖",
    ytRow?.influencer_id === "UC_shared_handle" && ytRow?.influencer_email === "shared@yt.com",
    JSON.stringify(ytRow)
  );
  check(
    "TikTok 行拿到自己的 id/邮箱",
    ttRow?.influencer_id === "7111535719642858542" && ttRow?.influencer_email === "shared@tt.com",
    JSON.stringify(ttRow)
  );

  // ---------- 2. 同平台同 handle：原地更新 ----------
  console.log("\n[test] 2. 同平台同 handle 重复写入必须原地更新");
  await upsertInfluencer({
    influencerId: "7111535719642858542",
    platform: "tiktok",
    username: "sharedhandle",
    profileUrl: "https://www.tiktok.com/@sharedhandle",
    influencerEmail: "shared+updated@tt.com",
  });
  rows = await queryTikTok(
    "SELECT platform, influencer_id, influencer_email FROM tiktok_influencer WHERE username='sharedhandle'"
  );
  check("仍然是 2 行（没有产生第三行）", rows.length === 2, `实际 ${rows.length}`);
  const ttRow2 = rows.find((r) => r.platform === "tiktok");
  check(
    "TikTok 行邮箱被更新",
    ttRow2?.influencer_email === "shared+updated@tt.com",
    JSON.stringify(ttRow2)
  );

  // ---------- 3. 同平台账号改名 ----------
  console.log("\n[test] 3. 同平台账号改名（按 influencer_id 命中）必须原地更新");
  await upsertInfluencer({
    influencerId: "7111535719642858542",
    platform: "tiktok",
    username: "sharedhandle_renamed",
    profileUrl: "https://www.tiktok.com/@sharedhandle_renamed",
    influencerEmail: "shared+updated@tt.com",
  });
  rows = await queryTikTok(
    "SELECT platform, username FROM tiktok_influencer WHERE influencer_id='7111535719642858542'"
  );
  check("按 id 命中并改名，没有新增行", rows.length === 1 && rows[0].username === "sharedhandle_renamed", JSON.stringify(rows));

  // ---------- 4. 平台维度查询 ----------
  console.log("\n[test] 4. 按 (platform, handle) 查询命中正确平台");
  const ytLookup = await getInfluencerByHandle({ platform: "youtube", username: "sharedhandle" });
  const ttLookup = await getInfluencerByHandle({ platform: "tiktok", username: "sharedhandle" });
  check("youtube 查询命中 YouTube 行", ytLookup?.influencerId === "UC_shared_handle", JSON.stringify(ytLookup?.influencerId));
  check("tiktok 查询不命中 YouTube 行", ttLookup === null, JSON.stringify(ttLookup?.influencerId));

  // ---------- 5. 发信主档解析回退 ----------
  console.log("\n[test] 5. 发信主档解析三级回退");
  const r1 = await resolveInfluencerForOutreach({
    platformInfluencerId: "UC_shared_handle",
    tiktokUsername: "sharedhandle",
    platform: "youtube",
  });
  check("id 命中时 matchedBy=id", r1.matchedBy === "id" && r1.influencerId === "UC_shared_handle", JSON.stringify(r1.matchedBy));

  // 事件给的是 Instagram id（主档里没有），但同 handle 有 YouTube 行
  const r2 = await resolveInfluencerForOutreach({
    platformInfluencerId: "24034562729",
    tiktokUsername: "sharedhandle",
    platform: "instagram",
  });
  check(
    "id 查不到时回退到 handle（修复主档不存在）",
    r2.matchedBy === "handle" && r2.influencerId === "UC_shared_handle",
    JSON.stringify({ matchedBy: r2.matchedBy, id: r2.influencerId })
  );

  const r3 = await resolveInfluencerForOutreach({
    platformInfluencerId: "no_such_id",
    tiktokUsername: "no_such_handle_at_all",
    platform: "tiktok",
  });
  check("彻底查不到时返回 null（仍然会 failed 而不是乱发）", r3.influencer === null, JSON.stringify(r3));

  // ---------- 6. candidates 唯一键 ----------
  console.log("\n[test] 6. candidates (campaign, platform, handle) 唯一键");
  const candSql = `
    INSERT INTO tiktok_campaign_influencer_candidates
      (campaign_id, tiktok_username, influencer_id, source, influencer_snapshot, should_contact, email, has_email)
    VALUES (?, ?, ?, 'web_search', ?, 1, ?, 1)
    ON DUPLICATE KEY UPDATE
      email = IF(has_email = 0, VALUES(email), email),
      updated_at = CURRENT_TIMESTAMP
  `;
  await queryTikTok(candSql, ["CAMP-T", "candhandle", "111", JSON.stringify({ platform: "TikTok" }), "a@x.com"]);
  await queryTikTok(candSql, ["CAMP-T", "candhandle", "24034562729", JSON.stringify({ platform: "Instagram" }), "b@x.com"]);
  let candRows = await queryTikTok(
    "SELECT platform, influencer_id FROM tiktok_campaign_influencer_candidates WHERE campaign_id='CAMP-T' AND tiktok_username='candhandle'"
  );
  check("同 handle 跨平台 = 2 个候选", candRows.length === 2, JSON.stringify(candRows));
  await queryTikTok(candSql, ["CAMP-T", "candhandle", "112", JSON.stringify({ platform: "TikTok" }), "c@x.com"]);
  candRows = await queryTikTok(
    "SELECT platform, influencer_id FROM tiktok_campaign_influencer_candidates WHERE campaign_id='CAMP-T' AND tiktok_username='candhandle'"
  );
  check("同平台重复写入仍然是 2 行", candRows.length === 2, JSON.stringify(candRows));
  check(
    "生成列 platform 由快照派生且小写",
    candRows.some((r) => r.platform === "tiktok") && candRows.some((r) => r.platform === "instagram"),
    JSON.stringify(candRows)
  );

  // ---------- 7. execution 唯一键 ----------
  console.log("\n[test] 7. execution (campaign, platform, handle) 唯一键");
  const exeSql = `
    INSERT IGNORE INTO tiktok_campaign_execution
      (campaign_id, tiktok_username, influencer_id, influencer_snapshot, source, stage, currency)
    VALUES (?, ?, ?, ?, 'web_search', 'pending_quote', 'USD')
  `;
  await queryTikTok(exeSql, ["CAMP-T", "exehandle", "111", JSON.stringify({ platform: "TikTok" })]);
  await queryTikTok(exeSql, ["CAMP-T", "exehandle", "24034562729", JSON.stringify({ platform: "Instagram" })]);
  await queryTikTok(exeSql, ["CAMP-T", "exehandle", "111", JSON.stringify({ platform: "TikTok" })]);
  const exeRows = await queryTikTok(
    "SELECT platform, influencer_id FROM tiktok_campaign_execution WHERE campaign_id='CAMP-T' AND tiktok_username='exehandle'"
  );
  check("同 handle 跨平台 = 2 条执行行，同平台重复被 IGNORE", exeRows.length === 2, JSON.stringify(exeRows));

  // ---------- 8. 爬虫写入路径 ----------
  console.log("\n[test] 8. 爬虫 saveTikTokInfluencer 不得跨平台覆盖");
  await upsertInfluencer({
    influencerId: "UC_crawler_target",
    platform: "youtube",
    username: "crawlerhandle",
    profileUrl: "https://www.youtube.com/@crawlerhandle",
    influencerEmail: "crawler@yt.com",
  });
  await saveTikTokInfluencer(
    {
      // 爬虫路径读取的是 tiktokUserId / userId / profile_data.userInfo.userId，
      // 最后才回退 influencerId
      tiktokUserId: "7258842021442602026",
      username: "crawlerhandle",
      platform: "tiktok",
      profileUrl: "https://www.tiktok.com/@crawlerhandle",
      displayName: "Crawler TT",
      followers: { count: 1234 },
    },
    { skipGlobalEmailSync: true }
  );
  const crawlerRows = await queryTikTok(
    "SELECT platform, influencer_id, influencer_email FROM tiktok_influencer WHERE username='crawlerhandle' ORDER BY platform"
  );
  check("爬虫写入后 = 2 行（YT 未被覆盖）", crawlerRows.length === 2, JSON.stringify(crawlerRows));
  check(
    "YouTube 行 id/邮箱保持不变",
    crawlerRows.find((r) => r.platform === "youtube")?.influencer_id === "UC_crawler_target",
    JSON.stringify(crawlerRows)
  );
  check(
    "TikTok 行写入自己的 id",
    crawlerRows.find((r) => r.platform === "tiktok")?.influencer_id === "7258842021442602026",
    JSON.stringify(crawlerRows)
  );

  await tiktokPool.end();
  console.log(`\n[test] 清理临时库 ${TEST_DB}`);
  await admin.query(`DROP DATABASE ${TEST_DB}`);
  await admin.end();

  console.log(`\n[test] 结果：通过 ${passed}，失败 ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("[test] 运行失败:", err);
  process.exit(1);
});
