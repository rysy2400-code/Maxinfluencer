#!/usr/bin/env node
import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local" });
const { acquireTiktokApiSession } = await import(
  "./lib/tools/influencer-functions/tiktok/tiktok-direct-fetch.js"
);
const s = await acquireTiktokApiSession(null, { endpointKey: "http://127.0.0.1:9222" });
const c = await s.page.getTiktokCookies();
console.log("cookie names:", Object.keys(c).sort().join(", "));
console.log("s_v_web_id:", c.s_v_web_id || "MISSING");
console.log("msToken:", c.msToken || c.mstoken || "MISSING");
await s.dispose();
