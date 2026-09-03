/**
 * 从导入任务 payload 重建聊天附件 xlsx（不写数据库）。
 *
 * 背景：聊天附件（PENDING-*.xlsx）在名单导入完成后会被清理，历史聊天消息里
 * 的下载链接因此返回「附件不存在」。导入任务 payload.rows 保留了名单内容
 * （profileUrl / platform / username），可据此重建一份可下载、可再次导入的文件。
 *
 * 用法：
 *   node scripts/rebuild-import-attachment-xlsx.mjs --task=195 --out=tmp/attachments
 *
 * 输出：tmp/attachments/<sessionId>/<storageKeyBase>.xlsx
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { loadXlsx } from "../lib/influencer/load-xlsx.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function parseArgs() {
  const args = process.argv.slice(2);
  const taskArg = args.find((a) => a.startsWith("--task="));
  const outArg = args.find((a) => a.startsWith("--out="));
  return {
    taskId: taskArg ? Number(taskArg.split("=")[1]) : NaN,
    outDir: outArg
      ? path.resolve(projectRoot, outArg.split("=").slice(1).join("="))
      : path.join(projectRoot, "tmp", "attachments"),
  };
}

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function loadTask(taskId) {
  const rows = await queryTikTok(
    `
    SELECT id, session_id, import_batch_id, batch_group_id, contact_mode,
           total_rows, source_file_name, source_file_storage_key, payload
    FROM tiktok_influencer_import_task
    WHERE id = ?
    LIMIT 1
  `,
    [taskId]
  );
  const r = rows?.[0];
  if (!r) return null;
  const payload = parseJson(r.payload) || {};
  return {
    ...r,
    payload,
    rows: Array.isArray(payload.rows) ? payload.rows : [],
  };
}

function buildXlsxBuffer(rows) {
  const XLSX = loadXlsx();
  const aoa = [
    ["主页链接", "平台", "用户名"],
  ];
  for (const r of rows || []) {
    aoa.push([
      String(r.profileUrl || r.profile_url || "").trim(),
      String(r.platform || "").trim(),
      String(r.username || "").trim(),
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [
    { wch: 60 },
    { wch: 12 },
    { wch: 30 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

async function main() {
  const { taskId, outDir } = parseArgs();
  if (!Number.isInteger(taskId) || taskId <= 0) {
    throw new Error("请传入 --task=<导入任务ID>");
  }

  const task = await loadTask(taskId);
  if (!task) throw new Error(`导入任务不存在: ${taskId}`);
  if (!task.rows.length) {
    throw new Error(`任务 ${taskId} payload 中没有可重建的名单行`);
  }
  if (!/\.xlsx$/i.test(task.source_file_name || "")) {
    throw new Error(`仅支持重建 xlsx 附件，当前文件: ${task.source_file_name}`);
  }

  const buffer = buildXlsxBuffer(task.rows);
  const storageKeyBase = String(task.source_file_storage_key || "").split("/").pop() || `PENDING-${taskId}.xlsx`;
  const sessionDir = path.join(outDir, String(task.session_id || "unknown"));
  fs.mkdirSync(sessionDir, { recursive: true });
  const outPath = path.join(sessionDir, storageKeyBase);
  fs.writeFileSync(outPath, buffer);

  console.log(
    JSON.stringify(
      {
        taskId,
        sessionId: task.session_id,
        contactMode: task.contact_mode,
        sourceFileName: task.source_file_name,
        sourceStorageKey: task.source_file_storage_key,
        storageKeyBase,
        rebuiltRows: task.rows.length,
        taskTotalRows: task.total_rows,
        bytes: buffer.length,
        outPath,
      },
      null,
      2
    )
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[rebuild] failed:", e?.message || e);
    process.exit(1);
  });
