/**
 * 检查 tiktok_campaign_execution：平台 influencer_id 是否在主档存在且含可用邮箱。
 * 用法：node scripts/check-execution-influencer-main.mjs [CAMP-xxx 可选，省略则全表]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const campaignFilter = process.argv[2] || null;

function hasUsableEmail(row) {
  const e = row?.influencer_email;
  return typeof e === "string" && e.includes("@");
}

async function main() {
  const where = campaignFilter ? "WHERE e.campaign_id = ?" : "";
  const params = campaignFilter ? [campaignFilter] : [];
  const rows = await queryTikTok(
    `
    SELECT
      e.campaign_id,
      e.tiktok_username,
      e.influencer_id AS platform_influencer_id,
      i.influencer_id AS main_influencer_id,
      i.influencer_email
    FROM tiktok_campaign_execution e
    LEFT JOIN tiktok_influencer i ON i.influencer_id = e.influencer_id
    ${where}
    ORDER BY e.campaign_id, e.tiktok_username
  `,
    params
  );

  const list = rows || [];
  const missingMain = list.filter((r) => !r.main_influencer_id);
  const missingEmail = list.filter(
    (r) => r.main_influencer_id && !hasUsableEmail(r)
  );
  const ok = list.filter((r) => r.main_influencer_id && hasUsableEmail(r));

  console.log(
    JSON.stringify(
      {
        campaignFilter: campaignFilter || "(all)",
        totalRows: list.length,
        okCount: ok.length,
        missingMainRowCount: missingMain.length,
        missingEmailCount: missingEmail.length,
        missingMainSample: missingMain.slice(0, 20).map((r) => ({
          campaign_id: r.campaign_id,
          tiktok_username: r.tiktok_username,
          platform_influencer_id: r.platform_influencer_id,
        })),
        missingEmailSample: missingEmail.slice(0, 20).map((r) => ({
          campaign_id: r.campaign_id,
          tiktok_username: r.tiktok_username,
          platform_influencer_id: r.platform_influencer_id,
          influencer_email: r.influencer_email,
        })),
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
