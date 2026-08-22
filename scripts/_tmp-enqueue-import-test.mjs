#!/usr/bin/env node
/**
 * 为 CAMP-1785176721239-KCL1TS2PZ（meetwhale Echo Mini 学生）投递 2 个测试导入任务：
 * 模式1 = 附件 Excel 导入（sourceFileName）
 * 模式2 = 消息正文链接导入（rowsFromTextItems 真实解析路径）
 * 红人：https://www.tiktok.com/@carolinemaeve
 */
import dotenv from "dotenv";
dotenv.config({ path: "C:\\maxinfluencer\\.env.local" });
dotenv.config({ path: "C:\\maxinfluencer\\.env" });
const { queryTikTok, tiktokPool } = await import("../lib/db/mysql-tiktok.js");
const { createImportTask } = await import("../lib/db/influencer-import-task-dao.js");
const { rowsFromTextItems } = await import("../lib/influencer/apply-extraction-plan.js");

const CAMPAIGN_ID = "CAMP-1785176721239-KCL1TS2PZ";
const SESSION_ID = "e4ff0382-99f8-4b8f-943d-1ded0ac07f0c";
const URL = "https://www.tiktok.com/@carolinemaeve";

// 模式2：正文链接（真实解析路径 rowsFromTextItems）
const parsedText = rowsFromTextItems(
  [{ profileUrl: URL, evidence: "test-mode2-text" }],
  { maxItems: 10 }
);
console.log("TEXT_PARSE", JSON.stringify(parsedText));
const mode2Rows = (parsedText.rows || []).map((r) => ({ ...r }));

// 模式1：附件解析输出（模拟 xlsx 行结构）
const mode1Rows = [
  {
    username: "carolinemaeve",
    profileUrl: URL,
    platform: "tiktok",
    email: null,
    source: "attachment",
  },
];

const ts = Date.now();
const id1 = await createImportTask({
  campaignId: CAMPAIGN_ID,
  sessionId: SESSION_ID,
  importBatchId: `IMP-TEST-${ts}-mode1-xlsx`,
  platform: "tiktok",
  priority: 150,
  payload: { rows: mode1Rows, importBatchId: `IMP-TEST-${ts}-mode1-xlsx` },
  totalRows: mode1Rows.length,
  sourceFileName: "test-import-mode1.xlsx",
  sourceFileStorageKey: null,
});
const id2 = await createImportTask({
  campaignId: CAMPAIGN_ID,
  sessionId: SESSION_ID,
  importBatchId: `IMP-TEST-${ts}-mode2-text`,
  platform: "tiktok",
  priority: 150,
  payload: { rows: mode2Rows, importBatchId: `IMP-TEST-${ts}-mode2-text` },
  totalRows: mode2Rows.length,
  sourceFileName: null,
  sourceFileStorageKey: null,
});
console.log("CREATED", JSON.stringify({ id1, id2, mode2Rows }));
await tiktokPool.end();
process.exit(0);
