/**
 * 待报价（pending_quote）红人「合作跟进」一次性运维脚本。
 *
 * 对指定 campaign 中满足以下条件的红人再发一封简短跟进邮件（询问是否愿意合作）：
 *   pending_quote ∧ 已发首封 ∧ 未回信 ∧ 可联系 ∧ 有邮箱 ∧ 本 campaign 尚无跟进
 *
 * 与首封邀约一致的发信规则：
 *   - 发件箱：从「首封邀约发信池」里选，严格遵守池的 20–40 分钟冷却
 *     （统一走 pickOutboundAccountForNewOutreach()，与 Worker 的首封共用
 *      op_contacts.last_send_date 原子门槛，互相不撞箱）；
 *   - 标题/线程：沿用该红人原始邮件的主题与线程（Re: <原主题> + In-Reply-To + References）；
 *   - 回信兜底：Reply-To = bin@binfluencer.xyz（红人回复统一回到品牌信箱，和首封一致）。
 *
 * 用法：
 *   node scripts/send-followup-pending-quote.mjs --dry-run                 # 只算名单/抽样正文，不发信
 *   node scripts/send-followup-pending-quote.mjs                           # 正式发送（可断点续跑）
 *   node scripts/send-followup-pending-quote.mjs --limit 20                # 只处理前 20 个（测试）
 *   node scripts/send-followup-pending-quote.mjs --campaigns CAMP-xxx      # 限定 campaign（默认 CapCut 优先 + VAST）
 *
 * 环境变量：FOLLOWUP_CONCURRENCY（默认 10）控制并行发件数。
 * 运行期状态：tmp/followup-pending-quote/<campaignId>/{plan.json,progress.jsonl,run.log}
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { getInfluencerById } from "../lib/db/influencer-dao.js";
import { loadConversationHistoryForInfluencer } from "../lib/agents/influencer-agent.js";
import { influencerAgentBasePrompt } from "../lib/agents/influencer-agent-prompt.js";
import { callDeepSeekLLM } from "../lib/utils/llm-client.js";
import {
  resolveCommunicationLanguage,
  languageEnglishName,
} from "../lib/influencer/infer-bio-language.js";
import { getInfluencerLanguage } from "../lib/influencer/influencer-language-store.js";
import {
  buildReplyLanguageRule,
  buildReplyLanguageTail,
} from "../lib/influencer/reply-language-prompt.js";
import { languageDisplayName } from "../lib/influencer/country-primary-language.js";
import {
  sendMail,
  pickOutboundAccountForNewOutreach,
  OutboundCooldownError,
} from "../lib/email/enterprise-mail-client.js";
import {
  normalizePoolEmail,
  getOpContactEmail,
} from "../lib/email/temporary-outbound-pool.js";
import { logConversationMessage } from "../lib/db/influencer-conversation-dao.js";
import {
  REPLY_HANDOFF_MAILBOX,
  normalizeMessageIdForHeader,
  stripSubjectPrefixes,
} from "../lib/email/influencer-thread-mail.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

// CapCut 优先，其次 VAST/Tripo
const DEFAULT_CAMPAIGNS = [
  "CAMP-1787230569375-WWIKAD4TO", // CapCut AI 影片编辑器
  "CAMP-1782463190123-3BETBZB1B", // VAST AI 3D 模型生成器（Tripo）
];

const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  if (i === -1) return 0;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
})();
const CAMPAIGNS = (() => {
  const i = process.argv.indexOf("--campaigns");
  if (i >= 0 && process.argv[i + 1]) {
    return String(process.argv[i + 1])
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return DEFAULT_CAMPAIGNS;
})();

const CONCURRENCY = Math.max(1, Number(process.env.FOLLOWUP_CONCURRENCY || 10));
const COOLDOWN_WAIT_MS = 45_000;

function ensureRunDir(campaignId) {
  const dir = path.join(projectRoot, "tmp", "followup-pending-quote", campaignId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ts() {
  return new Date().toISOString();
}

function makeLogger(paths) {
  return (...args) => {
    const line = `[${ts()}] ${args.map(String).join(" ")}`;
    console.log(line);
    try {
      fs.appendFileSync(paths.LOG_PATH, line + "\n");
    } catch {
      /* ignore */
    }
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

