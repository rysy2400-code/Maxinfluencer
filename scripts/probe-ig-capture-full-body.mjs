#!/usr/bin/env node
import { chromium } from "playwright";
import fs from "fs";

const keyword = process.argv[2] || "pool cleaner";
const CDP = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";

const browser = await chromium.connectOverCDP(CDP, { timeout: 15000 });
const page = browser.contexts()[0].pages().find((p) => !p.isClosed()) || (await browser.contexts()[0].newPage());

let body = null;
page.on("request", (req) => {
  const url = req.url();
  if (!url.includes("/api/graphql")) return;
  const post = req.postData() || "";
  if (post.includes("PolarisKeywordSearchExplorePageRelayQuery")) body = post;
});

await page.goto(
  `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(keyword)}`,
  { waitUntil: "commit", timeout: 60000 }
).catch(() => {});
await page.waitForTimeout(6000);

if (body) {
  const params = new URLSearchParams(body);
  const keys = [...params.keys()];
  console.log("keys:", keys.join(", "));
  console.log("doc_id:", params.get("doc_id"));
  console.log("variables:", params.get("variables"));
  console.log("lsd:", params.get("lsd"));
  console.log("fb_api_req_friendly_name:", params.get("fb_api_req_friendly_name"));
  fs.writeFileSync("/tmp/ig-gql-body.txt", body);
  console.log("saved", body.length, "bytes");
} else {
  console.log("no body captured");
}
await browser.close().catch(() => {});
