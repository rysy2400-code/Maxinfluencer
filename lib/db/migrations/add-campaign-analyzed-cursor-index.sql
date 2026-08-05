-- 已分析红人列表加速（方案 4）：
-- 排序改为 analyzed_at DESC, id DESC（已分析行 analyzed_at 均非空，去掉 COALESCE），
-- 用 (campaign_id, analyzed_at DESC, id DESC) 索引消除 5 万行 filesort，并支撑键集分页。
-- 新索引完全覆盖旧的 idx_campaign_analyzed(campaign_id, analyzed_at DESC)，一并移除。
ALTER TABLE tiktok_campaign_influencer_candidates
  ADD INDEX idx_campaign_analyzed_cursor
    (campaign_id, analyzed_at DESC, id DESC),
  DROP INDEX idx_campaign_analyzed;
