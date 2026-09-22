/**
 * 一次性运维脚本（按用户要求执行）：
 * 阳光电源 光伏逆变器 campaign 中，仍处于 pending_quote（待红人报价）阶段、
 * 且此前已发过首封邀约但尚未收到回复的红人，
 * 生成一封简短跟进邮件（询问是否愿意合作），并 enqueue outbound_email 事件，
 * 由 InfluencerAgent worker 以同一邮件线程发送。
 *
 * 幂等：每个红人若已存在 source_type='outbound_email' 的对话记录，则跳过。
 *
 * 用法：node scripts/manual-followup-pending-quote.mjs
 */

import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { getInfluencerById } from "../lib/db/influencer-dao.js";
import {
  loadConversationHistoryForInfluencer,
} from "../lib/agents/influencer-agent.js";
import { influencerAgentBasePrompt } from "../lib/agents/influencer-agent-prompt.js";
import { enqueueInfluencerAgentEvent } from "../lib/db/influencer-agent-event-dao.js";
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const CAMPAIGN_ID = "CAMP-1787827595895-LHDC9RANH";
const CONCURRENCY = 3;

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

async function getCampaign(campaignId) {
  const rows = await queryTikTok("SELECT * FROM tiktok_campaign WHERE id = ?", [
    campaignId,
  ]);
  if (!rows || rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    sessionId: r.session_id,
    productInfo: parseJsonOrObject(r.product_info) || {},
    campaignInfo: parseJsonOrObject(r.campaign_info) || {},
    influencerProfile: parseJsonOrObject(r.influencer_profile) || {},
    contentScript: parseJsonOrObject(r.content_script) || {},
    status: r.status,
  };
}

async function generateFollowUpBody({
  campaign,
  influencer,
  executionSnapshot,
  conversationHistory,
}) {
  const productInfo = campaign.productInfo || {};
  const campaignInfo = campaign.campaignInfo || {};
  const brand = productInfo.brandName || "our brand partner";
  const product = productInfo.productName || "this product";
  const productLink = String(productInfo.productLink || "").trim();
  const fitSummary =
    typeof executionSnapshot.analysisSummary === "string"
      ? executionSnapshot.analysisSummary.trim().slice(0, 1200)
      : null;

  // 跟进邮件语言：prompt 看会话历史判断，这里只给 bio 语言作兜底（不再用历史回复语言）
  const languageRecord = await getInfluencerLanguage(
    influencer?.influencerId || null
  ).catch(() => null);
  const followupLanguage = resolveCommunicationLanguage({
    bioLanguage: languageRecord?.bioLanguage || null,
    bioLanguageConfidence: languageRecord?.bioLanguageConfidence ?? null,
  });
  const followupLanguageEn = languageEnglishName(followupLanguage.language);
  const followupLanguageZh = languageDisplayName(followupLanguage.language);

  const systemPrompt = `
${influencerAgentBasePrompt}

【当前任务：首封邀约后的无回复跟进邮件】
- 场景：Bin 此前已给这位红人发送过一封首封合作邀约邮件（conversationHistory 中 source_type=seed_outreach 的那条），对方尚未回复，执行阶段仍为 pending_quote（待红人报价/确认意向）。
- 现在写一封简短、礼貌、有温度的跟进邮件（follow-up）：
  - 自然提及上一封邮件，但不要整封重发，也不要重复所有细节；
  - 核心目的：询问对方是否对这次与「${brand} / ${product}」的合作感兴趣、是否愿意合作；
  - 请对方无论有意向还是暂不考虑，都简单回复一句；如有问题也欢迎直接问；
  - 如果上一封邮件已包含报价/固定费，只能用「our previous offer still stands / we can go over the details」这类轻描淡写的说法，禁止编造或改动任何数字；
  - 2–4 个短段落，不逐条罗列 bullet，不做硬推销、不施压、不制造紧迫感（不要写 deadline / final call / last chance 等）；
  - 纯文本正文，不要 markdown、不要 JSON、不要输出标题；品牌名、产品名、链接保留原文。
  ${buildReplyLanguageRule({
    language: followupLanguage.language,
    languageName: followupLanguageZh,
    languageEn: followupLanguageEn,
    source: followupLanguage.source,
    label: "跟进邮件正文",
  })}
`;

  const payload = {
    influencer: {
      id: influencer?.influencerId || null,
      displayName: influencer?.displayName || null,
      username: influencer?.username || null,
      profileUrl: influencer?.profileUrl || null,
      platform: influencer?.platform || null,
      country: influencer?.country || null,
    },
    campaign: {
      id: campaign.id,
      brand,
      product,
      productLink: productLink || null,
    },
    executionSnapshot: {
      analysisSummary: fitSummary,
      matchAnalysis: executionSnapshot.matchAnalysis || null,
    },
    conversationHistory,
  };

  const userContent = `
Below is the context for a follow-up email to a creator who has not replied to the first outreach.

JSON input:
${JSON.stringify(payload, null, 2)}

${buildReplyLanguageTail({ languageEn: followupLanguageEn, label: "follow-up email body" })}
No JSON, no extra commentary.
`;

  const raw = await callDeepSeekLLM(
    [{ role: "user", content: userContent }],
    systemPrompt
  );
  return String(raw || "").trim();
}

