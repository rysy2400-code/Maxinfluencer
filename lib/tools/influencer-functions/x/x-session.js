/**
 * X (Twitter) Lite 会话：在已登录的 x.com 页面上下文内直调 GraphQL。
 * 账号走机器自身香港 IP 直连（不走代理），登录由人工在 9222 Chrome 完成。
 */

import {
  harvestTransactionInitFromPage,
  harvestTransactionInitFromNetwork,
  createXClientTransaction,
} from "./x-client-transaction-id.js";

export class XLoginRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "XLoginRequiredError";
    this.code = "X_LOGIN_REQUIRED";
  }
}

export class XAccountBlockedError extends Error {
  constructor(message, detail = null) {
    super(message);
    this.name = "XAccountBlockedError";
    this.code = "X_ACCOUNT_BLOCKED";
    this.detail = detail;
  }
}

export class XRateLimitedError extends Error {
  constructor(message, resetAtMs = 0) {
    super(message);
    this.name = "XRateLimitedError";
    this.code = "X_RATE_LIMITED";
    this.resetAtMs = resetAtMs;
  }
}

export class XGraphqlConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "XGraphqlConfigError";
    this.code = "X_GQL_CONFIG";
  }
}

const X_HOME_URL = "https://x.com/home";

/** 页面 evaluate 串行链（风控敏感，默认串行；X_LITE_DISABLE_EVALUATE_LOCK=1 可并发） */
const evaluateChains = new WeakMap();

function chainEvaluate(page, fn) {
  const prev = evaluateChains.get(page) || Promise.resolve();
  const next = prev.then(() => fn(), () => fn());
  evaluateChains.set(
    page,
    next.catch(() => {})
  );
  return next;
}

