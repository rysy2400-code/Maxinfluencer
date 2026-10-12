/**
 * 新网 域名APIv2 调用封装（只读用途为主）
 *
 * 文档: https://apidoc.xin.cn/doc-7283837
 * 鉴权: header timestamp(UTC yyyyMMdd'T'HHmmss'Z') + authorization
 *        authorization = "HMAC-SHA256 Access=agent7973399, Signature=<hmac>"
 *        Signature = HMAC-SHA256(stringToSign, appSecret)
 *        stringToSign = "HMAC-SHA256\n<ts>\nPOST\n<urlPath/>\n<requestBody>"
 *
 * 凭证从 .env.xinnet.local 读取（gitignored）：
 *   XINNET_DOMAIN_API_TOKEN  = appSecret
 *   XINNET_DOMAIN_ACCESS     = agentCode（默认 agent7973399）
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function loadEnvFile(rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(abs, "utf8")
      .split("\n")
      .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      })
  );
}

const env = { ...loadEnvFile(".env.xinnet.local"), ...process.env };
const APP_SECRET = env.XINNET_DOMAIN_API_TOKEN;
const ACCESS = env.XINNET_DOMAIN_ACCESS || "agent7973399";
const BASE = "https://apiv2.xinnet.com";
const XAPI_PUBLIC_KEY = env.XINNET_XAPI_PUBLIC_KEY;
const XAPI_PRIVATE_KEY = env.XINNET_XAPI_PRIVATE_KEY;
const XAPI_BASE = "https://x-api.xinnet.com";

export function utcTimestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

export function sign(urlPath, requestBody, signerDate, secret = APP_SECRET) {
  const stringToSign = ["HMAC-SHA256", signerDate, "POST", urlPath, requestBody].join("\n");
  return crypto.createHmac("sha256", secret).update(stringToSign, "utf8").digest("hex");
}

/**
 * 注意：签名串里的 urlPath 必须带结尾 "/"，但实际请求 URL 不带。
 * 文档示例：请求 https://apiv2.xinnet.com/api/domain/check
 *          stringToSign 里用 "/api/domain/check/"
 */
export async function domainApi(urlPath, params = {}) {
  const requestPath = urlPath.replace(/\/+$/, "");
  const signPath = requestPath + "/";
  const requestBody = JSON.stringify(params);
  const signerDate = utcTimestamp();
  const signature = sign(signPath, requestBody, signerDate);
  const res = await fetch(BASE + requestPath, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      timestamp: signerDate,
      authorization: `HMAC-SHA256 Access=${ACCESS}, Signature=${signature}`,
    },
    body: requestBody,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep raw */
  }
  return { http: res.status, json, text };
}

/** 云主机/邮局等 X-API（Xn-PublicKey + Xn-Signature，body 里带 authTimestamp） */
export async function xapi(xPath, params = {}) {
  const body = JSON.stringify({ authTimestamp: String(Date.now()), ...params });
  const signature = crypto.createHmac("sha256", XAPI_PRIVATE_KEY).update(body, "utf8").digest("hex");
  const res = await fetch(XAPI_BASE + xPath, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Xn-PublicKey": XAPI_PUBLIC_KEY,
      "Xn-Signature": signature,
    },
    body,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep raw */
  }
  return { http: res.status, json, text };
}

export const api = {
  balance: () => domainApi("/api/account/queryBalance"),
  productPrice: (queryType) => domainApi("/api/account/queryProductPrice", { queryType }),
  check: (prefix, suffix) => domainApi("/api/domain/check", { prefix, suffix }),
  domainList: (params) => domainApi("/api/domain/queryDomainList", params),
  domainPage: (params) => domainApi("/api/domain/list", params),
  domainInfo: (params) => domainApi("/api/domain/queryDomainInfo", params),
  domainQuery: (domainName) => domainApi("/api/domain/query", { domainName }),
  templateList: (params) => domainApi("/api/template/list", params),
  register: (domainName, templateName, year = 1) =>
    domainApi("/api/domain/create", {
      domainName,
      templateName,
      year,
      price: null,
      registrar: "xinnet",
      dns1: "ns11.xincache.com",
      dns2: "ns12.xincache.com",
      dns3: "",
      dns4: "",
      dns5: "",
      dns6: "",
      dns7: "",
      dns8: "",
    }),
  mailOpen: (domainName, serviceCode, companyName, userEmail) =>
    xapi("/mailcloud/qqy/open", { domainName, serviceCode, companyName, userEmail }),
  mailServiceDetail: (domainName) => xapi("/mailcloud/qqy/get", { domainName }),
  mailServiceList: (params) => xapi("/mailcloud/qqy/query", params),
  dnsCheck: (domainName) => domainApi("/api/dns/checkDomain", { domainName }),
  dnsOpen: (domainName) => domainApi("/api/dns/openDomain", { domainName }),
  dnsDomain: (domainName) => domainApi("/api/dns/queryDomain", { domainName }),
  dnsRecords: (domainName, domainId, pageNo = 1, pageSize = 50) =>
    domainApi("/api/dns/queryRecordsPage", { domainName, domainId, pageNo, pageSize }),
  dnsCreate: (params) => domainApi("/api/dns/create", params),
};