function parseJsonOrObject(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function classifySendError(e) {
  const m = `${e?.code || ""} ${e?.message || ""} ${e?.response || ""}`;
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return "sender_dead";
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|etimedout|timeout/i.test(m))
    return "sender_down";
  if (/EAUTH|Invalid login|535|authentication failed/i.test(m)) return "sender_auth";
  if (/EENVELOPE|550|551|553|554|mailbox|recipient|not exist|User unknown|does not exist/i.test(m))
    return "recipient";
  return "unknown";
}

async function getCampaign(campaignId) {
  const rows = await queryTikTok("SELECT * FROM tiktok_campaign WHERE id = ?", [campaignId]);
  if (!rows || rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    productInfo: parseJsonOrObject(r.product_info) || {},
    campaignInfo: parseJsonOrObject(r.campaign_info) || {},
    status: r.status,
  };
}

/** 目标集合：pending_quote ∧ 已发首封 ∧ 未回信 ∧ 可联系 ∧ 有邮箱 ∧ 尚无本 campaign 跟进 */
async function loadTargets(campaignId) {
  const rows = await queryTikTok(
    `
    SELECT
      ce.influencer_id AS influencerId,
      ce.tiktok_username AS tiktokUsername,
      ce.influencer_snapshot AS snapshot,
      i.display_name AS displayName,
      i.username AS masterUsername,
      i.platform AS platform,
      i.country AS country,
      i.influencer_email AS toEmail,
      (SELECT m.subject
         FROM tiktok_influencer_conversation_messages m
        WHERE m.influencer_id = ce.influencer_id AND m.direction='bin' AND m.channel='email'
        ORDER BY COALESCE(m.sent_at, m.created_at) ASC, m.id ASC LIMIT 1) AS firstSubject,
      (SELECT m.message_id
         FROM tiktok_influencer_conversation_messages m
        WHERE m.influencer_id = ce.influencer_id AND m.direction='bin' AND m.channel='email'
        ORDER BY COALESCE(m.sent_at, m.created_at) ASC, m.id ASC LIMIT 1) AS firstMessageId,
      (SELECT m.message_id
         FROM tiktok_influencer_conversation_messages m
        WHERE m.influencer_id = ce.influencer_id AND m.channel='email'
          AND m.message_id IS NOT NULL AND TRIM(m.message_id) <> ''
        ORDER BY COALESCE(m.event_time, m.sent_at, m.created_at) DESC, m.id DESC LIMIT 1) AS latestMessageId
    FROM tiktok_campaign_execution ce
    JOIN tiktok_influencer i ON i.influencer_id = ce.influencer_id
    WHERE ce.campaign_id = ? AND ce.stage = 'pending_quote'
      AND i.contact_status <> 'do_not_contact'
      AND i.influencer_email IS NOT NULL AND TRIM(i.influencer_email) <> ''
      AND EXISTS (SELECT 1 FROM tiktok_influencer_conversation_messages m
                   WHERE m.influencer_id = ce.influencer_id AND m.direction='bin' AND m.channel='email')
      AND NOT EXISTS (SELECT 1 FROM tiktok_influencer_conversation_messages m
                   WHERE m.influencer_id = ce.influencer_id AND m.direction='influencer' AND m.channel='email')
      AND NOT EXISTS (SELECT 1 FROM tiktok_influencer_email_events e
                   WHERE e.influencer_id = ce.influencer_id)
      AND NOT EXISTS (SELECT 1 FROM tiktok_influencer_conversation_messages m2
                   WHERE m2.influencer_id = ce.influencer_id AND m2.campaign_id = ce.campaign_id
                     AND m2.source_type = 'outbound_email')
    ORDER BY ce.created_at ASC, ce.id ASC
    `,
    [campaignId]
  );
  return rows || [];
}

function buildReferencesHeader(rootRaw, parentRaw) {
  const root = normalizeMessageIdForHeader(rootRaw);
  const parent = normalizeMessageIdForHeader(parentRaw);
  const rr = String(rootRaw || "").replace(/^<|>$/g, "").trim();
  const pr = String(parentRaw || "").replace(/^<|>$/g, "").trim();
  if (root && parent && rr && pr && rr === pr) return parent;
  if (root && parent) return `${root} ${parent}`;
  return parent || root || null;
}

/** 沿用原线程主题 + References，保证进同一会话 */
function buildThreadInfo(t) {
  const rootRaw = t.firstMessageId || null;
  const parentRaw = t.latestMessageId || t.firstMessageId || null;
  const base = stripSubjectPrefixes(t.firstSubject) || null;
  const subjectForSend = base ? `Re: ${base}` : "Re: Binfluencer | Social Media Collaboration";
  return {
    subjectForSend,
    inReplyTo: parentRaw ? normalizeMessageIdForHeader(parentRaw) : null,
    references: buildReferencesHeader(rootRaw || parentRaw, parentRaw),
  };
}

