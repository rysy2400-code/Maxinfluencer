/**
 * 深度探测 Affiliate Creator API（仅 partner.us.tiktokshop.com/oec/affiliate）
 * 用法:
 *   node scripts/probe-tiktok-affiliate-api-deep.mjs search una_flor_cubana
 *   node scripts/probe-tiktok-affiliate-api-deep.mjs detail 7495403384116840923
 */
import { chromium } from "playwright";

function unwrapField(node) {
  if (node == null) return null;
  if (typeof node !== "object") return node;
  if ("value" in node) return unwrapField(node.value);
  return node;
}

function pickCreatorSummary(item = {}) {
  const gmvNode = item.med_gmv_revenue || item.gmv || item.total_gmv;
  const gmvUnwrapped = unwrapField(gmvNode);
  return {
    creator_oecuid: unwrapField(item.creator_oecuid),
    handle: unwrapField(item.handle),
    nickname: unwrapField(item.nickname),
    med_gmv_revenue: gmvUnwrapped,
    units_sold: unwrapField(item.units_sold),
    ec_video_gpm: unwrapField(item.ec_video_gpm),
    ec_live_gpm: unwrapField(item.ec_live_gpm),
    ec_video_avg_view_cnt: unwrapField(item.ec_video_avg_view_cnt),
    follower_cnt: unwrapField(item.follower_cnt),
    avg_commission_rate: unwrapField(item.avg_commission_rate),
    product_cnt: unwrapField(item.product_cnt),
    brand_collaboration_cnt: unwrapField(item.brand_collaboration_cnt),
    industry_groups: unwrapField(item.industry_groups),
    selection_region: unwrapField(item.selection_region),
  };
}

async function attachApiCapture(page, store) {
  const handler = async (response) => {
    const url = response.url();
    if (!url.includes("partner.us.tiktokshop.com/api/v1/oec/affiliate")) return;
    if (response.status() >= 400) return;
    try {
      const json = JSON.parse(await response.text());
      store.push({
        method: response.request().method(),
        url,
        postData: response.request().postData()?.slice(0, 2000) || null,
        json,
      });
    } catch {
      /* ignore */
    }
  };
  page.on("response", handler);
  return () => page.off("response", handler);
}

async function main() {
  const mode = process.argv[2] || "search";
  const arg = process.argv[3] || "una_flor_cubana";
  const endpoint = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";

  const browser = await chromium.connectOverCDP(endpoint, { timeout: 20000 });
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = await context.newPage();
  const captured = [];
  const detach = await attachApiCapture(page, captured);

  if (mode === "search") {
    await page.goto(
      "https://partner.us.tiktokshop.com/affiliate-cmp/creator?market=100",
      { waitUntil: "domcontentloaded", timeout: 60000 }
    );
    await page.waitForTimeout(3000);
    const input = page.locator('input[placeholder*="Search"], input[type="search"]').first();
    await input.fill(arg);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(8000);
  } else if (mode === "detail") {
    await page.goto(
      `https://partner.us.tiktokshop.com/affiliate-cmp/creator/detail?cid=${encodeURIComponent(
        arg
      )}&market=100`,
      { waitUntil: "domcontentloaded", timeout: 60000 }
    );
    await page.waitForTimeout(8000);
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(3000);
  } else {
    throw new Error(`unknown mode ${mode}`);
  }

  detach();

  const summaries = captured.map((c) => {
    const j = c.json || {};
    const list =
      j.creator_profile_list ||
      j.data?.creator_profile_list ||
      j.data?.creator_profile ||
      j.data?.creator ||
      null;

    let picked = null;
    if (Array.isArray(list) && list.length) {
      picked = list.map(pickCreatorSummary);
    } else if (j.data && typeof j.data === "object") {
      picked = pickCreatorSummary(j.data);
    }

    return {
      method: c.method,
      urlPath: c.url.split("?")[0],
      postData: c.postData,
      code: j.code,
      message: j.message || j.msg,
      listCount: Array.isArray(list) ? list.length : list ? 1 : 0,
      picked,
      topKeys: j && typeof j === "object" ? Object.keys(j) : [],
      rawKeys:
        j.data && typeof j.data === "object" && !Array.isArray(j.data)
          ? Object.keys(j.data).slice(0, 40)
          : [],
    };
  });

  console.log(
    JSON.stringify(
      {
        mode,
        arg,
        pageUrl: page.url(),
        apiCount: captured.length,
        summaries,
      },
      null,
      2
    )
  );

  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}

main().catch((e) => {
  console.error("DEEP_PROBE_FAILED", e?.message || e);
  process.exit(1);
});