async function findXPage(context) {
  const pages = context.pages();
  for (const page of pages) {
    try {
      const url = page.url() || "";
      if (/^(https?:\/\/)?(www\.)?(x|twitter)\.com/i.test(url)) return page;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function isChallengeUrl(url) {
  const u = String(url || "").toLowerCase();
  return (
    u.includes("/i/flow/login") ||
    u.includes("/account/access") ||
    u.includes("/i/flow/signup") ||
    u.includes("challenge") ||
    u.includes("progressive")
  );
}

/**
 * 获取已登录 X 会话（复用已有 x.com tab，或新开一个）。
 * @param {import('playwright').BrowserContext} context
 * @param {{ onStepUpdate?: Function, logPrefix?: string }} [options]
 */
export async function acquireXSession(context, options = {}) {
  const { onStepUpdate = null, logPrefix = "[x-session]" } = options;
  const sendStep = (step, message) => {
    try {
      onStepUpdate?.({ step, message });
    } catch {
      /* ignore */
    }
  };

  let page = await findXPage(context);
  if (!page) {
    page = await context.newPage();
  }

  // Lite 流量控制：拦截 image/media/font 等资源（与 IG/TT/YT lite 一致）
  let unblockResources = async () => {};
  const blockedTypes = new Set(
    String(process.env.LITE_BLOCK_RESOURCE_TYPES || "image,media,font")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  if (blockedTypes.size > 0) {
    // 视频/流媒体 URL 模式（resourceType 为 XHR/fetch 的视频分段），media 拦截时一并中止
    const blockMediaUrl = blockedTypes.has("media");
    const MEDIA_URL_RE =
      /(video\.twimg\.com|\.m4s(\?|$)|\.m3u8(\?|$)|\.mp4(\?|$)|\.webm(\?|$)|\.ts(\?|$)|\.mpd(\?|$)|\.akamaized\.net\/.*\/video|media-[a-z0-9-]+\.cdn|\.googlevideo\.com)/i;
    try {
      if (typeof page.enableLiteResourceBlocker === "function") {
        unblockResources = await page.enableLiteResourceBlocker([...blockedTypes]);
        console.log(`${logPrefix} 已启用 CDP 资源拦截: ${[...blockedTypes].join(",")}`);
      } else if (typeof page.route === "function") {
        await page.route("**/*", (route) => {
          const t = route.request().resourceType();
          const u = route.request().url() || "";
          if (blockedTypes.has(t) || (blockMediaUrl && MEDIA_URL_RE.test(u))) {
            return route.abort();
          }
          return route.continue();
        });
        unblockResources = () => page.unroute("**/*");
        console.log(`${logPrefix} 已启用 route 资源拦截: ${[...blockedTypes].join(",")}`);
      }
    } catch (e) {
      console.warn(`${logPrefix} 资源拦截启用失败: ${e.message}`);
    }
  }

  const navigateHome = async () => {
    try {
      await page.goto(X_HOME_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch (e) {
      console.warn(`${logPrefix} 打开 x.com 失败: ${e.message}`);
    }
    await page.waitForTimeout(2500);
  };

  const currentUrl = (() => {
    try {
      return page.url() || "";
    } catch {
      return "";
    }
  })();
  if (!/x\.com|twitter\.com/i.test(currentUrl) || isChallengeUrl(currentUrl)) {
    await navigateHome();
  }

  const cookies = await context.cookies(["https://x.com", "https://twitter.com"]).catch(() => []);
  const cookieMap = new Map(cookies.map((c) => [c.name, c.value]));
  const authToken = cookieMap.get("auth_token");
  const ct0 = cookieMap.get("ct0");

  if (!authToken || !ct0) {
    sendStep("X 登录检查", "❌ 9222 Chrome 未检测到 X 登录态（auth_token/ct0），请在浏览器手动登录后重试");
    throw new XLoginRequiredError(
      "X 未登录：9222 Chrome 需要先登录 x.com（人工操作一次），确认后重试任务"
    );
  }

  const challenge = isChallengeUrl(page.url() || "");
  if (challenge) {
    throw new XAccountBlockedError(
      "X 账号出现验证/风控页面（challenge/account access），需要人工在 9222 Chrome 处理后再重试",
      { url: page.url() }
    );
  }

  // txid 初始化数据（bundle 拉取延迟到首次使用）
  let txInit = null;
  try {
    txInit = await harvestTransactionInitFromPage(page);
  } catch (e) {
    console.warn(`${logPrefix} txid init harvest 失败: ${e.message}`);
  }
  if (
    !txInit ||
    !txInit.siteVerification ||
    !txInit.ondemandHash ||
    !txInit.animFramePaths?.length
  ) {
    try {
      txInit = await harvestTransactionInitFromNetwork();
      console.log(`${logPrefix} 已用网络 harvest 兜底 txid 初始化数据`);
    } catch (e2) {
      console.warn(`${logPrefix} txid 网络 harvest 兜底失败: ${e2.message}`);
    }
  }
  let clientTx = null;
  if (txInit) {
    clientTx = createXClientTransaction(txInit);
  }

  const state = {
    cooldownUntilMs: 0,
    consecutiveErrors: 0,
    badReason: null,
    badAt: 0,
    requestCount: 0,
    lastRequestAt: 0,
  };

  const session = {
    page,
    authToken,
    ct0,
    csrfToken: ct0,
    clientTx,
    state,
    isLoggedIn: true,

    /** 串行化页内 fetch */
    evaluate(fn, arg) {
      return chainEvaluate(page, () => page.evaluate(fn, arg));
    },

    markRateLimited(resetAtMs = 0) {
      state.cooldownUntilMs = resetAtMs > Date.now() ? resetAtMs : Date.now() + 15 * 60 * 1000;
      state.consecutiveErrors += 1;
      console.warn(
        `${logPrefix} ⚠️ X 限流：冷却至 ${new Date(state.cooldownUntilMs).toISOString()} (reset=${resetAtMs})`
      );
    },

    markBad(reason, detail = null) {
      state.badReason = reason;
      state.badAt = Date.now();
      console.error(`${logPrefix} ❌ X 账号异常: ${reason}`, detail || "");
      throw new XAccountBlockedError(`X 账号异常: ${reason}`, detail);
    },

    isCoolingDown() {
      return state.cooldownUntilMs > Date.now();
    },

    coolDownRemainingMs() {
      return Math.max(0, state.cooldownUntilMs - Date.now());
    },

    isUsable() {
      if (state.badReason) return false;
      if (this.isCoolingDown()) return false;
      try {
        return !page.isClosed();
      } catch {
        return false;
      }
    },

    resetHealth() {
      state.cooldownUntilMs = 0;
      state.consecutiveErrors = 0;
      state.badReason = null;
    },

    async dispose() {
      try {
        await unblockResources();
      } catch {
        /* ignore */
      }
      try {
        if (!page.isClosed()) await page.close();
      } catch {
        /* ignore */
      }
    },
  };

  return session;
}
