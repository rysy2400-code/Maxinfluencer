#!/usr/bin/env node
/**
 * Instagram 自动登录（连接 9222 CDP Chrome）
 *
 * 用法:
 *   IG_LOGIN_USERNAME=nora.harbor_ghk \
 *   IG_LOGIN_PASSWORD=xxx \
 *   IG_EMAIL_USERNAME=victor.ward1979awg@hotmail.com \
 *   IG_EMAIL_PASSWORD=xxx \
 *   node scripts/ig-auto-login.mjs
 *
 * 流程:
 *   1. 连接 9222 Chrome，打开 instagram.com 登录页；
 *   2. 填写 IG 账号密码并提交；
 *   3. 若 IG 要求邮箱验证码：自动打开 Outlook 登录绑定邮箱，
 *      搜索 Instagram 验证码邮件，提取 6 位验证码回填 IG；
 *   4. 校验登录态（存在 sessionid cookie / 已进 feed）；
 *   5. 遇到无法自动处理的验证（手机验证/图片挑战/Outlook 二次验证）时
 *      明确报错停止，等待人工介入。
 *
 * 凭据只从环境变量读取，不写入任何文件。
 */
import { chromium } from "playwright";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CDP_ENDPOINT = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
const IG_LOGIN_URL = process.env.IG_LOGIN_URL || "https://www.instagram.com/";
const IG_USER = (process.env.IG_LOGIN_USERNAME || "").trim();
const IG_PASS = process.env.IG_LOGIN_PASSWORD || "";
const EMAIL_USER = (process.env.IG_EMAIL_USERNAME || "").trim();
const EMAIL_PASS = process.env.IG_EMAIL_PASSWORD || "";
const EMAIL_RECOVERY = (process.env.IG_EMAIL_RECOVERY || "").trim();
const EMAIL_RECOVERY_PASS = process.env.IG_EMAIL_RECOVERY_PASSWORD || "";
const IMAP_HOST =
  process.env.IG_IMAP_HOST ||
  (EMAIL_RECOVERY.includes("@") ? `mail.${EMAIL_RECOVERY.split("@")[1]}` : "mail.reevalmail.com");
const IMAP_PORT = Number(process.env.IG_IMAP_PORT || 993);
const TOTAL_TIMEOUT_MS = Number(process.env.IG_LOGIN_TIMEOUT_MS || 600_000);
const POLL_MS = 1500;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!IG_USER || !IG_PASS || !EMAIL_USER || !EMAIL_PASS) {
  console.error(
    "请设置 IG_LOGIN_USERNAME / IG_LOGIN_PASSWORD / IG_EMAIL_USERNAME / IG_EMAIL_PASSWORD"
  );
  process.exit(2);
}

const log = (...args) => console.log("[ig-login]", ...args);

const IG_CODE_PATTERNS = [
  "code we emailed|we emailed you a code|enter the code|login code",
  "输入验证码|验证码已发送|验证码发|已发送验证码|安全验证码",
  "confirm it's you|确认这是你本人|确认是你本人",
  "check your email|查收邮件|邮箱查收",
];

const CODE_INPUT_PATTERN =
  'input[autocomplete="one-time-code"], input[name="verificationCode"], input[name="code"], input[name="email"]';
const IG_USER_SELECTOR = 'input[name="username"], input[name="email"]';
const IG_PASS_SELECTOR = 'input[name="password"], input[name="pass"]';
const MS_EMAIL_SELECTOR = 'input[name="loginfmt"], input#usernameEntry, input[type="email"]';
const MS_PASS_SELECTOR = 'input[name="passwd"], input#passwordEntry, input[type="password"]';
const MS_RECOVERY_SELECTOR = "#proof-confirmation-email-input";
const MS_CODE_BOX_SELECTOR = 'input[id^="codeEntry-"]';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readMsCodeFromImap() {
  return new Promise((resolve, reject) => {
    const py = path.join(__dirname, "ig-imap-code.py");
    execFile(
      "python3",
      [py, "--poll-seconds", "90"],
      {
        timeout: 100000,
        env: {
          ...process.env,
          IMAP_HOST,
          IMAP_PORT: String(IMAP_PORT),
          IMAP_USER: EMAIL_RECOVERY,
          IMAP_PASS: EMAIL_RECOVERY_PASS,
        },
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error((stderr || err.message || "").trim().slice(0, 300)));
          return;
        }
        const code = String(stdout || "").trim();
        if (!/^\d{6}$/.test(code)) {
          reject(new Error("IMAP 未返回有效验证码: " + code));
          return;
        }
        resolve(code);
      }
    );
  });
}

