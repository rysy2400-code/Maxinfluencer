/** Bin 会话消息：排序与合并（前端 / 服务端共用） */

const WELCOME_SNIPPET = "您好，我是Bin，告诉我您想推广的产品链接";

export function sessionMessageMergeKey(msg) {
  if (!msg || typeof msg !== "object") return "";
  const role = msg.role || "";
  const name = msg.name || "";
  const content = String(msg.content || "").slice(0, 500);
  const createdAt = msg.createdAt ? String(msg.createdAt) : "";
  // 含 createdAt，避免用户重复发送相同短指令（如「暂停」「恢复」）被误判为同一条
  if (createdAt) return `${role}|${name}|${content}|${createdAt}`;
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

/** 无正文、仅有 thinking.steps 的 assistant（流式占位，不可持久化） */
export function isThinkingOnlyAssistantPlaceholder(msg) {
  if (!msg || msg.role !== "assistant") return false;
  const content = String(msg.content || "").trim();
  if (content) return false;
  const steps = msg.thinking?.steps;
  return Array.isArray(steps) && steps.length > 0;
}

export function isStreamingAssistantMessage(msg) {
  return isThinkingOnlyAssistantPlaceholder(msg);
}

/** 是否应在 Bin 聊天框展示（有正文，或流式思考中） */
export function isChatVisibleMessage(msg) {
  if (!msg || typeof msg !== "object") return false;
  if (Array.isArray(msg.attachments) && msg.attachments.length > 0) return true;
  const content = String(msg.content || "").trim();
  if (content) return true;
  if (msg.role === "assistant") {
    const steps = msg.thinking?.steps;
    return Array.isArray(steps) && steps.length > 0;
  }
  return false;
}

/** 入库前：去掉流式占位；有正文的 assistant 去掉 thinking.steps */
export function sanitizeMessageForStorage(msg) {
  if (!msg || typeof msg !== "object") return msg;
  if (isThinkingOnlyAssistantPlaceholder(msg)) return null;

  const content = String(msg.content || "").trim();
  if (msg.role !== "assistant" || !content || !msg.thinking) {
    return msg;
  }

  const thinking = { ...msg.thinking };
  delete thinking.steps;
  const hasOtherThinking =
    Object.keys(thinking).some((k) => {
      const v = thinking[k];
      if (v == null) return false;
      if (Array.isArray(v)) return v.length > 0;
      if (typeof v === "object") return Object.keys(v).length > 0;
      return true;
    });

  if (!hasOtherThinking) {
    const { thinking: _removed, ...rest } = msg;
    return rest;
  }

  return { ...msg, thinking };
}

/** 入库前移除工作实况占位等无聊天正文的 assistant 消息 */
export function stripNonChatMessages(messages, { keepStreaming = false } = {}) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((m) => sanitizeMessageForStorage(m))
    .filter((m) => {
      if (!m) return false;
      if (isChatVisibleMessage(m)) return true;
      if (keepStreaming && isStreamingAssistantMessage(m)) return true;
      return false;
    });
}

/** 排序分桶：welcome → legacy（无时间戳历史）→ timed（近期）→ streaming（流式占位） */
const SORT_BUCKET = {
  WELCOME: 0,
  LEGACY: 1,
  TIMED: 2,
  STREAMING: 3,
};

function classifyMessageSortBucket(msg, index) {
  const t = parseMessageTime(msg?.createdAt);
  // 仅无时间戳的初始欢迎语固定在最前；带 createdAt 的欢迎语归入 timed
  if (isWelcomeMessage(msg) && !t) {
    return { bucket: SORT_BUCKET.WELCOME, order: index };
  }
  if (t) {
    return { bucket: SORT_BUCKET.TIMED, order: t.getTime() };
  }
  if (isStreamingAssistantMessage(msg)) {
    return { bucket: SORT_BUCKET.STREAMING, order: index };
  }
  const content = String(msg?.content || "").trim();
  if (!content) {
    return { bucket: SORT_BUCKET.STREAMING, order: index };
  }
  // 无 createdAt 的正文消息：按原始数组下标保留历史顺序
  return { bucket: SORT_BUCKET.LEGACY, order: index };
}

/** 欢迎语 → 无时间戳历史（原序）→ 有时间戳近期对话（按 createdAt）→ 流式占位 */
export function sortSessionMessagesByTime(messages) {
  if (!Array.isArray(messages) || messages.length <= 1) {
    return Array.isArray(messages) ? [...messages] : [];
  }
  return messages
    .map((m, index) => ({ m, index }))
    .sort((a, b) => {
      const ca = classifyMessageSortBucket(a.m, a.index);
      const cb = classifyMessageSortBucket(b.m, b.index);
      if (ca.bucket !== cb.bucket) return ca.bucket - cb.bucket;
      if (ca.order !== cb.order) return ca.order - cb.order;
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
    const key = sessionMessageMergeKey(m);
    if (isStreamingAssistantMessage(m)) {
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      merged.push(m);
      continue;
    }
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    merged.push(m);
  }

  return sortSessionMessagesByTime(stripNonChatMessages(merged));
}

export function normalizeSessionMessagesForStorage(messages, { keepStreaming = false } = {}) {
  return sortSessionMessagesByTime(stripNonChatMessages(messages, { keepStreaming }));
}