async function generateFollowUpBody({
  campaign,
  influencer,
  snapshot,
  conversationHistory,
  tiktokUsername,
}) {
  const productInfo = campaign.productInfo || {};
  const brand = productInfo.brandName || "our brand partner";
  const product = productInfo.productName || "this product";
  const productLink = String(productInfo.productLink || "").trim();
  const fitSummary =
    typeof snapshot?.analysisSummary === "string"
      ? snapshot.analysisSummary.trim().slice(0, 1200)
      : null;

  const languageRecord = await getInfluencerLanguage(
    influencer?.influencerId || null
  ).catch(() => null);
  const lang = resolveCommunicationLanguage({
    bioLanguage: languageRecord?.bioLanguage || null,
    bioLanguageConfidence: languageRecord?.bioLanguageConfidence ?? null,
  });
  const langEn = languageEnglishName(lang.language);
  const langZh = languageDisplayName(lang.language);

  const systemPrompt = `
${influencerAgentBasePrompt}

【当前任务：首封邀约后的无回复跟进邮件】
- 场景：Bin 此前已给这位红人发送过一封首封合作邀约邮件（conversationHistory 中 source_type=seed_outreach 的那条），对方尚未回复，执行阶段仍为 pending_quote（待红人报价/确认意向）。
- 现在写一封简短、礼貌、有温度的跟进邮件（follow-up）：
  - 自然提及上一封邮件，但不要整封重发，也不要重复所有细节；
  - 核心目的：说明品牌方对这次与「${brand} / ${product}」的合作非常感兴趣，询问对方是否愿意合作；
  - 请对方无论有意向还是暂不考虑，都简单回复一句；如有问题也欢迎直接问；
  - 如果上一封邮件已包含报价/固定费，只能用「our previous offer still stands / we can go over the details」这类轻描淡写的说法，禁止编造或改动任何数字；
  - 2–4 个短段落，不逐条罗列 bullet，不做硬推销、不施压、不制造紧迫感（不要写 deadline / final call / last chance 等）；
  - 纯文本正文，不要 markdown、不要 JSON、不要输出标题；品牌名、产品名、链接保留原文。
  ${buildReplyLanguageRule({
    language: lang.language,
    languageName: langZh,
    languageEn: langEn,
    source: lang.source,
    label: "跟进邮件正文",
  })}
`;

  const payload = {
    influencer: {
      id: influencer?.influencerId || null,
      displayName: influencer?.displayName || null,
      username: influencer?.username || tiktokUsername || null,
      platform: influencer?.platform || null,
      country: influencer?.country || null,
    },
    campaign: { id: campaign.id, brand, product, productLink: productLink || null },
    executionSnapshot: {
      analysisSummary: fitSummary,
      matchAnalysis: snapshot?.matchAnalysis || null,
    },
    conversationHistory,
  };

  const userContent = `
Below is the context for a follow-up email to a creator who has not replied to the first outreach.

JSON input:
${JSON.stringify(payload, null, 2)}

${buildReplyLanguageTail({ languageEn: langEn, label: "follow-up email body" })}
No JSON, no extra commentary.
`;

  const raw = await callDeepSeekLLM([{ role: "user", content: userContent }], systemPrompt);
  return String(raw || "").trim();
}

function readProgress(paths) {
  const done = new Set();
  const givenUp = new Set();
  if (!fs.existsSync(paths.PROGRESS_PATH)) return { done, givenUp, sent: 0 };
  const lines = fs.readFileSync(paths.PROGRESS_PATH, "utf8").split("\n").filter(Boolean);
  let sent = 0;
  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      if (o.ok === true) {
        if (!o.skipped) done.add(o.influencerId);
        sent++;
      } else if (o.giveUp === true) {
        givenUp.add(o.influencerId);
      }
    } catch {
      /* ignore */
    }
  }
  return { done, givenUp, sent };
}

function appendProgress(paths, rec) {
  fs.appendFileSync(paths.PROGRESS_PATH, JSON.stringify(rec) + "\n");
}

/** 发件箱统一从池里选（与首封共用 20–40 分钟冷却原子门槛） */
async function pickSenderPoolOnly() {
  const acc = await pickOutboundAccountForNewOutreach();
  const email = normalizePoolEmail(getOpContactEmail(acc));
  return { acc, email };
}