/** 从注册价表里抽出「首年价格」，key 形如 "英文.site" / "H英文.monster" / "转入英文.fan" */
export function firstYearPrices(priceMap) {
  const rows = [];
  for (const [key, list] of Object.entries(priceMap || {})) {
    if (!/英文/.test(key)) continue;
    if (/(赎回|转入|续费)/.test(key)) continue;
    const tld = key.slice(key.lastIndexOf(".")).toLowerCase();
    const oneYear = (list || []).find((x) => x.timeAmount === "1");
    if (!tld || !oneYear) continue;
    const price = Number(oneYear.price);
    if (!Number.isFinite(price)) continue;
    rows.push({ tld, price, key });
  }
  rows.sort((a, b) => a.price - b.price);
  return rows;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [cmd, ...args] = process.argv.slice(2);
  const run = async () => {
    if (cmd === "balance") return api.balance();
    if (cmd === "price") return api.productPrice(args[0] || "regist");
    if (cmd === "check") return api.check(args[0], (args[1] || "").split(",").filter(Boolean));
    if (cmd === "domains") return api.domainPage({ pageNo: args[0] || "1", pageSize: args[1] || "20" });
    if (cmd === "info") return api.domainQuery(args[0]);
    if (cmd === "register") return api.register(args[0], args[1], Number(args[2] || 1));
    if (cmd === "mailopen")
      return api.mailOpen(args[0], args[1], args[2] || "Maxin AI", args[3] || "");
    if (cmd === "maildetail") return api.mailServiceDetail(args[0]);
    if (cmd === "dnscheck") return api.dnsCheck(args[0]);
    if (cmd === "dnsopen") return api.dnsOpen(args[0]);
    if (cmd === "dnsdomain") return api.dnsDomain(args[0]);
    if (cmd === "dnsrecords") return api.dnsRecords(args[0], args[1], Number(args[2] || 1), Number(args[3] || 50));
    if (cmd === "dnscreate") {
      const [domainName, recordName, type, value, line = "默认", mx = "0"] = args;
      return api.dnsCreate({ domainName, recordName, type, value, line, mx: Number(mx), ttl: 600 });
    }
    if (cmd === "dnscreateb64") {
      // value 用 base64 传入，避免空格/引号在远程 shell 里被吃掉
      const [domainName, recordName, type, b64, line = "默认", mx = "0"] = args;
      const value = Buffer.from(b64, "base64").toString("utf8");
      return api.dnsCreate({ domainName, recordName, type, value, line, mx: Number(mx), ttl: 600 });
    }
    if (cmd === "templates") {
      const q = args[0] || "";
      const param = q.includes("@") ? { userEmail: q } : { organizeNameCn: q };
      return api.templateList({ ...param, pageNo: "1", pageSize: "20" });
    }
    if (cmd === "tlds") {
      const r = await api.productPrice("regist");
      const max = Number(args[0] || 15);
      const rows = firstYearPrices(r.json?.data).filter((x) => x.price <= max);
      return rows;
    }
    if (cmd === "checkmany") {
      const file = args[0];
      const domains = fs
        .readFileSync(file, "utf8")
        .split("\n")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s && !s.startsWith("#"));
      const out = [];
      for (const d of domains) {
        const i = d.indexOf(".");
        const prefix = d.slice(0, i);
        const suffix = d.slice(i);
        const r = await api.check(prefix, [suffix]);
        const row = r.json?.data?.[0] || {};
        out.push({
          domain: d,
          canReg: row.canReg,
          feeLabel: row.feeLabel,
          feePrice: row.feePrice,
          comment: row.comment,
          code: r.json?.code,
          msg: r.json?.msg,
        });
        await new Promise((res) => setTimeout(res, 250));
      }
      return out;
    }
    throw new Error(`未知命令: ${cmd}`);
  };
  run()
    .then((r) => {
      const out = Array.isArray(r) ? r : r?.json ?? r?.text ?? r;
      console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
    })
    .catch((e) => {
      console.error("ERR", e.message);
      process.exit(1);
    });
}
