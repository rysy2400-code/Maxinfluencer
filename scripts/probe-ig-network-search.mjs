#!/usr/bin/env node
import { chromium } from "playwright";

const keyword = process.argv[2] || "pool cleaner";
const CDP = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";

const browser = await chromium.connectOverCDP(CDP, { timeout: 15000 });
const ctx = browser.contexts()[0];
const pages = ctx.pages().filter((p) => !p.isClosed());
console.log("pages:", pages.map((p) => p.url()).join(" | "));

const page =
  pages.find((p) => String(p.url() || "").includes("instagram.com")) || pages[0];

const gqlReq = [];
const gqlRes = [];
const apiReq = [];

page.on("request", (r) => {
  const u = r.url();
  if (u.includes("graphql")) {
    const post = r.postData() || "";
    gqlReq.push({
      method: r.method(),
      path: u.split("?")[0].replace(/^https?:\/\/[^/]+/, ""),
      friendly: post.match(/fb_api_req_friendly_name=([^&]+)/)?.[1] || null,
      docId: post.match(/doc_id=(\d+)/)?.[1] || null,
      postLen: post.length,
    });
  }
  if (u.includes("/api/v1/")) {
    apiReq.push(u.split("?")[0].replace(/^https?:\/\/[^/]+/, ""));
  }
});

page.on("response", async (r) => {
  const u = r.url();
  if (!u.includes("graphql")) return;
  let preview = "";
  try {
    preview = (await r.text()).replace(/^for\s*\(\s*;\s*;\s*\)\s*;/, "").slice(0, 160);
  } catch {
    /* ignore */
  }
  gqlRes.push({ status: r.status(), preview });
});

console.log("navigating from", page.url());
await page
  .goto(`https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(keyword)}`, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  })
  .catch((e) => console.log("goto err:", e.message));

await page.waitForTimeout(8000);
console.log("after url:", page.url());
console.log("gql requests:", JSON.stringify(gqlReq, null, 2));
console.log("gql responses:", JSON.stringify(gqlRes, null, 2));
console.log("api requests:", [...new Set(apiReq)]);

await browser.close().catch(() => {});
