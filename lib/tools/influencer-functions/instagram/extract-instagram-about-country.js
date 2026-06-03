/**
 * Instagram「账户简介 / 关于此账户」：wbloks 国家 + 弹窗 DOM 兜底
 */

import { normalizeInfluencerCountryToIso } from "../../../influencer/campaign-country-codes.js";

const ABOUT_COUNTRY_BLOKS_KEY =
  "IG_ABOUT_THIS_ACCOUNT:about_this_account_country";

/** 部分账号为「账户简介」，部分为「关于」；优先精确项避免误点 */
const ABOUT_MENU_LABELS = [
  /^账户简介$/,
  /^关于$/,
  /关于此账户/i,
  /关于这个账户/i,
  /About this account/i,
  /Account information/i,
];

const OPTIONS_ARIA = ["选项", "Options", "More options", "更多选项"];

/**
 * @param {string} text
 * @returns {string|null}
 */
export function parseWbloksAboutCountry(text) {
  const jsonStr = String(text || "").replace(/^for \(;;\);/, "");
  try {
    const data = JSON.parse(jsonStr);
    const arr = data?.payload?.layout?.bloks_payload?.data;
    if (!Array.isArray(arr)) return null;
    const countryObj = arr.find(
      (item) => item?.data?.key === ABOUT_COUNTRY_BLOKS_KEY
    );
    const v = countryObj?.data?.initial;
    return v != null && v !== "" ? String(v).trim() : null;
  } catch {
    return null;
  }
}

/**
 * 从「账户简介」弹窗 DOM 解析账户所在地
 * @param {string} text
 * @returns {string|null}
 */
