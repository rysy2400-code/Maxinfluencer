import { queryTikTok } from "./mysql-tiktok.js";

/**
 * @param {{ realAdvertiserUserId: number, effectiveAdvertiserUserId: number, action: string, resourceType?: string | null, resourceId?: string | null, meta?: object | null }} entry
 */
export async function insertAdminActionLog(entry) {
  const metaJson = entry.meta != null ? JSON.stringify(entry.meta) : null;
  await queryTikTok(
    `INSERT INTO admin_action_log
      (real_advertiser_user_id, effective_advertiser_user_id, action, resource_type, resource_id, meta)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      entry.realAdvertiserUserId,
      entry.effectiveAdvertiserUserId,
      entry.action,
      entry.resourceType ?? null,
      entry.resourceId ?? null,
      metaJson,
    ]
  );
}
