/** 标签页级聊天持久化（sessionStorage），避免多标签共享 localStorage 导致 Campaign 串会话 */

export const TAB_STORAGE_KEYS = {
  MESSAGES: "maxinfluencer_chat_messages",
  CONTEXT: "maxinfluencer_chat_context",
  CURRENT_SESSION_ID: "maxinfluencer_current_session_id",
  VERSION: "maxinfluencer_message_version",
};

function storage() {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function readTabItem(key) {
  const s = storage();
  if (!s) return null;
  try {
    return s.getItem(key);
  } catch {
    return null;
  }
}

export function writeTabItem(key, value) {
  const s = storage();
  if (!s) return;
  try {
    if (value == null || value === "") s.removeItem(key);
    else s.setItem(key, String(value));
  } catch {
    /* ignore quota */
  }
}

export function removeTabItem(key) {
  writeTabItem(key, null);
}

/** 按 sessionId 分桶，避免 currentSessionId 与 messages 来自不同 Campaign */
export function sessionScopedKey(baseKey, sessionId) {
  const sid = String(sessionId || "").trim();
  if (!sid) return baseKey;
  return `${baseKey}__${sid}`;
}

export function readSessionScopedItem(baseKey, sessionId) {
  const sid = String(sessionId || "").trim();
  if (!sid) return null;
  return readTabItem(sessionScopedKey(baseKey, sid));
}

export function writeSessionScopedItem(baseKey, sessionId, value) {
  const sid = String(sessionId || "").trim();
  if (!sid) return;
  writeTabItem(sessionScopedKey(baseKey, sid), value);
}

export function removeSessionScopedItem(baseKey, sessionId) {
  const sid = String(sessionId || "").trim();
  if (!sid) return;
  removeTabItem(sessionScopedKey(baseKey, sid));
}

/** 清除全局（非分桶）messages/context，保留 currentSessionId / version */
export function clearLegacyGlobalChatTabKeys() {
  removeTabItem(TAB_STORAGE_KEYS.MESSAGES);
  removeTabItem(TAB_STORAGE_KEYS.CONTEXT);
}

/** 清除本标签页的聊天持久化 */
export function clearTabChatPersistence() {
  const s = storage();
  if (!s) return;
  try {
    const toRemove = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (!k) continue;
      if (
        k === TAB_STORAGE_KEYS.CURRENT_SESSION_ID ||
        k === TAB_STORAGE_KEYS.VERSION ||
        k.startsWith(`${TAB_STORAGE_KEYS.MESSAGES}__`) ||
        k.startsWith(`${TAB_STORAGE_KEYS.CONTEXT}__`) ||
        k === TAB_STORAGE_KEYS.MESSAGES ||
        k === TAB_STORAGE_KEYS.CONTEXT
      ) {
        toRemove.push(k);
      }
    }
    for (const k of toRemove) s.removeItem(k);
  } catch {
    for (const key of Object.values(TAB_STORAGE_KEYS)) {
      removeTabItem(key);
    }
  }
}

/**
 * 首次打开标签页：若 sessionStorage 无会话，从 localStorage 迁移一次（兼容旧版单标签）
 */
export function migrateLegacyLocalStorageToTabOnce() {
  if (typeof window === "undefined") return;
  const s = storage();
  if (!s) return;
  if (readTabItem(TAB_STORAGE_KEYS.CURRENT_SESSION_ID)) return;

  try {
    const legacySid = window.localStorage.getItem(TAB_STORAGE_KEYS.CURRENT_SESSION_ID);
    const legacyMessages = window.localStorage.getItem(TAB_STORAGE_KEYS.MESSAGES);
    const legacyContext = window.localStorage.getItem(TAB_STORAGE_KEYS.CONTEXT);
    const legacyVersion = window.localStorage.getItem(TAB_STORAGE_KEYS.VERSION);

    if (legacySid) writeTabItem(TAB_STORAGE_KEYS.CURRENT_SESSION_ID, legacySid);
    if (legacyMessages) {
      writeSessionScopedItem(TAB_STORAGE_KEYS.MESSAGES, legacySid, legacyMessages);
    }
    if (legacyContext) {
      writeSessionScopedItem(TAB_STORAGE_KEYS.CONTEXT, legacySid, legacyContext);
    }
    if (legacyVersion) writeTabItem(TAB_STORAGE_KEYS.VERSION, legacyVersion);
  } catch {
    /* ignore */
  }
}

/**
 * v2.2 → v2.3：全局 messages/context 迁入当前 session 分桶后删除全局键
 */
export function migrateGlobalTabMessagesToSessionScopedOnce() {
  if (typeof window === "undefined") return;
  const sid = readTabItem(TAB_STORAGE_KEYS.CURRENT_SESSION_ID);
  if (!sid) {
    clearLegacyGlobalChatTabKeys();
    return;
  }
  const globalMessages = readTabItem(TAB_STORAGE_KEYS.MESSAGES);
  const globalContext = readTabItem(TAB_STORAGE_KEYS.CONTEXT);
  if (globalMessages && !readSessionScopedItem(TAB_STORAGE_KEYS.MESSAGES, sid)) {
    writeSessionScopedItem(TAB_STORAGE_KEYS.MESSAGES, sid, globalMessages);
  }
  if (globalContext && !readSessionScopedItem(TAB_STORAGE_KEYS.CONTEXT, sid)) {
    writeSessionScopedItem(TAB_STORAGE_KEYS.CONTEXT, sid, globalContext);
  }
  clearLegacyGlobalChatTabKeys();
}

/** 停止跨标签污染：移除 localStorage 中的会话相关键 */
export function clearLegacyLocalChatPersistence() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(TAB_STORAGE_KEYS.MESSAGES);
    window.localStorage.removeItem(TAB_STORAGE_KEYS.CONTEXT);
    window.localStorage.removeItem(TAB_STORAGE_KEYS.CURRENT_SESSION_ID);
  } catch {
    /* ignore */
  }
}
