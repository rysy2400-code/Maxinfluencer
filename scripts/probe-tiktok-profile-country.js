/**
 * 探测 TikTok 主页 API 是否包含国家/地区字段
 * 用法: node scripts/probe-tiktok-profile-country.js alondranunez.z
 */
import { chromium } from "playwright";

const COUNTRY_KEY_RE =
  /country|region|location|geo|nation|province|city|area|locale|ip/i;

function findCountryLikeFields(obj, path = "", out = [], depth = 0) {
  if (depth > 12 || obj == null) return out;
  if (typeof obj !== "object") return out;

  if (Array.isArray(obj)) {
    for (let i = 0; i < Math.min(obj.length, 5); i++) {
      findCountryLikeFields(obj[i], `${path}[${i}]`, out, depth + 1);
    }
    return out;
  }

  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;
    if (COUNTRY_KEY_RE.test(k) && v != null && v !== "") {
      const preview =
        typeof v === "object"
          ? JSON.stringify(v).slice(0, 200)
          : String(v).slice(0, 200);
      out.push({ path: p, value: preview });
    }
    if (typeof v === "object" && v !== null) {
      findCountryLikeFields(v, p, out, depth + 1);
    }
  }
  return out;
}

async function main() {
  const username = (process.argv[2] || "alondranunez.z").replace(/^@/, "");
  const endpoint =
    process.env.CDP_ENDPOINT_ENRICH ||
    process.env.CDP_ENDPOINT ||
    "http://127.0.0.1:9223";

  const captured = {
    userDetail: null,
    itemList: [],
    otherApis: [],
  };

  const browser = await chromium.connectOverCDP(endpoint, { timeout: 10000 });
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = await context.newPage();

  const handler = async (response) => {
    const url = response.url();
    if (response.status() >= 300 && response.status() < 400) return;
    if (!url.includes("tiktok.com/api/")) return;

    try {
      const body = await response.text();
      const json = JSON.parse(body);

      if (url.includes("/api/user/detail")) {
        captured.userDetail = { url, json };
        console.log("[probe] user/detail intercepted");
      } else if (url.includes("/api/post/item_list")) {
        captured.itemList.push({ url, json });
        console.log(
          `[probe] item_list intercepted (${json?.itemList?.length || 0} items)`
        );
      } else if (COUNTRY_KEY_RE.test(url)) {
        captured.otherApis.push({ url, json });
      }
    } catch {
      /* ignore parse errors */
    }
  };

  page.on("response", handler);

  try {
    await page.goto(`https://www.tiktok.com/@${username}`, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await page.waitForTimeout(4000);
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() =>
        window.scrollTo(0, document.body.scrollHeight)
      );
      await page.waitForTimeout(2000);
    }
    await page.waitForTimeout(3000);
  } finally {
    page.off("response", handler);
  }

  console.log("\n=== 拦截统计 ===");
  console.log({
    userDetail: !!captured.userDetail,
    itemListCount: captured.itemList.length,
    otherApis: captured.otherApis.length,
  });

  const report = (label, json) => {
    const hits = findCountryLikeFields(json);
    console.log(`\n--- ${label}: ${hits.length} 个疑似国家/地区字段 ---`);
    for (const h of hits.slice(0, 40)) {
      console.log(`  ${h.path} => ${h.value}`);
    }
    if (hits.length > 40) console.log(`  ... 还有 ${hits.length - 40} 条`);
    return hits;
  };

  let allHits = [];

  if (captured.userDetail?.json) {
    allHits = allHits.concat(
      report("user/detail", captured.userDetail.json).map((h) => ({
        ...h,
        source: "user/detail",
      }))
    );
    const user = captured.userDetail.json?.userInfo?.user || captured.userDetail.json?.user;
    if (user) {
      console.log("\n[user/detail] author 顶层 keys:", Object.keys(user).join(", "));
    }
  } else {
    console.log("\n⚠️ 未拦截到 /api/user/detail");
  }

  if (captured.itemList[0]?.json) {
    const first = captured.itemList[0].json;
    allHits = allHits.concat(
      report("item_list", first).map((h) => ({ ...h, source: "item_list" }))
    );
    const author = first?.itemList?.[0]?.author;
    if (author) {
      console.log("\n[item_list] author keys:", Object.keys(author).join(", "));
    }
  } else {
    console.log("\n⚠️ 未拦截到 /api/post/item_list");
  }

  // 检查 SIGI_STATE / __UNIVERSAL_DATA_FOR_REHYDRATION__
  const embedded = await page.evaluate(() => {
    const out = {};
    const sigi = document.getElementById("SIGI_STATE");
    if (sigi?.textContent) {
      try {
        out.SIGI_STATE = JSON.parse(sigi.textContent);
      } catch {}
    }
    const scripts = document.querySelectorAll(
      'script[id="__UNIVERSAL_DATA_FOR_REHYDRATION__"]'
    );
    if (scripts[0]?.textContent) {
      try {
        out.UNIVERSAL = JSON.parse(scripts[0].textContent);
      } catch {}
    }
    return out;
  });

  if (embedded.SIGI_STATE) {
    report("SIGI_STATE (DOM)", embedded.SIGI_STATE);
  }
  if (embedded.UNIVERSAL) {
    report("UNIVERSAL_DATA (DOM)", embedded.UNIVERSAL);
  }

  console.log("\n=== 结论摘要 ===");
  const uniquePaths = [...new Set(allHits.map((h) => h.path))];
  if (uniquePaths.length) {
    console.log("发现字段路径:", uniquePaths.slice(0, 20).join("; "));
  } else {
    console.log("拦截的 user/detail 与 item_list 中未发现明显的 country/region 字段");
  }

  await page.close();
  await browser.close();
}

main().catch((e) => {
  console.error("probe failed:", e.message);
  process.exit(1);
});
