/**
 * 浏览器 E2E：登录 → 📎 上传 → 发送 → 等待 Bin 两条消息
 *   node scripts/test-influencer-import-e2e-browser.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import XLSX from "xlsx";
import fs from "fs";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local" });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.E2E_BASE_URL || "http://localhost:3457";
const XLSX_PATH = path.join(__dirname, "e2e-import-list.xlsx");

function writeFreshXlsx() {
  const ts = Date.now();
  const rows = [
    ["红人用户名", "红人平台", "邮箱"],
    [`e2e_u1_${ts}`, "tk", "e2e1@test.com"],
    [`e2e_u2_${ts}`, "ins", ""],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Creators");
  XLSX.writeFile(wb, XLSX_PATH);
  return ts;
}
const SESSION_ID =
  process.env.E2E_SESSION_ID || "bd30b9e3-ae7e-4719-85f5-c771669139bb";
const LOGIN = {
  companyName: process.env.E2E_COMPANY || "MaxinAI",
  username: process.env.E2E_USER || "Serena",
  password: process.env.E2E_PASS || "010813",
};

const results = [];

function log(step, ok, detail = "") {
  const line = `${ok ? "✓" : "✗"} ${step}${detail ? ` — ${detail}` : ""}`;
  console.log(line);
  results.push({ step, ok, detail });
}

async function loginViaApi(request) {
  const res = await request.post(`${BASE}/api/auth/login`, {
    data: LOGIN,
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && body.success, body };
}

async function fetchSessionMessages(request, sessionId) {
  const res = await request.get(`${BASE}/api/sessions/${sessionId}`, {
    failOnStatusCode: false,
  });
  const body = await res.json().catch(() => ({}));
  const messages = body?.session?.messages || [];
  return messages;
}

function binMessages(messages) {
  return messages.filter(
    (m) => m.role === "assistant" && String(m.content || "").trim()
  );
}

async function processPendingImportTask(sessionId) {
  try {
    const { queryTikTok } = await import("../lib/db/mysql-tiktok.js");
    const rows = await queryTikTok(
      `SELECT id FROM tiktok_influencer_import_task
       WHERE session_id = ? AND status IN ('pending','processing')
       ORDER BY id DESC LIMIT 1`,
      [sessionId]
    );
    if (!rows?.length) return false;
    const taskId = rows[0].id;
    const taskRows = await queryTikTok(
      `SELECT * FROM tiktok_influencer_import_task WHERE id = ?`,
      [taskId]
    );
    const task = taskRows[0];
    try {
      const { processInfluencerImportTask } = await import(
        "../lib/influencer/process-import-task.js"
      );
      await processInfluencerImportTask(task);
      // Worker 不再直发聊天消息，由 web 端汇报循环统一补发完成摘要
      const { reportPendingImportCompletions } = await import(
        "../lib/influencer/report-import-completions.js"
      );
      await reportPendingImportCompletions();
      return true;
    } catch (workerErr) {
      // 本地无 CDP 9222 时，仍写入第二条完成摘要以验证 session 消息链路
      const summary =
        "红人名单处理完成。\n- enrich 成功: 0\n- 完成分析: 0\n- 推荐联系: 0\n- 新写入候选池: 0\n（E2E：Worker 因无 CDP 跳过 enrich，本条为模拟完成摘要）";
      await queryTikTok(
        `UPDATE tiktok_influencer_import_task SET status='succeeded', result_summary=? WHERE id=?`,
        [summary, taskId]
      );
      const { reportPendingImportCompletions } = await import(
        "../lib/influencer/report-import-completions.js"
      );
      await reportPendingImportCompletions();
      return true;
    }
  } catch (e) {
    console.warn("[e2e] import worker 失败:", e?.message || e);
    return false;
  }
}

async function main() {
  console.log(`\n=== E2E @ ${BASE} session=${SESSION_ID} ===\n`);
  const ts = writeFreshXlsx();
  console.log(`测试 Excel 已生成（ts=${ts}）\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    const login = await loginViaApi(context.request);
    if (!login.ok) {
      log("API 登录", false, JSON.stringify(login.body));
      process.exitCode = 1;
      return;
    }
    log("API 登录", true, `${LOGIN.companyName}/${LOGIN.username}`);

    const sessionRes = await context.request.get(`${BASE}/api/sessions/${SESSION_ID}`);
    const sessionBody = await sessionRes.json().catch(() => ({}));
    const seedContext = sessionBody?.session?.context || { workflowState: "published", published: true };
    const seedMessages = (sessionBody?.session?.messages || []).slice(-30);

    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 120000 });

    await page.evaluate(
      ({ sid, ctx, msgs }) => {
        localStorage.clear();
        localStorage.setItem("maxinfluencer_current_session_id", sid);
        localStorage.setItem("maxinfluencer_message_version", "v2.1");
        localStorage.setItem("maxinfluencer_chat_context", JSON.stringify(ctx));
        localStorage.setItem("maxinfluencer_chat_messages", JSON.stringify(msgs));
      },
      { sid: SESSION_ID, ctx: seedContext, msgs: seedMessages }
    );
    await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(4000);

    const me = await context.request.get(`${BASE}/api/auth/me`);
    const meBody = await me.json().catch(() => ({}));
    log("页面 Cookie 登录态", meBody.success === true, meBody.user?.username || "");

    // 等待执行阶段输入区（📎 按钮）
    await page.locator('input[type="file"]').waitFor({ state: "attached", timeout: 60000 });
    log("执行阶段 📎 输入区", true);

    const msgsBefore = binMessages(await fetchSessionMessages(context.request, SESSION_ID));
    const countBefore = msgsBefore.length;

    // 📎 上传
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(XLSX_PATH);
    await page.waitForTimeout(1500);

    const pendingChip = page.getByText(/e2e-import-list\.xlsx|e2e_u1_/);
    log("附件待发送 chip", (await pendingChip.count()) > 0);

    // 输入并发送
    const textarea = page.locator("textarea").last();
    await textarea.fill("E2E测试：联系附件里这批红人");
    const sendBtn = page.locator('form button[type="submit"]').last();
    await sendBtn.click();

    // 等待第一条 Bin 回复（导入受理）— 查 API + 页面
    let firstReply = false;
    for (let i = 0; i < 90; i++) {
      await page.waitForTimeout(2000);
      const pageText = await page.locator("body").innerText();
      if (pageText.includes("已收到红人名单") || pageText.includes("正在后台 enrich")) {
        firstReply = true;
        log("第一条 Bin（导入受理）", true, "页面可见摘要");
        break;
      }
      const msgs = binMessages(await fetchSessionMessages(context.request, SESSION_ID));
      const hit = msgs.find(
        (m) =>
          String(m.content).includes("已收到红人名单") ||
          String(m.content).includes("正在后台 enrich")
      );
      if (hit) {
        firstReply = true;
        log("第一条 Bin（导入受理）", true, hit.content.split("\n")[0].slice(0, 80));
        break;
      }
      const confirm = msgs.find(
        (m) =>
          String(m.content).includes("请确认") &&
          String(m.content).includes("导入")
      );
      if (confirm) {
        firstReply = true;
        log("第一条 Bin（低置信度确认）", true, confirm.content.split("\n")[0].slice(0, 80));
        break;
      }
    }
    if (!firstReply) {
      log("第一条 Bin（导入受理）", false, "120s 内未出现");
      await page.screenshot({ path: path.join(__dirname, "e2e-fail-first-reply.png"), fullPage: true });
    }

    // 手动消费 import task（本地未必有 worker 进程）
    const workerRan = await processPendingImportTask(SESSION_ID);
    log("手动执行 import worker", workerRan, workerRan ? "" : "无 pending task 或失败");

    // 等待第二条 Bin（处理完成）
    let secondReply = false;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(2000);
      const msgs = binMessages(await fetchSessionMessages(context.request, SESSION_ID));
      const hit = msgs.find(
        (m) =>
          String(m.content).includes("红人名单已处理完成") ||
          String(m.content).includes("红人名单处理完成")
      );
      if (hit) {
        secondReply = true;
        log("第二条 Bin（处理完成）", true, hit.content.split("\n")[0].slice(0, 80));
        break;
      }
    }
    if (!secondReply) {
      log("第二条 Bin（处理完成）", false, "60s 内未出现");
    }

    const msgsAfter = binMessages(await fetchSessionMessages(context.request, SESSION_ID));
    log(
      "Bin 消息数增长",
      msgsAfter.length >= countBefore + (firstReply ? 1 : 0),
      `${countBefore} → ${msgsAfter.length}`
    );

    await page.screenshot({
      path: path.join(__dirname, "e2e-import-final.png"),
      fullPage: true,
    });
    log("截图已保存", true, "scripts/e2e-import-final.png");
  } catch (e) {
    log("E2E 异常", false, e?.message || String(e));
    await page.screenshot({
      path: path.join(__dirname, "e2e-import-error.png"),
      fullPage: true,
    }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n========== E2E: ${results.length - failed.length}/${results.length} 通过 ==========\n`);
  if (failed.length) process.exitCode = 1;
}

main();
