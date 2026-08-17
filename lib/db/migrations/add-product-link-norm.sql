-- 迁移：tiktok_campaign 增加归一化产品链接列（跨 campaign 查重用）
-- 归一化规则：去 https://、www.、尾部斜杠，统一小写（见 lib/campaign/product-link.js）
-- 历史数据中已存在重复链接，因此使用普通索引；重复阻止由应用层负责。
-- 说明：当前生产实现采用应用层 JS 归一化查重（lib/db/campaign-dao.js 的
-- findCampaignsByNormalizedProductLink），无需此 DDL；本文件仅作为未来
-- 数据量增大时落库列 + 索引方案的参考。执行前需先处理历史重复数据。

ALTER TABLE tiktok_campaign
  ADD COLUMN product_link_norm VARCHAR(512) NULL
  COMMENT '归一化产品链接（去协议/www/尾斜杠，小写），用于跨 campaign 查重'
  AFTER product_info;

CREATE INDEX idx_product_link_norm ON tiktok_campaign (product_link_norm);
