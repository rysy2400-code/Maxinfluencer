-- 邮件事件 LLM 决策失败重试：记录已尝试次数
ALTER TABLE tiktok_influencer_email_events
  ADD COLUMN attempt_count INT NOT NULL DEFAULT 0 COMMENT '处理尝试次数（LLM 失败重试用）'
  AFTER error_message;
