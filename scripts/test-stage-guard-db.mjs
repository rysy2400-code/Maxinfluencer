/**
 * Phase 1 状态机落库测试（需 DB + 已有 execution 行）
 * 运行：node scripts/test-stage-guard-db.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import {
  SQL_EXECUTION_CREATOR_MATCH,
  paramsExecutionCreatorMatch,
} from "../lib/db/campaign-execution-keys.js";
import { spawnSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

async function main() {
  const rows = await queryTikTok(
    `SELECT campaign_id, tiktok_username, stage FROM tiktok_campaign_execution
     WHERE stage = 'quote_submitted' ORDER BY updated_at DESC LIMIT 1`,
    []
  );
  if (!rows?.length) {
    console.log("跳过：无 quote_submitted 行");
    return;
  }

  const { campaign_id: campaignId, tiktok_username: influencerId } = rows[0];

  const ins = await queryTikTok(
    `INSERT INTO tiktok_advertiser_agent_event (campaign_id, influencer_id, event_type, payload, status)
     VALUES (?, ?, 'execution_update_suggested', ?, 'pending')`,
    [
      campaignId,
      influencerId,
      JSON.stringify({
        campaignId,
        influencerId,
        newStage: "pending_sample",
        note: "test illegal jump",
        shippingInfo: { name: "Test User", city: "LA" },
      }),
    ]
  );
  const eventId = ins?.insertId;

  const r = spawnSync("node", ["scripts/process-campaign-agent-events.js"], {
    cwd: projectRoot,
    stdio: "pipe",
    encoding: "utf8",
  });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error("worker 退出非 0");
  }

  const after = await queryTikTok(
    `SELECT stage, shipping_info FROM tiktok_campaign_execution
     WHERE campaign_id = ? AND ${SQL_EXECUTION_CREATOR_MATCH}`,
    [campaignId, ...paramsExecutionCreatorMatch(influencerId)]
  );
  const stage = after[0]?.stage;
  const ship = after[0]?.shipping_info;

  if (stage !== "quote_submitted") {
    throw new Error(`stage 被错误改为 ${stage}，应为 quote_submitted`);
  }

  const shipObj =
    typeof ship === "object" ? ship : ship ? JSON.parse(ship) : null;
  if (!shipObj?.city) {
    throw new Error("shipping_info 未写入");
  }

  await queryTikTok(`DELETE FROM tiktok_advertiser_agent_event WHERE id = ?`, [
    eventId,
  ]);

  console.log("状态机落库测试通过：越权 stage 被拦截，shipping_info 仍写入 ✓");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
