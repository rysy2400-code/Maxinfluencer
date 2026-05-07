import { getInfluencerById } from "../db/influencer-dao.js";
import { getExecutionRow } from "../db/campaign-dao.js";
import { avgViewsFromSnapshot } from "../db/campaign-candidates-dao.js";
import {
  SQL_EXECUTION_CREATOR_MATCH,
  paramsExecutionCreatorMatch,
} from "../db/campaign-execution-keys.js";
import { queryTikTok } from "../db/mysql-tiktok.js";
import { sendMail } from "../email/enterprise-mail-client.js";
import { resolveInfluencerThreadMailContext } from "../email/influencer-thread-mail.js";
import { logConversationMessage } from "../db/influencer-conversation-dao.js";
import { callDeepSeekLLM } from "../utils/llm-client.js";
import { influencerAgentBasePrompt } from "./influencer-agent-prompt.js";

/**
 * 从红人信息中提取收件邮箱（规范：只读 tiktok_influencer.influencer_email）
 */
function pickInfluencerEmail(influencer) {
  const e = influencer?.influencerEmail;
  if (typeof e === "string" && e.includes("@")) {
    return e.trim();
  }
  return null;
}

function getPlatformLabel(campaign) {
  const platforms = campaign?.campaignInfo?.platforms;
  if (Array.isArray(platforms) && platforms.length) {
    const uniq = [
      ...new Set(
        platforms
          .map((p) => (p == null ? "" : String(p).trim()))
          .filter(Boolean)
      ),
    ];
    if (!uniq.length) return "social media";
    if (uniq.length === 1) return uniq[0];
    return uniq.join(" / ");
  }
  return "social media";
}

function roundToNearest10(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.round(x / 10) * 10;
}

/** 首封报价：eCPM=3 → USD，按平均播放量/1000*3 后四舍五入到 10 的倍数 */
function computeQuotedFlatFeeUsdFromAvgViews(avgViews) {
  if (avgViews == null) return null;
  const v = Number(avgViews);
  if (!Number.isFinite(v) || v < 0) return null;
  const raw = (v / 1000) * 3;
  return roundToNearest10(raw);
}