async function pageText(page) {
  return page
    .evaluate(() => (document.body?.innerText || "").slice(0, 20000))
    .catch(() => "");
}

async function detectIgChallenge(page) {
  const text = await pageText(page);
  const hit = IG_CODE_PATTERNS.find((p) => new RegExp(p, "i").test(text));
  const codeInput = await page.locator(CODE_INPUT_PATTERN).first().isVisible().catch(() => false);
  return { pattern: hit || null, hasCodeInput: codeInput, text: text.slice(0, 400) };
}

async function isIgLoggedIn(page, context) {
  const cookies = await context.cookies("https://www.instagram.com").catch(() => []);
  if (cookies.some((c) => c.name === "sessionid")) return true;
  const url = page.url();
  // 只有真实落在 instagram.com 且不是登录页才算已登录；about:blank/中间页一律不算
  if (!/instagram\.com/i.test(url) || /accounts\/login|login\/?$|accounts\/recovery/i.test(url)) {
    return false;
  }
  const text = await pageText(page);
  return text.length > 300 && !/log in|登录|登入|sign up/i.test(text);
}

async function openPage(context, url) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2000);
  return page;
}

async function submitIgLogin(page) {
  log("填写 IG 账号密码...");
  const userInput = page
    .locator(IG_USER_SELECTOR)
    .first();
  await userInput.waitFor({ state: "visible", timeout: 30000 });
  await userInput.fill(IG_USER, { timeout: 10000 });
  await page
    .locator(IG_PASS_SELECTOR)
    .first()
    .fill(IG_PASS, { timeout: 10000 });
  await page
    .locator('button[type="submit"], div[role="button"]:has-text("Log in"), div[role="button"]:has-text("登录")')
    .first()
    .click({ timeout: 10000 })
    .catch(async () => {
      await page.keyboard.press("Enter");
    });
  log("已提交登录，等待 IG 校验...");
}

