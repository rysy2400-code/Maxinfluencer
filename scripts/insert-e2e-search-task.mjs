/**
 * One-off: enqueue a high-priority search task for work-live E2E (Beatbot).
 * Usage: node scripts/insert-e2e-search-task.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const campaignId = "CAMP-1776833098120-12TV80JPW";
const sessionId = "8c1f433d-80ed-4da5-94fe-1939174503f4";
const marker = `e2e-${Date.now()}`;
const payload = {
  trigger: "manual_e2e_worklive",
  targetBatchSize: 2,
  userMessage: "Beatbot pool cleaner creators — e2e validation",
  validationMarker: marker,
  createdAt: new Date().toISOString(),
};

const r = await queryTikTok(
  `INSERT INTO tiktok_influencer_search_task (campaign_id, session_id, priority, payload, status)
   VALUES (?, ?, 1000, ?, 'pending')`,
  [campaignId, sessionId, JSON.stringify(payload)]
);

console.log(JSON.stringify({ ok: true, insertId: r.insertId, marker }));
