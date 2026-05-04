import { getCampaignSessionById } from "../db/campaign-session-dao.js";

/**
 * @param {string} sessionId
 * @param {{ advertiserUserId: number, isAdmin: boolean }} authUser
 */
export async function assertUserCanAccessSession(sessionId, authUser) {
  if (!sessionId || !authUser) {
    return { ok: false, status: 401, session: null };
  }
  const session = await getCampaignSessionById(sessionId);
  if (!session) {
    return { ok: false, status: 404, session: null };
  }
  if (authUser.isAdmin) {
    return { ok: true, status: 200, session };
  }
  const ownerId = session.advertiserUserId != null ? Number(session.advertiserUserId) : null;
  if (ownerId == null || ownerId !== authUser.advertiserUserId) {
    return { ok: false, status: 403, session };
  }
  return { ok: true, status: 200, session };
}
