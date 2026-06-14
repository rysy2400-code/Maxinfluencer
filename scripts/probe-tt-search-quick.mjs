#!/usr/bin/env node
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const endpoint = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
const { acquireTiktokApiSession, fetchSearchItemFull } = await import(
  "../lib/tools/influencer-functions/tiktok/tiktok-direct-fetch.js"
);

const session = await acquireTiktokApiSession(null, { endpointKey: endpoint, forceNewTab: false });
try {
  const json = await fetchSearchItemFull(session.page, { keyword: "pool cleaner", cursor: 0 });
  const items = json?.item_list || json?.itemList || [];
  console.log(JSON.stringify({ ok: true, items: items.length, status: json?.status_code }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, err: e.message }));
} finally {
  await session.dispose();
}
