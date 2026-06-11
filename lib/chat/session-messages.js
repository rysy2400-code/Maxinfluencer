/** Bin 会话消息：排序与合并（前端 / 服务端共用） */

const WELCOME_SNIPPET = "您好，我是Bin，告诉我您想推广的产品链接";

export function sessionMessageMergeKey(msg) {
  if (!msg || typeof msg !== "object") return "";
  const role = msg.role || "";
  const name = msg.name || "";
  const content = String(msg.content || "").slice(0, 500);
  return `${role}|${name}|${content}`;
}

export function parseMessageTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function isWelcomeMessage(msg) {
  const content = String(msg?.content || "");
  return msg?.role === "assistant" && content.includes(WELCOME_SNIPPET);
}

export function isStreamingAssistantMessage(msg) {
  if (!msg || msg.role !== "assistant") return false;
  const content = String(msg.content || "").trim();
  if (content) return false;
  const steps = msg.thinking?.steps;
  return Array.isArray(steps) && steps.length > 0;
}

/** 是否应在 Bin 聊天框展示（有正文，或流式思考中） */
export function isChatVisibleMessage(msg) {
  if (!msg || typeof msg !== "object") return false;
  const content = String(msg.content || "").trim();
  if (content) return true;
  if (msg.role === "assistant") {
    const steps = msg.thinking?.steps;
    return Array.isArray(steps) && steps.length > 0;
  }
  return false;
}

/** 入库前移除工作实况占位等无聊天正文的 assistant 消息 */
export function stripNonChatMessages(messages, { keepStreaming = false } = {}) {
  if (!Array.isArray(messages)) return [];
  return messages.filter((m) => {
    if (isChatVisibleMessage(m)) return true;
    if (keepStreaming && isStreamingAssistantMessage(m)) return true;
    return false;
  });
}

function getMessageSortKey(msg, index) {
  const t = parseMessageTime(msg?.createdAt);
  // 仅无时间戳的初始欢迎语固定在最前；带 createdAt 的重复欢迎语按时间排序
  if (isWelcomeMessage(msg) && !t) return -1;
  if (t) return t.getTime();
  if (isStreamingAssistantMessage(msg)) {
    return Number.MAX_SAFE_INTEGER - 1 + index * 0.001;
  }
  const content = String(msg?.content || "").trim();
  if (!content) {
    return Number.MAX_SAFE_INTEGER - 2 + index * 0.001;
  }
  return Number.MAX_SAFE_INTEGER - 1000 + index;
}

/** 按 createdAt 升序；欢迎语固定最前；无时间戳的流式消息靠后 */
export function sortSessionMessagesByTime(messages) {
  if (!Array.isArray(messages) || messages.length <= 1) {
    return Array.isArray(messages) ? [...messages] : [];
  }
  return messages
    .map((m, index) => ({ m, index }))
    .sort((a, b) => {
      const ka = getMessageSortKey(a.m, a.index);
      const kb = getMessageSortKey(b.m, b.index);
      if (ka !== kb) return ka - kb;
      return a.index - b.index;
    })
    .map(({ m }) => m);
}

/**
 * 合并本地与服务端消息：服务端为已持久化记录的权威来源，保留本地未落库的用户消息与流式 assistant。
 */
export function mergeSessionMessages(local, remote) {
  const localArr = Array.isArray(local) ? local : [];
  const remoteArr = Array.isArray(remote) ? remote : [];

  if (remoteArr.length === 0) return sortSessionMessagesByTime(localArr);

  const merged = [];
  const seen = new Set();

  for (const m of remoteArr) {
    const key = sessionMessageMergeKey(m);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    merged.push(m);
  }

  for (const m of localArr) {
    if (isStreamingAssistantMessage(m)) {
      merged.push(m);
      continue;
    }
    const key = sessionMessageMergeKey(m);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    merged.push(m);
  }

  return sortSessionMessagesByTime(stripNonChatMessages(merged));
}

export function normalizeSessionMessagesForStorage(messages, { keepStreaming = false } = {}) {
  return sortSessionMessagesByTime(stripNonChatMessages(messages, { keepStreaming }));
}
