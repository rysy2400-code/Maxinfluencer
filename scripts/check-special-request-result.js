/**
 * 检查特殊请求测试结果：tiktok_advertiser_agent_event 中是否有 creator_replied_special_request
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

async function main() {
  const rows = await queryTikTok(
    `SELECT id, campaign_id, influencer_id, event_type, payload, status, created_at
     FROM tiktok_advertiser_agent_event
     WHERE event_type = 'creator_replied_special_request'
     ORDER BY id DESC
     LIMIT 5`,
    []
  );
  console.log("creator_replied_special_request 事件：");
  console.log(JSON.stringify(rows || [], null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
