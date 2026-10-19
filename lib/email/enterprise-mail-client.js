// 企业邮箱客户端封装
// - 从 op_contacts 读取每个邮箱的 smtp/smtp_port/imap/imap_port/email/auth_code
// - 基于 nodemailer 实现发信
// - 基于 imapflow 预留轮询收信能力（MVP：只拉基础字段）

import { queryTikTok } from "../db/mysql-tiktok.js";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import * as cheerio from "cheerio";
import {
  isExcludedFromColdOutreach,
  isExcludedFromOutreachPool,
} from "./temporary-outbound-pool.js";
import { OUTREACH_COOLDOWN_MAX_MS } from "./outreach-cooldown.js";

/** 新红人首封邀约：所有发件邮箱均在各自的 20–40 分钟冷却中 */
export class OutboundCooldownError extends Error {
  constructor(message = "所有发件邮箱均在首封邀约冷却中（20–40 分钟），下一轮 Worker 重试") {
    super(message);
    this.name = "OutboundCooldownError";
  }
}

/**
 * 收件附件入库上限。超过即跳过下载（不入库，广告主侧也就看不到）。
 * 25MB 覆盖红人常见的中短视频；再高会显著增加 worker 内存与 IMAP 超时风险。
 */
export const MAX_INBOUND_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function decodeQuotedPrintable(input) {
  if (input == null) return "";
  const str = Buffer.isBuffer(input) ? input.toString("utf8") : String(input);
  // remove soft line breaks
  const softWrapped = str.replace(/=\r?\n/g, "");
  // decode =XX hex escapes
  return softWrapped.replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

function decodeRfc2047(encoded) {
  if (!encoded) return encoded;
  const str = String(encoded);
  return str.replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]+)\?=/g,
    (_m, _charset, enc, text) => {
      try {
        if (enc.toLowerCase() === "b") {
          return Buffer.from(text, "base64").toString("utf8");
        }
        // Q-encoding
        const q = text.replace(/_/g, " ");
        return q.replace(/=([0-9A-Fa-f]{2})/g, (_h, hex) =>
          String.fromCharCode(parseInt(hex, 16))
        );
      } catch {
        return text;
      }
    }
  );
}

function walkBodyStructure(node, visitor) {
  if (!node) return;
  visitor(node);
  if (Array.isArray(node.childNodes)) {
    for (const c of node.childNodes) walkBodyStructure(c, visitor);
  }
}

function pickTextPart(bodyStructure, mimeType) {
  // 单段邮件（非 multipart）的正文就是根节点，但根节点没有 IMAP part 编号。
  // 旧逻辑要求 n.part 必须存在，导致这类邮件正文永远取不到（实测约 6% 入站邮件受影响）。
  // 这里显式把根节点当作 part "1" 处理。
  const rootType = String(bodyStructure?.type || "").toLowerCase();
  const rootDisp = String(bodyStructure?.disposition || "").toLowerCase();
  const hasChildren = Array.isArray(bodyStructure?.childNodes)
    ? bodyStructure.childNodes.length > 0
    : false;
  if (!hasChildren && rootType === mimeType && rootDisp !== "attachment") {
    return { ...bodyStructure, part: bodyStructure.part || "1" };
  }

  let found = null;
  walkBodyStructure(bodyStructure, (n) => {
    if (found) return;
    const type = String(n.type || "").toLowerCase();
    const disp = String(n.disposition || "").toLowerCase();
    if (type === mimeType && disp !== "attachment" && n.part) {
      found = n;
    }
  });
  return found;
}

function pickTextPlainPart(bodyStructure) {
  return pickTextPart(bodyStructure, "text/plain");
}

function pickTextHtmlPart(bodyStructure) {
  return pickTextPart(bodyStructure, "text/html");
}

function decodePartContent(content, encoding) {
  if (content == null) return "";
  const enc = String(encoding || "").toLowerCase();
  if (enc === "base64") {
    const raw = Buffer.isBuffer(content)
      ? content
      : Buffer.from(String(content).replace(/\s/g, ""), "base64");
    return raw.toString("utf8");
  }
  if (enc === "quoted-printable") {
    return decodeQuotedPrintable(content);
  }
  let text = Buffer.isBuffer(content) ? content.toString("utf8") : String(content);
  if (/=0D=0A|=\r?\n|=[0-9A-Fa-f]{2}/.test(text)) {
    text = decodeQuotedPrintable(text);
  }
  return text;
}

