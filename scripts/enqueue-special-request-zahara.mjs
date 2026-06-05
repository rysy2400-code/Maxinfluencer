/**
 * 补发 Heyup Match by Interests → @zaharagrwm1 特殊请求（$590 / 2 条视频）
 *
 * 使用：node scripts/enqueue-special-request-zahara.mjs
 * 可选：node scripts/enqueue-special-request-zahara.mjs --run-worker
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { enqueueAskInfluencerSpecialRequest } from "../lib/execution/special-request-events.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const CAMPAIGN_ID = "CAMP-1780576567873-070YBQ1XI";
const HANDLE = "zaharagrwm1";
const BRAND_MESSAGE =
  "品牌方希望确认：你是否愿意以 $590 USD 的总价制作 2 条 TikTok 视频（而非原先讨论的 1 条）？如可以接受或希望 counter，请告知。";

async function main() {
  const runWorker = process.argv.includes("--run-worker");

  const result = await enqueueAskInfluencerSpecialRequest({
    campaignId: CAMPAIGN_ID,
    influencerHandle: HANDLE,
    requestType: "adjust_price",
    brandMessage: BRAND_MESSAGE,
  });

  console.log("[enqueue-special-request-zahara] 已写入 tiktok_influencer_agent_event");
  console.log("  campaignId:", CAMPAIGN_ID);
  console.log("  handle:", HANDLE);
  console.log("  platformInfluencerId:", result.platformInfluencerId);
  console.log("  specialRequestId:", result.specialRequestId);
  console.log("  eventId:", result.eventId);

  if (runWorker) {
    console.log("\n[enqueue-special-request-zahara] 运行 process-influencer-agent-events.js …");
    const r = spawnSync("node", ["scripts/process-influencer-agent-events.js"], {
      cwd: projectRoot,
      stdio: "inherit",
      env: process.env,
    });
    process.exit(r.status ?? 1);
  }

  console.log("\n请运行: node scripts/process-influencer-agent-events.js");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
