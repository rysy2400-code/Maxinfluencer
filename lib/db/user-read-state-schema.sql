-- 未读提示：已读水位表（tiktok 库）
--
-- 口径说明（详见 Bin 工作台未读提示方案）：
-- - 水位按「真实登录用户」记账（reader_user_id 取 auth.realUser.advertiserUserId），
--   管理员代看（actingAs）时读到哪算管理员自己读到哪，不影响被代看账号。
-- - scope='session'：会话聊天框未读，last_read_seq 对齐
--   tiktok_campaign_sessions.assistant_message_seq。
-- - scope='campaign_influencer'：红人卡片沟通记录未读，last_read_seq / last_read_card_seq
--   分别对齐 tiktok_campaign_execution.infl_event_seq / infl_card_seq。
--   infl_event_seq 计入寄样条目（用于「待寄送样品」tab 徽标），infl_card_seq 不计入。

CREATE TABLE IF NOT EXISTS tiktok_user_read_state (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  reader_user_id INT NOT NULL COMMENT '真实登录用户 tiktok_advertiser_user.id',
  scope VARCHAR(32) NOT NULL COMMENT 'session=会话聊天框 / campaign_influencer=红人卡片',
  scope_key VARCHAR(191) NOT NULL COMMENT 'session=<sessionId>；campaign_influencer=<campaignId>:<username>',
  last_read_seq BIGINT NOT NULL DEFAULT 0 COMMENT '已读顺序水位（会话消息数 / 红人沟通条目数）',
  last_read_card_seq BIGINT NOT NULL DEFAULT 0 COMMENT '红人卡片已读水位（不含寄样条目）',
  last_read_at DATETIME NULL COMMENT '最后一次标记已读时间',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_reader_scope_key (reader_user_id, scope, scope_key),
  KEY idx_reader_scope (reader_user_id, scope)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='未读提示已读水位表';
