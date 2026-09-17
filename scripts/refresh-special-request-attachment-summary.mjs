// 为已发出的「特殊请求 · 待您决策」消息补上红人附件的**内容摘要**。
//
// 场景：pdf-parse 版本问题导致收件 PDF 全部解析失败，摘要里写着
// 「PDF 解析失败无法自动提取内容」。解析修好后用本脚本回填一条。
//
// 行为：
// 1. 按 sourceEventId 读出红人附件，用 lib/influencer/extract-attachment-text.js 抽文字；
// 2. 交给 LLM 产出中文要点摘要（只依据抽取到的原文，不编造）；
// 3. 把摘要追加到对应 Bin 消息末尾，并替换掉「PDF 解析失败…」这句过时描述。
//
// 用法：
//   node scripts/refresh-special-request-attachment-summary.mjs --handle pedrohdarico --dry-run
//   node scripts/refresh-special-request-attachment-summary.mjs --handle pedrohdarico --apply
//
// 参数：
//   --handle <handle>  指定红人（可多个，逗号分隔）；缺省处理全部
//   --event <id>       只处理指定的 advertiser agent event id
//   --dry-run          仅预览（默认）
//   --apply            真正写库

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import {
  getCampaignSessionById,
  updateCampaignSession,
} from "../lib/db/campaign-session-dao.js";
import { listInboundAttachmentsByEmailEventId } from "../lib/db/influencer-inbound-attachments-dao.js";
import { extractAttachmentText } from "../lib/influencer/extract-attachment-text.js";
import { isHiddenInboundAttachment } from "../lib/influencer/inbound-attachment-urls.js";
import { callDeepSeekLLM } from "../lib/utils/llm-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const LOG = "[refresh-special-request-summary]";
const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const dryRun = !apply || argv.includes("--dry-run");

function argValue(flag) {
  const idx = argv.indexOf(flag);
  return idx < 0 ? null : argv[idx + 1] || null;
}

const handleFilter = String(argValue("--handle") || "")
  .split(",")
  .map((s) => s.trim().replace(/^@/, "").toLowerCase())
  .filter(Boolean);
const eventFilter = Number(argValue("--event")) || null;

// 旧摘要里这句是解析失败时的兜底描述，补写后应替换掉。
const STALE_CLAUSE =
  "PDF 解析失败无法自动提取内容，需广告主查看媒体资料后决定是否接受，或由我方继续追问。";

const MAX_CHARS_PER_ATTACHMENT = 12000;

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isSpecialRequestBinMessage(msg) {
  if (!msg || msg.role !== "assistant") return false;
  const content = String(msg.content || "");
  return (
    content.includes("【特殊请求 · 待您决策】") ||
    content.includes("【特殊请求已达成一致】") ||
    content.includes("【特殊请求 · 请补充交付要求】")
  );
}

function findMatchingMessageIndex(messages, { creatorMessage, note }) {
  if (!Array.isArray(messages) || !messages.length) return -1;
  const creator = String(creatorMessage || "").trim();
  const noteText = String(note || "").trim();
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!isSpecialRequestBinMessage(msg)) continue;
    const content = String(msg.content || "");
    if (creator && content.includes(`红人回复：${creator}`)) return i;
    if (noteText.length >= 12) {
      if (content.includes(`执行侧摘要：${noteText}`)) return i;
      const snippet = noteText.slice(0, Math.min(48, noteText.length));
      if (snippet.length >= 12 && content.includes(snippet)) return i;
    }
  }
  return -1;
}

async function fetchTargetEvents() {
  const rows = await queryTikTok(
    `
    SELECT
      e.id AS event_id,
      e.campaign_id,
      e.influencer_id,
      e.payload,
      c.session_id,
      c.status AS campaign_status
    FROM tiktok_advertiser_agent_event e
    INNER JOIN tiktok_campaign c ON c.id = e.campaign_id
    WHERE e.event_type = 'creator_replied_special_request'
      AND e.status = 'succeeded'
      AND c.session_id IS NOT NULL
      AND TRIM(c.session_id) <> ''
    ORDER BY e.id ASC
  `,
    []
  );
  return rows || [];
}

async function loadAttachmentTexts(items) {
  const texts = [];
  for (const att of items) {
    if (isHiddenInboundAttachment(att.contentType)) continue;
    const rows = await queryTikTok(
      "SELECT id, filename, content_type, content FROM tiktok_influencer_email_event_attachments WHERE id = ? LIMIT 1",
      [att.inboundAttachmentId]
    );
    const row = rows?.[0];
    if (!row) continue;
    const extracted = await extractAttachmentText({
      content_type: row.content_type,
      filename: row.filename,
      content: Buffer.isBuffer(row.content)
        ? row.content
        : Buffer.from(row.content || []),
    });
    if (!extracted?.text || String(extracted.kind).endsWith("_error")) {
      console.log(
        `  ${LOG} 跳过附件 ${row.id}（${row.filename}）：${
          extracted?.text || "无可抽取文本"
        }`
      );
      continue;
    }
    texts.push({
      filename: row.filename || `附件 ${row.id}`,
      contentKind: extracted.kind,
      text: extracted.text.slice(0, MAX_CHARS_PER_ATTACHMENT),
    });
  }
  return texts;
}

