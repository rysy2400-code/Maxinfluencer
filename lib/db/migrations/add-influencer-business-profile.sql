ALTER TABLE tiktok_influencer
  ADD COLUMN business_profile_markdown MEDIUMTEXT NULL COMMENT '红人商务档案（固定 Markdown 模板，唯一内容存储）',
  ADD COLUMN business_profile_updated_at DATETIME NULL,
  ADD COLUMN business_profile_source_message_id VARCHAR(255) NULL,
  ADD COLUMN contact_status VARCHAR(32) NOT NULL DEFAULT 'contactable',
  ADD COLUMN do_not_contact_at DATETIME NULL,
  ADD COLUMN do_not_contact_reason TEXT NULL,
  ADD COLUMN do_not_contact_source_message_id VARCHAR(255) NULL;

ALTER TABLE tiktok_campaign_execution
  ADD COLUMN quote_origin VARCHAR(32) NULL COMMENT 'creator_quote|commerce_profile_estimate';

ALTER TABLE tiktok_campaign_execution
  MODIFY COLUMN stage ENUM(
    'pending_quote','quote_submitted','pending_creator_confirmation',
    'pending_sample','pending_draft','draft_submitted','published','quote_rejected'
  ) NOT NULL DEFAULT 'pending_quote';
