/** node scripts/add-advertiser-user-serena.js */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { hashPasswordForStorage } from "../lib/db/tiktok-advertiser-dao.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });
const COMPANY = "MaxinAI", USER = "Serena", PASS = "010813";
async function run() {
  const a = await queryTikTok(`SELECT id FROM tiktok_advertiser WHERE name=? LIMIT 1`, [COMPANY]);
  if (!a[0]) throw new Error("广告主不存在，先跑 setup-tiktok-advertiser-auth.js");
  const aid = a[0].id, h = hashPasswordForStorage(PASS);
  const ex = await queryTikTok(
    `SELECT id FROM tiktok_advertiser_user WHERE advertiser_id=? AND username=? LIMIT 1`,
    [aid, USER]
  );
  if (ex[0]) {
    await queryTikTok(
      `UPDATE tiktok_advertiser_user SET password_hash=?,is_active=1,is_admin=0 WHERE id=?`,
      [h, ex[0].id]
    );
    console.log("✅ 更新", USER, "id=", ex[0].id);
  } else {
    await queryTikTok(
      `INSERT INTO tiktok_advertiser_user (advertiser_id,username,password_hash,is_active,is_admin) VALUES (?,?,?,?,0)`,
      [aid, USER, h, 1]
    );
    const r = await queryTikTok(
      `SELECT id FROM tiktok_advertiser_user WHERE advertiser_id=? AND username=?`,
      [aid, USER]
    );
    console.log("✅ 创建", USER, "id=", r[0].id);
  }
}
run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
