-- Billing v1（库：tiktok）
-- 执行：node scripts/setup-billing-v1.js

CREATE TABLE IF NOT EXISTS tiktok_advertiser_balance_ledger (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  advertiser_id INT NOT NULL COMMENT 'tiktok_advertiser.id',
  amount DECIMAL(14,4) NOT NULL COMMENT '正=充值 负=消费',
  balance_after DECIMAL(14,4) NOT NULL,
  currency VARCHAR(16) NOT NULL DEFAULT 'USD',
  type VARCHAR(32) NOT NULL COMMENT 'top_up|quote_approve|adjustment',
  campaign_id VARCHAR(64) NULL,
  influencer_id VARCHAR(128) NULL,
  influencer_amount DECIMAL(14,4) NULL COMMENT '红人合作费（消费类）',
  platform_fee_amount DECIMAL(14,4) NULL COMMENT '平台服务费',
  platform_fee_rate DECIMAL(8,6) NULL COMMENT '扣款时平台服务费率快照，如 0.01 / 0.05',
  influencer_source VARCHAR(32) NULL COMMENT '扣款时红人来源快照 user_upload|web_search',
  campaign_name VARCHAR(255) NULL,
  influencer_display_name VARCHAR(255) NULL,
  note TEXT NULL,
  idempotency_key VARCHAR(255) NULL,
  created_by_user_id INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_ledger_idempotency (idempotency_key),
  KEY idx_ledger_advertiser_created (advertiser_id, created_at),
  KEY idx_ledger_advertiser_type (advertiser_id, type),
  CONSTRAINT fk_ledger_advertiser FOREIGN KEY (advertiser_id) REFERENCES tiktok_advertiser (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tiktok_advertiser_billing_profile (
  advertiser_id INT NOT NULL PRIMARY KEY,
  company_legal_name VARCHAR(255) NOT NULL,
  company_address TEXT NOT NULL,
  contact_name VARCHAR(128) NOT NULL,
  contact_email VARCHAR(255) NOT NULL,
  tax_id VARCHAR(128) NULL,
  country VARCHAR(128) NULL,
  updated_by_user_id INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_billing_profile_advertiser FOREIGN KEY (advertiser_id) REFERENCES tiktok_advertiser (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tiktok_advertiser_invoice (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  advertiser_id INT NOT NULL,
  invoice_no VARCHAR(64) NOT NULL,
  invoice_type VARCHAR(32) NOT NULL COMMENT 'recharge|monthly_consumption|influencer_campaign',
  document_title VARCHAR(255) NOT NULL,
  period_yyyymm CHAR(6) NOT NULL,
  seq INT NOT NULL,
  period_start DATE NULL,
  period_end DATE NULL,
  amount_usd DECIMAL(14,4) NOT NULL,
  line_items_json JSON NULL,
  pdf_storage_key VARCHAR(512) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'issued',
  email_sent_at TIMESTAMP NULL,
  email_error TEXT NULL,
  related_ledger_ids JSON NULL,
  related_top_up_id BIGINT NULL,
  issued_at TIMESTAMP NULL,
  created_by_user_id INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_invoice_no (invoice_no),
  UNIQUE KEY uk_invoice_advertiser_type_period_seq (advertiser_id, invoice_type, period_yyyymm, seq),
  KEY idx_invoice_advertiser_issued (advertiser_id, issued_at),
  CONSTRAINT fk_invoice_advertiser FOREIGN KEY (advertiser_id) REFERENCES tiktok_advertiser (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tiktok_advertiser_top_up (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  advertiser_id INT NOT NULL,
  amount_usd DECIMAL(14,4) NOT NULL,
  received_at DATE NOT NULL,
  bank_reference VARCHAR(255) NULL,
  note TEXT NULL,
  ledger_id BIGINT NULL,
  invoice_id BIGINT NULL,
  created_by_user_id INT NULL,
  notification_sent_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_topup_bank_ref_global (bank_reference),
  KEY idx_topup_advertiser_received (advertiser_id, received_at),
  CONSTRAINT fk_topup_advertiser FOREIGN KEY (advertiser_id) REFERENCES tiktok_advertiser (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tiktok_billing_notification_config (
  advertiser_id INT NOT NULL PRIMARY KEY,
  finance_notify_emails JSON NOT NULL COMMENT '["finance@example.com"]',
  updated_by_user_id INT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_billing_notify_advertiser FOREIGN KEY (advertiser_id) REFERENCES tiktok_advertiser (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
