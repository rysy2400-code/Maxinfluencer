#!/usr/bin/env node
import { chromium } from "playwright";

const keyword = process.argv[2] || "pool cleaner";
const CDP = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";

const browser = await chromium.connectOverCDP(CDP, { timeout: 15000 });
const page = browser.contexts()[0].pages().find((p) => !p.isClosed()) || (await browser.contexts()[0].newPage());

const gql = [];
page.on("request", (req) => {
  const url = req.url();
  if (!url.includes("graphql")) return;
  const post = req.postData() || "";
  let docId = null;
  let friendly = null;
  let vars = null;
  try {
    if (post.startsWith("{")) {
      const j = JSON.parse(post);
      docId = j.doc_id || j.docId;
      friendly = j.fb_api_req_friendly_name;
      vars = j.variables;
    } else {
      const p = new URLSearchParams(post);
      docId = p.get("doc_id");
      friendly = p.get("fb_api_req_friendly_name");
      vars = p.get("variables");
    }
  } catch {
    /* ignore */
  }
  if (docId || friendly) {
    gql.push({
      path: url.split("?")[0].replace(/^https?:\/\/[^/]+/, ""),
      docId,
      friendly,
      varsPreview: typeof vars === "string" ? vars.slice(0, 200) : JSON.stringify(vars || "").slice(0, 200),
    });
  }
});

if (!page.url().includes("instagram.com")) {
  await page.goto("https://www.instagram.com/", { waitUntil: "commit", timeout: 60000 });
}
await page.goto(
  `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(keyword)}`,
  { waitUntil: "commit", timeout: 60000 }
).catch(() => {});
await page.waitForTimeout(5000);
await page.evaluate(() => window.scrollBy(0, 800));
await page.waitForTimeout(3000);

const seen = new Set();
const unique = gql.filter((g) => {
  const k = `${g.docId}|${g.friendly}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

console.log(JSON.stringify(unique, null, 2));
await browser.close().catch(() => {});
