/**
 * X Lite 浏览器 IO：打开真实页面（搜索/主页），拦截 X GraphQL 网络响应。
 * 背景：X 边缘 WAF 校验 x-client-transaction-id 等签名，Node 自组 GraphQL 直调稳定返回
 * 403 HTML；浏览器内由页面自身发起的 SearchTimeline/UserByScreenName 请求天然携带正确
 * 签名与 cookie。本模块只负责「等响应 + 解析」，页面跳转由调用方完成。
 */

/**
 * 挂载 X GraphQL 响应收集器。
 * @param {import('playwright').Page} page
 * @param {string[]} queryNames 例如 ['SearchTimeline','UserByScreenName','UserTweets']
 * @returns {{ drain: Function, waitFor: Function, stats: Function, detach: Function }}
 */
export function attachXGraphqlCollector(page, queryNames) {
  const wanted = new Set(queryNames);
  /** @type {{ name: string, json: object, url: string, status: number }[]} */
  const pending = [];
  let totalResponses = 0;

  const handler = async (response) => {
    const url = response.url() || "";
    if (!url.includes("/i/api/graphql/")) return;
    const after = url.split("graphql/")[1] || "";
    const name = (after.split("/")[1] || after).split("?")[0];
    if (!wanted.has(name)) return;
    try {
      const text = await response.text();
      if (!text || (text[0] !== "{" && text[0] !== "[")) return;
      const json = JSON.parse(text);
      pending.push({ name, json, url, status: response.status() });
      totalResponses += 1;
    } catch {
      /* 非 JSON 或解析失败，忽略 */
    }
  };

  page.on("response", handler);

  return {
    drain() {
      return pending.splice(0, pending.length);
    },

    /**
     * 只读当前所有未消费响应（不移动队列）。
     * 用于在等待目标响应时先收集已到的 timeline，避免被 drain 丢批。
     */
    peek() {
      return [...pending];
    },

    /**
     * 等待至少一条指定 query 的响应，并只取走匹配项；
     * 其它名字的响应（如 timeline）继续留在队列，避免被误排空。
     * @param {string|string[]|null} names
     * @param {{ timeoutMs?: number }} [opts]
     * @returns {Promise<{ name: string, json: object, url: string, status: number }[]>}
     */
    async take(names = null, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? 20000;
      const want = names
        ? Array.isArray(names)
          ? new Set(names)
          : new Set([names])
        : wanted;
      const start = Date.now();
      const extractMatches = () => {
        const matches = pending.filter((h) => want.has(h.name));
        if (!matches.length) return [];
        const rest = pending.filter((h) => !want.has(h.name));
        pending.splice(0, pending.length, ...rest);
        return matches;
      };
      while (Date.now() - start < timeoutMs) {
        const hit = pending.find((h) => want.has(h.name));
        if (hit) return extractMatches();
        await new Promise((r) => setTimeout(r, 300));
      }
      return extractMatches();
    },

    /**
     * 等待至少一条指定 query 的响应。
     * @param {string|string[]|null} names
     * @param {{ timeoutMs?: number }} [opts]
     */
    async waitFor(names = null, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? 20000;
      const want = names
        ? Array.isArray(names)
          ? new Set(names)
          : new Set([names])
        : wanted;
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const hit = pending.find((h) => want.has(h.name));
        if (hit) return this.drain();
        await new Promise((r) => setTimeout(r, 300));
      }
      return this.drain();
    },

    stats() {
      return { totalResponses, pending: pending.length };
    },

    detach() {
      page.off("response", handler);
    },
  };
}

/**
 * 等待页面出现指定 UI 元素（结果栅格等）。
 * @param {import('playwright').Page} page
 * @param {string} selector
 * @param {{ timeoutMs?: number, min?: number }} [opts]
 * @returns {Promise<number>} 命中的元素数量（超时返回当前数量）
 */
export async function waitForUiElements(page, selector, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 25000;
  const min = Math.max(1, Number(opts.min) || 1);
  const start = Date.now();
  let count = 0;
  while (Date.now() - start < timeoutMs) {
    count = await page.locator(selector).count().catch(() => 0);
    if (count >= min) return count;
    await page.waitForTimeout(800);
  }
  return count;
}

/**
 * X SPA 路由跳转（不整页重载）：pushState + popstate 触发客户端路由，
 * 页面脚本不再重复下载，仅产生 API 流量。首次进入 x.com 仍需整页加载一次。
 * @param {import('playwright').Page} page
 * @param {string} path 例如 /search?q=xx&f=media 或 /username
 * @returns {Promise<boolean>} 是否成功发起 SPA 导航（true=已 pushState；false=页面不可用）
 */
export async function xSpaNavigate(page, path) {
  try {
    const cur = await page.evaluate(() => location.pathname + location.search + location.hash);
    if (cur === path) return true;
    const ok = await page.evaluate(
      (p) => {
        history.pushState({}, "", p);
        window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
        return true;
      },
      path
    );
    return ok !== false;
  } catch {
    return false;
  }
}

/**
 * 从主页 DOM 提取 profile 兜底字段（GraphQL 响应有时缺 followers/location）。
 * @param {import('playwright').Page} page
 * @returns {Promise<{ followers?: number|null, location?: string|null, description?: string|null, website?: string|null, displayName?: string|null }>}
 */
export async function parseProfileDom(page) {
  try {
    return await page.evaluate(() => {
      const txt = (sel) => {
        const el = document.querySelector(sel);
        return el ? (el.innerText || "").trim() : "";
      };
      const href = (sel) => {
        const el = document.querySelector(sel);
        return el ? (el.getAttribute("href") || "") : "";
      };
      const followersRaw = txt('[data-testid="UserProfileHeader_Items"] a[href*="/followers"]')
        || txt('a[href$="/verified_followers"]')
        || txt('a[href*="/followers"]');
      const followersMatch = String(followersRaw).replace(/[,\s]/g, "").match(/(\d+)(K|M)?/i);
      let followers = null;
      if (followersMatch) {
        let n = Number(followersMatch[1]);
        if (followersMatch[2] === "K") n *= 1000;
        if (followersMatch[2] === "M") n *= 1000000;
        followers = n;
      }
      const location = txt('[data-testid="UserProfileHeader_Items"] [data-testid="UserLocation"]')
        || txt('[data-testid="UserLocation"]');
      let website = href('[data-testid="UserProfileHeader_Items"] a[href^="http"]')
        || href('a[href^="http"][target="_blank"][rel="nofollow"]');
      if (website && website.startsWith("/")) website = null;
      return {
        followers,
        location: location || null,
        description: txt('[data-testid="userDescription"]') || null,
        website: website || null,
        displayName: txt('[data-testid="UserName"]') ? String(txt('[data-testid="UserName"]')).split("\n")[0] : null,
      };
    });
  } catch {
    return {};
  }
}
