// 企业邮箱客户端封装
// - 从 op_contacts 读取每个邮箱的 smtp/smtp_port/imap/imap_port/email/auth_code
// - 基于 nodemailer 实现发信
// - 基于 imapflow 预留轮询收信能力（MVP：只拉基础字段）

import { queryTikTok } from "../db/mysql-tiktok.js";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";

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

function pickTextPlainPart(bodyStructure) {
  let found = null;
  walkBodyStructure(bodyStructure, (n) => {
    if (found) return;
    const type = String(n.type || "").toLowerCase();
    const disp = String(n.disposition || "").toLowerCase();
    if (type === "text/plain" && disp !== "attachment" && n.part) {
      found = n;
    }
  });
  return found;
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

    const looksLikeAttachment =
      disp === "attachment" || (disp === "inline" && filename);

    if (!looksLikeAttachment) return;
    if (!n.part) return;
    // Skip the alternative html/text bodies
    if (type === "text/plain" || type === "text/html") return;

    out.push({
      part: n.part,
      contentId: n.id || null,
      filename: filename ? decodeRfc2047(filename) : null,
      contentType: n.type || null,
      sizeBytes: typeof n.size === "number" ? n.size : null,
      encoding: n.encoding || null,
    });
  });
  return out;
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

export async function pickRandomOutboundAccount() {
  const accounts = await getAllOutboundAccounts();
  if (!accounts.length) return null;
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

  const info = await transporter.sendMail(mailOptions);

  console.log("[EnterpriseMailClient] 邮件已发送：", {
    from: fromEmail,
    to,
    subject,
    messageId: info.messageId,
  });

  return { success: true, messageId: info.messageId };
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

  const results = [];

  try {
    await client.connect();
    await client.mailboxOpen("INBOX");

    // imapflow 的 search 支持 { since: Date }；这里直接用 UID，便于后续下载附件
    const searchCriteria = since instanceof Date ? { since } : {};
    const uids = (await client.search(searchCriteria, { uid: true })) || [];

    // 控制数量，避免一次性拉太多
    const limitedUids = uids.slice(-50);

    console.log("[EnterpriseMailClient] IMAP search 结果：", {
      account: fromEmail,
      totalMatched: uids.length,
      limitedUids,
    });

    if (!limitedUids.length) {
      return [];
    }

    // 先一次性 fetch 所有消息的 envelope/bodyStructure/headers，避免在 fetch loop 中发起其它 IMAP 命令导致死锁
    const msgs = await client.fetchAll(
      limitedUids,
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
      const attachments = extractAttachments(msg.bodyStructure);

      // 下载 text/plain + 所有附件（按 part number）
      const partsToDownload = [];
      if (plainPartNode?.part) partsToDownload.push(plainPartNode.part);
      for (const a of attachments) {
        // 简单限流：跳过超大附件（避免撑爆内存/DB）
        if (typeof a.sizeBytes === "number" && a.sizeBytes > 10 * 1024 * 1024) {
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

      let bodyText = "";
      if (plainPartNode?.part && downloaded?.[plainPartNode.part]?.content) {
        const meta = downloaded[plainPartNode.part].meta || {};
        const content = downloaded[plainPartNode.part].content;
        if (meta.encoding && String(meta.encoding).toLowerCase() === "quoted-printable") {
          bodyText = decodeQuotedPrintable(content);
        } else {
          bodyText = Buffer.isBuffer(content) ? content.toString("utf8") : String(content);
          // 某些服务器返回未解码的 quoted-printable，这里做一次兜底解码（不会破坏纯文本）
          if (/=0D=0A|=\r?\n|=[0-9A-Fa-f]{2}/.test(bodyText)) {
            bodyText = decodeQuotedPrintable(bodyText);
          }
        }
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
      err?.message || err
    );
  } finally {
    try {
      await client.logout();
    } catch {
      // ignore
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

