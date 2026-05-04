import { queryTikTok } from "./mysql-tiktok.js";

export async function getInfluencerHandoverMode(influencerId) {
  const rows = await queryTikTok(
    "SELECT handover_mode FROM tiktok_influencer WHERE influencer_id = ? LIMIT 1",
    [influencerId]
  );
  if (!rows || !rows[0]) return null;
  return rows[0].handover_mode || "assist";
}

export async function setInfluencerHandoverMode(influencerId, mode) {
  const m = mode === "auto" ? "auto" : "assist";
  await queryTikTok(
    "UPDATE tiktok_influencer SET handover_mode = ?, updated_at = CURRENT_TIMESTAMP WHERE influencer_id = ?",
    [m, influencerId]
  );
  return m;
}

