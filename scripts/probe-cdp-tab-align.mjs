#!/usr/bin/env node
/** 验证 Lite 9222 IG/YT 常驻 tab 对齐 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { withCdp9222PreparedSession } from "../lib/cdp/connect-cdp-9222.js";
import { listCdpPageTargets } from "../lib/cdp/cdp-target-page.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

process.env.SCRAPER_MODE = process.env.SCRAPER_MODE || "lite";
process.env.SEARCH_WORKER_PLATFORMS =
  process.env.SEARCH_WORKER_PLATFORMS || "instagram,youtube";

async function dump(label) {
  const pages = await listCdpPageTargets();
  console.log(`\n=== ${label} (${pages.length} tabs) ===`);
  for (const t of pages) console.log(" ", t.url);
  return pages;
}

await dump("BEFORE");

await withCdp9222PreparedSession(
  { platform: "instagram", phase: "tab-align-probe" },
  async () => {
    await dump("AFTER align (instagram task)");
  }
);

await dump("IDLE after session");

await withCdp9222PreparedSession(
  { platform: "youtube", phase: "tab-align-probe" },
  async () => {
    await dump("AFTER align (youtube task)");
  }
);

const final = await dump("FINAL");
const ig = final.filter((t) => String(t.url).includes("instagram.com"));
const yt = final.filter((t) => String(t.url).includes("youtube.com"));
const ok = ig.length === 1 && yt.length === 1;
console.log(`\nPASS=${ok} ig=${ig.length} yt=${yt.length}`);
process.exit(ok ? 0 : 1);
