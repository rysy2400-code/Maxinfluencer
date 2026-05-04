/**
 * 模块3 DAO级测试脚本（不依赖 Next server）
 *
 * 用法:
 *   node scripts/test-timeline-api.js [influencerId]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import {
  listActiveCampaignCards,
  listTimelineEvents,
} from "../lib/db/influencer-timeline-dao.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

async function main() {
  const influencerId = process.argv[2] || "test_rysy_1";

  console.log("========== timeline api dao test ==========");
  console.log("influencerId:", influencerId);

  const firstPage = await listTimelineEvents({
    influencerId,
    limit: 5,
    debug: false,
  });
  console.log("\n[timeline page1]");
  console.log("items:", firstPage.items.length);
  console.log("hasMore:", firstPage.hasMore);
  console.log("nextCursor:", firstPage.nextCursor ? "yes" : "no");
  if (firstPage.items[0]) {
    console.log("latest event:", {
      id: firstPage.items[0].id,
      eventType: firstPage.items[0].eventType,
      actorType: firstPage.items[0].actorType,
      eventTime: firstPage.items[0].eventTime,
    });
  }

  if (firstPage.nextCursor) {
    const secondPage = await listTimelineEvents({
      influencerId,
      limit: 5,
      cursor: firstPage.nextCursor,
      debug: false,
    });
    console.log("\n[timeline page2]");
    console.log("items:", secondPage.items.length);
    console.log("hasMore:", secondPage.hasMore);
  }

  const inboundOnly = await listTimelineEvents({
    influencerId,
    limit: 5,
    eventTypes: "email_inbound",
  });
  console.log("\n[timeline filter=email_inbound]");
  console.log("items:", inboundOnly.items.length);

  const cards = await listActiveCampaignCards({ influencerId, limit: 10 });
  console.log("\n[active-campaigns]");
  console.log("count:", cards.length);
  if (cards[0]) {
    console.log("sample:", cards[0]);
  }

  console.log("\n========== done ==========");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[test-timeline-api] failed:", err?.message || err);
    process.exit(1);
  });

