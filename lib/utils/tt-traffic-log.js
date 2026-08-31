/**
 * TikTok 流量打点（试点测量用，151 9225 青果试点）。
 * 记录每次数据请求的 类型 + 响应字节数，追加到 logs/traffic-9225.log。
 * 仅测量用途；LLM 请求直连不走代理，不在此列。
 */
import fs from "node:fs";

const LOG_PATH = String(
  process.env.TT_TRAFFIC_LOG || "C:\\maxinfluencer\\logs\\traffic-9225.log"
);

export function classifyTikTokApiKind(pathname) {
  const p = String(pathname || "");
  if (p.includes("/api/search/general/full")) return "search";
  if (p.includes("/api/search/item/full")) return "search_item";
  if (p.includes("/api/user/detail")) return "user_detail";
  if (p.includes("/api/post/item_list")) return "item_list";
  if (p.includes("/api/video/item/detail")) return "video_detail";
  if (p.includes("/api/video/info/universal")) return "universal";
  if (p.includes("/api/")) return "api_other";
  return "other";
}

export function logTikTokTraffic(kind, bytes, url = "", extra = "") {
  try {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return;
    fs.appendFileSync(
      LOG_PATH,
      `${new Date().toISOString()} kind=${kind} bytes=${Math.round(n)} url=${String(url).slice(0, 140)} ${extra}\n`,
      "utf8"
    );
  } catch {
    /* ignore */
  }
}
