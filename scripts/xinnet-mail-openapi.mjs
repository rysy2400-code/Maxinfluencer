/**
 * 新网全球邮 OpenAPI（open.global-mail.cn）
 *
 * 文档: http://images.global-mail.cn/openapidoc/api.html
 * 凭证来自 webmail 管理后台「企业服务 → 开放接口」：corpid / corpsecret
 *
 * 签名:
 *   token : sign = md5(corpid + "_" + uuid + "_" + ts + "_" + corpsecret)
 *   api   : sign = md5(json + "_" + corpid + "_" + uuid + "_" + ts + "_" + access_token + "_" + corpsecret)
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const envFile = path.join(root, ".env.xinnet.local");
const env = Object.fromEntries(
  (fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

// 注意：官方 OpenAPI 走 http（https 会 502）
const BASE = process.env.MAIL_OPENAPI_BASE || "http://open.global-mail.cn";
const CORP_ID = process.env.MAIL_CORP_ID || env.MAIL_CORP_ID;
const CORP_SECRET = process.env.MAIL_CORP_SECRET || env.MAIL_CORP_SECRET;

export const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");
export const uuid = () => crypto.randomUUID();

/** 密码加密：AES-128-CBC，key=md5(secret)[0:16]，iv=md5(secret)[16:32] */
export function encryptPassword(plain, secret = CORP_SECRET) {
  const h = md5(secret);
  const key = Buffer.from(h.slice(0, 16), "utf8");
  const iv = Buffer.from(h.slice(16, 32), "utf8");
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]).toString("base64");
}

let cachedToken = null;

export async function getAccessToken() {
  if (cachedToken) return cachedToken;
  const ts = String(Date.now());
  const u = uuid();
  const sign = md5(`${CORP_ID}_${u}_${ts}_${CORP_SECRET}`);
  // 实测：/token 用 GET 才通（POST 会 404）
  const url = `${BASE}/token?corpId=${encodeURIComponent(CORP_ID)}&uuid=${u}&ts=${ts}&sign=${sign}`;
  const res = await fetch(url, { method: "GET" });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* raw */
  }
  const token = json?.data?.accessToken;
  if (!token) throw new Error(`获取 access_token 失败: ${text.slice(0, 300)}`);
  cachedToken = token;
  return token;
}

export async function mailApi(apiPath, body = {}) {
  const token = await getAccessToken();
  const ts = String(Date.now());
  const u = uuid();
  const json = JSON.stringify(body);
  const sign = md5(`${json}_${CORP_ID}_${u}_${ts}_${token}_${CORP_SECRET}`);
  const url = `${BASE}${apiPath}?access_token=${encodeURIComponent(token)}&corpid=${encodeURIComponent(
    CORP_ID
  )}&ts=${ts}&uuid=${u}&sign=${sign}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: json,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* raw */
  }
  return { http: res.status, json: parsed, text };
}

export const mailApiHelpers = {
  queryUsers: (params) => mailApi("/api/user/queryUsers", params),
  addUser: (params) => mailApi("/api/user/addUser", params),
  updateUser: (params) => mailApi("/api/user/updateUser", params),
  updateUserPWD: (params) => mailApi("/api/user/updateUserPWD", params),
  getUser: (params) => mailApi("/api/user/getUser", params),
  delUser: (params) => mailApi("/api/user/delUser", params),
  getOrgTree: (params) => mailApi("/api/org/getOrgTree", params),
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [cmd, ...args] = process.argv.slice(2);
  (async () => {
    if (cmd === "token") return { accessToken: await getAccessToken() };
    if (cmd === "orgs") return mailApiHelpers.getOrgTree({ domainName: args[0] });
    if (cmd === "users") return mailApiHelpers.queryUsers({ domainName: args[0] });
    if (cmd === "user") return mailApiHelpers.getUser({ domainName: args[0], loginuserid: args[1] });
    if (cmd === "encrypt") return { plain: args[0], encrypted: encryptPassword(args[0]) };
    throw new Error(`未知命令: ${cmd}`);
  })()
    .then((r) => console.log(JSON.stringify(r?.json ?? r, null, 2)))
    .catch((e) => {
      console.error("ERR", e.message);
      process.exit(1);
    });
}