async function outlookSignIn(context, page) {
  log(`打开 Outlook 登录绑定邮箱 ${EMAIL_USER} ...`);
  if (process.env.IG_MS_FORCE_RELOGIN === "1") {
    log("IG_MS_FORCE_RELOGIN=1，清除微软账号登录态（切换邮箱账号）...");
    // 微软 Web 登录令牌存在各域 localStorage + 会话 cookie，
    // 必须逐域清 localStorage 并显式登出，否则旧会话会一直续用。
    for (const u of [
      "https://login.live.com/",
      "https://outlook.live.com/",
      "https://account.microsoft.com/",
      "https://account.live.com/",
    ]) {
      await page.goto(u, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await page
        .evaluate(() => {
          try {
            localStorage.clear();
            sessionStorage.clear();
          } catch {
            /* ignore */
          }
        })
        .catch(() => {});
      await page.waitForTimeout(1200);
    }
    await context.clearCookies().catch(() => {});
  }
  // 1) 快速探测已登录态
  await page.goto("https://outlook.live.com/mail/0/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  }).catch(() => {});
  await page.waitForTimeout(5000);
  if (/outlook\.live\.com\/mail|outlook\.office\.com\/mail/.test(page.url())) {
    log("Outlook 已是登录态");
    return;
  }

  // 2) 未登录：直接进 login.live.com 标准登录流（避免营销页跳转不稳定）
  await page.goto("https://login.live.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  }).catch(() => {});
  await page.waitForTimeout(3000);
  if (/outlook\.live\.com\/mail|outlook\.office\.com\/mail/.test(page.url())) {
    log("Outlook 已是登录态");
    return;
  }

  const emailInput = page.locator(MS_EMAIL_SELECTOR).first();
  const emailOk = await emailInput
    .waitFor({ state: "visible", timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  if (emailOk) {
    await emailInput.fill(EMAIL_USER, { timeout: 10000 });
    await page
      .locator('input[type="submit"], button:has-text("Next"), button:has-text("下一步")')
      .first()
      .click({ timeout: 10000 });
    log("已提交 Outlook 邮箱，等待密码框...");

    // 无密码(passkey)账号：微软要求先验证恢复邮箱
    const recoveryBox = page.locator(MS_RECOVERY_SELECTOR).first();
    let recoveryVisible = await recoveryBox
      .waitFor({ state: "visible", timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (!recoveryVisible) {
      // 兜底：页面文案/元素再判断一次（慢加载场景）
      const text = await pageText(page);
      recoveryVisible =
        /verify your email|recovery email|proof-confirmation|验证你的电子邮件|恢复邮箱/i.test(text) ||
        (await page.locator(MS_RECOVERY_SELECTOR).count()) > 0;
      if (recoveryVisible) {
        await recoveryBox.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
      }
    }
    if (recoveryVisible) {
      await handleMsRecovery(page, recoveryBox);
    } else {
      await completeMsPasswordOrRecovery(page);
    }

    // 等待落在邮箱页（可能先出现 Stay signed in?）
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (/outlook\.live\.com\/mail|outlook\.office\.com\/mail/.test(page.url())) break;
      const stay = page
        .locator('button[value="No"], input[value="No"], button:has-text("No"), button:has-text("否")')
        .first();
      if (await stay.isVisible().catch(() => false)) {
        await stay.click({ timeout: 5000 }).catch(() => {});
      }
      const errText = await pageText(page);
      if (/That Microsoft account doesn't exist|密码不正确|account doesn't exist|incorrect password/i.test(errText)) {
        throw new Error("Outlook 账号或密码错误");
      }
      if (/Help us protect your account|保护你的账户|verify your identity|验证你的身份/i.test(errText)) {
        throw new Error("Outlook 要求二次身份验证，需要人工处理");
      }
      await sleep(POLL_MS);
    }
    log(`Outlook 登录完成，当前 URL: ${page.url()}`);
    return;
  }
  throw new Error("无法定位 Outlook 登录入口, URL=" + page.url());
}

/**
 * 常规密码登录；若实际是恢复邮箱验证页（慢加载），自动切换恢复邮箱流程。
 */
async function completeMsPasswordOrRecovery(page) {
  const passInput = page.locator(MS_PASS_SELECTOR).first();
  let passVisible = await passInput
    .waitFor({ state: "visible", timeout: 25000 })
    .then(() => true)
    .catch(() => false);
  if (!passVisible) {
    const text = await pageText(page);
    const rec2 = page.locator(MS_RECOVERY_SELECTOR).first();
    const isRecovery = (await rec2.count()) > 0 ||
      /verify your email|recovery email|proof-confirmation|验证你的电子邮件|恢复邮箱/i.test(text);
    if (isRecovery) {
      await handleMsRecovery(page, rec2);
      return;
    }
    await passInput.waitFor({ state: "visible", timeout: 15000 });
    passVisible = true;
  }
  await passInput.fill(EMAIL_PASS, { timeout: 10000 });
  await page
    .locator('input[type="submit"], button:has-text("Sign in"), button:has-text("登录")')
    .first()
    .click({ timeout: 10000 });
  log("已提交 Outlook 密码，等待登录结果...");
}

async function handleMsRecovery(page, recoveryBox) {
  if (!EMAIL_RECOVERY || !EMAIL_RECOVERY_PASS) {
    throw new Error("微软要求验证恢复邮箱，请配置 IG_EMAIL_RECOVERY / IG_EMAIL_RECOVERY_PASSWORD");
  }
  log(`检测到恢复邮箱验证页，自动填入 ${EMAIL_RECOVERY} 并发送验证码...`);
  await recoveryBox.waitFor({ state: "visible", timeout: 20000 });
  await recoveryBox.fill(EMAIL_RECOVERY, { timeout: 10000 });
  await page
    .locator('button:has-text("Send code"), input[type="submit"]')
    .first()
    .click({ timeout: 10000 });
  log("已发送恢复邮箱验证码，等待 IMAP 收码...");
  const codeBox = page.locator(MS_CODE_BOX_SELECTOR).first();
  await codeBox.waitFor({ state: "visible", timeout: 30000 });
  const msCode = await readMsCodeFromImap();
  log(`IMAP 收到微软验证码: ${msCode}`);
  const boxes = page.locator(MS_CODE_BOX_SELECTOR);
  const n = await boxes.count();
  for (let i = 0; i < n && i < 6; i += 1) {
    await boxes.nth(i).fill(msCode[i] || "", { timeout: 5000 }).catch(() => {});
  }
  await page.keyboard.press("Enter");
  log("已提交微软验证码，等待登录结果...");
}

async function findIgCodeEmail(page, usedIgCodes) {
  log("在 Outlook 中搜索 Instagram 验证码邮件...");
  const deadline = Date.now() + 180000;
  let lastRefresh = 0;
  while (Date.now() < deadline) {
    if (Date.now() - lastRefresh > 15000) {
      lastRefresh = Date.now();
      await page.goto("https://outlook.live.com/mail/0/", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      }).catch(() => {});
      await page.waitForTimeout(2500);
      const searchInput = page
        .locator(
          'input[aria-label*="Search" i], input[placeholder*="Search" i], input[placeholder*="搜索" i], input[aria-label*="搜索" i]'
        )
        .first();
      if (await searchInput.isVisible().catch(() => false)) {
        await searchInput.fill("Instagram");
        await page.keyboard.press("Enter");
        await page.waitForTimeout(2500);
      }
    }
    // 新 Outlook：搜索结果列表项；兼容多种选择器
    const items = page.locator(
      '[role="option"], div[data-testid^="message"], [aria-label*="Instagram" i], div[title*="Instagram" i]'
    );
    const count = await items.count().catch(() => 0);
    let clicked = false;
    for (let i = 0; i < Math.min(count, 30); i += 1) {
      const el = items.nth(i);
      const txt = (await el.innerText().catch(() => "")) || "";
      if (/Instagram/i.test(txt) && /code|验证码|确认|login/i.test(txt)) {
        await el.click({ timeout: 5000 }).catch(() => {});
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      // 旧版 UI 直接点标题含 Instagram 的邮件
      const any = page.locator('span:has-text("Instagram"), div:has-text("Instagram")').first();
      if (await any.isVisible().catch(() => false)) {
        const txt = await pageText(page);
        if (/Instagram/i.test(txt)) {
          await any.click({ timeout: 5000 }).catch(() => {});
          clicked = true;
        }
      }
    }
    if (clicked) {
      await page.waitForTimeout(2500);
      const body = await pageText(page);
      const code = extractCode(body);
      if (code) {
        if (usedIgCodes.has(code)) {
          log(`命中已用过的验证码 ${code}，等待新邮件...`);
        } else {
          log(`已找到验证码邮件，验证码: ${code}`);
          return code;
        }
      }
    }
    await sleep(POLL_MS);
  }
  throw new Error("在 Outlook 中 3 分钟内未找到 Instagram 验证码邮件");
}

function extractCode(text) {
  // 验证码常见格式：6 位数字，出现在 code / 验证码 附近
  const m = String(text || "").match(/(?:code|验证码|confirmation code)[^0-9]{0,80}\b(\d{6})\b/i);
  if (m) return m[1];
  const m2 = String(text || "").match(/\b(\d{6})\b/);
  return m2 ? m2[1] : null;
}

async function submitIgCode(page, code) {
  log("回填 IG 验证码...");
  const single = page.locator(CODE_INPUT_PATTERN).first();
  if (await single.isVisible().catch(() => false)) {
    await single.fill(code, { timeout: 10000 });
  } else {
    // 6 个独立输入框
    const boxes = page.locator('input[inputmode="numeric"], input[type="tel"], input[type="text"][maxlength="1"]');
    const n = await boxes.count().catch(() => 0);
    if (n >= 6) {
      for (let i = 0; i < 6; i += 1) {
        await boxes.nth(i).fill(code[i] || "", { timeout: 5000 }).catch(() => {});
      }
    } else {
      throw new Error("未找到 IG 验证码输入框");
    }
  }
  await page
    .locator(
      'button[type="submit"], div[role="button"]:has-text("Confirm"), div[role="button"]:has-text("确认"), div[role="button"]:has-text("Submit"), div[role="button"]:has-text("Continue"), div[role="button"]:has-text("继续")'
    )
    .first()
    .click({ timeout: 10000 })
    .catch(() => page.keyboard.press("Enter"));
  log("已提交验证码，等待登录完成...");
}

async function dismissSaveInfoPrompt(page) {
  const notNow = page
    .locator('button:has-text("Not Now"), button:has-text("以后再说"), div[role="button"]:has-text("Not Now"), div[role="button"]:has-text("以后再说")')
    .first();
  if (await notNow.isVisible({ timeout: 3000 }).catch(() => false)) {
    await notNow.click({ timeout: 5000 }).catch(() => {});
  }
}

async function main() {
  const browser = await chromium.connectOverCDP(CDP_ENDPOINT, { timeout: 20000 });
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error("9222 浏览器没有可用的浏览器上下文");
    let page = context.pages()[0] || (await context.newPage());

    log(`连接成功，当前页面: ${page.url()}`);
    if (process.env.IG_FORCE_RELOGIN === "1") {
      log("IG_FORCE_RELOGIN=1，清除 instagram 登录态...");
      await context.clearCookies().catch(() => {});
    }
    // 注意：/accounts/login/ 路径在部分 IP 上会被 IG 直接 429，
    // 而首页 www.instagram.com/ 自带登录表单且通常可正常加载，因此默认走首页。
    // IG 对数据中心 IP 偶发限流(429)，首次导航可能超时，重试并等待真实到达 instagram 域
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await page.goto(IG_LOGIN_URL, {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      }).catch(() => {});
      const url = page.url();
      if (/instagram\.com/i.test(url)) break;
      log(`导航未到达 instagram (当前: ${url})，第 ${attempt} 次重试...`);
      await sleep(5000);
    }
    await page.waitForTimeout(4000);

    if (await isIgLoggedIn(page, context)) {
      log("IG 已是登录态，无需登录 ✅");
      return;
    }

    await submitIgLogin(page);

    const deadline = Date.now() + TOTAL_TIMEOUT_MS;
    let codeSent = false;
    const usedIgCodes = new Set();
    while (Date.now() < deadline) {
      if (await isIgLoggedIn(page, context)) {
        await dismissSaveInfoPrompt(page);
        log("IG 登录成功 ✅ 账号: " + IG_USER);
        return;
      }

      const ch = await detectIgChallenge(page);
      if (!ch.hasCodeInput && !ch.pattern && !(await page.locator(IG_USER_SELECTOR).first().isVisible().catch(() => false))) {
        const url = page.url();
        const text = await pageText(page);
        if (/instagram\.com/i.test(url) && text.length < 200) {
          log("登录页内容为空/仍在加载，等待...");
          await sleep(POLL_MS);
          continue;
        }
      }
      if (ch.hasCodeInput || ch.pattern) {
        if (!codeSent) {
          log(`检测到邮箱验证码页: ${ch.pattern || "存在验证码输入框"}`);
          codeSent = true;
        }
        // 若已有输入框说明 IG 已把验证码发出/展示，直接尝试收码回填
        const outlookPage = await openPage(context, "https://outlook.live.com/mail/0/");
        try {
          await outlookSignIn(context, outlookPage);
          const code = await findIgCodeEmail(outlookPage, usedIgCodes);
          await page.bringToFront().catch(() => {});
          await page.waitForTimeout(1000);
          await submitIgCode(page, code);
          usedIgCodes.add(code);
          // 若 IG 提示验证码错误，点 Get a new code 触发新码
          await sleep(3000);
          const afterText = await pageText(page);
          if (/incorrect|不正确|wrong code|didn'?t work|invalid code/i.test(afterText)) {
            log("IG 提示验证码错误，点击 Get a new code 重新获取...");
            const getNew = page
              .locator('div[role="button"]:has-text("Get a new code"), div[role="button"]:has-text("重新获取"), a:has-text("Get a new code")')
              .first();
            if (await getNew.isVisible().catch(() => false)) {
              await getNew.click({ timeout: 8000 }).catch(() => {});
              await sleep(3000);
            }
          }
        } finally {
          await outlookPage.close().catch(() => {});
        }
        continue;
      }

      const text = await pageText(page);
      if (/Sorry, your password was incorrect|密码不正确|The password you entered is incorrect/i.test(text)) {
        throw new Error("IG 账号或密码错误");
      }
      if (/challenge|checkpoint|unusual activity|异常活动|suspicious/i.test(text) && !ch.hasCodeInput) {
        throw new Error("IG 出现安全挑战（非邮箱验证码），需要人工处理: " + text.slice(0, 300));
      }
      await sleep(POLL_MS);
    }
    throw new Error(`IG 登录超时(${Math.round(TOTAL_TIMEOUT_MS / 1000)} 秒)`);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`[ig-login] 登录失败: ${error.message}`);
  process.exitCode = 1;
});
