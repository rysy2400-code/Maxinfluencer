import { chromium } from "playwright";

async function check(label, url, checks) {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222", {
    timeout: 10000,
  });
  const ctx = browser.contexts()[0] || (await browser.newContext());
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(5000);
  const info = await page.evaluate(() => ({
    href: location.href,
    title: document.title,
    loginBtn: !!document.querySelector(
      '[data-e2e="top-login-button"], a[href*="/login"]'
    ),
    profileIcon: !!document.querySelector(
      '[data-e2e="profile-icon"], [data-testid="user-avatar"]'
    ),
    text: (document.body?.innerText || "").slice(0, 400),
  }));
  const cookies = await ctx.cookies([url.split("/").slice(0, 3).join("/")]);
  const names = cookies.map((c) => c.name);
  console.log(
    label,
    JSON.stringify(
      {
        cookies: cookies.length,
        hasSessionid: names.includes("sessionid"),
        hasSidTt: names.includes("sid_tt"),
        hasDsUser: names.includes("ds_user_id"),
        hasSessionidIg: names.includes("sessionid") && url.includes("instagram"),
        loggedInHint: info.loginBtn
          ? "login_page"
          : info.profileIcon
            ? "profile_ui"
            : info.href.includes("/login")
              ? "login_redirect"
              : "unknown",
        ...info,
      },
      null,
      0
    )
  );
  await page.close();
  await browser.close();
}

await check("tiktok_home", "https://www.tiktok.com/");
await check("instagram_home", "https://www.instagram.com/");

// Cookie file paths (Chrome 149)
import fs from "fs";
import path from "path";
for (const rel of [
  ".chrome-cdp-9222/Default/Cookies",
  ".chrome-cdp-9222/Default/Network/Cookies",
  ".chrome-cdp-9223/Default/Network/Cookies",
]) {
  const p = path.join("C:/maxinfluencer", rel.replace(/\//g, path.sep));
  if (fs.existsSync(p)) {
    const st = fs.statSync(p);
    console.log("cookie_file", rel, st.size, st.mtime.toISOString());
  } else {
    console.log("cookie_file", rel, "MISSING");
  }
}
