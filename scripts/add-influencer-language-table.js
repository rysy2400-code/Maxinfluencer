/**
 * 幂等创建「红人语言」旁路表。
 *
 * 为什么用独立表而不是给 TikTok_influencer 加列：
 * TikTok_influencer 是千万级 / 数十 GB 的大表，且线上存在长事务长期持有元数据锁，
 * 在其上加列会让 ALTER 排在 MDL 队列头部、反把爬虫的 INSERT 全部堵住。
 * 语言是「按需读取的派生属性」，放独立小表更安全，也避免 UPDATE 大表行。
 *
 * 表结构：
 * - bio_language*：搜索任务执行时从红人主页简介推断的语言（卡片展示用）；
 * - communication_language*：与该红人发信实际使用的语言，以红人最近一次回复语言为准，
 *   未回复时按 bio 语言（置信度过线）兜底，否则英语。
 *
 * 用法: node scripts/add-influencer-language-table.js
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

export const INFLUENCER_LANGUAGE_TABLE = "tiktok_influencer_language";

const DDL = `
CREATE TABLE IF NOT EXISTS ${INFLUENCER_LANGUAGE_TABLE} (
  influencer_id VARCHAR(128) NOT NULL COMMENT '与 TikTok_influencer.influencer_id 对齐',
  bio_language VARCHAR(16) NULL COMMENT '主页简介推断语言（BCP-47 简码）',
  bio_language_confidence DECIMAL(4,2) NULL COMMENT 'bio 语言推断置信度 0~1',
  bio_language_source VARCHAR(32) NULL COMMENT 'script / latin_hint / ascii_default',
  bio_language_checked_at DATETIME NULL COMMENT '最近一次推断 bio 语言时间',
  communication_language VARCHAR(16) NULL COMMENT '与该红人发信使用的语言（BCP-47 简码）',
  communication_language_source VARCHAR(32) NULL COMMENT 'reply / bio / default / manual',
  communication_language_updated_at DATETIME NULL COMMENT '最近一次更新沟通语言时间',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (influencer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='红人画像语言与沟通语言（旁路小表，避免动大表）'
`;

async function main() {
  await queryTikTok(DDL);
  const rows = await queryTikTok(
    `SELECT COUNT(*) AS n FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [INFLUENCER_LANGUAGE_TABLE]
  );
  console.log(
    Number(rows?.[0]?.n || 0) > 0
      ? `✅ 表已就绪: ${INFLUENCER_LANGUAGE_TABLE}`
      : `❌ 表创建失败: ${INFLUENCER_LANGUAGE_TABLE}`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ 建表失败:", err?.message || err);
    process.exit(1);
  });
