#!/usr/bin/env node
import { chromium } from "playwright";

const ports = process.argv.slice(2).length ? process.argv.slice(2).map(Number) : [9222, 9223, 9224, 9225];
for (const p of ports) {
  try {
    const b = await chromium.connectOverCDP(`http://127.0.0.1:${p}`, { timeout: 15000 });
    const ctx = b.contexts()[0];
    const cookies = ctx ? await ctx.cookies("https://www.tiktok.com") : [];
    const names = cookies.map((c) => c.name).sort();
    const loginish = names.filter((n) => /session|sid_tt|uid_tt|ssid|ttwid|login|passport/i.test(n));
    console.log(`PORT ${p}: cookies=${names.length} loginish=${loginish.join(",") || "none"}`);
    await b.close().catch(() => {});
  } catch (e) {
    console.log(`PORT ${p}: ERR ${String(e.message || e).slice(0, 120)}`);
  }
}
process.exit(0);