function htmlToPlainText(html) {
  if (!html) return "";
  try {
    const $ = cheerio.load(html, { decodeEntities: true });
    $("script, style, noscript").remove();
    return $.root()
      .text()
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch {
    return String(html)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
}

function extractBodyTextFromDownloadedPart(downloadedPart) {
  if (!downloadedPart?.content) return "";
  const meta = downloadedPart.meta || {};
  const mimeType = String(meta.contentType || meta.type || "").toLowerCase();
  const decoded = decodePartContent(downloadedPart.content, meta.encoding);
  if (!decoded.trim()) return "";
  if (mimeType.includes("text/html") || decoded.includes("<html") || decoded.includes("<body")) {
    return htmlToPlainText(decoded);
  }
  return decoded.trim();
}

function decodeDownloadedPartContent(downloadedPart) {
  if (!downloadedPart?.content) return "";
  const meta = downloadedPart.meta || {};
  return decodePartContent(downloadedPart.content, meta.encoding);
}

/** Content-ID 归一化：去掉尖括号后比较 */
function normalizeContentId(value) {
  if (value == null) return "";
  return String(value)
    .trim()
    .replace(/^<|>$/g, "");
}

/** 收集 HTML 正文中通过 cid: 引用的 Content-ID（只保留实际展示的 inline 图片） */
function collectReferencedContentIdsFromHtml(htmlDownloadedPart) {
  const raw = decodeDownloadedPartContent(htmlDownloadedPart);
  if (!raw) return null;
  const refs = new Set();
  const re = /cid:\s*([^"'>\s)\]]+)/gi;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const id = normalizeContentId(m[1]);
    if (id) refs.add(id);
  }
  return refs;
}

function contentTypeExtension(contentType) {
  const t = String(contentType || "").toLowerCase();
  if (t.includes("png")) return "png";
  if (t.includes("jpeg") || t.includes("jpg")) return "jpg";
  if (t.includes("gif")) return "gif";
  if (t.includes("webp")) return "webp";
  if (t.includes("svg")) return "svg";
  if (t.includes("bmp")) return "bmp";
  return "bin";
}

function deriveInlineFilename(partNode, fallbackPart) {
  const cid = normalizeContentId(partNode?.id);
  const seg = cid.split("@")[0].replace(/[^\w.-]/g, "_").slice(0, 160);
  const ext = contentTypeExtension(partNode?.type);
  const base = seg || `inline-${fallbackPart || "image"}`;
  const filename = `${base}.${ext}`.replace(/\s+/g, "_");
  return filename.length > 255 ? filename.slice(-255) : filename;
}

function extractAttachments(bodyStructure) {
  const out = [];
  walkBodyStructure(bodyStructure, (n) => {
    const type = String(n.type || "").toLowerCase();
    const disp = String(n.disposition || "").toLowerCase();
    const filename =
      n?.dispositionParameters?.filename ||
      n?.parameters?.name ||
      null;

    const isImage = type.startsWith("image/");
    const looksLikeAttachment =
      disp === "attachment" ||
      (disp === "inline" && filename) ||
      (isImage && n.id);

    if (!looksLikeAttachment) return;
    if (!n.part) return;
    // Skip the alternative html/text bodies
    if (type === "text/plain" || type === "text/html") return;

    out.push({
      part: n.part,
      contentId: n.id || null,
      filename: filename
        ? decodeRfc2047(filename)
        : isImage && n.id
          ? deriveInlineFilename(n, n.part)
          : null,
      contentType: n.type || null,
      sizeBytes: typeof n.size === "number" ? n.size : null,
      encoding: n.encoding || null,
      disposition: disp || null,
      isInline: disp === "inline" || (isImage && Boolean(n.id)),
    });
  });
  return out;
}

/**
 * 只保留：
 * - disposition=attachment 的真实附件；
 * - 正文 HTML 实际通过 cid: 引用的 inline 图片；
 * - 无法拿到 HTML 时的兼容兜底：保留带 filename 的 inline（保持旧行为）。
 */
function filterBodyReferencedAttachments(attachments, referencedCids, hasHtmlContent) {
  const hasRefs = Boolean(referencedCids && referencedCids.size);
  return (attachments || []).filter((a) => {
    if (a?.disposition === "attachment") return true;
    if (!a?.isInline) return true;
    if (hasHtmlContent) {
      return Boolean(a.contentId && hasRefs && referencedCids.has(normalizeContentId(a.contentId)));
    }
    return Boolean(a.filename);
  });
}

/**
 * 从 op_contacts 表读取所有可用邮箱账号。
 * 当前实现不过滤 role，后续可以根据业务需要增加字段约束。
 */
async function getAllOpContacts() {
  try {
    const rows = await queryTikTok("SELECT * FROM op_contacts");
    return rows || [];
  } catch (err) {
    console.error("[EnterpriseMailClient] 查询 op_contacts 失败:", err);
    return [];
  }
}

export async function getAllOutboundAccounts() {
  const contacts = await getAllOpContacts();
  return contacts.filter((c) => {
    const email = c.email || c.email_address || c.username || c.account;
    const smtpHost = c.smtp;
    const smtpPort = Number(c.smtp_port || 0);
    const password = c.auth_code;
    return Boolean(email && smtpHost && smtpPort && password);
  });
}

function getAccountEmail(account) {
  return (
    account?.email ||
    account?.email_address ||
    account?.username ||
    account?.account ||
    null
  );
}

export async function getOutboundAccountByEmail(email) {
  if (!email) return null;
  const target = String(email).trim().toLowerCase();
  const accounts = await getAllOutboundAccounts();
  return (
    accounts.find((acc) => {
      const current = String(getAccountEmail(acc) || "")
        .trim()
        .toLowerCase();
      return current === target;
    }) || null
  );
}

export async function getOutreachPoolAccounts() {
  const accounts = await getAllOutboundAccounts();
  return accounts.filter((acc) => {
    const email = getAccountEmail(acc);
    return email && !isExcludedFromOutreachPool(email);
  });
}

/**
 * 为新红人首封邀约选发件账号：动态池 + 独立持久化的 20–40 分钟冷却 + LRU。
 * 若全部在冷却中则抛出 OutboundCooldownError，由 Worker 下轮重试。
 */
export async function pickOutboundAccountForNewOutreach() {
  const accounts = await getOutreachPoolAccounts();
  if (!accounts.length) {
    console.warn(
      "[EnterpriseMailClient] pickOutboundAccountForNewOutreach：动态池内无可用 SMTP 账号。"
    );
    return null;
  }

  const now = Date.now();
  /** @type {{ acc: object, lastMs: number }[]} */
  const eligible = [];

  for (const acc of accounts) {
    const email = String(getAccountEmail(acc) || "")
      .trim()
      .toLowerCase();
    if (!email) continue;
    // 品牌信箱（bin@binfluencer.xyz）不参与首封冷启动选号；
    // 它仍会被 IMAP 轮询、并作为红人回信后的线程发件人。
    if (isExcludedFromColdOutreach(email)) continue;

    const accountLastMs = acc.last_send_date
      ? new Date(acc.last_send_date).getTime()
      : 0;
    if (!(accountLastMs > 0)) {
      eligible.push({ acc, lastMs: 0 });
      continue;
    }

    if (Number.isFinite(accountLastMs) && now >= accountLastMs + OUTREACH_COOLDOWN_MAX_MS) {
      eligible.push({ acc, lastMs: accountLastMs });
    }
  }

  if (!eligible.length) {
    throw new OutboundCooldownError();
  }

  eligible.sort((a, b) => a.lastMs - b.lastMs);
  for (const { acc } of eligible) {
    if (acc.id == null) continue;
    // 原子预留：多个 worker 同时选号时，同一个邮箱只能被一个 worker 拿到。
    const reserved = await queryTikTok(
      `
      UPDATE op_contacts
      SET last_send_date = NOW()
      WHERE id = ?
        AND (
          last_send_date IS NULL
          OR last_send_date <= DATE_SUB(NOW(), INTERVAL 40 MINUTE)
        )
    `,
      [acc.id]
    );
    if (Number(reserved?.affectedRows || 0) > 0) return acc;
  }
  throw new OutboundCooldownError();
}

export async function pickRandomOutboundAccount() {
  const accounts = (await getOutreachPoolAccounts()).filter(
    (acc) => !isExcludedFromColdOutreach(getAccountEmail(acc))
  );
  if (!accounts.length) {
    console.warn(
      "[EnterpriseMailClient] pickRandomOutboundAccount：动态池内邮箱在 op_contacts 中均无可用 SMTP 配置。"
    );
    return null;
  }
  const idx = Math.floor(Math.random() * accounts.length);
  return accounts[idx] || null;
}

/**
 * 选出一个默认发件账号。
 * 策略（MVP）：
 * - 若存在 is_default / is_default_outbound 为真，则优先
 * - 否则取第一条记录
 */
async function getDefaultOutboundAccount() {
  const contacts = await getAllOpContacts();
  if (!contacts.length) {
    console.warn(
      "[EnterpriseMailClient] op_contacts 为空，无法选择默认发件账号。"
    );
    return null;
  }

  const preferred =
    contacts.find(
      (c) =>
        c.is_default === 1 ||
        c.is_default === true ||
        c.is_default_outbound === 1 ||
        c.is_default_outbound === true
    ) || contacts[0];

  return preferred;
}

/**
 * 根据红人信息选择发件账号。
 * 当前版本：
 * - 忽略 influencer 上的偏好字段，统一使用默认账号
 * - 预留 future：支持按 region / brand / preferred_outbound_email 选择
 */
export async function getOutboundAccountForInfluencer(_influencer) {
  const account = await getDefaultOutboundAccount();
  if (!account) {
    throw new Error(
      "[EnterpriseMailClient] 没有可用的企业邮箱账号（op_contacts 为空）"
    );
  }
  return account;
}

/**
 * 发送邮件（基于 nodemailer 的实现）。
 *
 * - fromAccount 需包含：
 *   - email / email_address / username 之一作为发件人账号
 *   - auth_code 作为密码/授权码
 *   - smtp 作为 SMTP 主机
 *   - smtp_port 作为 SMTP 端口
 */
export async function sendMail({
  fromAccount,
  to,
  subject,
  text,
  html,
  headers = {},
  attachments = null,
}) {
  if (!fromAccount) {
    throw new Error("[EnterpriseMailClient] sendMail 缺少 fromAccount");
  }
  if (!to) {
    throw new Error("[EnterpriseMailClient] sendMail 缺少收件人 to");
  }

  const fromEmail =
    fromAccount.email ||
    fromAccount.email_address ||
    fromAccount.username ||
    fromAccount.account;

  const smtpHost = fromAccount.smtp;
  const smtpPort = Number(fromAccount.smtp_port || 0);
  const password = fromAccount.auth_code;

  if (!fromEmail || !smtpHost || !smtpPort || !password) {
    throw new Error(
      "[EnterpriseMailClient] sendMail 缺少 smtp/smtp_port/email/auth_code 配置"
    );
  }

  const secure = smtpPort === 465 || smtpPort === 994;

  // 部分企业邮箱 SMTP 使用共享证书（如 *.global-mail.cn），与连接主机名不匹配，
  // 导致 ERR_TLS_CERT_ALTNAME_INVALID。在受控环境下可关闭证书主机名校验。
  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure,
    auth: {
      user: fromEmail,
      pass: password,
    },
    tls: {
      rejectUnauthorized: false,
    },
  });

  const mailOptions = {
    from: fromEmail,
    to,
    subject,
    headers,
  };

  if (html) {
    mailOptions.html = html;
    if (text) {
      mailOptions.text = text;
    }
  } else {
    mailOptions.text = text || "";
  }

  if (Array.isArray(attachments) && attachments.length) {
    // nodemailer attachments: [{ filename, contentType, content: Buffer }]
    mailOptions.attachments = attachments
      .filter((a) => a && a.content)
      .map((a) => ({
        filename: a.filename || "attachment",
        contentType: a.contentType || undefined,
        content: a.content, // Buffer
      }));
  }

  let info;
  try {
    info = await transporter.sendMail(mailOptions);
  } catch (error) {
    // Persisted by the event worker for SMTP auditing; no credential is attached.
    error.senderEmail = String(fromEmail).trim().toLowerCase();
    throw error;
  }

  console.log("[EnterpriseMailClient] 邮件已发送：", {
    from: fromEmail,
    to,
    subject,
    messageId: info.messageId,
  });

  return { success: true, messageId: info.messageId };
}

/**
 * 查询事件表里已存在的 message_id（分片批量 IN 查询，命中唯一键索引）。
 * 用于「先比对、只下载新邮件」的预筛，避免每轮把窗口内已入库的邮件正文/附件重复下载。
 * @param {string[]} messageIds
 * @returns {Promise<Set<string>>}
 */
async function loadExistingEmailMessageIds(messageIds = []) {
  const ids = Array.from(
    new Set(
      (messageIds || [])
        .map((m) => String(m || "").trim())
        .filter(Boolean)
    )
  );
  const found = new Set();
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => "?").join(",");
    try {
      const rows = await queryTikTok(
        `SELECT message_id FROM tiktok_influencer_email_events WHERE message_id IN (${placeholders})`,
        chunk
      );
      for (const r of rows || []) {
        if (r?.message_id) found.add(r.message_id);
      }
    } catch (err) {
      // 查询失败时保守返回空集合 → 该批邮件会被当作「新邮件」下载，
      // 业务层仍用 INSERT IGNORE(message_id 唯一键) 兜底，不会产生重复事件。
      console.error(
        "[EnterpriseMailClient] 预筛查询已入库 message_id 失败，本批按新邮件处理：",
        err?.message || err
      );
    }
  }
  return found;
}

