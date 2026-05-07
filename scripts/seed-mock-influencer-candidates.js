#!/usr/bin/env node
/**
 * 为指定 campaign 插入少量「已分析候选红人」用于测试执行心跳：
 * - 写入 tiktok_influencer（全局缓存）
 * - 写入 tiktok_campaign_influencer_candidates（should_contact=1）
 *
 * 使用方式：
 *   node scripts/create-tiktok-influencer-tables.js   # 先建表
 *   node scripts/seed-mock-influencer-candidates.js CAMP-MOCK-001
 *   node scripts/run-execution-heartbeat-once.js
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const campaignId = process.argv[2] || "CAMP-MOCK-001";

const MOCKS = [
  {
    influencerId: "echotik_creator_001",
    username: "alice_fashion",
    displayName: "Alice Fashion",
    region: "US",
    followerCount: 180000,
    avgViews: 120000,
    influencerEmail: "alice@example.com",
    snapshot: {
      platform: "tiktok",
      username: "alice_fashion",
      followerCount: 180000,
      avgViews: 120000,
      contact: { email: "alice@example.com" },
    },
    matchScore: 92,
    shouldContact: 1,
    analysisSummary: "风格/垂类匹配，数据稳定，有邮箱可触达，建议优先联系。",
  },
  {
    influencerId: "echotik_creator_002",
    username: "bob_lifestyle",
    displayName: "Bob Lifestyle",
    region: "US",
    followerCount: 95000,
    avgViews: 60000,
    influencerEmail: "bob@example.com",
    snapshot: {
      platform: "tiktok",
      username: "bob_lifestyle",
      followerCount: 95000,
      avgViews: 60000,
      contact: { email: "bob@example.com" },
    },
    matchScore: 86,
    shouldContact: 1,
    analysisSummary: "受众与产品人群较贴近，互动不错，有联系方式，建议联系。",
  },
  {
    influencerId: "echotik_creator_003",
    username: "carol_beauty",
    displayName: "Carol Beauty",
    region: "US",
    followerCount: 240000,
    avgViews: 90000,
    influencerEmail: "carol@example.com",
    snapshot: {
      platform: "tiktok",
      username: "carol_beauty",
      followerCount: 240000,
      avgViews: 90000,
      contact: { email: "carol@example.com" },
    },
    matchScore: 80,
    shouldContact: 1,
    analysisSummary: "整体匹配度中上，具备触达方式，可作为补充池。",
  },
];

async function upsertInfluencer(m) {
  const profileUrl = `https://www.tiktok.com/@${m.username}`;
  await queryTikTok(
    `
    INSERT INTO tiktok_influencer (
      influencer_id, platform, region, username, display_name, avatar_url,
      profile_url,
      followers_count, avg_views, influencer_email, source, source_ref, source_payload, last_fetched_at
    ) VALUES (?, 'tiktok', ?, ?, ?, NULL, ?, ?, ?, ?, 'mock', ?, ?, NOW())
    ON DUPLICATE KEY UPDATE
      region=VALUES(region),
      username=VALUES(username),
      display_name=VALUES(display_name),
      profile_url=VALUES(profile_url),
      followers_count=VALUES(followers_count),
      avg_views=VALUES(avg_views),
      influencer_email=VALUES(influencer_email),
      source=VALUES(source),
      source_ref=VALUES(source_ref),
      source_payload=VALUES(source_payload),
      last_fetched_at=VALUES(last_fetched_at),
      updated_at=CURRENT_TIMESTAMP
  `,
    [
      m.influencerId,
      m.region || null,
      m.username || null,
      m.displayName || null,
      profileUrl,
      m.followerCount || null,
      m.avgViews || null,
      m.influencerEmail || null,
      m.influencerId,
      JSON.stringify(m.snapshot || {}),
    ]
  );
}

async function upsertCandidate(m) {
  await queryTikTok(
    `
    INSERT INTO tiktok_campaign_influencer_candidates (
      campaign_id, tiktok_username, influencer_id, source, influencer_snapshot,
      match_score, should_contact, email, has_email, analysis_summary, analyzed_at
    ) VALUES (?, ?, ?, 'mock', ?, ?, ?, ?, ?, ?, NOW())
    ON DUPLICATE KEY UPDATE
      influencer_snapshot=VALUES(influencer_snapshot),
      influencer_id=COALESCE(VALUES(influencer_id), influencer_id),
      match_score=VALUES(match_score),
      should_contact=VALUES(should_contact),
      analysis_summary=VALUES(analysis_summary),
      analyzed_at=VALUES(analyzed_at),
      updated_at=CURRENT_TIMESTAMP
  `,
    [
      campaignId,
      m.username,
      /^\d{10,}$/.test(String(m.influencerId || "")) ? String(m.influencerId) : null,
      JSON.stringify(m.snapshot || {}),
      m.matchScore ?? null,
      m.shouldContact ? 1 : 0,
      m.influencerEmail || null,
      m.influencerEmail ? 1 : 0,
      m.analysisSummary || null,
    ]
  );
}

async function main() {
  console.log("Seeding candidates for campaign:", campaignId);
  for (const m of MOCKS) {
    await upsertInfluencer(m);
    await upsertCandidate(m);
  }
  console.log("✅ done. Inserted:", MOCKS.length);
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ failed:", err);
  process.exit(1);
});

