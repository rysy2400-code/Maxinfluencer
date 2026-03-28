/**
 * 迁移脚本：将 TikTok 红人的 influencer_id 统一回填为 tiktok_user_id（数字 userId 字符串）
 *
 * 同步更新引用表的 influencer_id：
 * - tiktok_campaign_execution
 * - tiktok_campaign_influencer_candidates
 * - tiktok_influencer_email_events
 *
 * 使用方式：
 *   node scripts/migrate-influencer-id-to-tiktok-user-id.js
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const REF_TABLES = [
  "tiktok_campaign_execution",
  "tiktok_campaign_influencer_candidates",
  "tiktok_influencer_email_events",
];

async function main() {
  const mappings =
    (await queryTikTok(
      `
      SELECT influencer_id AS old_id, tiktok_user_id AS new_id, username
      FROM tiktok_influencer
      WHERE platform = 'tiktok'
        AND tiktok_user_id IS NOT NULL
        AND influencer_id IS NOT NULL
        AND influencer_id <> tiktok_user_id
    `,
      []
    )) || [];

  if (!mappings.length) {
    console.log(
      "[migrate-influencer-id] 没有需要迁移的记录（influencer_id 已等于 tiktok_user_id 或 tiktok_user_id 为空）。"
    );
    return;
  }

  let updated = 0;
  let skipped = 0;

  for (const m of mappings) {
    const oldId = String(m.old_id);
    const newId = String(m.new_id);

    // 若已存在 influencer_id = newId 的其它记录，先跳过避免冲突
    const conflict = await queryTikTok(
      `
      SELECT COUNT(*) AS n
      FROM tiktok_influencer
      WHERE influencer_id = ?
        AND influencer_id <> ?
    `,
      [newId, oldId]
    );
    if (conflict && Number(conflict[0]?.n || 0) > 0) {
      console.warn(
        "[migrate-influencer-id] 冲突，跳过：",
        { oldId, newId, username: m.username }
      );
      skipped++;
      continue;
    }

    for (const t of REF_TABLES) {
      await queryTikTok(`UPDATE ${t} SET influencer_id = ? WHERE influencer_id = ?`, [
        newId,
        oldId,
      ]);
    }

    await queryTikTok(
      `UPDATE tiktok_influencer SET influencer_id = ? WHERE influencer_id = ?`,
      [newId, oldId]
    );

    updated++;
  }

  console.log("[migrate-influencer-id] 完成：", { updated, skipped, total: mappings.length });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ migrate-influencer-id 失败:", err?.message || err);
    process.exit(1);
  });

