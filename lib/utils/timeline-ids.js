export function buildTraceIdFromInboundMessageId(inboundMessageId) {
  const mid = String(inboundMessageId || "").trim();
  return mid ? `trace:${mid}` : `trace:unknown:${Date.now().toString(36)}`;
}

export function buildDraftMessageId(inboundMessageId) {
  const mid = String(inboundMessageId || "").trim();
  return `draft:${mid || `unknown:${Date.now().toString(36)}`}`;
}

export function buildActionMessageId(inboundMessageId, actionName) {
  const mid = String(inboundMessageId || "").trim();
  const a = String(actionName || "").trim() || "action";
  return `action:${mid || `unknown:${Date.now().toString(36)}`}:${a}`;
}

export function buildCampaignUpdateMessageId(advertiserAgentEventId) {
  const id = advertiserAgentEventId == null ? "" : String(advertiserAgentEventId).trim();
  return `campupd:${id || `unknown:${Date.now().toString(36)}`}`;
}

export function buildTraceIdFromSourceKey(sourceKey) {
  const k = String(sourceKey || "").trim();
  return k ? `trace:${k}` : `trace:unknown:${Date.now().toString(36)}`;
}