export function parseAboutDialogCountryFromDom(text) {
  const t = String(text || "");
  const patterns = [
    /账户所在地[\s\n]*([^\n]+)/,
    /Account based in[\s\n]*([^\n]+)/i,
    /Country[\s\n]*([^\n]+)/i,
  ];
  for (const p of patterns) {
    const m = t.match(p);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 打开主页右上角「选项」菜单
 * @param {import('playwright').Page} page
 */
export async function openInstagramProfileOptionsMenu(page) {
  const viaEvaluate = await page.evaluate((ariaLabels) => {
    for (const label of ariaLabels) {
      const svg =
        document.querySelector(`header svg[aria-label="${label}"]`) ||
        document.querySelector(`svg[aria-label="${label}"]`);
      if (!svg) continue;
      let el = svg.parentElement;
      for (let i = 0; i < 8 && el; i++) {
        if (el.tagName === "BUTTON" || el.getAttribute("role") === "button") {
          el.click();
          return { ok: true, aria: label, via: "button" };
        }
        el = el.parentElement;
      }
      const clickable = svg.closest("div[role='button']") || svg.parentElement;
      clickable?.click();
      return { ok: true, aria: label, via: "parent" };
    }
    return { ok: false };
  }, OPTIONS_ARIA);

  if (viaEvaluate.ok) return viaEvaluate;

  for (const label of OPTIONS_ARIA) {
    try {
      const btn = page.getByRole("button", { name: new RegExp(label, "i") }).first();
      if ((await btn.count()) > 0 && (await btn.isVisible())) {
        await btn.click({ timeout: 5000 });
        return { ok: true, aria: label, via: "playwright" };
      }
    } catch {
      /* try next */
    }
  }
  return { ok: false };
}

/**
 * 在已打开的选项菜单中点击「关于 / 账户简介」
 * @param {import('playwright').Page} page
 */
export async function clickInstagramAboutMenuItem(page) {
  for (const pat of ABOUT_MENU_LABELS) {
    try {
      const item = page.getByRole("menuitem", { name: pat }).first();
      if ((await item.count()) > 0) {
        await item.click({ timeout: 5000 });
        return { ok: true, label: String(pat), via: "menuitem" };
      }
    } catch {
      /* continue */
    }
    try {
      const el = page.getByText(pat).first();
      if ((await el.count()) > 0 && (await el.isVisible())) {
        await el.click({ timeout: 5000 });
        return { ok: true, label: String(pat), via: "text" };
      }
    } catch {
      /* continue */
    }
  }

  const viaEvaluate = await page.evaluate(() => {
    const labels = [
      "账户简介",
      "关于",
      "About this account",
      "关于此账户",
      "关于这个账户",
    ];
    const els = [
      ...document.querySelectorAll('[role="menuitem"]'),
      ...document.querySelectorAll("button, span, div"),
    ];
    for (const want of labels) {
      for (const el of els) {
        const t = (el.innerText || el.textContent || "").trim();
        if (t === want || t.toLowerCase() === want.toLowerCase()) {
          el.click();
          return { ok: true, label: want, via: "evaluate-exact" };
        }
      }
    }
    return { ok: false, visible: els.map((e) => (e.innerText || "").trim()).filter((t) => t && t.length < 30).slice(0, 15) };
  });

  return viaEvaluate;
}

/**
 * 读取已打开的「账户简介」弹窗
 * @param {import('playwright').Page} page
 */
export async function readAboutDialogFromPage(page) {
  return page.evaluate(() => {
    const dialog =
      document.querySelector('[role="dialog"]') ||
      document.querySelector('div[aria-modal="true"]');
    return {
      hasDialog: !!dialog,
      text: dialog?.innerText || "",
    };
  });
}

/**
 * @param {import('playwright').Page} page
 * @param {string} username
 * @param {{ waitAfterAboutMs?: number, skipInitialGoto?: boolean, onWbloksCountry?: (country: string) => void }} [options]
 */
export async function extractInstagramAboutCountryFromPage(
  page,
  username,
  options = {}
) {
  const handle = String(username || "").replace(/^@/, "").trim();
  const waitAfterAboutMs = options.waitAfterAboutMs ?? 12_000;
  const skipInitialGoto = !!options.skipInitialGoto;
  const wbloksCountries = [];
  let wbloksRequests = 0;

  const responseHandler = async (response) => {
    const url = response.url();
    if (!url.includes("/async/wbloks/fetch/")) return;
    wbloksRequests += 1;
    try {
      const text = await response.text();
      const country = parseWbloksAboutCountry(text);
      if (country) {
        wbloksCountries.push(country);
        options.onWbloksCountry?.(country);
      }
    } catch {
      /* ignore */
    }
  };

  page.on("response", responseHandler);

  const profileUrl = `https://www.instagram.com/${handle}/`;
  let navError = null;
  if (!skipInitialGoto) {
    try {
      await page.goto(profileUrl, {
        waitUntil: "domcontentloaded",
        timeout: 120_000,
      });
    } catch (e) {
      navError = e.message;
      if (!page.url().includes(handle)) {
        page.off("response", responseHandler);
        return {
          success: false,
          username: handle,
          accountCountry: null,
          accountCountryIso: null,
          videoPublishCountry: null,
          source: null,
          error: navError,
          wbloksRequests: 0,
        };
      }
    }
    await sleep(3500);
  } else {
    await sleep(1500);
  }

  const menuResult = await openInstagramProfileOptionsMenu(page);
  await sleep(2200);

  const aboutClick = await clickInstagramAboutMenuItem(page);
  await sleep(waitAfterAboutMs);

  const dialog = await readAboutDialogFromPage(page);
  const domCountry = parseAboutDialogCountryFromDom(dialog.text);

  page.off("response", responseHandler);

  const wbloksCountry = wbloksCountries[wbloksCountries.length - 1] || null;
  const accountCountryRaw = wbloksCountry || domCountry;
  const accountCountryIso = normalizeInfluencerCountryToIso(accountCountryRaw);
  const source = wbloksCountry
    ? "wbloks"
    : domCountry
      ? "about_dialog_dom"
      : null;

  return {
    success: !!accountCountryRaw,
    username: handle,
    accountCountry: accountCountryRaw,
    accountCountryRaw,
    accountCountryIso,
    /** 与 TikTok/YouTube 统一：写入 video_publish_country（ISO 2） */
    videoPublishCountry: accountCountryIso,
    source,
    wbloksCountry,
    domCountry,
    wbloksRequests,
    menuResult,
    aboutClick,
    hasAboutDialog: dialog.hasDialog,
    navError,
    error: accountCountryRaw
      ? null
      : aboutClick.ok
        ? "about_country_not_found"
        : menuResult.ok
          ? "about_menu_item_not_found"
          : "profile_options_menu_not_found",
  };
}
