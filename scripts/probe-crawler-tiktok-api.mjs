import { acquireTiktokApiSession, fetchSearchItemFull } from "../lib/tools/influencer-functions/tiktok/tiktok-direct-fetch.js";

const s = await acquireTiktokApiSession(null, { endpointKey: "http://127.0.0.1:9222" });
try {
  const cookies = await s.page.getTiktokCookies?.();
  console.log("msToken", cookies?.msToken ? "yes" : "no", "sessionid", cookies?.sessionid ? "yes" : "no");
  const j = await fetchSearchItemFull(s.page, { keyword: "pool cleaner", cursor: 0 });
  const n = j?.item_list?.length || j?.itemList?.length || 0;
  console.log("search_api", { items: n, status: j?.status_code });
} catch (e) {
  console.log("search_api FAIL", e.message);
}
await s.dispose();
