import { queryTikTok } from "./mysql-tiktok.js";

export async function insertOutboundAttachment({
  dedupeKey,
  filename,
  contentType,
  sizeBytes,
  content,
}) {
  const r = await queryTikTok(
    `
    INSERT INTO tiktok_influencer_outbound_attachments
      (conversation_message_id, dedupe_key, filename, content_type, size_bytes, content)
    VALUES
      (NULL, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      id = LAST_INSERT_ID(id),
      filename = COALESCE(VALUES(filename), filename),
      content_type = COALESCE(VALUES(content_type), content_type),
      size_bytes = COALESCE(VALUES(size_bytes), size_bytes),
      content = COALESCE(VALUES(content), content)
  `,
    [dedupeKey, filename || null, contentType || null, sizeBytes || null, content]
  );
  return r?.insertId || null;
}

export async function attachOutboundAttachmentsToConversationMessage({
  conversationMessageId,
  dedupeKeys,
}) {
  if (!conversationMessageId || !Array.isArray(dedupeKeys) || !dedupeKeys.length) {
    return;
  }
  const placeholders = dedupeKeys.map(() => "?").join(", ");
  await queryTikTok(
    `
    UPDATE tiktok_influencer_outbound_attachments
    SET conversation_message_id = ?
    WHERE dedupe_key IN (${placeholders})
  `,
    [conversationMessageId, ...dedupeKeys]
  );
}

export async function listOutboundAttachmentsByConversationMessageId(conversationMessageId) {
  if (!conversationMessageId) return [];
  const rows = await queryTikTok(
    `
    SELECT id, filename, content_type, size_bytes
    FROM tiktok_influencer_outbound_attachments
    WHERE conversation_message_id = ?
    ORDER BY id ASC
  `,
    [conversationMessageId]
  );
  return rows || [];
}

export async function getOutboundAttachmentById(attachmentId) {
  if (!attachmentId) return null;
  const rows = await queryTikTok(
    `
    SELECT
      id,
      conversation_message_id,
      dedupe_key,
      filename,
      content_type,
      size_bytes,
      content,
      created_at
    FROM tiktok_influencer_outbound_attachments
    WHERE id = ?
    LIMIT 1
  `,
    [attachmentId]
  );
  return rows?.[0] || null;
}

