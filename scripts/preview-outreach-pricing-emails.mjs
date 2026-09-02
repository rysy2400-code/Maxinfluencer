#!/usr/bin/env node
/**
 * 本地预览三种单位红人报价策略的首封邀约邮件正文（只调用 LLM 生成，不发送、不写库）。
 * 用法: node scripts/preview-outreach-pricing-emails.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { generateOutreachBodyWithLLM } from "../lib/agents/influencer-agent.js";
import {
  PRICING_MODE_ASK_CREATOR_QUOTE,
  PRICING_MODE_COMMISSION_ONLY,
  PRICING_MODE_ECPM_WITH_CAP,
  computeQuotedFlatFeeUsd,
  normalizeInfluencerPricing,
} from "../lib/campaign/influencer-pricing.js";
import { avgViewsFromSnapshot } from "../lib/db/campaign-candidates-dao.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const AVG_VIEWS = 100000;

function followerCountFromSnapshot(s) {
  const f = s?.followers;
  if (typeof f === "number" && Number.isFinite(f)) return f;
  if (f && typeof f.count === "number" && Number.isFinite(f.count)) return f.count;
  return null;
}

function buildCreatorFitContext(executionSnapshot) {
  if (!executionSnapshot || typeof executionSnapshot !== "object") return null;
  const ma = executionSnapshot.matchAnalysis;
  const summaryRaw =
    typeof executionSnapshot.analysisSummary === "string"
      ? executionSnapshot.analysisSummary.trim()
      : "";
  const summary = summaryRaw || null;
  const hasMa =
    ma &&
    typeof ma === "object" &&
    !Array.isArray(ma) &&
    Object.keys(ma).length > 0;
  const views = avgViewsFromSnapshot(executionSnapshot);
  const followers = followerCountFromSnapshot(executionSnapshot);
  if (!summary && !hasMa && views == null && followers == null) return null;
  return {
    analysisSummary: summary,
    matchAnalysis: hasMa ? ma : null,
    avgViewsFromSnapshot: views,
    followerCountFromSnapshot: followers,
  };
}

const influencer = {
  influencerId: "e2e_pricing_test_1",
  platform: "tiktok",
  username: "e2e_pricing_creator",
  displayName: "E2E Pricing Test",
  profileUrl: "https://www.tiktok.com/@e2e_pricing_creator",
  country: "US",
};

const executionSnapshot = {
  influencerId: "e2e_pricing_test_1",
  username: "e2e_pricing_creator",
  displayName: "E2E Pricing Test",
  platform: "tiktok",
  profileUrl: "https://www.tiktok.com/@e2e_pricing_creator",
  views: { avg: AVG_VIEWS, display: "100K" },
  followers: { count: 50000 },
  analysisSummary:
    "Tech and lifestyle creator with consistent 100K average views; strong fit for app demos.",
  matchAnalysis: {
    audienceFit: "Relevant audience for E2E Product demos",
    contentStyle: "Short-form TikTok videos with product showcases",
  },
};

const scenarios = [
  {
    label: "策略 A — eCPM=$3，上限 $1000",
    mode: PRICING_MODE_ECPM_WITH_CAP,
    ecpmUsd: 3,
    maxFlatFeeUsd: 1000,
    commission: 15,
  },
  {
    label: "策略 B — 无固定费用，仅佣金 20%",
    mode: PRICING_MODE_COMMISSION_ONLY,
    ecpmUsd: null,
    maxFlatFeeUsd: null,
    commission: 20,
  },
  {
    label: "策略 C — 不主动报价，询问红人合作价格",
    mode: PRICING_MODE_ASK_CREATOR_QUOTE,
    ecpmUsd: null,
    maxFlatFeeUsd: null,
    commission: 0,
  },
];

async function main() {
  for (const sc of scenarios) {
    const campaign = {
      id: "PREVIEW-CAMP",
      commissionPercent: null,
      productInfo: {
        brandName: "E2E Brand",
        productName: "E2E Product",
        productLink: "https://example.com/e2e-product",
      },
      influencerProfile: {},
      contentScript: {},
      campaignInfo: {
        platform: "TikTok",
        region: "美国",
        publishTimeRange: "2026-09-01 至 2026-09-30",
        budget: 50000,
        commission: sc.commission,
        influencerPricing: {
          mode: sc.mode,
          ecpmUsd: sc.ecpmUsd,
          maxFlatFeeUsd: sc.maxFlatFeeUsd,
        },
        deliverables: "1条专属视频\n发布前需分享草稿供确认",
      },
    };

    const pricing = normalizeInfluencerPricing(
      campaign.campaignInfo.influencerPricing
    );
    const quotedFlatFeeUsd = computeQuotedFlatFeeUsd(AVG_VIEWS, pricing);
    const outreachPricing = {
      pricingMode: pricing.mode,
      ecpmUsd: pricing.ecpmUsd,
      maxFlatFeeUsd: pricing.maxFlatFeeUsd,
      quotedFlatFeeUsd,
      commissionPercent: sc.commission,
      avgViewsUsed: AVG_VIEWS,
      rule:
        pricing.mode === PRICING_MODE_ASK_CREATOR_QUOTE
          ? "ask_creator_quote: no flat fee in outreach, request creator's rate"
          : pricing.mode === PRICING_MODE_COMMISSION_ONLY
            ? sc.commission === 0
              ? "commission_only: pure product exchange (0% commission, no flat fee)"
              : "commission_only: no flat fee in outreach"
            : `ecpm_with_cap: flat_fee = min(round10(avg_views/1000*${pricing.ecpmUsd}), ${pricing.maxFlatFeeUsd})`,
    };

    const body = await generateOutreachBodyWithLLM({
      campaign,
      influencer,
      conversationHistory: [],
      executionSnapshot,
      outreachPricing,
      creatorFitContext: buildCreatorFitContext(executionSnapshot),
    });

    console.log(`\n========== ${sc.label} ==========\n`);
    console.log(body);
    console.log("\n========================================\n");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ 预览失败:", err?.message || err);
    process.exit(1);
  });
