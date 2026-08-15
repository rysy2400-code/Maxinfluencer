#!/usr/bin/env node
/**
 * 单独完成 Microsoft/Outlook 登录（含无密码账号的恢复邮箱验证），
 * 供 ig-auto-login.mjs 复用；登录态通过 Chrome profile cookie 持久化。
 *
 * 用法:
 *   IG_EMAIL_USERNAME=victor.ward1979awg@hotmail.com \
 *   IG_EMAIL_PASSWORD=xxx \
 *   IG_EMAIL_RECOVERY=bixgrcyk@reevalmail.com \
 *   IG_EMAIL_RECOVERY_PASSWORD=xxx \
 *   node scripts/ig-ms-login.mjs
 */
import { chromium } from "playwright";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CDP_ENDPOINT = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
const EMAIL_USER = (process.env.IG_EMAIL_USERNAME || "").trim();
const EMAIL_PASS = process.env.IG_EMAIL_PASSWORD || "";
const EMAIL_RECOVERY = (process.env.IG_EMAIL_RECOVERY || "").trim();
const EMAIL_RECOVERY_PASS = process.env.IG_EMAIL_RECOVERY_PASSWORD || "";
const IMAP_HOST = process.env.IG_IMAP_HOST || "mail.reevalmail.com";
const IMAP_PORT = Number(process.env.IG_IMAP_PORT || 993);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MS_EMAIL_SELECTOR = 'input[name="loginfmt"], input#usernameEntry, input[type="email"]';
const MS_PASS_SELECTOR = 'input[name="passwd"], input#passwordEntry, input[type="password"]';
const MS_RECOVERY_SELECTOR = "#proof-confirmation-email-input";
const MS_CODE_BOX_SELECTOR = 'input[id^="codeEntry-"]';

if (!EMAIL_USER) {
  console.error("请设置 IG_EMAIL_USERNAME");
  process.exit(2);
}

