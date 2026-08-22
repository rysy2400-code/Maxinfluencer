#!/usr/bin/env node
import { chromium } from "playwright";

const ports = process.argv.slice(2).length ? process.argv.slice(2).map(Number) : [9222, 9225];
for (const p of ports) {
  try {
    const b = await chromium.connectOverCDP(`http://127.0.0.1:${p}`, { timeout: 15000 });
    const ctx = b.contexts()[0];
    const pages = ctx ? ctx.pages() : [];
    const ttk = pages.find((pg) => String(pg.url() || "").includes("tiktok.com"));
    if (!ttk) {
      console.log(`PORT ${p}: no tiktok page, urls=${pages.map((pg) => pg.url()).slice(0, 5).join(",")}`);
      await b.close().catch(() => {});
      continue;
    }
    const keys = await ttk.evaluate(() => Object.keys(localStorage).sort()).catch((e) => ["ERR:" + String(e.message || e).slice(0, 80)]);
    const acct = keys.filter((k) => /uid|sid|session|passport|login|account|user|tt_/i.test(k));
    console.log(`PORT ${p}: lsKeys=${keys.length} acctish=${acct.join(",") || "none"}`);
    await b.close().catch(() => {});
  } catch (e) {
    console.log(`PORT ${p}: ERR ${String(e.message || e).slice(0, 120)}`);
  }
}
process.exit(0);
