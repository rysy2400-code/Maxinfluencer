/**
 * 单个红人主页提取（Playwright + CDP），并将 TikTok userId/secUid 写入 tiktok_influencer
 *
 * 前置：先启动带远程调试端口的 Chrome（9223）
 *   bash scripts/launch-chrome-remote-debug-enrich.sh
 *
 * 使用：
 *   CDP_ENDPOINT_ENRICH=http://127.0.0.1:9223 node scripts/enrich-one-tiktok-profile.js iamlonni7
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { extractUserProfileFromPageCDP } from "../lib/tools/influencer-functions/extract-user-profile-cdp.js";
import { saveTikTokInfluencer } from "../lib/db/tiktok-influencer-dao.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

async function main() {
  const username = (process.argv[2] || "").replace(/^@/, "").trim();
  if (!username) {
    console.error("用法: node scripts/enrich-one-tiktok-profile.js <username>");
    process.exit(1);
  }

  const endpoint =
    process.env.CDP_ENDPOINT_ENRICH ||
    process.env.CDP_ENDPOINT ||
    "http://127.0.0.1:9223";

  const browser = await chromium.connectOverCDP(endpoint, { timeout: 10000 });
  const contexts = browser.contexts();
  const context = contexts.length ? contexts[0] : await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`https://www.tiktok.com/@${username}`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    const profileData = await extractUserProfileFromPageCDP(page, username, {
      humanLikeBehavior: true,
    });

    console.log("[enrich-one] extracted:", {
      success: profileData?.success,
      userId: profileData?.userInfo?.userId || null,
      secUid: profileData?.userInfo?.secUid || null,
      uniqueId: profileData?.userInfo?.username || username,
      displayName: profileData?.userInfo?.displayName || null,
    });

    if (!profileData?.success) {
      process.exit(2);
    }

    const dbInfluencer = {
      username: (profileData.userInfo?.username || username).replace(/^@/, ""),
      displayName: profileData.userInfo?.displayName || username,
      profileUrl: `https://www.tiktok.com/@${profileData.userInfo?.username || username}`,
      avatarUrl: profileData.userInfo?.avatarUrl || "",
      bio: profileData.userInfo?.bio || "",
      verified: profileData.userInfo?.verified || false,
      tiktokUserId: profileData.userInfo?.userId || null,
      tiktokSecUid: profileData.userInfo?.secUid || null,
      followers: profileData.userInfo?.followers || { count: 0, display: "0" },
      views: { avg: profileData.statistics?.avgViews || 0, display: "0" },
      engagement: {
        rate: 0,
        avgLikes: profileData.statistics?.avgLikes || 0,
        avgComments: profileData.statistics?.avgComments || 0,
      },
      following: profileData.userInfo?.following?.count || null,
      postsCount: profileData.userInfo?.postsCount?.count || null,
      country: "",
      accountType: "",
      accountTypes: [],
      profile_data: profileData,
    };

    const save = await saveTikTokInfluencer(dbInfluencer, { updateProfileOnly: true });
    console.log("[enrich-one] saved:", save);
  } finally {
    try {
      await page.close();
    } catch {}
    try {
      await browser.close();
    } catch {}
  }
}

main().catch((err) => {
  console.error("❌ enrich-one failed:", err?.message || err);
  process.exit(1);
});