function resolveCampaignCommissionPercent(dbRow, campaignInfo) {
  if (dbRow?.commission != null && dbRow.commission !== "") {
    const n = Number(dbRow.commission);
    if (Number.isFinite(n)) return n;
  }
  if (campaignInfo?.commission != null && campaignInfo.commission !== "") {
    const n = Number(campaignInfo.commission);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function budgetUsdFromRow(dbRow) {
  if (dbRow?.budget == null) return null;
  const n = Number(dbRow.budget);
  return Number.isFinite(n) ? n : null;
}

/** 避免把 campaign_info.budget 误当单人报价；仍由系统单独传 totalCampaignBudgetUsd */
function stripBudgetFromCampaignInfo(campaignInfo) {
  if (!campaignInfo || typeof campaignInfo !== "object" || Array.isArray(campaignInfo)) {
    return campaignInfo;
  }
  const { budget: _b, ...rest } = campaignInfo;
  return rest;
}

function followerCountFromSnapshot(s) {
  const f = s?.followers;
  if (typeof f === "number" && Number.isFinite(f)) return f;
  if (f && typeof f.count === "number" && Number.isFinite(f.count)) return f.count;
  return null;
}

function buildCreatorFitContext(executionSnapshot) {
  if (!executionSnapshot || typeof executionSnapshot !== "object") return null;
  const ma = executionSnapshot.matchAnalysis;
  const summaryRaw =
    typeof executionSnapshot.analysisSummary === "string"
      ? executionSnapshot.analysisSummary.trim()
      : "";
  const summary = summaryRaw || null;
  const hasMa =
    ma &&
    typeof ma === "object" &&
    !Array.isArray(ma) &&
    Object.keys(ma).length > 0;
  const views = avgViewsFromSnapshot(executionSnapshot);
  const followers = followerCountFromSnapshot(executionSnapshot);
  if (!summary && !hasMa && views == null && followers == null) return null;
  return {
    analysisSummary: summary,
    matchAnalysis: hasMa ? ma : null,
    avgViewsFromSnapshot: views,
    followerCountFromSnapshot: followers,
  };
}

export async function loadConversationHistoryForInfluencer(influencerId, limit = 20) {
  if (!influencerId) return [];
  const n = Math.min(50, Math.max(1, Number(limit) || 20));
  const rows = await queryTikTok(
    `
    SELECT
      influencer_id,
      campaign_id,
      direction,
      channel,
      from_email,
      to_email,
      subject,
      body_text,
      message_id,
      source_type,
      source_event_table,
      source_event_id,
      event_type,
      event_time,
      actor_type,
      actor_id,
      send_mode,
      content_origin,
      trace_id,
      payload,
      sent_at,
      created_at
    FROM tiktok_influencer_conversation_messages
    WHERE influencer_id = ?
    ORDER BY COALESCE(event_time, sent_at, created_at) DESC
    LIMIT ${n}
  `,
    [influencerId]
  );
  return (rows || []).map((r) => ({
    influencerId: r.influencer_id,
    campaignId: r.campaign_id,
    direction: r.direction,
    channel: r.channel,
    fromEmail: r.from_email,
    toEmail: r.to_email,
    subject: r.subject,
    bodyText: r.body_text,
    messageId: r.message_id,
    sourceType: r.source_type,
    sourceEventTable: r.source_event_table,
    sourceEventId: r.source_event_id,
    eventType: r.event_type,
    eventTime: r.event_time,
    actorType: r.actor_type,
    actorId: r.actor_id,
    sendMode: r.send_mode,
    contentOrigin: r.content_origin,
    traceId: r.trace_id,
    payload: parseJsonOrObject(r.payload),
    sentAt: r.sent_at,
    createdAt: r.created_at,
  }));
}

async function generateOutreachBodyWithLLM({
  campaign,
  influencer,
  conversationHistory,
  executionSnapshot,
  outreachPricing,
  creatorFitContext,
}) {
  const brand =
    campaign?.productInfo?.brand ||
    campaign?.campaignInfo?.brand ||
    "our brand partner";
  const product = campaign?.productInfo?.product || "your product";
  const productLink = (campaign?.productInfo?.productLink || "").trim();
  const platformLabel = getPlatformLabel(campaign);

  const cid = campaign?.id || null;
  const campaignInfoSafe = stripBudgetFromCampaignInfo(campaign?.campaignInfo || null);

  const productLinkRule =
    productLink !== ""
      ? `- **必需**：正文中必须包含以下完整产品链接（一字不差，方便对方点击）：\n  ${productLink}\n  可将链接自然放在介绍产品或结尾处；禁止省略或用「见官网」代替。`
      : `- 当前未配置 productLink，无需强行编造 URL。`;

  const pricingRules = (() => {
    const q = outreachPricing?.quotedFlatFeeUsd;
    const pct = outreachPricing?.commissionPercent;
    const total = outreachPricing?.totalCampaignBudgetUsd;
    const lines = [
      `- **金额纪律（极其重要）**：整案总预算为 totalCampaignBudgetUsd（若有）。这是整个 campaign 的总预算，**绝不是**给单个创作者的个人固定费。正文中**禁止**把总预算写成「给你的 flat fee / fixed fee」。`,
      `- 若 outreachPricing.quotedFlatFeeUsd 有数值：这是你（单人）的固定费报价（已由系统按执行表 snapshot 内平均播放量、eCPM=$3 计算并四舍五入到 $10），正文用英文简要说明该固定费与（若有）佣金；**禁止**自造其他美元数字作为固定费。`,
      `- 若 quotedFlatFeeUsd 为 null：不要编造具体固定费美元数字；可说明愿在了解其内容表现后讨论 compensation，若 commissionPercent 有值仍可提佣金结构。`,
      `- 佣金百分比仅使用 outreachPricing.commissionPercent；无则不要捏造百分比。`,
    ];
    if (total != null && Number.isFinite(Number(total))) {
      lines.push(
        `- 若需提及项目规模，仅可用「overall campaign budget / program budget」等说法（约 $${Number(
          total
        ).toLocaleString("en-US")} USD **for the whole program**），**不得**暗示全款付给该创作者。`
      );
    }
    if (q != null && Number.isFinite(Number(q))) {
      const commHint =
        pct != null && Number.isFinite(Number(pct))
          ? ` Mention a **$${Number(q).toLocaleString(
              "en-US"
            )} USD** fixed fee (one creator) **plus ${Number(pct)}% commission** where applicable.`
          : ` Mention a **$${Number(q).toLocaleString("en-US")} USD** fixed fee (one creator) only.`;
      lines.push(`- 英文表述要求：${commHint}`);
    }
    return lines.join("\n");
  })();

  const fitRules = creatorFitContext
    ? `- **合作动机**：请阅读 creatorFitContext（来自执行表 influencer_snapshot 的分析与匹配说明）。用 1–2 段自然英文说明**为什么**这位创作者适合该品牌/产品：可引用 analysisSummary、matchAnalysis 中的要点（受众、内容风格、匹配度），避免空泛客套，让红人感到「有被认真看过」；不要逐条抄字段名。`
    : `- 若无 creatorFitContext，用真诚、具体的语气说明你欣赏其内容风格与受众，但仍避免夸张或与事实不符的陈述。`;

  const systemPrompt = `
${influencerAgentBasePrompt}

【当前任务：首封邀约邮件】
- 给指定红人写一封「首封」或「本轮机会」的邀约邮件正文，风格自然、像一对一沟通，而不是群发模板。
- 邮件标题（subject）由系统统一为规范化线程标题（首封为 Binfluencer x …，续信为 Re: …），你不要设计或输出标题，只负责正文内容。
- 用英文写邮件正文（纯文本，不要 markdown，不要 JSON）。
- 语气：专业、友好、简洁，不要太推销感。
- 不要逐条罗列 bullet point，保持自然段落。
- conversationHistory 中每条可含 campaignId。若存在多个 campaign，你必须以本轮 campaign（campaign.id = ${cid || "null"}）为主，在正文中自然区分品牌/产品，避免把不同合作混为一谈。
- 适当根据 conversationHistory 判断：
  - 如果之前已经联系过同一个红人，可以简要提到「we talked before / nice to reconnect」之类的过往；
  - 但不要重复上一封几乎一模一样的句子。
- 主体人设一定是 Bin（代表 Binfluencer 与品牌沟通）。

${productLinkRule}

【报价与预算】
${pricingRules}

【个性化与诚意】
${fitRules}
`;

  const payload = {
    influencer: {
      id: influencer?.influencerId || influencer?.id || null,
      displayName: influencer?.displayName || null,
      username: influencer?.username || null,
      profileUrl: influencer?.profileUrl || null,
      country: influencer?.country || null,
    },
    campaign: {
      id: campaign?.id || null,
      brand,
      product,
      productLink: productLink || null,
      platformLabel,
      productInfo: campaign?.productInfo || null,
      campaignInfo: campaignInfoSafe,
    },
    outreachPricing: outreachPricing || null,
    creatorFitContext: creatorFitContext || null,
    executionSnapshot: executionSnapshot || null,
    conversationHistory,
  };

  const userContent = `
Below is the context for a new outreach email to a creator.

JSON input:
${JSON.stringify(payload, null, 2)}

Please output ONLY the email body in English, no greeting explanation, no JSON, no extra commentary.
`;

  const raw = await callDeepSeekLLM(
    [{ role: "user", content: userContent }],
    systemPrompt
  );

  return String(raw || "").trim();
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

/**
 * 读取完整 campaign，用于邮件内容生成。
 */
async function getCampaignByIdInternal(campaignId) {
  const rows = await queryTikTok(
    "SELECT * FROM tiktok_campaign WHERE id = ?",
    [campaignId]
  );
  if (!rows || rows.length === 0) return null;
  const r = rows[0];
  const campaignInfo = parseJsonOrObject(r.campaign_info);
  return {
    id: r.id,
    budgetUsd: budgetUsdFromRow(r),
    commissionPercent: resolveCampaignCommissionPercent(r, campaignInfo),
    productInfo: parseJsonOrObject(r.product_info),
    campaignInfo,
    influencerProfile: parseJsonOrObject(r.influencer_profile),
    contentScript: parseJsonOrObject(r.content_script),
  };
}

/**
 * 首轮触达：真正的发信逻辑，由 InfluencerAgent 事件 Worker 调用。
 * - 仅用 platformInfluencerId（与 tiktok_influencer.influencer_id 一致）查主档与邮箱
 * - 选择企业发件邮箱
 * - 生成邮件并发送
 * - 在 tiktok_campaign_execution.last_event 中记录结果
 * - 写入对话记忆表（会话键亦为平台 influencer_id）
 *
 * 线程策略（发件人 / 规范化标题 / In-Reply-To）：见 lib/email/influencer-thread-mail.js，
 * 按 influencer_id 全局（跨 campaign）共用一线程。
 *
 * @param {{ campaignId: string, platformInfluencerId: string, tiktokUsername?: string|null, snapshot?: object }} opts
 */
export async function sendOutreach({
  campaignId,
  platformInfluencerId,
  tiktokUsername = null,
  snapshot,
}) {
  const pid =
    platformInfluencerId != null ? String(platformInfluencerId).trim() : "";
  if (!pid) {
    throw new Error(
      "[InfluencerAgent] sendOutreach 缺少 platformInfluencerId（应与 tiktok_influencer.influencer_id 一致）"
    );
  }

  const influencer = await getInfluencerById(pid);
  if (!influencer) {
    throw new Error(
      `[InfluencerAgent] 主档不存在红人 influencer_id=${pid}（请回填 tiktok_influencer）`
    );
  }

  const toEmail = pickInfluencerEmail(influencer);
  if (!toEmail) {
    throw new Error(
      `[InfluencerAgent] 红人 influencer_id=${pid} 缺少可用 influencer_email`
    );
  }

  const campaign = await getCampaignByIdInternal(campaignId);
  if (!campaign) {
    throw new Error(`[InfluencerAgent] 未找到 campaign: ${campaignId}`);
  }

  const handle = tiktokUsername
    ? String(tiktokUsername).replace(/^@/, "").trim()
    : null;
  const execRow = handle
    ? await getExecutionRow(campaignId, handle)
    : (await getExecutionRow(campaignId, pid)) || null;
  const fromDb = parseJsonOrObject(execRow?.influencer_snapshot) || {};
  const fromPayload = snapshot && typeof snapshot === "object" ? snapshot : {};
  const executionSnapshot = { ...fromPayload, ...fromDb };

  const avgViewsForQuote = avgViewsFromSnapshot(executionSnapshot);
  const quotedFlatFeeUsd = computeQuotedFlatFeeUsdFromAvgViews(avgViewsForQuote);
  const commissionPercent =
    campaign.commissionPercent != null
      ? campaign.commissionPercent
      : null;
  const outreachPricing = {
    quotedFlatFeeUsd,
    commissionPercent,
    totalCampaignBudgetUsd: campaign.budgetUsd ?? null,
    ecpmUsd: 3,
    avgViewsUsed: avgViewsForQuote,
    rule: "flat_fee = round10(avg_views/1000*3); totalCampaignBudgetUsd is whole campaign, not per creator",
  };
  const creatorFitContext = buildCreatorFitContext(executionSnapshot);

  const ctx = await resolveInfluencerThreadMailContext({
    influencerId: pid,
    influencer,
  });
  const fromAccount = ctx.fromAccount;
  const subject = ctx.subjectForSend;

  const fromEmailResolved =
    fromAccount.email ||
    fromAccount.email_address ||
    fromAccount.username ||
    fromAccount.account ||
    null;

  const lastEvent =
    execRow?.lastEvent ?? parseJsonOrObject(execRow?.last_event) ?? {};
  const outreachMeta =
    lastEvent.outreachEmail && typeof lastEvent.outreachEmail === "object"
      ? lastEvent.outreachEmail
      : null;

  /** 曾发信且 last_event 有 Message-ID，但对话表缺失 → 补一行，避免重发 */
  if (outreachMeta?.messageId) {
    const mid = String(outreachMeta.messageId).trim();
    if (mid) {
      const dup = await queryTikTok(
        `SELECT id FROM tiktok_influencer_conversation_messages
         WHERE influencer_id = ? AND message_id = ? LIMIT 1`,
        [pid, mid]
      );
      if (!dup?.length) {
        const backfillBody = [
          "[Timeline recovery] Outreach was sent (see campaign execution last_event) but the conversation row was missing. Original body is not stored in last_event.",
          "",
          `Subject: ${outreachMeta.subject || subject}`,
          `To: ${outreachMeta.to || toEmail}`,
          `Sent (log): ${outreachMeta.sentAt || ""}`,
        ].join("\n");
        await logConversationMessage({
          influencerId: pid,
          campaignId,
          direction: "bin",
          channel: "email",
          fromEmail: fromEmailResolved,
          toEmail: outreachMeta.to || toEmail,
          subject: outreachMeta.subject || subject,
          bodyText: backfillBody,
          messageId: mid,
          sourceType: "seed_outreach",
          sourceEventTable: null,
          sourceEventId: null,
          sentAt: outreachMeta.sentAt
            ? new Date(outreachMeta.sentAt)
            : new Date(),
          payload: { backfillFromExecutionLastEvent: true },
        });
      }
    }
  }

  /** 本 campaign 已有首封种子行 → 不再 LLM/发信（Worker 重试幂等） */
  const seedExisting = await queryTikTok(
    `SELECT id, subject, message_id, to_email
     FROM tiktok_influencer_conversation_messages
     WHERE influencer_id = ? AND campaign_id = ? AND source_type = 'seed_outreach'
     ORDER BY id DESC LIMIT 1`,
    [pid, campaignId]
  );
  if (seedExisting?.length) {
    const r = seedExisting[0];
    return {
      campaignId,
      influencerId: pid,
      toEmail: r.to_email || toEmail,
      fromEmail: fromEmailResolved,
      subject: r.subject || subject,
      messageId: r.message_id || null,
      headers: {
        "X-Maxin-Influencer-Id": pid,
        "X-Maxin-Campaign-Id": campaignId,
      },
      deduplicated: true,
    };
  }

  // LLM 生成正文（无模板回退）：如果调用失败，将直接抛错并由上层事件标记为失败
  const history = await loadConversationHistoryForInfluencer(pid, 20);
  const text = await generateOutreachBodyWithLLM({
    campaign,
    influencer,
    conversationHistory: history,
    executionSnapshot,
    outreachPricing,
    creatorFitContext,
  });

  const headers = {
    "X-Maxin-Influencer-Id": pid,
    "X-Maxin-Campaign-Id": campaignId,
  };
  if (ctx.inReplyTo) {
    headers["In-Reply-To"] = ctx.inReplyTo;
  }
  if (ctx.references) {
    headers["References"] = ctx.references;
  }

  const result = await sendMail({
    fromAccount,
    to: toEmail,
    subject,
    text,
    headers,
  });

  // 记录到执行表的 last_event，方便排查
  try {
    await queryTikTok(
      `
      UPDATE tiktok_campaign_execution
      SET last_event = JSON_MERGE_PRESERVE(
            COALESCE(last_event, JSON_OBJECT()),
            JSON_OBJECT(
              'outreachEmail',
              JSON_OBJECT(
                'sentAt', ?,
                'to', ?,
                'subject', ?,
                'messageId', ?,
                'createdBy', 'InfluencerAgent'
              )
            )
          )
      WHERE campaign_id = ? AND ${SQL_EXECUTION_CREATOR_MATCH}
    `,
      [
        new Date().toISOString(),
        toEmail,
        subject,
        result?.messageId || null,
        campaignId,
        ...paramsExecutionCreatorMatch(tiktokUsername || pid),
      ]
    );
  } catch (err) {
    console.error(
      "[InfluencerAgent] 更新 tiktok_campaign_execution.last_event 失败:",
      err
    );
  }

  // 对话表写入失败必须向上抛错，否则事件会标 succeeded 而 UI 无记录；重试时由上文 backfill + dedupe 避免重复发信
  await logConversationMessage({
    influencerId: pid,
    campaignId,
    direction: "bin",
    channel: "email",
    fromEmail: fromEmailResolved,
    toEmail: toEmail,
    subject,
    bodyText: text,
    messageId: result?.messageId || null,
    sourceType: "seed_outreach",
    sourceEventTable: null,
    sourceEventId: null,
    sentAt: new Date(),
  });

  return {
    campaignId,
    influencerId: pid,
    toEmail,
    fromEmail: fromEmailResolved,
    subject,
    messageId: result?.messageId || null,
    headers,
  };
}

/**
 * 首轮触达：由执行心跳 / 种子脚本调用，只负责写入 InfluencerAgent 事件表，
 * 真正发信由 process-influencer-agent-events.js Worker 负责。
 *
 * @param {{ campaignId: string, tiktokUsername: string, platformInfluencerId?: string|null, snapshot?: object }} opts
 */
export async function enqueueFirstOutreach({
  campaignId,
  tiktokUsername,
  platformInfluencerId = null,
  snapshot,
}) {
  if (!campaignId || !tiktokUsername) {
    console.warn(
      "[InfluencerAgent] enqueueFirstOutreach 缺少 campaignId 或 tiktokUsername，跳过。"
    );
    return;
  }

  const handle = String(tiktokUsername).replace(/^@/, "").trim();
  const platformKey =
    platformInfluencerId != null && String(platformInfluencerId).trim() !== ""
      ? String(platformInfluencerId).trim()
      : null;

  await queryTikTok(
    `
    INSERT INTO tiktok_influencer_agent_event (
      influencer_id,
      campaign_id,
      event_type,
      payload,
      status
    ) VALUES (?, ?, 'first_outreach', ?, 'pending')
  `,
    [
      platformKey,
      campaignId,
      JSON.stringify({
        campaignId,
        tiktokUsername: handle,
        platformInfluencerId: platformKey,
        snapshot: snapshot || null,
        createdBy: "execution-heartbeat",
        createdAt: new Date().toISOString(),
      }),
    ]
  );
}


