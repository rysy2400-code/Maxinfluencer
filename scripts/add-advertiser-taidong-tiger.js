/**
 * 创建钛动科技公司管理员 tiger-admin（is_company_admin=1，非平台管理员）
 *
 * 执行前请先跑：node scripts/add-company-admin-column.js
 * 执行：node scripts/add-advertiser-taidong-tiger.js
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { hashPasswordForStorage } from "../lib/db/tiktok-advertiser-dao.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const COMPANY = "钛动科技";
const USER = "tiger-admin";
const PASS = "010813";

async function run() {
  let rows = await queryTikTok(`SELECT id FROM tiktok_advertiser WHERE name = ? LIMIT 1`, [COMPANY]);
  let advertiserId = rows?.[0]?.id;
  if (!advertiserId) {
    await queryTikTok(`INSERT INTO tiktok_advertiser (name) VALUES (?)`, [COMPANY]);
    rows = await queryTikTok(`SELECT id FROM tiktok_advertiser WHERE name = ? LIMIT 1`, [COMPANY]);
    advertiserId = rows[0].id;
    console.log("✅ 已创建公司:", COMPANY, "id=", advertiserId);
  } else {
    console.log("⏭️ 公司已存在:", COMPANY, "id=", advertiserId);
  }

  const hash = hashPasswordForStorage(PASS);
  rows = await queryTikTok(
    `SELECT id FROM tiktok_advertiser_user WHERE advertiser_id = ? AND username = ? LIMIT 1`,
    [advertiserId, USER]
  );
  const existingId = rows?.[0]?.id;
  if (existingId) {
    await queryTikTok(
      `UPDATE tiktok_advertiser_user
       SET password_hash = ?, is_active = 1, is_admin = 0, is_company_admin = 1
       WHERE id = ?`,
      [hash, existingId]
    );
    console.log("✅ 已更新公司管理员:", USER, "id=", existingId);
  } else {
    await queryTikTok(
      `INSERT INTO tiktok_advertiser_user
       (advertiser_id, username, password_hash, is_active, is_admin, is_company_admin)
       VALUES (?, ?, ?, 1, 0, 1)`,
      [advertiserId, USER, hash]
    );
    rows = await queryTikTok(
      `SELECT id FROM tiktok_advertiser_user WHERE advertiser_id = ? AND username = ? LIMIT 1`,
      [advertiserId, USER]
    );
    console.log("✅ 已创建公司管理员:", USER, "id=", rows[0].id);
  }
}

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("❌", e.message);
    process.exit(1);
  });
