/**
 * 从红人简介文本中提取首个邮箱（TikTok / Instagram / YouTube bio 共用）
 * @param {unknown} bio
 * @returns {string|null}
 */
const DOMAIN_PART =
  "(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+)";
const LOCAL_PART = "[a-zA-Z0-9](?:[-a-zA-Z0-9._+%]*[a-zA-Z0-9])?";
const MAILBOX_WORDS =
  "contact|business|info|hello|scale|email|enquir(?:y|ies)|sponsor(?:ing)?|partnership";

const BLOCKED_LOCAL_RE =
  /^(instagram|tiktok|twitter|youtube|facebook|ig|dm|follow)$/i;

/** IG 中文/英文 header 误识别为 bio 的帖子数等统计行 */
const IG_HEADER_STATS_BIO_RE =
  /^[\d,.]+[km万]?(?:帖子|posts?|post|followers?|following|粉丝|关注|关注者)$/i;

function isSocialHandleContext(text, index) {
  const before = text.slice(Math.max(0, index - 60), index).toLowerCase();
  return /(?:instagram|tiktok|twitter|youtube|facebook|\big\b|dm\s+me|follow\s+me|on\s+)$/.test(
    before
  );
}

function buildEmail(local, domain) {
  const mailbox = String(local || "").trim().toLowerCase();
  const host = String(domain || "").trim().toLowerCase();
  if (!mailbox || !host || BLOCKED_LOCAL_RE.test(mailbox)) return null;
  if (!host.includes(".")) return null;
  return `${mailbox}@${host}`;
}

/** @param {unknown} bio */
export function isLikelyIgHeaderStatsBio(bio) {
  const t = String(bio || "").trim();
  if (!t) return false;
  if (IG_HEADER_STATS_BIO_RE.test(t)) return true;
  if (/^[\d,.]+[km万]?$/.test(t)) return true;
  return false;
}

/** 过滤无效 bio 后再做邮箱解析 */
export function normalizeBioForEmailExtraction(bio) {
  if (typeof bio !== "string") return "";
  const t = bio.trim();
  if (!t || isLikelyIgHeaderStatsBio(t)) return "";
  return t;
}

/** 从粘连前缀文本中选取最可信的邮箱（如 Collaborationngeena@domain.com） */
function pickBestEmailCandidate(candidates) {
  const valid = candidates.filter(Boolean);
  if (!valid.length) return null;
  const scored = valid.map((email) => {
    const [local] = email.split("@");
    let score = local.length;
    if (/^[a-z][a-z0-9._%+-]*$/i.test(local)) score += 4;
    if (local.length >= 3) score += 2;
    if (/^(contact|info|hello|business|email)$/i.test(local)) score += 1;
    return { email, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].email;
}

function extractEmailsFromText(text) {
  const candidates = [];
  const s = String(text || "");
  if (!s) return candidates;

  const gluedRe = new RegExp(
    `(?<![a-zA-Z0-9._%+-])(${LOCAL_PART}@${DOMAIN_PART})\\b`,
    "gi"
  );
  let gluedMatch;
  while ((gluedMatch = gluedRe.exec(s)) !== null) {
    if (isSocialHandleContext(s, gluedMatch.index)) continue;
    const email = gluedMatch[1].toLowerCase();
    candidates.push(email);
    const [local, domain] = email.split("@");
    if (local.length > 2 && /^[a-z](?=[a-z0-9._%+-]*@)/i.test(`${local}@`)) {
      const trimmed = buildEmail(local.slice(1), domain);
      if (trimmed) candidates.push(trimmed);
    }
  }

  if (!s.includes("@")) return candidates;

  const flexRe = new RegExp(
    `(?<![a-zA-Z0-9._%+-])(${LOCAL_PART}|${MAILBOX_WORDS})\\s*@\\s*(${DOMAIN_PART})\\b`,
    "gi"
  );
  let flexMatch;
  while ((flexMatch = flexRe.exec(s)) !== null) {
    if (isSocialHandleContext(s, flexMatch.index)) continue;
    const email = buildEmail(flexMatch[1], flexMatch[2]);
    if (email) candidates.push(email);
  }

  const contactDomainRe = new RegExp(`\\bcontact\\s+@\\s*(${DOMAIN_PART})\\b`, "i");
  const contactDomainMatch = s.match(contactDomainRe);
  if (contactDomainMatch) {
    const email = buildEmail("contact", contactDomainMatch[1]);
    if (email) candidates.push(email);
  }

  const atObfuscated = s.match(
    /\b([a-z0-9._%+-]+)\s*(?:\(at\)|\[at\]|@\s*at\s*)\s*([a-z0-9.-]+\.[a-z]{2,})\b/i
  );
  if (atObfuscated) {
    const email = buildEmail(atObfuscated[1], atObfuscated[2]);
    if (email) candidates.push(email);
  }

  return candidates;
}

export function extractEmailFromBio(bio) {
  const s = normalizeBioForEmailExtraction(bio);
  if (!s) return null;
  let text = s;
  text = text.replace(/"\s*,\s*"email"\s*:\s*"/gi, " ");
  return pickBestEmailCandidate(extractEmailsFromText(text));
}

/**
 * 说明邮箱如何从 bio 中被解析（用于回填报告）
 * @param {unknown} bio
 * @param {string|null} email
 * @returns {string|null}
 */
export function describeEmailExtractionReason(bio, email) {
  if (!email || typeof bio !== "string") return null;
  const s = bio.trim();
  const lower = email.toLowerCase();

  const fullRe = new RegExp(`\\b(${LOCAL_PART}@${DOMAIN_PART})\\b`, "i");
  if (fullRe.test(s) && s.toLowerCase().includes(lower)) {
    return "bio 含标准完整邮箱（local@domain 连续书写）";
  }

  if (/contact\s+@\s*[a-z0-9.-]+\.[a-z]{2,}/i.test(s)) {
    return "bio 为「contact @ domain.com」格式，旧正则要求 @ 前后为完整邮箱";
  }

  if (
    /\b(?:business|contact|info|hello|scale|email|enquir)\s*@\s*[a-z0-9.-]+\.[a-z]{2,}\b/i.test(
      s
    ) &&
    !fullRe.test(s)
  ) {
    return "bio 为「mailbox @domain」或 mailbox 与 @ 之间有空格，旧正则无法匹配";
  }

  if (/\b[a-z0-9._%+-]+\s+@\s+[a-z0-9.-]+\.[a-z]{2,}\b/i.test(s)) {
    return "bio 邮箱 @ 两侧有空格，旧正则无法匹配";
  }

  return "bio 非标准邮箱格式，由增强正则推断";
}
