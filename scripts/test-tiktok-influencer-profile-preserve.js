/**
 * 回归测试：搜索阶段轻量 upsert 不应清空主页 enrich 写入的 profile_data。
 * 用法: node scripts/test-tiktok-influencer-profile-preserve.js
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok, tiktokPool } from "../lib/db/mysql-tiktok.js";
import {
  saveTikTokInfluencer,
  saveTikTokInfluencers,
} from "../lib/db/tiktok-influencer-dao.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const suffix = Date.now();
const username = `yt_profile_preserve_${suffix}`;
const influencerId = `UC_TEST_PROFILE_${suffix}`;

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

async function cleanup() {
  await queryTikTok(
    `DELETE FROM tiktok_influencer WHERE username = ? OR influencer_id = ?`,
    [username, influencerId]
  );
}

async function main() {
  await cleanup();

  const profileSave = await saveTikTokInfluencer(
    {
      username,
      platform: "youtube",
      influencerId,
      tiktokUserId: influencerId,
      displayName: username,
      profileUrl: `https://www.youtube.com/@${username}`,
      profile_data: {
        success: true,
        userInfo: { userId: influencerId, displayName: username },
        videos: [{ videoId: "v1", description: "#fromprofile" }],
      },
    },
    { updateProfileOnly: true, skipGlobalEmailSync: true }
  );
  assert(profileSave.success, `profile save failed: ${profileSave.message}`);

  const searchSave = await saveTikTokInfluencers(
    [
      {
        username,
        platform: "YouTube",
        influencerId,
        tiktokUserId: influencerId,
        displayName: username,
        profileUrl: `https://www.youtube.com/@${username}`,
        search_video_data: [{ videoId: "sv1", description: "#fromsearch" }],
      },
    ],
    { skipGlobalEmailSync: true }
  );
  assert(searchSave.success === 1, "search upsert should succeed");

  const rows = await queryTikTok(
    `
    SELECT
      platform,
      JSON_LENGTH(JSON_EXTRACT(profile_data, '$.videos')) AS videos_len,
      JSON_UNQUOTE(JSON_EXTRACT(profile_data, '$.videos[0].description')) AS first_desc,
      JSON_LENGTH(search_video_data) AS search_videos_len
    FROM tiktok_influencer
    WHERE influencer_id = ?
    LIMIT 1
  `,
    [influencerId]
  );

  const row = rows?.[0];
  assert(row, "saved influencer row not found");
  assert(row.platform === "youtube", `platform should be youtube, got ${row.platform}`);
  assert(Number(row.videos_len) === 1, "profile_data.videos should be preserved");
  assert(row.first_desc === "#fromprofile", "profile video payload should remain");
  assert(Number(row.search_videos_len) === 1, "search_video_data should be updated");

  await cleanup();
  console.log("✅ tiktok influencer profile preserve test passed");
  await tiktokPool.end();
}

main().catch(async (err) => {
  try {
    await cleanup();
  } catch {
    /* ignore */
  }
  console.error("❌", err?.message || err);
  try {
    await tiktokPool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
