/**
 * 聊天附件下载兜底解析。
 *
 * 场景：用户上传的 PENDING-*.xlsx 在名单导入完成后会被清理（见
 * execute-influencer-list-import.js），但聊天消息里的下载链接仍指向
 * PENDING storageKey，直接读取会返回「附件不存在」。
 *
 * 本模块在直接读取失败时：
 * 1. 按 storageKey 反查导入任务（source_file_storage_key 保留了原始 key）；
 * 2. 优先返回导入时保存的 IMP-* 审计副本（新逻辑：导入前落副本，字节一致）；
 * 3. 没有副本时，用任务 payload.rows 重建一份可下载、可再次导入的 xlsx。
 */
import {
  readSessionImportFile,
  saveSessionImportFile,
} from "./session-import-storage.js";
import { getImportTasksBySourceFileStorageKey } from "../db/influencer-import-task-dao.js";
import { loadXlsx } from "./load-xlsx.js";

function extFromFileName(fileName, fallback = ".xlsx") {
  const name = String(fileName || "");
  const m = name.match(/\.(xlsx|xls|csv)$/i);
  return m ? m[0].toLowerCase() : fallback;
}

function buildWorkbookBuffer(rows) {
  const XLSX = loadXlsx();
  if (!XLSX?.utils) {
    throw new Error("xlsx 模块加载失败");
  }
  const aoa = [["主页链接", "平台", "用户名"]];
  for (const r of rows || []) {
    aoa.push([
      String(r.profileUrl || r.profile_url || "").trim(),
      String(r.platform || "").trim(),
      String(r.username || "").trim(),
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [{ wch: 60 }, { wch: 12 }, { wch: 30 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

function payloadRows(task) {
  if (!task?.payload) return [];
  if (Array.isArray(task.payload)) return task.payload;
  if (Array.isArray(task.payload.rows)) return task.payload.rows;
  return [];
}

/**
 * 尝试解析聊天附件内容。
 * @param {string} sessionId
 * @param {string} storageKey
 * @returns {Promise<{ buffer: Buffer, storageKey: string, source: string } | null>}
 */
export async function resolveChatAttachmentBuffer(sessionId, storageKey) {
  const direct = readSessionImportFile(storageKey);
  if (direct) {
    return { buffer: direct, storageKey, source: "direct" };
  }

  const base = String(storageKey || "").split("/").pop() || "";
  if (!base.startsWith("PENDING-")) return null;
  if (!sessionId) return null;

  const tasks = await getImportTasksBySourceFileStorageKey(sessionId, storageKey);
  if (!tasks?.length) return null;
  const task = tasks[0];

  const groupId = task.batch_group_id || task.import_batch_id;
  const ext = extFromFileName(task.source_file_name);
  const durableKey = `${sessionId}/${groupId}${ext}`;

  const durable = readSessionImportFile(durableKey);
  if (durable) {
    return { buffer: durable, storageKey: durableKey, source: "durable_copy" };
  }

  const rows = payloadRows(task);
  if (!rows.length || ext !== ".xlsx") return null;
  try {
    const rebuilt = buildWorkbookBuffer(rows);
    saveSessionImportFile(sessionId, groupId, rebuilt, task.source_file_name || "list.xlsx");
    return { buffer: rebuilt, storageKey: durableKey, source: "rebuilt" };
  } catch (err) {
    console.warn(
      "[chat-attachment-resolver] 重建附件失败:",
      err?.message || err
    );
    return null;
  }
}