const log = (...args) => console.log("[ms-login]", ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageText(page) {
  return page.evaluate(() => (document.body?.innerText || "").slice(0, 1500)).catch(() => "");
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

async function fillCodeBoxes(page, code) {
  const boxes = page.locator(MS_CODE_BOX_SELECTOR);
  const n = await boxes.count();
  log(`填入微软验证码到 ${n} 个输入框`);
  for (let i = 0; i < n && i < 6; i += 1) {
    await boxes.nth(i).fill(code[i] || "", { timeout: 5000 }).catch(() => {});
  }
  await page.keyboard.press("Enter");
}

async function main() {
  const browser = await chromium.connectOverCDP(CDP_ENDPOINT, { timeout: 20000 });
  try {
    const ctx = browser.contexts()[0];
    const page = await ctx.newPage();
    try {
      log("打开 login.live.com ...");
      await page.goto("https://login.live.com/", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      }).catch(() => {});
      await page.waitForTimeout(3000);

      if (/outlook\.live\.com\/mail|outlook\.office\.com\/mail/.test(page.url())) {
        log("Outlook 已是登录态 ✅ " + page.url());
        return;
      }

      // 营销页 Sign in 入口
      const signIn = page
        .locator('a:has-text("Sign in"), button:has-text("Sign in"), a[href*="login.live.com"]')
        .first();
      if (await signIn.isVisible().catch(() => false) && !(await page.locator(MS_EMAIL_SELECTOR).count())) {
        await signIn.click({ timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(3000);
      }

      const emailInput = page.locator(MS_EMAIL_SELECTOR).first();
      await emailInput.waitFor({ state: "visible", timeout: 30000 });
      log("填写微软邮箱: " + EMAIL_USER);
      await emailInput.fill(EMAIL_USER, { timeout: 10000 });
      await page
        .locator('input[type="submit"], button:has-text("Next"), button:has-text("下一步")')
        .first()
        .click({ timeout: 10000 });
      log("已提交邮箱，等待下一步...");

      const recoveryBox = page.locator(MS_RECOVERY_SELECTOR).first();
      let recoveryVisible = await recoveryBox
        .waitFor({ state: "visible", timeout: 30000 })
        .then(() => true)
        .catch(() => false);
      if (!recoveryVisible) {
        const text = await pageText(page);
        recoveryVisible = /verify your email|recovery email|proof-confirmation|验证你的电子邮件|恢复邮箱/i.test(text);
        if (recoveryVisible) {
          await recoveryBox.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
        }
      }

      if (recoveryVisible) {
        if (!EMAIL_RECOVERY || !EMAIL_RECOVERY_PASS) {
          throw new Error("微软要求验证恢复邮箱，请配置 IG_EMAIL_RECOVERY / IG_EMAIL_RECOVERY_PASSWORD");
        }
        log("检测到恢复邮箱验证页，填写: " + EMAIL_RECOVERY);
        await recoveryBox.fill(EMAIL_RECOVERY, { timeout: 10000 });
        const sendBtn = page
          .locator('button:has-text("Send code"), input[type="submit"]')
          .first();
        log("点击 Send code...");
        await sendBtn.click({ timeout: 10000 });
        const codeBox = page.locator(MS_CODE_BOX_SELECTOR).first();
        log("等待验证码输入框...");
        await codeBox.waitFor({ state: "visible", timeout: 30000 });
        log("调用 IMAP 收码...");
        const code = await readMsCodeFromImap();
        log("IMAP 收到微软验证码: " + code);
        await fillCodeBoxes(page, code);
      } else {
        log("进入密码登录...");
        const passInput = page.locator(MS_PASS_SELECTOR).first();
        const passOk = await passInput
          .waitFor({ state: "visible", timeout: 30000 })
          .then(() => true)
          .catch(() => false);
        if (!passOk) {
          // 可能是恢复邮箱页加载慢，再兜底一次
          const text = await pageText(page);
          if (/verify your email|recovery email|proof-confirmation|验证你的电子邮件|恢复邮箱/i.test(text)) {
            const rec2 = page.locator(MS_RECOVERY_SELECTOR).first();
            await rec2.waitFor({ state: "visible", timeout: 15000 });
            if (!EMAIL_RECOVERY || !EMAIL_RECOVERY_PASS) {
              throw new Error("微软要求验证恢复邮箱，请配置 IG_EMAIL_RECOVERY / IG_EMAIL_RECOVERY_PASSWORD");
            }
            log("兜底：检测到恢复邮箱验证页，填写: " + EMAIL_RECOVERY);
            await rec2.fill(EMAIL_RECOVERY, { timeout: 10000 });
            await page.locator('button:has-text("Send code"), input[type="submit"]').first().click({ timeout: 10000 });
            const codeBox2 = page.locator(MS_CODE_BOX_SELECTOR).first();
            await codeBox2.waitFor({ state: "visible", timeout: 30000 });
            const code2 = await readMsCodeFromImap();
            log("IMAP 收到微软验证码: " + code2);
            await fillCodeBoxes(page, code2);
          } else {
            await passInput.waitFor({ state: "visible", timeout: 15000 });
            await passInput.fill(EMAIL_PASS, { timeout: 10000 });
            await page.locator('input[type="submit"], button:has-text("Sign in"), button:has-text("登录")').first().click({ timeout: 10000 });
          }
        } else {
          await passInput.fill(EMAIL_PASS, { timeout: 10000 });
          await page.locator('input[type="submit"], button:has-text("Sign in"), button:has-text("登录")').first().click({ timeout: 10000 });
        }
      }

      log("等待进入 Outlook 邮箱...");
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        const url = page.url();
        if (/outlook\.live\.com\/mail|outlook\.office\.com\/mail/.test(url)) {
          log("Outlook 登录成功 ✅ " + url);
          return;
        }
        const stay = page
          .locator('button[value="No"], input[value="No"], button:has-text("No"), button:has-text("否")')
          .first();
        if (await stay.isVisible().catch(() => false)) {
          await stay.click({ timeout: 5000 }).catch(() => {});
        }
        const text = await pageText(page);
        if (/That Microsoft account doesn't exist|密码不正确|account doesn't exist|incorrect password/i.test(text)) {
          throw new Error("Outlook 账号或密码错误");
        }
        if (/Help us protect your account|保护你的账户|verify your identity|验证你的身份/i.test(text)) {
          throw new Error("Outlook 要求二次身份验证，需要人工处理");
        }
        if (/code is incorrect|验证码不正确|code didn't work/i.test(text)) {
          throw new Error("微软验证码错误（可能取到旧码）");
        }
        await sleep(2000);
      }
      throw new Error("Outlook 登录超时，当前 URL: " + page.url() + " text: " + (await pageText(page)).slice(0, 300));
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`[ms-login] 登录失败: ${error.message}`);
  process.exitCode = 1;
});
