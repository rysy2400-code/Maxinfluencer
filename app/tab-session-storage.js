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

/** 清除本标签页的聊天持久化 */
export function clearTabChatPersistence() {
  for (const key of Object.values(TAB_STORAGE_KEYS)) {
    removeTabItem(key);
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
    if (legacyMessages) writeTabItem(TAB_STORAGE_KEYS.MESSAGES, legacyMessages);
    if (legacyContext) writeTabItem(TAB_STORAGE_KEYS.CONTEXT, legacyContext);
    if (legacyVersion) writeTabItem(TAB_STORAGE_KEYS.VERSION, legacyVersion);
  } catch {
    /* ignore */
  }
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
