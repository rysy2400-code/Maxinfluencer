/**
 * 探测 TikTok 主页 item_list 前 N 条视频的发布地址字段
 * 用法: CDP_ENDPOINT=http://127.0.0.1:9222 node scripts/probe-tiktok-profile-video-locations.js kelly.herr 20
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOC_KEY_RE = /location|address|poi|region|country|city|geo/i;

function pickLocationFields(item) {
  const out = {};
  for (const [k, v] of Object.entries(item || {})) {
    if (LOC_KEY_RE.test(k) && v != null && v !== "") {
      out[k] = typeof v === "object" ? v : v;
    }
  }
  return out;
}

function mergeItemsFromResponses(captured) {
  const seen = new Set();
  const items = [];
  for (const { json } of captured.itemList) {
    const list = json?.itemList || json?.item_list || [];
    for (const item of list) {
      const id = item?.id || item?.aweme_id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      items.push(item);
    }
  }
  return items;
}

async function main() {
  const username = (process.argv[2] || "kelly.herr").replace(/^@/, "");
  const maxVideos = Math.min(Number(process.argv[3] || 20), 50);
  const endpoint = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";

  const captured = { itemList: [], userDetail: null };

  console.log(`[probe] CDP: ${endpoint}`);
  console.log(`[probe] 用户: @${username}，目标前 ${maxVideos} 条视频`);

  const browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = await context.newPage();

  const handler = async (response) => {
    const url = response.url();
    if (response.status() >= 300 && response.status() < 400) return;
    if (!url.includes("tiktok.com/api/")) return;
    try {
      const json = JSON.parse(await response.text());
      if (url.includes("/api/post/item_list")) {
        const n = json?.itemList?.length || json?.item_list?.length || 0;
        captured.itemList.push({ url, json });
        console.log(`[probe] item_list +${n} (累计批次 ${captured.itemList.length})`);
      } else if (url.includes("/api/user/detail")) {
        captured.userDetail = { url, json };
        console.log("[probe] user/detail intercepted");
      }
    } catch {
      /* ignore */
    }
  };

  page.on("response", handler);

  try {
    await page.goto(`https://www.tiktok.com/@${username}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(4000);

    let scrollRound = 0;
    while (scrollRound < 12) {
      const merged = mergeItemsFromResponses(captured);
      if (merged.length >= maxVideos) break;
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.2));
      await page.waitForTimeout(2000);
      scrollRound++;
    }
    await page.waitForTimeout(3000);
  } finally {
    page.off("response", handler);
  }

  const allItems = mergeItemsFromResponses(captured);
  const sample = allItems.slice(0, maxVideos);

  console.log("\n=== 采集统计 ===");
  console.log({
    itemListBatches: captured.itemList.length,
    uniqueVideos: allItems.length,
    analyzed: sample.length,
    userDetail: !!captured.userDetail,
  });

  if (sample.length === 0) {
    console.log("\n⚠️ 未拦截到视频数据。请确认 9222 Chrome 已登录 TikTok 且网络正常。");
    await page.close();
    await browser.close();
    process.exit(2);
  }

  const rows = sample.map((item, i) => {
    const locTop = pickLocationFields(item);
    const poi = item.poi || item.poiInfo || item.location || null;
    return {
      index: i + 1,
      id: item.id,
      desc: (item.desc || "").slice(0, 60),
      createTime: item.createTime || null,
      locationCreated: item.locationCreated ?? null,
      hasLocationCreated:
        item.locationCreated != null && item.locationCreated !== "",
      locationTopLevel: locTop,
      poi: poi,
      otherLocKeys: Object.keys(locTop).filter((k) => k !== "locationCreated"),
    };
  });

  const withLoc = rows.filter((r) => r.hasLocationCreated);
  const codes = {};
  for (const r of withLoc) {
    const c = String(r.locationCreated);
    codes[c] = (codes[c] || 0) + 1;
  }

  console.log(`\n=== 前 ${rows.length} 条：locationCreated 覆盖 ===`);
  console.log(`  有 locationCreated: ${withLoc.length}/${rows.length}`);
  console.log(`  无 locationCreated: ${rows.length - withLoc.length}/${rows.length}`);
  if (Object.keys(codes).length) {
    console.log("  locationCreated 取值分布:", codes);
  }

  console.log("\n=== 逐条明细 ===");
  for (const r of rows) {
    const locStr = r.hasLocationCreated
      ? `locationCreated=${JSON.stringify(r.locationCreated)}`
      : "locationCreated=缺失";
    const extra =
      r.otherLocKeys.length > 0
        ? ` | 其他地址字段: ${JSON.stringify(
            Object.fromEntries(
              r.otherLocKeys.map((k) => [k, r.locationTopLevel[k]])
            )
          ).slice(0, 120)}`
        : "";
    const poiStr = r.poi ? ` | poi=${JSON.stringify(r.poi).slice(0, 100)}` : "";
    console.log(
      `  ${String(r.index).padStart(2)}. ${r.id} | ${locStr}${extra}${poiStr}`
    );
    if (r.desc) console.log(`      desc: ${r.desc}`);
  }

  // 汇总 item 顶层 keys（第一条）
  const keys0 = Object.keys(sample[0] || {});
  const locKeysInItem = keys0.filter((k) => LOC_KEY_RE.test(k));
  console.log("\n=== item 顶层 location 相关 keys（首条视频）===");
  console.log(locKeysInItem.join(", ") || "(无)");

  const logsDir = path.join(__dirname, "../logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const outPath = path.join(
    logsDir,
    `probe-video-locations-${username}-${Date.now()}.json`
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        username,
        endpoint,
        stats: {
          total: rows.length,
          withLocationCreated: withLoc.length,
          withoutLocationCreated: rows.length - withLoc.length,
          locationCreatedDistribution: codes,
        },
        rows,
        firstItemKeys: keys0,
      },
      null,
      2
    ),
    "utf-8"
  );
  console.log(`\n完整结果已写入: ${outPath}`);

  console.log("\n=== 结论 ===");
  if (withLoc.length === rows.length) {
    console.log("前 N 条视频均含 locationCreated（本样本 100%）。");
  } else if (withLoc.length === 0) {
    console.log("前 N 条视频均无 locationCreated；不能依赖发布地址字段。");
  } else {
    console.log(
      `并非每条视频都有发布地址：${withLoc.length}/${rows.length} 有 locationCreated，` +
        `${rows.length - withLoc.length} 条缺失。`
    );
  }

  await page.close();
  await browser.close();
}

main().catch((e) => {
  console.error("probe failed:", e.message);
  process.exit(1);
});
