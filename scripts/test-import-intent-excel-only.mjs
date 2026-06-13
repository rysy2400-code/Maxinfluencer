/**
 * E2E：仅上传 Excel（无用户意图文字）→ 应先确认，不应创建 import task
 * 对比：带明确「联系」文字 → 应直接导入
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local" });

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

const BASE = process.env.E2E_BASE_URL || "http://localhost:3000";
const SESSION_ID = process.env.E2E_SESSION_ID || "bd30b9e3-ae7e-4719-85f5-c771669139bb";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function login() {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      companyName: "MaxinAI",
      username: "Serena",
      password: "010813",
    }),
  });
  const body = await login.json();
  if (!login.ok || !body.success) {
    throw new Error(`login failed: ${login.status} ${JSON.stringify(body)}`);
  }
  const jar = (login.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  return jar;
}

async function uploadExcel(jar, fileName, rows) {
  const xlsxPath = path.join(__dirname, fileName);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Creators");
  XLSX.writeFile(wb, xlsxPath);

  const fd = new FormData();
  fd.set("file", new Blob([fs.readFileSync(xlsxPath)]), fileName);
  const up = await fetch(`${BASE}/api/sessions/${SESSION_ID}/chat-attachments`, {
    method: "POST",
    headers: { Cookie: jar },
    body: fd,
  });
  const upBody = await up.json();
  if (!up.ok || !upBody.success) {
    throw new Error(`upload failed: ${up.status} ${JSON.stringify(upBody)}`);
  }
  return upBody;
}

async function chatWithAttachment(jar, { content, attachment, label }) {
  const sess = await fetch(`${BASE}/api/sessions/${SESSION_ID}`, {
    headers: { Cookie: jar },
  });
  const sessBody = await sess.json();
  const history = Array.isArray(sessBody.session?.messages) ? sessBody.session.messages : [];
  const context = sessBody.session?.context || {};

  const userMsg = {
    role: "user",
    content,
    attachments: [
      {
        type: "chat_attachment",
        name: attachment.fileName,
        storageKey: attachment.storageKey,
        sizeBytes: attachment.sizeBytes,
      },
    ],
  };

  console.log(`\n=== ${label} ===`);
  console.log("user content:", JSON.stringify(content));

  const chat = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: jar },
    body: JSON.stringify({
      messages: [...history.slice(-8), userMsg],
      context,
      sessionId: SESSION_ID,
      stream: false,
    }),
  });
  const chatBody = await chat.json();
  if (!chat.ok) {
    throw new Error(`chat failed: ${chat.status} ${JSON.stringify(chatBody)}`);
  }

  const tool = chatBody.thinking?.toolCall?.toolName || null;
  const reply = String(chatBody.reply || "");
  console.log("tool:", tool || "(none)");
  console.log("reply:", reply.slice(0, 600));

  const { queryTikTok } = await import("../lib/db/mysql-tiktok.js");
  const tasks = await queryTikTok(
    `SELECT id, status, source_file_name, created_at
     FROM tiktok_influencer_import_task
     WHERE session_id=? AND source_file_name=?
     ORDER BY id DESC LIMIT 1`,
    [SESSION_ID, attachment.fileName]
  );
  console.log("import task for this file:", tasks[0] || null);

  return { tool, reply, task: tasks[0] || null };
}

async function main() {
  const ts = Date.now();
  const fileName = `intent-confirm-e2e-${ts}.xlsx`;
  const rows = [
    ["红人用户名", "红人平台", "主页链接"],
    [`intent_e2e_${ts}`, "tk", `https://www.tiktok.com/@intent_e2e_${ts}`],
    [`intent_e2e_b_${ts}`, "tk", `https://www.tiktok.com/@intent_e2e_b_${ts}`],
  ];

  console.log("BASE", BASE, "SESSION", SESSION_ID);
  const jar = await login();
  const up = await uploadExcel(jar, fileName, rows);
  console.log("upload ok", up.storageKey);

  const beforeTaskCount = await (async () => {
    const { queryTikTok } = await import("../lib/db/mysql-tiktok.js");
    const r = await queryTikTok(
      `SELECT COUNT(*) AS n FROM tiktok_influencer_import_task WHERE session_id=? AND source_file_name=?`,
      [SESSION_ID, fileName]
    );
    return Number(r[0]?.n || 0);
  })();

  // 场景 A：仅附件占位文案（模拟前端只发 Excel）
  const a = await chatWithAttachment(jar, {
    content: `上传附件：${fileName}`,
    attachment: up,
    label: "A 仅上传附件（无意图文字）",
  });

  const afterA = await (async () => {
    const { queryTikTok } = await import("../lib/db/mysql-tiktok.js");
    const r = await queryTikTok(
      `SELECT COUNT(*) AS n FROM tiktok_influencer_import_task WHERE session_id=? AND source_file_name=?`,
      [SESSION_ID, fileName]
    );
    return Number(r[0]?.n || 0);
  })();

  let passA = !a.tool && afterA === beforeTaskCount;
  const confirmHints = /确认|是否|希望|导入|联系|看到|Excel|红人|名单/i;
  passA = passA && confirmHints.test(a.reply);

  console.log("\n--- 场景 A 判定 ---");
  console.log(passA ? "PASS" : "FAIL", {
    noTool: !a.tool,
    noNewTask: afterA === beforeTaskCount,
    replyAsksConfirm: confirmHints.test(a.reply),
  });

  // 场景 B：明确说要联系
  const b = await chatWithAttachment(jar, {
    content: `请分析并联系附件里的这批红人`,
    attachment: up,
    label: "B 明确联系意图",
  });

  const afterB = await (async () => {
    const { queryTikTok } = await import("../lib/db/mysql-tiktok.js");
    const r = await queryTikTok(
      `SELECT COUNT(*) AS n FROM tiktok_influencer_import_task WHERE session_id=? AND source_file_name=?`,
      [SESSION_ID, fileName]
    );
    return Number(r[0]?.n || 0);
  })();

  const passB =
    b.tool === "import_influencer_list" || afterB > beforeTaskCount || /识别.*红人|正在分析/i.test(b.reply);

  console.log("\n--- 场景 B 判定 ---");
  console.log(passB ? "PASS" : "FAIL", {
    tool: b.tool,
    taskCreated: afterB > beforeTaskCount,
  });

  if (!passA || !passB) process.exit(1);
  console.log("\n✅ 全部通过");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