/**
 * 拉取最近的邮件（基于 imapflow 的简化实现）。
 *
 * 说明：
 * - 仅打开 INBOX，按时间 since 过滤，最多返回若干封邮件的基础信息
 * - 业务层可根据 messageId、发件人、收件人、subject、文本正文做后续处理
 */
export async function listRecentMessages({ account, since }) {
  const fromEmail =
    account?.email ||
    account?.email_address ||
    account?.username ||
    account?.account ||
    null;

  const imapHost = account?.imap;
  const imapPort = Number(account?.imap_port || 0);
  const password = account?.auth_code;

  if (!fromEmail || !imapHost || !imapPort || !password) {
    console.warn(
      "[EnterpriseMailClient] listRecentMessages 缺少 imap/imap_port/email/auth_code 配置，跳过。"
    );
    return [];
  }

  const secure = imapPort === 993 || imapPort === 995;

  // 一些企业邮箱的 STARTTLS 使用过小的 DH 密钥，Node/OpenSSL 会直接拒绝握手。
  // 这里显式关闭 STARTTLS（doSTARTTLS:false），在端口 143 上保持明文 IMAP 连接。
  // 如果你后续将 imap_port 配置为 993 等纯 TLS 端口，可将 secure 设为 true 并移除 doSTARTTLS。
  const client = new ImapFlow({
    host: imapHost,
    port: imapPort,
    secure,
    auth: {
      user: fromEmail,
      pass: password,
    },
    doSTARTTLS: false,
  });

  /** 防止 imapflow 异步 error 事件导致进程崩溃 */
  client.on("error", (err) => {
    console.error(
      "[EnterpriseMailClient] IMAP 连接 error 事件：",
      fromEmail,
      err?.message || err
    );
  });

  const results = [];

  try {
    await client.connect();
    await client.mailboxOpen("INBOX");

    // 回看窗口：调用方传入的 since 若更早则沿用，否则放宽到 IMAP_RECENT_LOOKBACK_DAYS（默认 7 天）。
    // 放宽窗口本身不贵——下面会先只取 envelope，用 message_id 与库里比对，只对「新邮件」下载正文/附件。
    const lookbackDays = Math.max(
      1,
      Number(process.env.IMAP_RECENT_LOOKBACK_DAYS || 7) || 7
    );
    const lookbackSince = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
    const effectiveSince =
      since instanceof Date && since.getTime() < lookbackSince.getTime()
        ? since
        : lookbackSince;

    // envelope 扫描上限（防单个异常邮箱无限增长）。只影响 header 扫描，不影响正文下载量。
    const scanLimit = Math.max(
      1,
      Number(process.env.IMAP_ENVELOPE_SCAN_LIMIT || 2000) || 2000
    );

    // imapflow 的 search 支持 { since: Date }；这里直接用 UID，便于后续下载附件
    const uids = (await client.search({ since: effectiveSince }, { uid: true })) || [];
    const scanUids = uids.length > scanLimit ? uids.slice(-scanLimit) : uids;

    if (uids.length > scanLimit) {
      console.warn("[EnterpriseMailClient] IMAP 命中数超过扫描上限，已截断：", {
        account: fromEmail,
        totalMatched: uids.length,
        scanLimit,
      });
    }

    if (!scanUids.length) {
      console.log("[EnterpriseMailClient] IMAP search 结果：", {
        account: fromEmail,
        totalMatched: uids.length,
        scanned: 0,
        effectiveSince: effectiveSince.toISOString(),
      });
      return [];
    }

    // 第一段（廉价）：只取 envelope + internalDate，不取正文/附件。
    const envelopeMsgs =
      (await client.fetchAll(
        scanUids,
        { envelope: true, internalDate: true },
        { uid: true }
      )) || [];

    // 用 message_id 与事件表比对：已在库的邮件不再下载正文/附件。
    const candidateIds = [];
    for (const m of envelopeMsgs) {
      const mid = m.envelope?.messageId || null;
      if (mid) candidateIds.push(mid);
    }
    const knownIds = await loadExistingEmailMessageIds(candidateIds);

    const newUids = [];
    let skippedExisting = 0;
    let missingMessageId = 0;
    for (const m of envelopeMsgs) {
      const mid = m.envelope?.messageId || null;
      if (!mid) {
        // 缺 Message-ID 无法去重：保守起见仍下载，交由业务层处理/告警。
        missingMessageId += 1;
        newUids.push(m.uid);
        continue;
      }
      if (knownIds.has(mid)) {
        skippedExisting += 1;
        continue;
      }
      newUids.push(m.uid);
    }

    console.log("[EnterpriseMailClient] IMAP 预筛结果：", {
      account: fromEmail,
      totalMatched: uids.length,
      scanned: envelopeMsgs.length,
      existingSkipped: skippedExisting,
      newToDownload: newUids.length,
      missingMessageId,
      lookbackDays,
      effectiveSince: effectiveSince.toISOString(),
    });

    if (!newUids.length) {
      return [];
    }

    // 第二段（昂贵，仅新邮件）：取 envelope/bodyStructure/headers，再下载正文与附件。
    const msgs = await client.fetchAll(
      newUids,
      {
        envelope: true,
        bodyStructure: true,
        internalDate: true,
        headers: true,
      },
      { uid: true }
    );

    for (const msg of msgs) {
      const envelope = msg.envelope || {};

      let rawHeaders = "";
      try {
        if (msg.headers)
          rawHeaders = Buffer.isBuffer(msg.headers)
            ? msg.headers.toString("utf8")
            : String(msg.headers);
      } catch {
        rawHeaders = "";
      }

      const plainPartNode = pickTextPlainPart(msg.bodyStructure);
      const htmlPartNode = pickTextHtmlPart(msg.bodyStructure);
      const attachmentCandidates = extractAttachments(msg.bodyStructure);

      // 下载 text/plain / text/html + 所有附件（按 part number）
      const partsToDownload = [];
      if (plainPartNode?.part) partsToDownload.push(plainPartNode.part);
      if (htmlPartNode?.part && htmlPartNode.part !== plainPartNode?.part) {
        partsToDownload.push(htmlPartNode.part);
      }
      for (const a of attachmentCandidates) {
        // 简单限流：跳过超大附件（避免撑爆内存/DB）。
        // 25MB 是为了覆盖红人常见的中短视频；超出的不入库，广告主侧也就看不到。
        if (
          typeof a.sizeBytes === "number" &&
          a.sizeBytes > MAX_INBOUND_ATTACHMENT_BYTES
        ) {
          console.warn("[EnterpriseMailClient] 跳过超大附件:", {
            uid: msg.uid,
            filename: a.filename,
            contentType: a.contentType,
            sizeBytes: a.sizeBytes,
            limitBytes: MAX_INBOUND_ATTACHMENT_BYTES,
          });
          continue;
        }
        partsToDownload.push(a.part);
      }

      let downloaded = {};
      if (partsToDownload.length) {
        try {
          downloaded = await client.downloadMany(msg.uid, partsToDownload, {
            uid: true,
          });
        } catch (err) {
          console.error(
            "[EnterpriseMailClient] downloadMany 失败：",
            err?.message || err
          );
        }
      }

      const hasHtmlContent = Boolean(
        htmlPartNode?.part &&
          downloaded?.[htmlPartNode.part]?.content
      );
      const referencedContentIds = hasHtmlContent
        ? collectReferencedContentIdsFromHtml(downloaded[htmlPartNode.part])
        : null;
      const attachments = filterBodyReferencedAttachments(
        attachmentCandidates,
        referencedContentIds,
        hasHtmlContent
      );

      let bodyText = "";
      if (plainPartNode?.part && downloaded?.[plainPartNode.part]) {
        bodyText = extractBodyTextFromDownloadedPart(downloaded[plainPartNode.part]);
      }
      if (!bodyText && htmlPartNode?.part && downloaded?.[htmlPartNode.part]) {
        bodyText = extractBodyTextFromDownloadedPart(downloaded[htmlPartNode.part]);
      }
      if (!bodyText) {
        console.warn("[EnterpriseMailClient] 邮件正文解析为空：", {
          uid: msg.uid,
          subject: envelope.subject || "",
          from: envelope.from?.[0]?.address || "",
          hasPlainPart: Boolean(plainPartNode?.part),
          hasHtmlPart: Boolean(htmlPartNode?.part),
        });
      }

      const messageId = envelope.messageId || null;
      if (!messageId) {
        console.warn(
          "[EnterpriseMailClient] 收到缺少 Message-ID 的邮件，可能无法写入事件表去重：",
          {
            uid: msg.uid,
            subject: envelope.subject || "",
            from: envelope.from?.[0]?.address || "",
            date: msg.internalDate || null,
          }
        );
      }

      results.push({
        uid: msg.uid,
        messageId,
        subject: envelope.subject || "",
        date: msg.internalDate || null,
        from: envelope.from?.[0]?.address || "",
        to: envelope.to?.[0]?.address || "",
        inReplyTo: envelope.inReplyTo || null,
        bodyText,
        rawHeaders,
        attachments: attachments
          .map((a) => {
            const d = downloaded?.[a.part];
            return {
              part: a.part,
              contentId: a.contentId,
              filename: a.filename,
              contentType: a.contentType,
              sizeBytes: a.sizeBytes,
              encoding: a.encoding,
              content: d?.content || null, // Buffer
            };
          })
          .filter((a) => a.content), // 只返回成功下载到内容的附件
      });
    }
  } catch (err) {
    console.error(
      "[EnterpriseMailClient] listRecentMessages 失败:",
      fromEmail,
      err?.message || err
    );
    throw err;
  } finally {
    try {
      await client.logout();
    } catch {
      try {
        client.close();
      } catch {
        // ignore
      }
    }
  }

  console.log(
    "[EnterpriseMailClient] listRecentMessages 完成：",
    {
      account: fromEmail,
      count: results.length,
      sample: results.slice(0, 3).map((m) => ({
        uid: m.uid,
        messageId: m.messageId,
        from: m.from,
        to: m.to,
        subject: m.subject,
        date: m.date,
      })),
    }
  );

  return results;
}
