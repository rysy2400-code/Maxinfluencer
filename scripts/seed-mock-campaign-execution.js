/**
 * 种子脚本：插入模拟 Campaign 和执行数据，用于测试红人执行进度面板
 *
 * 使用方式：
 *   node scripts/seed-mock-campaign-execution.js
 *
 * 会创建：
 * - 1 个 campaign_session（published）
 * - 1 个 tiktok_campaign
 * - 8 个 tiktok_campaign_execution 记录（各阶段各 2 个红人）
 *
 * 测试用 campaignId: CAMP-MOCK-001
 * 测试用 sessionId: sess-mock-001
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const CAMPAIGN_ID = "CAMP-MOCK-001";
const SESSION_ID = "sess-mock-001";

const MOCK_INFLUENCERS = [
  {
    id: "alice_fashion",
    username: "alice_fashion",
    name: "Alice Fashion",
    platform: "TikTok",
    profileUrl: "https://www.tiktok.com/@alice_fashion",
    avatarUrl: "https://p16-sign.tiktokcdn-us.com/aweme/100x100/tos-alisg-avt-0068/1234567890.jpeg",
    followers: "125K",
    followerCount: 125000,
    avgViews: "85K",
    quote: 450,
    cpm: 3.6,
    recommendReason: "粉丝画像与产品目标人群高度匹配，互动率优秀",
  },
  {
    id: "bob_lifestyle",
    username: "bob_lifestyle",
    name: "Bob Lifestyle",
    platform: "TikTok",
    profileUrl: "https://www.tiktok.com/@bob_lifestyle",
    avatarUrl: "https://p16-sign.tiktokcdn-us.com/aweme/100x100/tos-alisg-avt-0068/0987654321.jpeg",
    followers: "280K",
    followerCount: 280000,
    avgViews: "120K",
    quote: 800,
    cpm: 6.67,
    recommendReason: "内容风格与品牌调性一致，转化潜力高",
  },
  {
    id: "carol_beauty",
    username: "carol_beauty",
    name: "Carol Beauty",
    platform: "TikTok",
    profileUrl: "https://www.tiktok.com/@carol_beauty",
    avatarUrl: "https://p16-sign.tiktokcdn-us.com/aweme/100x100/tos-alisg-avt-0068/abcdef1234.jpeg",
    followers: "95K",
    followerCount: 95000,
    avgViews: "62K",
    quote: 380,
    cpm: 6.13,
    recommendReason: "美妆垂类，受众精准",
  },
  {
    id: "dave_tech",
    username: "dave_tech",
    name: "Dave Tech",
    platform: "TikTok",
    profileUrl: "https://www.tiktok.com/@dave_tech",
    avatarUrl: "https://p16-sign.tiktokcdn-us.com/aweme/100x100/tos-alisg-avt-0068/tech123456.jpeg",
    followers: "210K",
    followerCount: 210000,
    avgViews: "95K",
    quote: 520,
    cpm: 5.47,
    recommendReason: "科技数码类，粉丝粘性强",
  },
  {
    id: "emma_fit",
    username: "emma_fit",
    name: "Emma Fit",
    platform: "TikTok",
    profileUrl: "https://www.tiktok.com/@emma_fit",
    avatarUrl: "https://p16-sign.tiktokcdn-us.com/aweme/100x100/tos-alisg-avt-0068/fit789012.jpeg",
    followers: "180K",
    followerCount: 180000,
    avgViews: "110K",
    quote: 600,
    cpm: 5.45,
    recommendReason: "健身穿搭类，与产品场景契合",
  },
  {
    id: "frank_food",
    username: "frank_food",
    name: "Frank Food",
    platform: "TikTok",
    profileUrl: "https://www.tiktok.com/@frank_food",
    avatarUrl: "https://p16-sign.tiktokcdn-us.com/aweme/100x100/tos-alisg-avt-0068/food345678.jpeg",
    followers: "350K",
    followerCount: 350000,
    avgViews: "200K",
    quote: 950,
    cpm: 4.75,
    recommendReason: "美食生活类，曝光量大",
  },
  {
    id: "grace_travel",
    username: "grace_travel",
    name: "Grace Travel",
    platform: "TikTok",
    profileUrl: "https://www.tiktok.com/@grace_travel",
    avatarUrl: "https://p16-sign.tiktokcdn-us.com/aweme/100x100/tos-alisg-avt-0068/travel9012.jpeg",
    followers: "420K",
    followerCount: 420000,
    avgViews: "180K",
    quote: 1200,
    cpm: 6.67,
    recommendReason: "旅行穿搭，品牌曝光度高",
  },
  {
    id: "henry_gaming",
    username: "henry_gaming",
    name: "Henry Gaming",
    platform: "TikTok",
    profileUrl: "https://www.tiktok.com/@henry_gaming",
    avatarUrl: "https://p16-sign.tiktokcdn-us.com/aweme/100x100/tos-alisg-avt-0068/game5678.jpeg",
    followers: "550K",
    followerCount: 550000,
    avgViews: "320K",
    quote: 1500,
    cpm: 4.69,
    recommendReason: "游戏区大号，年轻用户集中",
  },
];

const PRODUCT_INFO = {
  brand: "G4Free",
  product: "G4Free Women's High-Waisted Wide Leg Pants",
  productLink: "https://www.amazon.com/dp/B0EXAMPLE",
  type: "电商",
};

const CAMPAIGN_INFO = {
  platform: "TikTok",
  region: "美国",
  publishTimeRange: "2024-03-01 至 2024-03-31",
  budget: 3000,
  commission: 10,
};

const INFLUENCER_PROFILE = {
  followers: "10万-50万",
  avgViews: "10万-50万",
  accountTypes: ["时尚博主", "生活方式KOL", "创意内容"],
};

const CONTENT_SCRIPT = {
  title: "从办公室到周末，一条搞定！",
  duration: "18-25秒",
  platform: "TikTok",
  keyPoints: ["一裤多穿", "高腰显腿长", "超大口袋"],
};

async function seed() {
  console.log("开始插入模拟数据...\n");

  // 1. 确保 campaign_sessions 存在并插入测试会话
  try {
    const contextJson = JSON.stringify({
      published: true,
      campaignId: CAMPAIGN_ID,
      workflowState: "published",
    });
    await queryTikTok(
      `INSERT INTO campaign_sessions (id, title, status, messages, context, created_at, updated_at)
       VALUES (?, ?, 'published', '[]', ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE status = 'published', context = VALUES(context), updated_at = NOW()`,
      [SESSION_ID, "测试 Campaign - G4Free 神裤", contextJson]
    );
    console.log("✅ campaign_sessions: 已插入/更新会话", SESSION_ID);
  } catch (e) {
    if (e.code === "ER_NO_SUCH_TABLE") {
      console.error("❌ campaign_sessions 表不存在，请先执行: node scripts/create-table-direct.js");
      process.exit(1);
    }
    throw e;
  }

  // 2. 插入 tiktok_campaign（如已存在则先删除，保证幂等）
  await queryTikTok("DELETE FROM tiktok_campaign_execution WHERE campaign_id = ?", [CAMPAIGN_ID]);
  await queryTikTok("DELETE FROM tiktok_campaign WHERE id = ?", [CAMPAIGN_ID]);

  await queryTikTok(
    `INSERT INTO tiktok_campaign (
      id, session_id, platform, region, start_date, end_date, budget, commission,
      product_info, campaign_info, influencer_profile, content_script,
      influencers_per_day, status
    ) VALUES (?, ?, 'tiktok', 'US', NULL, NULL, 3000, 10, ?, ?, ?, ?, 5, 'running')`,
    [
      CAMPAIGN_ID,
      SESSION_ID,
      JSON.stringify(PRODUCT_INFO),
      JSON.stringify(CAMPAIGN_INFO),
      JSON.stringify(INFLUENCER_PROFILE),
      JSON.stringify(CONTENT_SCRIPT),
    ]
  );
  console.log("✅ tiktok_campaign: 已插入", CAMPAIGN_ID);

  // 3. 插入 tiktok_campaign_execution（各阶段 2 个红人）
  const stages = [
    { stage: "pending_quote", indices: [0, 1] },
    { stage: "pending_sample", indices: [2, 3], lastEvent: { shippingAddress: { fullName: "Carol Test", country: "US" } } },
    { stage: "draft_submitted", indices: [4, 5], lastEvent: { draftLink: "https://www.tiktok.com/@emma_fit/video/1234567890" } },
    { stage: "published", indices: [6, 7], lastEvent: { videoLink: "https://www.tiktok.com/@grace_travel/video/111", promoCode: "GRACE20", views: "125K", likes: "8.2K", comments: "320" } },
  ];

  for (const { stage, indices, lastEvent } of stages) {
    for (const i of indices) {
      const inf = MOCK_INFLUENCERS[i];
      const snapshot = JSON.stringify(inf);
      const lastEventJson = lastEvent ? JSON.stringify(lastEvent) : null;
      await queryTikTok(
        `INSERT INTO tiktok_campaign_execution (campaign_id, influencer_id, influencer_snapshot, stage, last_event)
         VALUES (?, ?, ?, ?, ?)`,
        [CAMPAIGN_ID, inf.id, snapshot, stage, lastEventJson]
      );
    }
    console.log(`✅ tiktok_campaign_execution: ${stage} x ${indices.length}`);
  }

  // 4. 为所有「无执行数据」的 campaign 补充模拟红人（解决「新 Campaign」等打开后右侧无数据的问题）
  const allCampaigns = await queryTikTok("SELECT id FROM tiktok_campaign");
  for (const row of allCampaigns || []) {
    const cid = row.id;
    const count = await queryTikTok(
      "SELECT COUNT(*) as n FROM tiktok_campaign_execution WHERE campaign_id = ?",
      [cid]
    );
    if (count && count[0].n === 0) {
      for (const { stage, indices, lastEvent } of stages) {
        for (const i of indices) {
          const inf = MOCK_INFLUENCERS[i];
          const snapshot = JSON.stringify(inf);
          const lastEventJson = lastEvent ? JSON.stringify(lastEvent) : null;
          await queryTikTok(
            `INSERT INTO tiktok_campaign_execution (campaign_id, influencer_id, influencer_snapshot, stage, last_event)
             VALUES (?, ?, ?, ?, ?)`,
            [cid, inf.id, snapshot, stage, lastEventJson]
          );
        }
      }
      console.log("✅ 已为 campaign", cid, "补充模拟执行数据");
    }
  }

  console.log("\n🎉 模拟数据插入完成！");
  console.log("\n测试说明：");
  console.log("  1. 启动前端: npm run dev");
  console.log("  2. 在左侧「已发布 Campaign」中点击任意已发布项（如「新 Campaign」）");
  console.log("  3. 右侧将显示红人执行进度，可切换四个 Tab 测试各板块");
  console.log("  4. 在聊天框输入自然语言，Agent 会识别并执行：");
  console.log("     - 「同意 alice_fashion 的报价」");
  console.log("     - 「暂不通过 bob_lifestyle」");
  console.log("     - 「已给 carol_beauty 寄样」");
  console.log("     - 「通过 emma_fit 的草稿」");
  console.log("     - 「emma 的草稿不通过，需要加强产品特写」");
  console.log("     - 「grace_travel 的视频已发布，链接 https://tiktok.com/xxx」");
  console.log("     - 「查一下执行状态」");
  console.log("\nCampaign ID:", CAMPAIGN_ID);
  console.log("Session ID:", SESSION_ID);
}

seed().catch((err) => {
  console.error("❌ 插入失败:", err);
  process.exit(1);
});