async function summarizeAttachments(items) {
  const texts = await loadAttachmentTexts(items);
  if (!texts.length) return null;

  const payload = texts
    .map((t) => `【附件：${t.filename}】（类型：${t.contentKind}）\n${t.text}`)
    .join("\n\n---\n\n");

  const prompt = [
    "以下是红人发来的邮件附件原文（可能是媒体资料、报价单或案例）。请用简体中文写一段简洁摘要，供广告主决策参考。",
    "",
    "要求：",
    "- 只依据原文内容，禁止编造或推测原文没有的数字与承诺；",
    "- 3-6 条要点，用「- 」开头，覆盖：红人/账号定位、受众或地区数据、可提供的合作形式与报价（如有）、其他对决策有用的信息；",
    "- 直接输出摘要，不要开场白、不要 markdown 标题、不要解释。",
    "",
    "附件原文：",
    payload,
  ].join("\n");

  const raw = await callDeepSeekLLM([{ role: "user", content: prompt }], null, {
    maxTokens: 1200,
  });

  const summary = String(raw || "").trim();
  if (!summary) return null;
  return { summary, files: texts.map((t) => t.filename) };
}

async function main() {
  const events = await fetchTargetEvents();
  console.log(`${LOG} 目标事件数: ${events.length}`);
  if (handleFilter.length) {
    console.log(`${LOG} handle 过滤: ${handleFilter.join(", ")}`);
  }
  if (eventFilter) console.log(`${LOG} event 过滤: ${eventFilter}`);
  console.log(`${LOG} ${dryRun ? "DRY RUN —— 不会写库" : "APPLY —— 会写库"}`);

  const sessionCache = new Map();
  const doneSessions = new Set();
  let patched = 0;
  let skipped = 0;

  for (const row of events) {
    if (eventFilter && Number(row.event_id) !== eventFilter) continue;
    const payload = parseJson(row.payload) || {};

    if (handleFilter.length) {
      const handle = String(payload.tiktokUsername || payload.influencerId || "")
        .replace(/^@/, "")
        .toLowerCase();
      if (!handleFilter.includes(handle)) continue;
    }

    const sourceEventId =
      payload.sourceEventId != null ? Number(payload.sourceEventId) : null;
    if (!sourceEventId) continue;

    const sessionId = row.session_id;
    if (doneSessions.has(sessionId)) {
      skipped++;
      continue;
    }

    const attachments = (
      await listInboundAttachmentsByEmailEventId(sourceEventId)
    ).filter((a) => !isHiddenInboundAttachment(a.contentType));
    if (!attachments.length) continue;

    let session = sessionCache.get(sessionId);
    if (!session) {
      const loaded = await getCampaignSessionById(sessionId);
      if (!loaded) continue;
      session = {
        ...loaded,
        messages: Array.isArray(loaded.messages) ? [...loaded.messages] : [],
        dirty: false,
      };
      sessionCache.set(sessionId, session);
    }

    const msgIndex = findMatchingMessageIndex(session.messages, {
      creatorMessage: payload.creatorMessage,
      note: payload.note,
    });
    if (msgIndex < 0) {
      console.log(`  SKIP event ${row.event_id}: 未匹配到 Bin 消息`);
      skipped++;
      continue;
    }

    const oldContent = String(session.messages[msgIndex].content || "");
    if (oldContent.includes("【附件内容摘要】")) {
      console.log(`  SKIP event ${row.event_id}: 已有附件摘要`);
      skipped++;
      continue;
    }

    const result = await summarizeAttachments(attachments);
    if (!result) {
      console.log(`  SKIP event ${row.event_id}: 附件无可抽取文本`);
      skipped++;
      continue;
    }

    const block = `\n\n【附件内容摘要】${result.files.join("、")}\n${result.summary}`;
    let newContent = oldContent;
    if (newContent.includes(STALE_CLAUSE)) {
      newContent = newContent.replace(
        STALE_CLAUSE,
        "媒体资料内容已解析，要点见下方【附件内容摘要】。"
      );
    }
    newContent += block;

    console.log(`\n  PATCH event ${row.event_id} campaign=${row.campaign_id}`);
    console.log(
      block
        .split("\n")
        .map((l) => `  | ${l}`)
        .join("\n")
    );

    session.messages[msgIndex] = {
      ...session.messages[msgIndex],
      content: newContent,
    };
    session.dirty = true;
    doneSessions.add(sessionId);
    patched++;
  }

  for (const [sessionId, cached] of sessionCache.entries()) {
    if (!cached.dirty) continue;
    if (dryRun) {
      console.log(`\n  WOULD SAVE session ${sessionId}`);
      continue;
    }
    const res = await updateCampaignSession(sessionId, {
      messages: cached.messages,
    });
    console.log(
      `\n  ${res.success ? "SAVED" : "FAIL"} session ${sessionId}${
        res.success ? "" : " " + res.message
      }`
    );
  }

  console.log(`\n${LOG} 完成：patched=${patched} skipped=${skipped}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`${LOG} 失败:`, err);
    process.exit(1);
  });
