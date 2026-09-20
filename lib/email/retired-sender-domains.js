/**
 * 已退役发件域名迁移表。
 *
 * 背景：2026-09-20 起 binfluencer.autos / binfluencers.autos / binfluencer.top /
 * binfluencers.top / binfluencers.pics / binfluencer.cfd 这批域名到期，其 SMTP/IMAP
 * 所在的 172.237.129.x（Linode 芝加哥）从全球节点都不可达，导致：
 * - 首邀/跟进发信 connect ETIMEDOUT 持续 failed；
 * - IMAP 轮询同样不可达，红人回信收不到；
 * - 历史线程的发件人被钉死在这些死域上。
 *
 * 处理原则：
 * - 运行时：动态发件池不再选这些域；线程解析遇到死域发件人时，按本表映射到健康域；
 * - 数据面：对存量线程做一次性迁移（只改线程锚点 from_email，原文保留在 payload）。
 *
 * 映射规则：优先保留 local part（同一「人物」身份），目标健康域没有该 local part 时
 * 回退到该域默认 persona。健康域当前由 global-mail.cn（101.237.133.13/14）承载。
 */

/** 已退役/不可用的发件域（小写） */
export const RETIRED_OUTBOUND_DOMAINS = Object.freeze([
  "binfluencer.autos",
  "binfluencers.autos",
  "binfluencer.top",
  "binfluencers.top",
  "binfluencers.pics",
  "binfluencer.cfd",
]);

/**
 * 每个退役域映射到哪个健康域。
 * 分散到不同健康域，避免几万封线程集中到单一邮箱触发日限额/风控。
 */
export const RETIRED_DOMAIN_TARGETS = Object.freeze({
  "binfluencer.autos": "ainfluencer.site",
  "binfluencers.autos": "ainfluencer.top",
  "binfluencer.top": "cinfluencer.site",
  "binfluencers.top": "minfluencer.uno",
  "binfluencers.pics": "pinfluencer.site",
  "binfluencer.cfd": "ainfluencer.website",
});

/**
 * 目标健康域上实际存在的 local part。运行时若发现目标域缺某个 local part，
 * 或存量迁移遇到仅存在于退役域的 persona（bob/ethan/lucas/luna），
 * 统一回退到该域默认 persona。
 */
export const HEALTHY_LOCAL_PARTS = Object.freeze([
  "annie",
  "james",
  "maxin",
  "mike",
  "pika",
]);

export const DEFAULT_HEALTHY_LOCAL_PART = "maxin";

const RETIRED_DOMAIN_SET = new Set(RETIRED_OUTBOUND_DOMAINS);

function splitEmail(email) {
  const s = String(email || "").trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at <= 0 || at === s.length - 1) return null;
  return { local: s.slice(0, at), domain: s.slice(at + 1) };
}

export function normalizeEmailDomain(email) {
  return splitEmail(email)?.domain || null;
}

export function isRetiredSenderEmail(email) {
  const domain = normalizeEmailDomain(email);
  return Boolean(domain && RETIRED_DOMAIN_SET.has(domain));
}

export function isRetiredSenderDomain(domain) {
  const d = String(domain || "").trim().toLowerCase();
  return Boolean(d && RETIRED_DOMAIN_SET.has(d));
}

/**
 * 把退役域邮箱映射到健康域邮箱。
 * - 非退役域原样返回；
 * - 目标域存在同 local part 时保留 persona；
 * - 否则回退到 DEFAULT_HEALTHY_LOCAL_PART。
 * @returns {{ from: string, to: string, changed: boolean, retired: boolean, reason: string|null }}
 */
export function planRetiredSenderMigration(email) {
  const parsed = splitEmail(email);
  if (!parsed) {
    return {
      from: email || null,
      to: email || null,
      changed: false,
      retired: false,
      reason: "invalid_email",
    };
  }
  const targetDomain = RETIRED_DOMAIN_TARGETS[parsed.domain];
  if (!targetDomain) {
    return {
      from: email,
      to: email,
      changed: false,
      retired: false,
      reason: null,
    };
  }
  const local = HEALTHY_LOCAL_PARTS.includes(parsed.local)
    ? parsed.local
    : DEFAULT_HEALTHY_LOCAL_PART;
  return {
    from: email,
    to: `${local}@${targetDomain}`,
    changed: true,
    retired: true,
    reason:
      local === parsed.local
        ? `retired_domain:${parsed.domain}`
        : `retired_domain:${parsed.domain};localpart_unavailable:${parsed.local}`,
  };
}

/** 便捷函数：只取迁移后的邮箱；非退役域原样返回。 */
export function mapRetiredSenderEmail(email) {
  return planRetiredSenderMigration(email).to;
}
