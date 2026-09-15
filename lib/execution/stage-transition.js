import { validateQuoteSubmittedAdmission } from "./agreed-terms.js";

/** 红人执行 stage 常量（与 tiktok_campaign_execution.stage ENUM 一致） */
export const EXECUTION_STAGES = {
  PENDING_QUOTE: "pending_quote",
  QUOTE_SUBMITTED: "quote_submitted",
  PENDING_CREATOR_CONFIRMATION: "pending_creator_confirmation",
  QUOTE_REJECTED: "quote_rejected",
  PENDING_SHIPPING_ADDRESS: "pending_shipping_address",
  PENDING_SAMPLE: "pending_sample",
  PENDING_SCRIPT: "pending_script",
  SCRIPT_REVIEW: "script_review",
  VIDEO_REVIEW: "video_review",
  PENDING_VIDEO: "pending_video",
  PUBLISHED: "published",
};

function parseLastEvent(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

export function hasQuoteApproved(lastEvent) {
  const ev = typeof lastEvent === "object" && lastEvent ? lastEvent : {};
  return Boolean(ev.quoteApprovedAt);
}

export function hasDraftApproved(lastEvent) {
  const ev = typeof lastEvent === "object" && lastEvent ? lastEvent : {};
  return Boolean(ev.draftApprovedAt);
}

export function hasScriptApproved(lastEvent) {
  const ev = typeof lastEvent === "object" && lastEvent ? lastEvent : {};
  return Boolean(
    ev.scriptApprovedAt ||
      (Array.isArray(ev.deliverablesTimeline) &&
        ev.deliverablesTimeline.some(
          (e) => e?.kind === "script" && e?.type === "approved"
        ))
  );
}

/**
 * Influencer Agent 建议的 stage 变更是否允许。
 * @param {object|null} [agreedTerms] 本条红人执行级的「已谈定条款」（固定费 + 佣金）。
 *   传入时，进 quote_submitted 需要两者都是明确值（可以是 0）；不传则维持历史行为。
 * @returns {{ allowed: boolean, dataOnly?: boolean, reason?: string }}
 */
export function validateInfluencerAgentStageTransition(
  fromStage,
  toStage,
  lastEventRaw,
  agreedTerms = null
) {
  const from = fromStage || EXECUTION_STAGES.PENDING_QUOTE;
  const to = toStage || from;
  const lastEvent = parseLastEvent(lastEventRaw);

  if (from === to) {
    return { allowed: true, dataOnly: true };
  }

  if (from === EXECUTION_STAGES.PENDING_QUOTE && to === EXECUTION_STAGES.QUOTE_SUBMITTED) {
    return checkQuoteSubmittedAdmission(agreedTerms);
  }

  if (from === EXECUTION_STAGES.QUOTE_REJECTED && to === EXECUTION_STAGES.QUOTE_SUBMITTED) {
    return checkQuoteSubmittedAdmission(agreedTerms);
  }

  if (
    from === EXECUTION_STAGES.PENDING_SHIPPING_ADDRESS &&
    to === EXECUTION_STAGES.PENDING_SAMPLE &&
    hasQuoteApproved(lastEvent)
  ) {
    return { allowed: true };
  }

  if (
    from === EXECUTION_STAGES.PENDING_SCRIPT &&
    to === EXECUTION_STAGES.SCRIPT_REVIEW &&
    hasQuoteApproved(lastEvent)
  ) {
    return { allowed: true };
  }

  if (
    from === EXECUTION_STAGES.PENDING_VIDEO &&
    to === EXECUTION_STAGES.VIDEO_REVIEW &&
    hasScriptApproved(lastEvent)
  ) {
    return { allowed: true };
  }

  if (
    (from === EXECUTION_STAGES.SCRIPT_REVIEW && to === EXECUTION_STAGES.SCRIPT_REVIEW) ||
    (from === EXECUTION_STAGES.VIDEO_REVIEW && to === EXECUTION_STAGES.VIDEO_REVIEW)
  ) {
    return { allowed: true };
  }

  if (
    from === EXECUTION_STAGES.PUBLISHED &&
    to === EXECUTION_STAGES.PUBLISHED &&
    hasDraftApproved(lastEvent)
  ) {
    return { allowed: true, dataOnly: true };
  }

  return {
    allowed: false,
    reason: `Influencer Agent 不可将 stage 从「${from}」变更为「${to}」；后续阶段需广告主在 Portal 操作后推进。`,
  };
}

/**
 * 硬准入：进入「待审核价格」前，固定费与佣金都必须已明确（可以是 0）。
 * 未明确时保持待报价，由红人沟通侧继续确认，而不是把空价格卡片推给广告主。
 */
function checkQuoteSubmittedAdmission(agreedTerms) {
  if (!agreedTerms || typeof agreedTerms !== "object") {
    return { allowed: true };
  }
  const admission = validateQuoteSubmittedAdmission(agreedTerms);
  if (admission.ready) return { allowed: true };
  return { allowed: false, reason: admission.reason };
}

/**
 * 解析 Influencer Agent 更新：决定最终 stage 及各字段是否可写。
 */
export function resolveInfluencerAgentUpdate({
  currentStage,
  requestedStage,
  lastEventRaw,
  payload = {},
  agreedTerms = null,
}) {
  const from = currentStage || EXECUTION_STAGES.PENDING_QUOTE;
  const requested = requestedStage || from;
  const lastEvent = parseLastEvent(lastEventRaw);
  const check = validateInfluencerAgentStageTransition(
    from,
    requested,
    lastEvent,
    agreedTerms
  );

  const effectiveStage = check.allowed ? requested : from;
  const stageChanged = check.allowed && from !== requested;

  const quotePhase = new Set([
    EXECUTION_STAGES.PENDING_QUOTE,
    EXECUTION_STAGES.QUOTE_SUBMITTED,
    EXECUTION_STAGES.QUOTE_REJECTED,
  ]);

  const allowFlatFeeUpdate = quotePhase.has(from);
  const allowShippingInfoUpdate =
    from === EXECUTION_STAGES.PENDING_SHIPPING_ADDRESS ||
    from === EXECUTION_STAGES.PENDING_SAMPLE ||
    (hasQuoteApproved(lastEvent) &&
      (from === EXECUTION_STAGES.QUOTE_SUBMITTED ||
        from === EXECUTION_STAGES.PENDING_SCRIPT ||
        from === EXECUTION_STAGES.PENDING_VIDEO));
  /** pending_sample 提前交稿：LLM 可报 script_review/video_review，worker 只存 draftLink、不改 stage */
  const draftLinkOnly =
    from === EXECUTION_STAGES.PENDING_SAMPLE &&
    (requested === EXECUTION_STAGES.SCRIPT_REVIEW ||
      requested === EXECUTION_STAGES.VIDEO_REVIEW) &&
    hasQuoteApproved(lastEvent) &&
    !check.allowed;

  const allowDraftLinkUpdate =
    hasQuoteApproved(lastEvent) &&
    (draftLinkOnly ||
      (effectiveStage === EXECUTION_STAGES.SCRIPT_REVIEW &&
        (from === EXECUTION_STAGES.PENDING_SCRIPT ||
          from === EXECUTION_STAGES.SCRIPT_REVIEW)) ||
      (effectiveStage === EXECUTION_STAGES.VIDEO_REVIEW &&
        (from === EXECUTION_STAGES.PENDING_VIDEO ||
          from === EXECUTION_STAGES.VIDEO_REVIEW)));
  const allowVideoLinkUpdate =
    from === EXECUTION_STAGES.PUBLISHED && hasDraftApproved(lastEvent);

  return {
    effectiveStage,
    stageChanged,
    skippedStageReason: check.allowed ? null : check.reason || null,
    draftLinkOnly,
    allowFlatFeeUpdate,
    allowShippingInfoUpdate,
    allowDraftLinkUpdate,
    allowVideoLinkUpdate,
  };
}
