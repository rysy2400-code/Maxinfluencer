#!/usr/bin/env node
import { chromium } from "playwright";

const all = {};
for (const p of [9222, 9223, 9224, 9225]) {
  try {
    const b = await chromium.connectOverCDP(`http://127.0.0.1:${p}`, { timeout: 15000 });
    const ctx = b.contexts()[0];
    const ttk = (ctx ? ctx.pages() : []).find((pg) => String(pg.url() || "").includes("tiktok.com"));
    const keys = ttk
      ? await ttk.evaluate(() => Object.keys(localStorage).sort()).catch(() => [])
      : [];
    all[p] = keys;
    await b.close().catch(() => {});
  } catch {
    all[p] = [];
  }
}
const union = [...new Set(Object.values(all).flat())].sort();
for (const k of union) {
  const present = Object.keys(all).filter((p) => all[p].includes(k));
  if (present.length < 4) console.log(`${k} => ${present.join(",")}`);
}
console.log("DONE");
process.exit(0);
