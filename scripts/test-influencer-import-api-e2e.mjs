/**
 * API 级 E2E：薄上传 + /api/chat（模拟前端发送带 attachments 的消息）
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import XLSX from "xlsx";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local" });

const BASE = process.env.E2E_BASE_URL || "http://localhost:3457";
const SESSION_ID = process.env.E2E_SESSION_ID || "bd30b9e3-ae7e-4719-85f5-c771669139bb";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const ts = Date.now();
  const xlsxPath = path.join(__dirname, "e2e-api-import.xlsx");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["红人用户名", "红人平台"],
      [`api_e2e_${ts}`, "tk"],
    ]),
    "Creators"
  );
  XLSX.writeFile(wb, xlsxPath);

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ companyName: "MaxinAI", username: "Serena", password: "010813" }),
  });
  console.log("login", login.status, await login.json());

  const jar = (login.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");

  const fd = new FormData();
  fd.set("file", new Blob([fs.readFileSync(xlsxPath)]), "e2e-api-import.xlsx");
  const up = await fetch(`${BASE}/api/sessions/${SESSION_ID}/chat-attachments`, {
    method: "POST",
    headers: { Cookie: jar },
    body: fd,
  });
  const upBody = await up.json();
  console.log("upload", up.status, upBody);
  if (!upBody.success) process.exit(1);

  const sess = await fetch(`${BASE}/api/sessions/${SESSION_ID}`, { headers: { Cookie: jar } });
  const sessBody = await sess.json();
  const history = Array.isArray(sessBody.session?.messages) ? sessBody.session.messages : [];
  const context = sessBody.session?.context || {};

  const userMsg = {
    role: "user",
    content: "E2E API：联系附件里这批红人",
    attachments: [
      {
        type: "chat_attachment",
        name: upBody.fileName,
        storageKey: upBody.storageKey,
      },
    ],
  };

  console.log("calling chat...");
  const chat = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: jar },
    body: JSON.stringify({
      messages: [...history.slice(-10), userMsg],
      context,
      sessionId: SESSION_ID,
      stream: false,
    }),
  });
  const chatBody = await chat.json();
  console.log("chat status", chat.status);
  console.log("reply preview:", String(chatBody.reply || "").slice(0, 500));
  console.log("tool", chatBody.thinking?.toolCall?.toolName);

  const { queryTikTok } = await import("../lib/db/mysql-tiktok.js");
  const tasks = await queryTikTok(
    `SELECT id,status FROM tiktok_influencer_import_task WHERE session_id=? ORDER BY id DESC LIMIT 1`,
    [SESSION_ID]
  );
  console.log("import task", tasks);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
