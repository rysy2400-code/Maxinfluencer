/**
 * E2E：粘贴 YouTube 链接 → 确认「是」→ 应成功导入（非「未能识别」）
 * 以及：明确「联系」+ 链接 → ack 不应出现「附件」
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local" });

const BASE = process.env.E2E_BASE_URL || "http://localhost:3000";
const SESSION_ID = process.env.E2E_SESSION_ID || "bd30b9e3-ae7e-4719-85f5-c771669139bb";

const LINKS_MSG = `youtube.com/@yaboyroshi_test_${Date.now()}
youtube.com/@jaceyflames_test_${Date.now()}
youtube.com/@Erenz_test_${Date.now()}`;

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
  if (!login.ok || !body.success) throw new Error(`login failed ${login.status}`);
  return (login.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
}

async function chat(jar, history, userMsg, label) {
  const sess = await fetch(`${BASE}/api/sessions/${SESSION_ID}`, { headers: { Cookie: jar } });
  const sessBody = await sess.json();
  const ctx = sessBody.session?.context || {};

  console.log(`\n=== ${label} ===`);
  console.log("user:", String(userMsg.content || userMsg).slice(0, 120));

  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: jar },
    body: JSON.stringify({
      messages: [...history.slice(-12), userMsg],
      context: ctx,
      sessionId: SESSION_ID,
      stream: false,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));

  const tool = data.thinking?.toolCall?.toolName || null;
  const reply = String(data.reply || "");
  console.log("tool:", tool || "(none)");
  console.log("reply:", reply.slice(0, 500));

  return { tool, reply, messages: [...history.slice(-12), userMsg, { role: "assistant", content: reply }] };
}

async function main() {
  const jar = await login();
  const sess = await fetch(`${BASE}/api/sessions/${SESSION_ID}`, { headers: { Cookie: jar } });
  const sessBody = await sess.json();
  let history = Array.isArray(sessBody.session?.messages) ? sessBody.session.messages : [];

  const step1 = await chat(jar, history, { role: "user", content: LINKS_MSG }, "A 仅发链接");
  history = step1.messages;

  const asksConfirm = /确认|是否|希望|导入|联系/i.test(step1.reply);
  const noTool1 = !step1.tool;
  console.log("A asks confirm:", asksConfirm, "no tool:", noTool1);

  const step2 = await chat(jar, history, { role: "user", content: "是" }, "B 用户确认「是」");
  const passB =
    step2.tool === "import_influencer_list" ||
    (/识别.*红人|正在分析/i.test(step2.reply) && !/未能识别|导入已取消/.test(step2.reply));

  console.log("\n--- B 判定 ---", passB ? "PASS" : "FAIL");

  const step3 = await chat(
    jar,
    history,
    { role: "user", content: `联系：${LINKS_MSG.split("\n")[0]}` },
    "C 明确联系+单链接"
  );
  const passC =
    (step3.tool === "import_influencer_list" || /识别.*红人/i.test(step3.reply)) &&
    !/已收到\s*附件|已收到附件/.test(step3.reply);

  console.log("--- C 判定 ---", passC ? "PASS" : "FAIL", {
    noAttachmentWording: !/已收到\s*附件|已收到附件/.test(step3.reply),
  });

  if (!passB || !passC) process.exit(1);
  console.log("\n✅ 全部通过");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
