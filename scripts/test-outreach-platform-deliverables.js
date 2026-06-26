/**
 * 多平台 campaign + YouTube 红人首封：验证 Deliverables 是否只提 YouTube 段
 * 用法：node scripts/test-outreach-platform-deliverables.js
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { generateOutreachBodyWithLLM } from "../lib/agents/influencer-agent.js";
import {
  PRICING_MODE_ECPM_WITH_CAP,
  computeQuotedFlatFeeUsd,
} from "../lib/campaign/influencer-pricing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const MULTI_PLATFORM_DELIVERABLES = `YouTube：1条 Youtube 专属视频；广告加热权限：60天；bio link 14天；素材二创权限：90天
Instagram：1条 Instagram Reel；Ad code: 60天；bio link 14天；素材二创权限：90天
TikTok：1条 TikTok 专属视频；Spark ads 60天；bio link 14天`;

const campaign = {
  id: "TEST-MULTI-PLATFORM-DELIVERABLES",
  productInfo: {
    brandName: "MaxTest",
    productName: "Social App",
    productLink: "https://example.com/product",
  },
  campaignInfo: {
    platform: ["YouTube", "Instagram", "TikTok"],
    platforms: ["YouTube", "Instagram", "TikTok"],
    region: "美国",
    deliverables: MULTI_PLATFORM_DELIVERABLES,
    influencerPricing: {
      mode: PRICING_MODE_ECPM_WITH_CAP,
      ecpmUsd: 5,
      maxFlatFeeUsd: 5000,
    },
    commission: 0,
  },
};

const influencer = {
  influencerId: "test_youtube_outreach_1",
  platform: "youtube",
  username: "testytb_creator",
  displayName: "Test YouTube Creator",
  profileUrl: "https://www.youtube.com/@testytb_creator",
  country: "US",
};

const executionSnapshot = {
  platform: "youtube",
  profileUrl: "https://www.youtube.com/@testytb_creator",
  followers: { count: 25000 },
  analysisSummary:
    "Tech and lifestyle creator with US audience; long-form reviews fit app demos.",
  matchAnalysis: {
    audienceFit: "US-focused viewers aligned with campaign region",
    contentStyle: "YouTube reviews and tutorials",
  },
};

const avgViews = 5300;
const influencerPricing = campaign.campaignInfo.influencerPricing;
const quotedFlatFeeUsd = computeQuotedFlatFeeUsd(avgViews, influencerPricing);

const outreachPricing = {
  pricingMode: influencerPricing.mode,
  ecpmUsd: influencerPricing.ecpmUsd,
  maxFlatFeeUsd: influencerPricing.maxFlatFeeUsd,
  quotedFlatFeeUsd,
  commissionPercent: 0,
  avgViewsUsed: avgViews,
};

function analyzeBody(body) {
  const lower = body.toLowerCase();
  const checks = {
    mentionsYouTube:
      /youtube|yt\b|your channel|your videos/i.test(body) ||
      lower.includes("dedicated video") ||
      lower.includes("ad boost") ||
      lower.includes("heat"),
    mentionsInstagramReel: /instagram reel|ig reel|reel on instagram/i.test(body),
    mentionsTikTok: /\btiktok\b|spark ads/i.test(body),
    mentionsAdCodeInstagram: /ad code.*instagram|instagram.*ad code/i.test(body),
    hasDeliverablesSection: /deliverables\s*:/i.test(body),
  };
  const pass =
    checks.hasDeliverablesSection &&
    checks.mentionsYouTube &&
    !checks.mentionsInstagramReel &&
    !checks.mentionsTikTok &&
    !checks.mentionsAdCodeInstagram;
  return { checks, pass };
}

async function main() {
  console.log("========== 多平台 Deliverables 首封测试 ==========");
  console.log("Campaign 平台: YouTube / Instagram / TikTok");
  console.log("红人平台: YouTube");
  console.log("\n--- campaignInfo.deliverables ---");
  console.log(MULTI_PLATFORM_DELIVERABLES);
  console.log("\n--- 调用 LLM 生成首封正文 ---\n");

  const body = await generateOutreachBodyWithLLM({
    campaign,
    influencer,
    conversationHistory: [],
    executionSnapshot,
    outreachPricing,
    creatorFitContext: {
      analysisSummary: executionSnapshot.analysisSummary,
      matchAnalysis: executionSnapshot.matchAnalysis,
      avgViewsFromSnapshot: avgViews,
      followerCountFromSnapshot: 25000,
    },
  });

  const { checks, pass } = analyzeBody(body);

  console.log("========== 邮件正文 ==========");
  console.log(body);
  console.log("\n========== 自动检查 ==========");
  console.log(JSON.stringify(checks, null, 2));
  console.log(`\n总体: ${pass ? "✅ PASS" : "❌ FAIL（可能仍含其他平台 deliverables 或缺少 YouTube 段）"}`);

  if (!pass) process.exitCode = 1;
}

main().catch((err) => {
  console.error("测试失败:", err?.message || err);
  process.exit(1);
});
