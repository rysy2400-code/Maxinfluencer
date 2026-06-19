import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../data/session-imports");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * 保存上传的 Excel，返回相对 storage key
 * @param {string} sessionId
 * @param {string} importBatchId
 * @param {Buffer} buffer
 * @param {string} originalName
 */
export function saveSessionImportFile(sessionId, importBatchId, buffer, originalName = "list.xlsx") {
  const safeSession = String(sessionId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeBatch = String(importBatchId || "batch").replace(/[^a-zA-Z0-9_-]/g, "_");
  const ext = path.extname(originalName || "") || ".xlsx";
  const dir = path.join(ROOT, safeSession);
  ensureDir(dir);
  const filename = `${safeBatch}${ext}`;
  const abs = path.join(dir, filename);
  fs.writeFileSync(abs, buffer);
  return {
    storageKey: `${safeSession}/${filename}`,
    absolutePath: abs,
  };
}

export function storageKeyBelongsToSession(storageKey, sessionId) {
  if (!storageKey || !sessionId) return false;
  const safeSession = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, "_");
  const key = String(storageKey);
  return key.startsWith(`${sessionId}/`) || key.startsWith(`${safeSession}/`);
}

export function readSessionImportFile(storageKey) {
  const key = String(storageKey || "");
  if (!key || key.includes("..")) return null;
  const abs = path.join(ROOT, key);
  const resolvedRoot = path.resolve(ROOT);
  const resolvedAbs = path.resolve(abs);
  if (!resolvedAbs.startsWith(resolvedRoot + path.sep) && resolvedAbs !== resolvedRoot) {
    return null;
  }
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs);
}
