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

/** 消息列表中最晚 createdAt（毫秒）；无时间戳则 0 */
export function maxMessageTimeMs(messages) {
  if (!Array.isArray(messages)) return 0;
  let max = 0;
  for (const m of messages) {
    const t = parseMessageTime(m?.createdAt);
    if (t) max = Math.max(max, t.getTime());
  }
  return max;
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

const MERGE_BULK_EXTRA_THRESHOLD = 5;

/** 从会话标题提取「本 Campaign」内容 marker，用于识别误入的其他产品对话块 */
export function ownMarkersFromSessionTitle(title) {
  const t = String(title || "").toLowerCase();
  const markers = new Set();
  if (t.includes("vast") || t.includes("tripo")) {
    markers.add("tripo");
    markers.add("tripo3d");
    markers.add("vast-similar");
    markers.add("vast ai");
    markers.add("camp-1782463190123");
  }
  if (t.includes("nexbie")) markers.add("nexbie");
  if (t.includes("hailuo") || t.includes("海螺")) {
    markers.add("hailuo");
    markers.add("hailuoai");
  }
  if (t.includes("ribbi")) markers.add("ribbi");
  for (const w of t.split(/[\s·\-—/]+/)) {
    const word = w.trim();
    if (word.length >= 4) markers.add(word);
  }
  return [...markers];
}

const FOREIGN_PRODUCT_URL_MARKERS = [
  "nexbie.com",
  "shoes.nexbie.com",
  "tripo3d.ai",
  "hailuoai.video",
  "ribbi.ai",
];

function isForeignMarkerOwnedBySession(foreign, ownMarkers) {
  const f = String(foreign || "").toLowerCase();
  const own = (ownMarkers || []).map((m) => String(m).toLowerCase());
  if (f.includes("tripo") && own.some((o) => o.includes("tripo"))) return true;
  if (f.includes("nexbie") && own.some((o) => o.includes("nexbie"))) return true;
  if (f.includes("hailuo") && own.some((o) => o.includes("hailuo"))) return true;
  if (f.includes("ribbi") && own.some((o) => o.includes("ribbi"))) return true;
  return false;
}

/**
 * 在「本 Campaign 对话」之后，找到第一条含 foreignMarker 的消息索引
 */
export function findForeignBlockStart(messages, { ownMarkers, foreignMarker: foreign }) {
  if (!Array.isArray(messages) || !foreign) return -1;
  const foreignLower = String(foreign).toLowerCase();
  const own = (ownMarkers || []).map((m) => String(m).toLowerCase());

  let lastOwnIndex = -1;
  for (let i = 0; i < messages.length; i++) {
    const c = String(messages[i]?.content || "").toLowerCase();
    if (own.some((m) => c.includes(m))) lastOwnIndex = i;
  }

  for (let i = Math.max(0, lastOwnIndex + 1); i < messages.length; i++) {
    const c = String(messages[i]?.content || "").toLowerCase();
    if (c.includes(foreignLower)) return i;
  }
  return -1;
}

/**
 * 去掉误追加的其他 Campaign 对话尾块（时间戳在会话创建之后也会被 merge 写入，trim-before-created 无法处理）
 */
export function stripForeignCampaignBlocks(messages, sessionTitle) {
  if (!Array.isArray(messages) || !sessionTitle) {
    return Array.isArray(messages) ? [...messages] : [];
  }
  const own = ownMarkersFromSessionTitle(sessionTitle);
  let result = messages;
  for (const foreign of FOREIGN_PRODUCT_URL_MARKERS) {
    if (isForeignMarkerOwnedBySession(foreign, own)) continue;
    const start = findForeignBlockStart(result, { ownMarkers: own, foreignMarker: foreign });
    if (start >= 0) result = result.slice(0, start);
  }
  return sortSessionMessagesByTime(stripNonChatMessages(result));
}

/**
 * 本地比服务端多出大量「未落库」消息时，丢弃 createdAt 早于会话/远端时间线的块，避免跨 Campaign 串历史。
 */
function filterSuspiciousLocalExtras(localArr, remoteArr, sessionCreatedAt) {
  const remoteKeys = new Set(
    remoteArr.map((m) => sessionMessageMergeKey(m)).filter(Boolean)
  );
  const extras = localArr.filter((m) => {
    const key = sessionMessageMergeKey(m);
    return key && !remoteKeys.has(key);
  });
  if (extras.length <= MERGE_BULK_EXTRA_THRESHOLD) return null;

  const sessionTs = parseMessageTime(sessionCreatedAt)?.getTime() ?? 0;
  const cutoff = Math.max(maxMessageTimeMs(remoteArr), sessionTs - 60_000);

  return extras.filter((m) => {
    if (isStreamingAssistantMessage(m)) return true;
    const t = parseMessageTime(m?.createdAt)?.getTime();
    if (t == null) return cutoff === 0;
    return t >= cutoff;
  });
}

/**
 * 合并本地与服务端消息：服务端为已持久化记录的权威来源，保留本地未落库的用户消息与流式 assistant。
 * @param {Object} [options]
 * @param {string} [options.sessionCreatedAt] - 会话创建时间；传入时可阻断跨 Campaign 大批量误入
 */
export function mergeSessionMessages(local, remote, options = {}) {
  const localArr = Array.isArray(local) ? local : [];
  const remoteArr = Array.isArray(remote) ? remote : [];
  const sessionCreatedAt = options.sessionCreatedAt ?? null;

  let merged;

  if (remoteArr.length === 0) {
    merged = sortSessionMessagesByTime(localArr);
  } else if (
    sessionCreatedAt &&
    localArr.length > remoteArr.length + MERGE_BULK_EXTRA_THRESHOLD
  ) {
    const safeExtras = filterSuspiciousLocalExtras(
      localArr,
      remoteArr,
      sessionCreatedAt
    );
    if (safeExtras) {
      const bulkMerged = [...remoteArr];
      const seen = new Set(
        remoteArr.map((m) => sessionMessageMergeKey(m)).filter(Boolean)
      );
      for (const m of safeExtras) {
        const key = sessionMessageMergeKey(m);
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        bulkMerged.push(m);
      }
      merged = sortSessionMessagesByTime(stripNonChatMessages(bulkMerged));
    }
  }

  if (!merged) {
    const combined = [];
    const seen = new Set();

    for (const m of remoteArr) {
      const key = sessionMessageMergeKey(m);
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      combined.push(m);
    }

    for (const m of localArr) {
      const key = sessionMessageMergeKey(m);
      if (isStreamingAssistantMessage(m)) {
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        combined.push(m);
        continue;
      }
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      combined.push(m);
    }

    merged = sortSessionMessagesByTime(stripNonChatMessages(combined));
  }

  if (sessionCreatedAt) {
    merged = trimMessagesBeforeSessionCreated(merged, sessionCreatedAt);
  }

  return merged;
}

export function normalizeSessionMessagesForStorage(messages, { keepStreaming = false } = {}) {
  return sortSessionMessagesByTime(stripNonChatMessages(messages, { keepStreaming }));
}

/**
 * 移除 createdAt 早于会话创建时间（减 1 分钟容差）的消息，保留无时间戳的欢迎语。
 * 用于清理误并入的其他 Campaign 历史。
 */
export function trimMessagesBeforeSessionCreated(messages, sessionCreatedAt) {
  if (!Array.isArray(messages) || !sessionCreatedAt) return Array.isArray(messages) ? [...messages] : [];
  const sessionTs = parseMessageTime(sessionCreatedAt)?.getTime();
  if (!sessionTs) return [...messages];

  const threshold = sessionTs - 60_000;
  const welcomeOnly = messages.filter(
    (m) => isWelcomeMessage(m) && !parseMessageTime(m?.createdAt)
  );
  const timedKept = messages.filter((m) => {
    const t = parseMessageTime(m?.createdAt)?.getTime();
    if (t == null) return false;
    return t >= threshold;
  });

  if (timedKept.length === 0) return [...messages];

  const merged = [];
  const seen = new Set();
  for (const m of [...welcomeOnly, ...timedKept]) {
    const key = sessionMessageMergeKey(m);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    merged.push(m);
  }
  return sortSessionMessagesByTime(stripNonChatMessages(merged));
}
