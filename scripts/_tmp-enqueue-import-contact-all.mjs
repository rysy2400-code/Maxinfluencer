#!/usr/bin/env node
/**
 * 复刻真实任务 id 74：carolinemaeve + contactMode=contact_all（直接联系模式）
 */
import dotenv from "dotenv";
dotenv.config({ path: "C:\\maxinfluencer\\.env.local" });
dotenv.config({ path: "C:\\maxinfluencer\\.env" });
const { queryTikTok, tiktokPool } = await import("../lib/db/mysql-tiktok.js");
const { createImportTask } = await import("../lib/db/influencer-import-task-dao.js");

const CAMPAIGN_ID = "CAMP-1785176721239-KCL1TS2PZ";
const SESSION_ID = "e4ff0382-99f8-4b8f-943d-1ded0ac07f0c";
const ts = Date.now();
const importBatchId = `IMP-TEST-${ts}-contact-all`;
const taskId = await createImportTask({
  campaignId: CAMPAIGN_ID,
  sessionId: SESSION_ID,
  importBatchId,
  platform: "tiktok",
  priority: 150,
  payload: {
    rows: [
      {
        email: null,
        platform: "TikTok",
        username: "carolinemaeve",
        profileUrl: "https://www.tiktok.com/@carolinemaeve",
        platformSlug: "tiktok",
      },
    ],
    sources: ["消息正文"],
    trigger: "user_list_import",
    platform: "tiktok",
    batchType: "split_platform",
    contactMode: "contact_all",
    importBatchId,
    parseErrorSample: [],
  },
  totalRows: 1,
});
console.log("CREATED", JSON.stringify({ taskId, importBatchId }));
await tiktokPool.end();
process.exit(0);
