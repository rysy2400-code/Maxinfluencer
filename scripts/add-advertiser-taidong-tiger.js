/** node scripts/add-advertiser-taidong-tiger.js — 创建钛动科技 / Tiger 账户 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { hashPasswordForStorage } from "../lib/db/tiktok-advertiser-dao.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const COMPANY = "钛动科技";
const USER = "Tiger";
const PASS = "010813";

async function run() {
  let rows = await queryTikTok(`SELECT id FROM tiktok_advertiser WHERE name = ? LIMIT 1`, [COMPANY]);
  let advertiserId = rows?.[0]?.id;
  if (!advertiserId) {
    await queryTikTok(`INSERT INTO tiktok_advertiser (name) VALUES (?)`, [COMPANY]);
    rows = await queryTikTok(`SELECT id FROM tiktok_advertiser WHERE name = ? LIMIT 1`, [COMPANY]);
    advertiserId = rows[0].id;
    console.log("✅ 已创建广告主:", COMPANY, "id=", advertiserId);
  } else {
    console.log("⏭️ 广告主已存在:", COMPANY, "id=", advertiserId);
  }

  const hash = hashPasswordForStorage(PASS);
  const ex = await queryTikTok(
    `SELECT id FROM tiktok_advertiser_user WHERE advertiser_id = ? AND username = ? LIMIT 1`,
    [advertiserId, USER]
  );
  if (ex[0]) {
    await queryTikTok(
      `UPDATE tiktok_advertiser_user SET password_hash = ?, is_active = 1, is_admin = 0 WHERE id = ?`,
      [hash, ex[0].id]
    );
    console.log("✅ 已更新用户:", USER, "id=", ex[0].id);
  } else {
    await queryTikTok(
      `INSERT INTO tiktok_advertiser_user (advertiser_id, username, password_hash, is_active, is_admin)
       VALUES (?, ?, ?, 1, 0)`,
      [advertiserId, USER, hash]
    );
    const r = await queryTikTok(
      `SELECT id FROM tiktok_advertiser_user WHERE advertiser_id = ? AND username = ? LIMIT 1`,
      [advertiserId, USER]
    );
    console.log("✅ 已创建用户:", USER, "id=", r[0].id);
  }
}

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