async function runWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const campaign = await getCampaign(CAMPAIGN_ID);
  if (!campaign) throw new Error(`campaign 不存在: ${CAMPAIGN_ID}`);

  const rows = await queryTikTok(
    `
    SELECT tiktok_username, influencer_id, influencer_snapshot, stage
    FROM tiktok_campaign_execution
    WHERE campaign_id = ? AND stage = 'pending_quote'
    ORDER BY created_at
    `,
    [CAMPAIGN_ID]
  );
  console.log(`pending_quote 红人：${rows.length} 位`);

  const results = await runWithConcurrency(rows, CONCURRENCY, async (r) => {
    const tiktokUsername = r.tiktok_username;
    const pid = r.influencer_id;
    const snapshot = parseJsonOrObject(r.influencer_snapshot) || {};

    if (!pid) {
      return { username: tiktokUsername, ok: false, reason: "缺少 influencer_id" };
    }

    const dup = await queryTikTok(
      `
      SELECT id FROM tiktok_influencer_conversation_messages
      WHERE influencer_id = ? AND campaign_id = ? AND source_type = 'outbound_email'
      LIMIT 1
      `,
      [pid, CAMPAIGN_ID]
    );
    if (dup && dup.length > 0) {
      return { username: tiktokUsername, ok: false, reason: "已存在跟进邮件，跳过" };
    }

    const influencer = await getInfluencerById(pid);
    if (!influencer) {
      return { username: tiktokUsername, ok: false, reason: "主档不存在" };
    }
    if (influencer.contactStatus === "do_not_contact") {
      return { username: tiktokUsername, ok: false, reason: "do_not_contact" };
    }
    const toEmail = influencer.influencerEmail;
    if (!toEmail) {
      return { username: tiktokUsername, ok: false, reason: "缺少邮箱" };
    }

    const history = await loadConversationHistoryForInfluencer(pid, 20);
    const seed = history.find((m) => m.sourceType === "seed_outreach");
    const inReplyTo = seed?.messageId || history.find((m) => m.messageId)?.messageId || null;

    const body = await generateFollowUpBody({
      campaign,
      influencer,
      executionSnapshot: snapshot,
      conversationHistory: history,
    });
    if (!body) {
      return { username: tiktokUsername, ok: false, reason: "LLM 生成正文为空" };
    }

    await enqueueInfluencerAgentEvent({
      influencerId: pid,
      campaignId: CAMPAIGN_ID,
      eventType: "outbound_email",
      payload: {
        campaignId: CAMPAIGN_ID,
        platformInfluencerId: pid,
        tiktokUsername,
        to: toEmail,
        body,
        sourceType: "outbound_email",
        inReplyTo,
        followup: {
          reason: "pending_quote_no_reply_followup",
          createdAt: new Date().toISOString(),
        },
      },
    });

    return {
      username: tiktokUsername,
      ok: true,
      to: toEmail,
      bodyPreview: body.slice(0, 90).replace(/\n/g, " "),
    };
  });

  const ok = results.filter((x) => x.ok);
  const failed = results.filter((x) => !x.ok);
  console.log(`\n完成：enqueue 跟进邮件 ${ok.length} 封，跳过/失败 ${failed.length} 条。`);
  for (const x of ok) console.log(`  ✓ ${x.username} -> ${x.to} | ${x.bodyPreview}…`);
  for (const x of failed) console.log(`  ✗ ${x.username}: ${x.reason}`);
}

main()
  .catch((err) => {
    console.error("脚本执行失败:", err);
    process.exitCode = 1;
  })
  .finally(() => process.exit(0));
