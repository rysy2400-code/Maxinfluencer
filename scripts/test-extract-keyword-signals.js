/**
 * 验证推荐红人 #tag / @mention 规则提取。
 * 用法: node scripts/test-extract-keyword-signals.js
 */
import { extractKeywordSignalsFromInfluencer } from "../lib/influencer/extract-keyword-signals.js";

const influencer = {
  isRecommended: true,
  username: "poolcreator",
  platform: "tiktok",
  profile_data: {
    videos: [
      { description: "Best pool hack #SaltWaterPool @beatbot #fyp", hashtags: ["#fyp"] },
      { caption: "Cleaning day #poolmaintenance @DolphinPool", mentions: ["@DolphinPool"] },
    ],
  },
};

const productInfo = { brandName: "MyBrand", productName: "MyBrand Pro" };

const { hashtags, mentions } = extractKeywordSignalsFromInfluencer(influencer, productInfo);

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

assert(hashtags.includes("#saltwaterpool"), "expected #saltwaterpool");
assert(hashtags.includes("#poolmaintenance"), "expected #poolmaintenance");
assert(!hashtags.includes("#fyp"), "noise #fyp should be filtered");
assert(mentions.includes("@beatbot"), "expected @beatbot");
assert(mentions.includes("@DolphinPool"), "expected @DolphinPool");

console.log("✅ extract-keyword-signals:", { hashtags, mentions });
