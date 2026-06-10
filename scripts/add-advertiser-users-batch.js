/** node scripts/add-advertiser-users-batch.js — 批量创建非管理员广告主账户 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { hashPasswordForStorage } from "../lib/db/tiktok-advertiser-dao.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const ACCOUNTS = [
  { company: "易点天下", username: "李娇", password: "010813" },
  { company: "蓝色光标", username: "白佳畅", password: "010813" },
];

async function ensureAccount({ company, username, password }) {
  let rows = await queryTikTok(`SELECT id FROM tiktok_advertiser WHERE name = ? LIMIT 1`, [company]);
  let advertiserId = rows?.[0]?.id;
  if (!advertiserId) {
    await queryTikTok(`INSERT INTO tiktok_advertiser (name) VALUES (?)`, [company]);
    rows = await queryTikTok(`SELECT id FROM tiktok_advertiser WHERE name = ? LIMIT 1`, [company]);
    advertiserId = rows[0].id;
    console.log("✅ 已创建广告主:", company, "id=", advertiserId);
  } else {
    console.log("⏭️ 广告主已存在:", company, "id=", advertiserId);
  }

  const hash = hashPasswordForStorage(password);
  const ex = await queryTikTok(
    `SELECT id FROM tiktok_advertiser_user WHERE advertiser_id = ? AND username = ? LIMIT 1`,
    [advertiserId, username]
  );
  if (ex[0]) {
    await queryTikTok(
      `UPDATE tiktok_advertiser_user SET password_hash = ?, is_active = 1, is_admin = 0 WHERE id = ?`,
      [hash, ex[0].id]
    );
    console.log("✅ 已更新用户:", company, "/", username, "id=", ex[0].id);
  } else {
    await queryTikTok(
      `INSERT INTO tiktok_advertiser_user (advertiser_id, username, password_hash, is_active, is_admin)
       VALUES (?, ?, ?, 1, 0)`,
      [advertiserId, username, hash]
    );
    const r = await queryTikTok(
      `SELECT id FROM tiktok_advertiser_user WHERE advertiser_id = ? AND username = ? LIMIT 1`,
      [advertiserId, username]
    );
    console.log("✅ 已创建用户:", company, "/", username, "id=", r[0].id);
  }
}

async function run() {
  for (const account of ACCOUNTS) {
    await ensureAccount(account);
  }
}

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
