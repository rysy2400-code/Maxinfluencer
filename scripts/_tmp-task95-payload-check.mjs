import dotenv from "dotenv";
dotenv.config({ path: "C:\\maxinfluencer\\.env.local" });
dotenv.config({ path: "C:\\maxinfluencer\\.env" });
const { queryTikTok, tiktokPool } = await import("../lib/db/mysql-tiktok.js");

const rows = await queryTikTok(
  `SELECT payload FROM tiktok_influencer_import_task WHERE id=95`
);
const payload = rows?.[0]?.payload;
const parsed = typeof payload === "string" ? JSON.parse(payload) : payload || {};
const usernames = (parsed.rows || []).map((r) => String(r.username || "").replace(/^@/, "").toLowerCase());
for (const u of ["woody.rocks", "waynexisted", "ratherbefishing48", "nooneyzydeco", "annjackson951", "rachealb93"]) {
  console.log(`HAS ${u} = ${usernames.includes(u)}`);
}
console.log(`TOTAL ${usernames.length} UNIQ ${new Set(usernames).size}`);
await tiktokPool.end();
process.exit(0);
