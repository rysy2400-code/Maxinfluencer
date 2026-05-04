function pick(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  const out = {};
  for (const k of keys) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return Object.keys(out).length ? out : null;
}

function parsePayload(payload) {
  if (payload == null) return null;
  if (typeof payload === "object") return payload;
  if (typeof payload !== "string") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

export function toSafeTimelinePayload(payload) {
  const p = parsePayload(payload);
  if (!p || typeof p !== "object") return null;

  return {
    kind: p.kind ?? null,
    status: p.status ?? null,
    error: p.error ? pick(p.error, ["message"]) : null,
    email: p.email
      ? pick(p.email, ["to", "subject", "inReplyTo", "messageId"])
      : null,
    specialRequest: p.specialRequest
      ? pick(p.specialRequest, ["specialRequestId", "specialRequestStatus"])
      : null,
    advertiserAgentEvent: p.advertiserAgentEvent
      ? pick(p.advertiserAgentEvent, ["id", "eventType"])
      : null,
    attachments:
      p.attachments && Array.isArray(p.attachments.items)
        ? {
            source: p.attachments.source || null,
            items: p.attachments.items.map((a) =>
              pick(a, [
                "attachmentId",
                "dedupeKey",
                "filename",
                "contentType",
                "sizeBytes",
              ])
            ),
          }
        : null,
    summary: p.summary ?? null,
  };
}

export function parseTimelinePayload(payload) {
  return parsePayload(payload);
}

