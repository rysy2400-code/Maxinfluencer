import { chromium } from "playwright";
const b = await chromium.connectOverCDP(process.env.CDP_ENDPOINT || "http://127.0.0.1:9222");
const ctx = b.contexts()[0];
for (const p of ctx.pages()) {
  try {
    console.log(JSON.stringify({ url: p.url(), closed: p.isClosed() }));
  } catch (e) {
    console.log("err", e.message);
  }
}
await b.close().catch(() => {});