async function sendOne({ job, campaign, paths, log }) {
  // 幂等：本 campaign 已发过跟进则跳过
  const dup = await queryTikTok(
    `SELECT 1 AS hit FROM tiktok_influencer_conversation_messages
      WHERE influencer_id=? AND campaign_id=? AND source_type='outbound_email' LIMIT 1`,
    [job.influencerId, campaign.id]
  );
  if (dup && dup.length) {
    appendProgress(paths, {
      influencerId: job.influencerId,
      ok: true,
      skipped: "already_followed_up",
      at: ts(),
    });
    return { skipped: true };
  }

  const influencer = await getInfluencerById(job.influencerId);
  if (!influencer) throw new Error("主档不存在");
  if (influencer.contactStatus === "do_not_contact") throw new Error("do_not_contact(已变更)");
  const toEmail = influencer.influencerEmail || job.toEmail;
  if (!toEmail) throw new Error("缺少邮箱");

  // 正文只生成一次并缓存：冷却等待 / 换箱重试都不会重复调用 LLM。
  const history = await loadConversationHistoryForInfluencer(job.influencerId, 20);
  const snapshot = parseJsonOrObject(job.snapshot) || {};
  const body = await generateFollowUpBody({
    campaign,
    influencer,
    snapshot,
    conversationHistory: history,
    tiktokUsername: job.tiktokUsername,
  });
  if (!body) {
    const e = new Error("LLM 正文为空");
    e.kind = "llm";
    throw e;
  }

  const thread = buildThreadInfo(job);

  // 内层循环：申请发件箱（池 20–40 分钟冷却原子门槛，与首封共用）→ 发送。
  // 冷却未到只等待重试，不再重生成正文；发件箱侧故障换箱继续（有上限，避免死循环）。
  let senderFaults = 0;
  while (true) {
    let acc;
    let senderEmail;
    try {
      ({ acc, email: senderEmail } = await pickSenderPoolOnly());
    } catch (e) {
      if (e instanceof OutboundCooldownError) {
        await sleep(COOLDOWN_WAIT_MS + Math.floor(Math.random() * 15_000));
        continue;
      }
      throw e;
    }

    const headers = {
      "X-Maxin-Influencer-Id": job.influencerId,
      "X-Maxin-Campaign-Id": campaign.id,
      "X-Maxin-Source": "PendingQuoteFollowup",
      // 红人回信统一回到品牌信箱（和首封冷号发信一致）
      "Reply-To": REPLY_HANDOFF_MAILBOX,
    };
    if (thread.inReplyTo) headers["In-Reply-To"] = thread.inReplyTo;
    if (thread.references) headers["References"] = thread.references;

    let result;
    try {
      result = await sendMail({
        fromAccount: acc,
        to: toEmail,
        subject: thread.subjectForSend,
        text: body,
        headers,
      });
    } catch (e) {
      e.kind = classifySendError(e);
      e.senderEmail = senderEmail;
      if (e.kind === "recipient") throw e; // 收件人问题：放弃该红人
      senderFaults++;
      if (senderFaults >= 8) {
        // 连续换箱仍失败：抛出让外层收尾，避免无限循环
        throw e;
      }
      log(`换箱重试 @${job.tiktokUsername}：${e.kind} ${e.message}`);
      await sleep(1500 + Math.floor(Math.random() * 3000));
      continue;
    }
    const sendAt = Date.now();

    await logConversationMessage({
      influencerId: job.influencerId,
      campaignId: campaign.id,
      direction: "bin",
      channel: "email",
      fromEmail: senderEmail,
      toEmail,
      subject: thread.subjectForSend,
      bodyText: body,
      messageId: result?.messageId || null,
      sourceType: "outbound_email",
      sourceEventTable: null,
      sourceEventId: null,
      sentAt: new Date(sendAt),
      eventType: "email_outbound",
      eventTime: new Date(sendAt),
      actorType: "agent",
      sendMode: "auto_send",
      contentOrigin: "agent_generated",
      payload: {
        kind: "email_outbound",
        status: "succeeded",
        followup: {
          reason: "pending_quote_no_reply_followup",
          poolRule: "20-40min",
          createdAt: ts(),
        },
        email: {
          to: toEmail,
          subject: thread.subjectForSend,
          inReplyTo: thread.inReplyTo,
          messageId: result?.messageId || null,
        },
        sender: { from: senderEmail, poolRule: "20-40min" },
      },
    });

    return { senderEmail, toEmail, subject: thread.subjectForSend, messageId: result?.messageId || null };
  }
}

