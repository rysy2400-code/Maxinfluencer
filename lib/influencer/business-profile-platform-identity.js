/**
 * 把红人主档里已知的平台账号写进商务档案的 Platform Profiles。
 *
 * 背景：@mixallin1 的主档已有 youtube/@mixallin1，但商务档案里的
 * YouTube 仍是 Unknown，导致后续邮件反复问"YouTube 主页链接是不是 @mixallin1"。
 * 这里在读档案时用主档身份补全，避免把已知信息当成未知项。
 */

const PLATFORM_LABELS = {
  youtube: "YouTube",
  yt: "YouTube",
  instagram: "Instagram",
  ins: "Instagram",
  ig: "Instagram",
  tiktok: "TikTok",
  tt: "TikTok",
  twitter: "X/Twitter",
  x: "X/Twitter",
  facebook: "Facebook",
  fb: "Facebook",
};

function normalizeValue(value) {
  return String(value || "")
    .replace(/^[-*]\s*/, "")
    .trim();
}

function isUnknownValue(value) {
  const v = normalizeValue(value).toLowerCase();
  return v === "" || v === "unknown" || v === "n/a" || v === "none";
}

function normalizePlatformKey(value) {
  const key = String(value || "").trim().toLowerCase();
  return PLATFORM_LABELS[key] ? key : null;
}

export function seedKnownPlatformProfiles(markdown, identities = []) {
  const source = String(markdown || "");
  if (!source.trim() || !identities.length) return source;

  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+platform profiles\s*$/i.test(line));
  if (start < 0) return source;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const block = lines.slice(start + 1, end);

  const known = new Map();
  for (const identity of identities) {
    const key = normalizePlatformKey(identity?.platform);
    if (!key) continue;
    const username = String(identity?.username || "").replace(/^@/, "").trim();
    const profileUrl = String(identity?.profileUrl || "").trim();
    if (!username && !profileUrl) continue;
    const label = PLATFORM_LABELS[key];
    const value = [username ? `@${username}` : null, profileUrl ? `(${profileUrl})` : null]
      .filter(Boolean)
      .join(" ");
    known.set(label.toLowerCase(), value);
  }
  if (!known.size) return source;

  let replaced = false;
  const nextBlock = block.map((line) => {
    const match = normalizeValue(line).match(/^([^:]+):\s*(.*)$/);
    if (!match) return line;
    const label = match[1].trim();
    const key = label.toLowerCase();
    if (!known.has(key) || !isUnknownValue(match[2])) return line;
    replaced = true;
    return `- ${label}: ${known.get(key)}`;
  });

  for (const [key, value] of known) {
    if (
      nextBlock.some((line) => {
        const match = normalizeValue(line).match(/^([^:]+):/);
        return match && match[1].trim().toLowerCase() === key;
      })
    ) {
      continue;
    }
    const label =
      Object.entries(PLATFORM_LABELS).find(([, v]) => v.toLowerCase() === key)?.[1] ||
      key;
    while (nextBlock.length && !nextBlock[nextBlock.length - 1].trim()) nextBlock.pop();
    nextBlock.push(`- ${label}: ${value}`);
    replaced = true;
  }
  if (!replaced) return source;

  const needsBlank =
    nextBlock.length > 0 && Boolean(nextBlock[nextBlock.length - 1].trim());
  return [
    ...lines.slice(0, start + 1),
    ...nextBlock,
    ...(needsBlank ? [""] : []),
    ...lines.slice(end),
  ].join("\n");
}
