import { formatExecInfluencerMention } from "./exec-influencer-mention.js";

/**
 * 构建 campaign 下红人键 → tiktok_username 映射（platform userId 与 handle 均可查）。
 * @param {Array<{ tiktok_username?: string, influencer_id?: string|null }>} executionRows
 */
export function buildExecutionUsernameLookup(executionRows = []) {
  const map = new Map();
  for (const row of executionRows) {
    const username = String(row.tiktok_username || "")
      .trim()
      .replace(/^@/, "");
    if (!username) continue;
    map.set(username.toLowerCase(), username);
    const pid = row.influencer_id != null ? String(row.influencer_id).trim() : "";
    if (pid) {
      map.set(pid, username);
      map.set(pid.toLowerCase(), username);
    }
  }
  return map;
}

/**
 * @param {string} key
 * @param {Map<string, string>} lookup
 * @returns {string|null}
 */
export function resolveHandleFromLookup(key, lookup) {
  const raw = String(key || "")
    .trim()
    .replace(/^@/, "");
  if (!raw) return null;
  const fromPlatformId = lookup.get(raw) || lookup.get(raw.toLowerCase());
  if (fromPlatformId) return fromPlatformId;
  if (!/^\d+$/.test(raw) && !/^UC[\w-]{10,}$/i.test(raw)) {
    return lookup.get(raw.toLowerCase()) || raw;
  }
  return null;
}

/**
 * 特殊请求类 Bin 消息：红人 @数字ID / @handle → [EXEC:@username]
 * @param {string} content
 * @param {(key: string) => string|null} resolveHandle
 */
export function repairSpecialRequestInfluencerMention(content, resolveHandle) {
  if (typeof content !== "string" || !content.includes("【特殊请求")) {
    return content;
  }

  let next = content.replace(/红人 @([\w.\u4e00-\u9fa5_-]+)/g, (full, key) => {
    const handle = resolveHandle(key);
    if (!handle) return full;
    const mention = formatExecInfluencerMention(handle);
    if (full === `红人 ${mention}`) return full;
    return `红人 ${mention}`;
  });

  next = next.replace(/\[EXEC:@([\w.\u4e00-\u9fa5_-]+)\]/g, (full, key) => {
    const handle = resolveHandle(key);
    if (!handle || handle === key) return full;
    return formatExecInfluencerMention(handle);
  });

  // 旧版正则会截断 YouTube ID，留下 [EXEC:@UC2Jl]-LpV_xxx 这类损坏标记
  next = next.replace(/\[EXEC:@([\w]+)\](-[\w-]+)/g, (full, head, tail) => {
    const candidate = `${head}${tail}`;
    const handle = resolveHandle(candidate);
    if (!handle) return full;
    return formatExecInfluencerMention(handle);
  });

  return next;
}

/**
 * 执行进度汇报：Campaign ID → 与左侧栏一致的 session.title
 * @param {string} content
 * @param {string} displayName
 */
export function repairExecutionReportCampaignTitle(content, displayName) {
  const title = String(displayName || "").trim();
  if (typeof content !== "string" || !title || !content.includes("执行进度日报（")) {
    return content;
  }

  return content.replace(/执行进度日报（Campaign [^）]+）：/g, `执行进度日报（${title}）：`);
}

/**
 * @param {string} content
 * @param {{ resolveHandle: (key: string) => string|null, campaignDisplayName?: string|null }} opts
 */
export function repairBinMessageContent(content, opts) {
  let next = content;
  next = repairSpecialRequestInfluencerMention(next, opts.resolveHandle);
  if (opts.campaignDisplayName) {
    next = repairExecutionReportCampaignTitle(next, opts.campaignDisplayName);
  }
  return next;
}

/**
 * @param {Array} messages
 * @param {{ resolveHandle: (key: string) => string|null, campaignDisplayName?: string|null }} opts
 * @returns {{ messages: Array, changedCount: number }}
 */
export function repairSessionMessages(messages, opts) {
  if (!Array.isArray(messages)) {
    return { messages: [], changedCount: 0 };
  }

  let changedCount = 0;
  const nextMessages = messages.map((msg) => {
    if (!msg || typeof msg !== "object") return msg;
    const content = msg.content;
    if (typeof content !== "string" || !content.trim()) return msg;

    const repaired = repairBinMessageContent(content, opts);
    if (repaired === content) return msg;
    changedCount += 1;
    return { ...msg, content: repaired };
  });

  return { messages: nextMessages, changedCount };
}
