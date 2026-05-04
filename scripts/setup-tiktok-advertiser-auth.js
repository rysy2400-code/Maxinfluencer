/**
 * 创建 tiktok_advertiser / tiktok_advertiser_user 表，
 * 为 tiktok_campaign_sessions 增加 advertiser_user_id，
 * 并插入默认账号：公司 MaxinAI、用户 Bin、密码 010813（6 位数字），is_admin=1，
 * 将历史会话 advertiser_user_id 绑定到该用户。
 *
 * 执行：node scripts/setup-tiktok-advertiser-auth.js
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { hashPasswordForStorage } from "../lib/db/tiktok-advertiser-dao.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const SESSION_TABLE = "tiktok_campaign_sessions";

async function ensureTables() {
  await queryTikTok(`
    CREATE TABLE IF NOT EXISTS tiktok_advertiser (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL COMMENT '展示名',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_advertiser_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await queryTikTok(`
    CREATE TABLE IF NOT EXISTS tiktok_advertiser_user (
      id INT AUTO_INCREMENT PRIMARY KEY,
      advertiser_id INT NOT NULL,
      username VARCHAR(64) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      is_admin TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_advertiser_username (advertiser_id, username),
      KEY idx_advertiser_id (advertiser_id),
      CONSTRAINT fk_advertiser_user_advertiser FOREIGN KEY (advertiser_id) REFERENCES tiktok_advertiser (id)
        ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function ensureSessionColumn() {
  try {
    await queryTikTok(
      `ALTER TABLE ${SESSION_TABLE} ADD COLUMN advertiser_user_id INT NULL COMMENT 'tiktok_advertiser_user.id'`
    );
    console.log(`✅ ${SESSION_TABLE}.advertiser_user_id 已添加`);
  } catch (e) {
    if (e.message && /Duplicate column name/i.test(e.message)) {
      console.log(`⏭️ ${SESSION_TABLE}.advertiser_user_id 已存在`);
    } else {
      throw e;
    }
  }
  try {
    await queryTikTok(
      `ALTER TABLE ${SESSION_TABLE} ADD INDEX idx_campaign_sessions_advertiser_user (advertiser_user_id)`
    );
    console.log("✅ idx_campaign_sessions_advertiser_user 已添加");
  } catch (e) {
    if (e.message && /Duplicate key name/i.test(e.message)) {
      console.log("⏭️ idx_campaign_sessions_advertiser_user 已存在");
    } else {
      console.warn("⚠️ 索引添加:", e.message);
    }
  }
}

async function run() {
  await ensureTables();
  await ensureSessionColumn();

  const companyName = "MaxinAI";
  const username = "Bin";
  const initialPassword = "010813";

  let rows = await queryTikTok(`SELECT id FROM tiktok_advertiser WHERE name = ? LIMIT 1`, [companyName]);
  let advertiserId = rows?.[0]?.id;
  if (!advertiserId) {
    await queryTikTok(`INSERT INTO tiktok_advertiser (name) VALUES (?)`, [companyName]);
    rows = await queryTikTok(`SELECT id FROM tiktok_advertiser WHERE name = ? LIMIT 1`, [companyName]);
    advertiserId = rows[0].id;
    console.log("✅ 已创建广告主:", companyName, "id=", advertiserId);
  } else {
    console.log("⏭️ 广告主已存在:", companyName, "id=", advertiserId);
  }

  rows = await queryTikTok(
    `SELECT id FROM tiktok_advertiser_user WHERE advertiser_id = ? AND username = ? LIMIT 1`,
    [advertiserId, username]
  );
  let userId = rows?.[0]?.id;
  if (!userId) {
    const hash = hashPasswordForStorage(initialPassword);
    await queryTikTok(
      `INSERT INTO tiktok_advertiser_user (advertiser_id, username, password_hash, is_active, is_admin)
       VALUES (?, ?, ?, 1, 1)`,
      [advertiserId, username, hash]
    );
    rows = await queryTikTok(
      `SELECT id FROM tiktok_advertiser_user WHERE advertiser_id = ? AND username = ? LIMIT 1`,
      [advertiserId, username]
    );
    userId = rows[0].id;
    console.log("✅ 已创建用户:", username, "id=", userId, "（管理员，初始密码 010813）");
  } else {
    await queryTikTok(
      `UPDATE tiktok_advertiser_user SET is_admin = 1 WHERE id = ?`,
      [userId]
    );
    console.log("⏭️ 用户已存在，已确保 is_admin=1:", username, "id=", userId);
  }

  const upd = await queryTikTok(
    `UPDATE ${SESSION_TABLE} SET advertiser_user_id = ? WHERE advertiser_user_id IS NULL`,
    [userId]
  );
  console.log("✅ 已绑定历史会话 advertiser_user_id，影响行数:", upd?.affectedRows ?? "n/a");

  console.log("\n完成。请在生产设置强随机 AUTH_JWT_SECRET。");
  process.exit(0);
}

run().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