async function runCampaign(campaignId) {
  const dir = ensureRunDir(campaignId);
  const paths = {
    PLAN_PATH: path.join(dir, "plan.json"),
    PROGRESS_PATH: path.join(dir, "progress.jsonl"),
    LOG_PATH: path.join(dir, "run.log"),
  };
  const log = makeLogger(paths);

  const campaign = await getCampaign(campaignId);
  if (!campaign) throw new Error(`campaign 不存在: ${campaignId}`);

  const { done, givenUp } = readProgress(paths);
  let targets = await loadTargets(campaignId);
  targets = targets.filter((t) => t.influencerId && !done.has(t.influencerId) && !givenUp.has(t.influencerId));
  if (LIMIT) targets = targets.slice(0, LIMIT);

  const seen = new Set();
  const jobs = [];
  for (const t of targets) {
    if (seen.has(t.influencerId)) continue;
    seen.add(t.influencerId);
    jobs.push(t);
  }

  log(
    `=== 跟进 ${DRY_RUN ? "(DRY-RUN)" : "(LIVE)"} | campaign=${campaignId} | brand=${campaign.productInfo?.brandName || "?"} | 待发=${jobs.length} | concurrency=${CONCURRENCY} ===`
  );

  try {
    fs.writeFileSync(
      paths.PLAN_PATH,
      JSON.stringify(
        {
          campaignId,
          generatedAt: ts(),
          total: jobs.length,
          jobs: jobs.map((j) => ({
            influencerId: j.influencerId,
            tiktokUsername: j.tiktokUsername,
            toEmail: j.toEmail,
            subject: buildThreadInfo(j).subjectForSend,
          })),
        },
        null,
        2
      )
    );
  } catch (e) {
    log(`plan.json 写入失败: ${e.message}`);
  }

  if (DRY_RUN) {
    for (const j of jobs.slice(0, 3)) {
      try {
        const influencer = await getInfluencerById(j.influencerId);
        const history = await loadConversationHistoryForInfluencer(j.influencerId, 20);
        const body = await generateFollowUpBody({
          campaign,
          influencer,
          snapshot: parseJsonOrObject(j.snapshot) || {},
          conversationHistory: history,
          tiktokUsername: j.tiktokUsername,
        });
        log(`--- 样本 @${j.tiktokUsername} | 主题=${buildThreadInfo(j).subjectForSend} ---`);
        log(body);
      } catch (e) {
        log(`样本生成失败 @${j.tiktokUsername}: ${e.message}`);
      }
    }
    log("DRY-RUN 结束（未发送任何邮件）。");
    return { sent: 0, failed: 0 };
  }

  let cursor = 0;
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const startedAt = Date.now();

  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= jobs.length) return;
      const job = jobs[idx];
      try {
        const r = await sendOne({ job, campaign, paths, log });
        if (r.skipped) {
          skipped++;
          log(`skip @${job.tiktokUsername} 已跟进过`);
        } else {
          sent++;
          log(`[${sent}/${jobs.length}] OK @${job.tiktokUsername} sender=${r.senderEmail} to=${r.toEmail}`);
          appendProgress(paths, {
            influencerId: job.influencerId,
            ok: true,
            sender: r.senderEmail,
            to: r.toEmail,
            at: ts(),
          });
        }
      } catch (e) {
        // sendOne 内部已处理冷却等待与换箱；到这里说明是终态失败（LLM/主档/退信/箱连续故障）
        failed++;
        const kind = e.kind || "unknown";
        appendProgress(paths, {
          influencerId: job.influencerId,
          ok: false,
          giveUp: true,
          reason: `${kind}:${e.message}`,
          at: ts(),
        });
        log(`FAIL @${job.tiktokUsername}: ${kind} ${e.message}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, () => worker())
  );

  const elapsedH = (Date.now() - startedAt) / 3.6e6;
  log(`=== 完成 campaign=${campaignId} sent=${sent} failed=${failed} skipped=${skipped} elapsed=${elapsedH.toFixed(2)}h ===`);
  return { sent, failed, skipped };
}

async function main() {
  console.log(`[followup] campaigns(按序): ${CAMPAIGNS.join(" -> ")}`);
  for (const cid of CAMPAIGNS) {
    await runCampaign(cid);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("脚本执行失败:", err);
    process.exit(1);
  });
