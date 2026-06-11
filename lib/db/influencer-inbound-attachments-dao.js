import { queryTikTok } from "./mysql-tiktok.js";

const META_SELECT = `
  id,
  event_id,
  message_id,
  part,
  content_id,
  filename,
  content_type,
  size_bytes,
  created_at
`;

function mapMetaRow(r) {
  return {
    inboundAttachmentId: r.id,
    eventId: r.event_id,
    messageId: r.message_id || null,
    part: r.part || null,
    contentId: r.content_id || null,
    filename: r.filename || null,
    contentType: r.content_type || null,
    sizeBytes: r.size_bytes ?? null,
    createdAt: r.created_at || null,
  };
}

export async function listInboundAttachmentsByEmailEventId(eventId) {
  if (!eventId) return [];
  const rows = await queryTikTok(
    `
    SELECT ${META_SELECT}
    FROM tiktok_influencer_email_event_attachments
    WHERE event_id = ?
    ORDER BY id ASC
  `,
    [eventId]
  );
  return (rows || []).map(mapMetaRow);
}

/** @param {number[]} eventIds */
export async function listInboundAttachmentsByEmailEventIds(eventIds) {
  const ids = [...new Set((eventIds || []).map((id) => Number(id)).filter((id) => id > 0))];
  if (!ids.length) return new Map();

  const placeholders = ids.map(() => "?").join(", ");
  const rows = await queryTikTok(
    `
    SELECT ${META_SELECT}
    FROM tiktok_influencer_email_event_attachments
    WHERE event_id IN (${placeholders})
    ORDER BY event_id ASC, id ASC
  `,
    ids
  );

  const map = new Map();
  for (const r of rows || []) {
    const key = r.event_id;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(mapMetaRow(r));
  }
  return map;
}

export async function getInboundAttachmentById(attachmentId) {
  if (!attachmentId) return null;
  const rows = await queryTikTok(
    `
    SELECT
      ${META_SELECT},
      content
    FROM tiktok_influencer_email_event_attachments
    WHERE id = ?
    LIMIT 1
  `,
    [attachmentId]
  );
  const r = rows?.[0];
  if (!r) return null;
  return {
    ...mapMetaRow(r),
    content: r.content,
  };
}
