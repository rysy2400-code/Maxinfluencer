ALTER TABLE tiktok_campaign_execution
  ADD INDEX idx_campaign_stage_created_cursor
    (campaign_id, stage, created_at DESC, id DESC),
  ADD INDEX idx_campaign_stage_updated_cursor
    (campaign_id, stage, updated_at DESC, id DESC);
