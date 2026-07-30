/** 红人执行 stage 常量（与 tiktok_campaign_execution.stage ENUM 一致） */
export const EXECUTION_STAGES = {
  PENDING_QUOTE: "pending_quote",
  QUOTE_SUBMITTED: "quote_submitted",
  PENDING_CREATOR_CONFIRMATION: "pending_creator_confirmation",
  QUOTE_REJECTED: "quote_rejected",
  PENDING_SHIPPING_ADDRESS: "pending_shipping_address",
  PENDING_SAMPLE: "pending_sample",
  PENDING_DRAFT: "pending_draft",
  DRAFT_SUBMITTED: "draft_submitted",
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

/**
 * Influencer Agent 建议的 stage 变更是否允许。
 * @returns {{ allowed: boolean, dataOnly?: boolean, reason?: string }}
 */
export function validateInfluencerAgentStageTransition(
  fromStage,
  toStage,
  lastEventRaw
) {
  const from = fromStage || EXECUTION_STAGES.PENDING_QUOTE;
  const to = toStage || from;
  const lastEvent = parseLastEvent(lastEventRaw);

  if (from === to) {
    return { allowed: true, dataOnly: true };
  }

  if (from === EXECUTION_STAGES.PENDING_QUOTE && to === EXECUTION_STAGES.QUOTE_SUBMITTED) {
    return { allowed: true };
  }

  if (from === EXECUTION_STAGES.QUOTE_REJECTED && to === EXECUTION_STAGES.QUOTE_SUBMITTED) {
    return { allowed: true };
  }

  if (
    from === EXECUTION_STAGES.PENDING_SHIPPING_ADDRESS &&
    to === EXECUTION_STAGES.PENDING_SAMPLE &&
    hasQuoteApproved(lastEvent)
  ) {
    return { allowed: true };
  }

  if (
    from === EXECUTION_STAGES.PENDING_DRAFT &&
    to === EXECUTION_STAGES.DRAFT_SUBMITTED &&
    hasQuoteApproved(lastEvent)
  ) {
    return { allowed: true };
  }

  if (from === EXECUTION_STAGES.DRAFT_SUBMITTED && to === EXECUTION_STAGES.DRAFT_SUBMITTED) {
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
 * 解析 Influencer Agent 更新：决定最终 stage 及各字段是否可写。
 */
export function resolveInfluencerAgentUpdate({
  currentStage,
  requestedStage,
  lastEventRaw,
  payload = {},
}) {
  const from = currentStage || EXECUTION_STAGES.PENDING_QUOTE;
  const requested = requestedStage || from;
  const lastEvent = parseLastEvent(lastEventRaw);
  const check = validateInfluencerAgentStageTransition(from, requested, lastEvent);

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
        from === EXECUTION_STAGES.PENDING_DRAFT));
  /** pending_sample 提前交稿：LLM 可报 draft_submitted，worker 只存 draftLink、不改 stage */
  const draftLinkOnly =
    from === EXECUTION_STAGES.PENDING_SAMPLE &&
    requested === EXECUTION_STAGES.DRAFT_SUBMITTED &&
    hasQuoteApproved(lastEvent) &&
    !check.allowed;

  const allowDraftLinkUpdate =
    hasQuoteApproved(lastEvent) &&
    (draftLinkOnly ||
      (effectiveStage === EXECUTION_STAGES.DRAFT_SUBMITTED &&
        (from === EXECUTION_STAGES.PENDING_DRAFT ||
          from === EXECUTION_STAGES.DRAFT_SUBMITTED)));
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
