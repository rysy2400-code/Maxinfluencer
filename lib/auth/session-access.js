import { getCampaignSessionById } from "../db/campaign-session-dao.js";

/**
 * @param {string} sessionId
 * @param {{ realUser?: { advertiserUserId: number, isAdmin: boolean }, effectiveUser?: { advertiserUserId: number }, isActingAs?: boolean, advertiserUserId?: number, isAdmin?: boolean }} authUser
 */
export async function assertUserCanAccessSession(sessionId, authUser) {
  if (!sessionId || !authUser) {
    return { ok: false, status: 401, session: null };
  }
  const session = await getCampaignSessionById(sessionId);
  if (!session) {
    return { ok: false, status: 404, session: null };
  }

  const realIsPlatformAdmin = authUser.realUser?.isAdmin ?? !!authUser.isAdmin;
  const isActingAs = !!authUser.isActingAs;
  const effectiveUserId =
    authUser.effectiveUser?.advertiserUserId ?? authUser.advertiserUserId;

  if (realIsPlatformAdmin && !isActingAs) {
    return { ok: true, status: 200, session };
  }

  const ownerId = session.advertiserUserId != null ? Number(session.advertiserUserId) : null;
  if (ownerId == null || ownerId !== effectiveUserId) {
    return { ok: false, status: 403, session };
  }
  return { ok: true, status: 200, session };
}
