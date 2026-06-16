/**
 * 通过 CDP WebSocket 附着 9222 Chrome 已有 instagram.com 标签（Playwright connectOverCDP 在此环境不可信）
 */
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { ws: WebSocketCtor } = require("playwright-core/lib/utilsBundle");

/**
 * @param {string} [cdpEndpoint]
 */
export async function listCdpPageTargets(cdpEndpoint = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222") {
  const res = await fetch(`${cdpEndpoint}/json/list`);
  if (!res.ok) throw new Error(`CDP list failed: ${res.status}`);
  return (await res.json()).filter((t) => t.type === "page");
}

function rankIgTargetUrl(url) {
  const u = String(url || "").split("?")[0];
  if (u === "https://www.instagram.com/") return 0;
  if (u.includes("instagram.com")) return 1;
  return 9;
}

function rankTiktokTargetUrl(url) {
  const u = String(url || "").split("?")[0];
  if (u === "https://www.tiktok.com/" || u === "https://www.tiktok.com") return 0;
  if (u.includes("tiktok.com")) return 1;
  return 9;
}

/**
 * @param {{ webSocketDebuggerUrl: string, url?: string }} target
 */
export async function verifyCdpTargetHealthy(target) {
  const session = new CdpSession(target.webSocketDebuggerUrl);
  try {
    await session.connect();
    const href = await session.evaluate(() => location.href);
    return String(href || "").includes("instagram.com") && !String(href).startsWith("chrome-error:");
  } catch {
    return false;
  } finally {
    await session.close();
  }
}

/**
 * @param {{ webSocketDebuggerUrl: string, url?: string }} target
 */
export async function verifyTiktokCdpTargetHealthy(target) {
  const session = new CdpSession(target.webSocketDebuggerUrl);
  try {
    await session.connect();
    const href = await session.evaluate(() => location.href);
    return String(href || "").includes("tiktok.com") && !String(href).startsWith("chrome-error:");
  } catch {
    return false;
  } finally {
    await session.close();
  }
}

/**
 * @param {string} [cdpEndpoint]
 */
export async function pickInstagramCdpTarget(cdpEndpoint) {
  const pages = await listCdpPageTargets(cdpEndpoint);
  const ranked = pages
    .filter((t) => String(t.url || "").includes("instagram.com"))
    .sort((a, b) => rankIgTargetUrl(a.url) - rankIgTargetUrl(b.url));
  for (const t of ranked) {
    if (await verifyCdpTargetHealthy(t)) return t;
  }
  return null;
}

/**
 * @param {string} [cdpEndpoint]
 */
export async function pickTiktokCdpTarget(cdpEndpoint) {
  const pages = await listCdpPageTargets(cdpEndpoint);
  const ranked = pages
    .filter((t) => String(t.url || "").includes("tiktok.com"))
    .sort((a, b) => rankTiktokTargetUrl(a.url) - rankTiktokTargetUrl(b.url));
  for (const t of ranked) {
    if (await verifyTiktokCdpTargetHealthy(t)) return t;
  }
  return null;
}

/**
 * @param {string} [cdpEndpoint]
 * @param {string} [url]
 */
export async function openCdpTab(cdpEndpoint, url = "https://www.instagram.com/") {
  const res = await fetch(`${cdpEndpoint}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!res.ok) throw new Error(`CDP new tab failed: ${res.status}`);
  return res.json();
}

/**
 * @param {string} [cdpEndpoint]
 * @param {string} targetId
 */
export async function closeCdpTarget(cdpEndpoint, targetId) {
  const endpoint = cdpEndpoint || process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
  const id = encodeURIComponent(String(targetId || ""));
  if (!id) return false;
  try {
    const res = await fetch(`${endpoint}/json/close/${id}`);
    return res.ok;
  } catch {
    return false;
  }
}

function rankYtTargetUrl(url) {
  const u = String(url || "").split("?")[0].replace(/\/$/, "");
  if (u === "https://www.youtube.com") return 0;
  if (u.includes("youtube.com") && !u.includes("/watch") && !u.includes("results?")) return 1;
  if (u.includes("youtube.com")) return 2;
  return 9;
}

/**
 * @param {string} [cdpEndpoint]
 */
export async function pickYoutubeCdpTarget(cdpEndpoint) {
  const pages = await listCdpPageTargets(cdpEndpoint);
  const ranked = pages
    .filter((t) => String(t.url || "").includes("youtube.com"))
    .sort((a, b) => rankYtTargetUrl(a.url) - rankYtTargetUrl(b.url));
  return ranked[0] || null;
}

class CdpSession {
  /** @param {string} wsUrl */
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    /** @type {Map<number, {resolve: Function, reject: Function}>} */
    this.pending = new Map();
    /** @type {Map<string, Set<Function>>} */
    this.eventHandlers = new Map();
    /** @type {import('ws')} */
    this.ws = null;
  }

  on(event, handler) {
    if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, new Set());
    this.eventHandlers.get(event).add(handler);
    return () => this.eventHandlers.get(event)?.delete(handler);
  }

  async connect() {
    this.ws = new WebSocketCtor(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    this.ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method && this.eventHandlers.has(msg.method)) {
        for (const fn of this.eventHandlers.get(msg.method)) {
          try {
            fn(msg.params);
          } catch {
            /* ignore */
          }
        }
      }
    });
    await this.send("Runtime.enable");
    await this.send("Page.enable");
  }

  /**
   * @param {{ navigateUrl: string, matchPost: (post: string) => boolean, timeoutMs?: number }} opts
   */
  async captureGraphqlResponse(opts) {
    const timeoutMs = opts.timeoutMs || 25_000;
    await this.send("Network.enable");

    return new Promise((resolve, reject) => {
      /** @type {Map<string, string>} */
      const postsByRequestId = new Map();
      /** @type {Set<string>} */
      const trackedIds = new Set();

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("graphql capture timeout"));
      }, timeoutMs);

      const onRequest = (params) => {
        const post = params.request?.postData || "";
        if (opts.matchPost(post)) {
          postsByRequestId.set(params.requestId, post);
          trackedIds.add(params.requestId);
        }
      };

      const onLoadingFinished = async (params) => {
        if (!trackedIds.has(params.requestId)) return;
        try {
          const body = await this.send("Network.getResponseBody", {
            requestId: params.requestId,
          });
          const raw = body.base64Encoded
            ? Buffer.from(body.body, "base64").toString("utf8")
            : body.body;
          const jsonText = raw.replace(/^for\s*\(\s*;\s*;\s*\)\s*;/, "");
          const json = JSON.parse(jsonText);
          cleanup();
          resolve({
            json,
            requestBody: postsByRequestId.get(params.requestId) || null,
          });
        } catch {
          /* body not ready or non-json */
        }
      };

      const offReq = this.on("Network.requestWillBeSent", onRequest);
      const offDone = this.on("Network.loadingFinished", onLoadingFinished);

      const cleanup = () => {
        clearTimeout(timer);
        offReq();
        offDone();
      };

      void (async () => {
        try {
          let href = "";
          try {
            href = await this.evaluate(() => location.href);
          } catch {
            href = "";
          }
          const target = opts.navigateUrl;
          const sameSearch =
            href &&
            target &&
            (href === target ||
              (href.includes("instagram.com/explore/search") &&
                target.includes("instagram.com/explore/search") &&
                href.split("q=")[1]?.split("&")[0] === target.split("q=")[1]?.split("&")[0]));
          if (opts.forceReload || sameSearch) {
            await this.send("Page.reload", { ignoreCache: true });
          } else {
            await this.send("Page.navigate", { url: target });
          }
        } catch (e) {
          cleanup();
          reject(e);
        }
      })();
    });
  }

  /**
   * 滚动页面并捕获下一页 GraphQL（不重新 navigate）
   * @param {{ matchPost: (post: string) => boolean, matchMaxId?: string, timeoutMs?: number }} opts
   */
  async captureGraphqlViaScroll(opts) {
    const timeoutMs = opts.timeoutMs || 18_000;
    await this.send("Network.enable");

    return new Promise((resolve, reject) => {
      /** @type {Map<string, string>} */
      const postsByRequestId = new Map();
      /** @type {Set<string>} */
      const trackedIds = new Set();

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("scroll graphql capture timeout"));
      }, timeoutMs);

      const matchesPost = (post) => {
        if (!opts.matchPost(post)) return false;
        if (opts.matchMaxId && !post.includes(String(opts.matchMaxId))) return false;
        return true;
      };

      const onRequest = (params) => {
        const post = params.request?.postData || "";
        if (matchesPost(post)) {
          postsByRequestId.set(params.requestId, post);
          trackedIds.add(params.requestId);
        }
      };

      const onLoadingFinished = async (params) => {
        if (!trackedIds.has(params.requestId)) return;
        try {
          const body = await this.send("Network.getResponseBody", {
            requestId: params.requestId,
          });
          const raw = body.base64Encoded
            ? Buffer.from(body.body, "base64").toString("utf8")
            : body.body;
          const jsonText = raw.replace(/^for\s*\(\s*;\s*;\s*\)\s*;/, "");
          const json = JSON.parse(jsonText);
          cleanup();
          resolve({
            json,
            requestBody: postsByRequestId.get(params.requestId) || null,
          });
        } catch {
          /* body not ready or non-json */
        }
      };

      const offReq = this.on("Network.requestWillBeSent", onRequest);
      const offDone = this.on("Network.loadingFinished", onLoadingFinished);

      const cleanup = () => {
        clearTimeout(timer);
        offReq();
        offDone();
      };

      void (async () => {
        try {
          await this.evaluate(() => {
            window.scrollTo({ top: document.body.scrollHeight, behavior: "auto" });
            window.scrollBy(0, window.innerHeight * 0.9);
          });
          await new Promise((r) => setTimeout(r, 1200));
          await this.evaluate(() => {
            window.scrollTo({ top: document.body.scrollHeight, behavior: "auto" });
          });
        } catch (e) {
          cleanup();
          reject(e);
        }
      })();
    });
  }

  /** @param {string} method @param {object} [params] */
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * @param {Function|string} fn
   * @param {unknown} [arg]
   */
  async evaluate(fn, arg) {
    const expression =
      typeof fn === "function"
        ? `(${fn.toString()})(${JSON.stringify(arg ?? null)})`
        : String(fn);
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) {
      const detail =
        exceptionDetails.exception?.description ||
        exceptionDetails.text ||
        JSON.stringify(exceptionDetails);
      throw new Error(detail || "Runtime.evaluate failed");
    }
    return result.value;
  }

  /**
   * Lite 模式：拦截 image/media/font 等，降低 CDP 页导航流量
   * @param {string[]} blockedTypeNames 如 ["image","media","font"]
   */
  async attachLiteResourceBlocker(blockedTypeNames = []) {
    const typeMap = {
      image: "Image",
      media: "Media",
      font: "Font",
      stylesheet: "Stylesheet",
      script: "Script",
    };
    const blocked = new Set(
      blockedTypeNames
        .map((t) => typeMap[String(t).trim().toLowerCase()] || String(t))
        .filter(Boolean)
    );
    if (!blocked.size) return async () => {};

    await this.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });

    const handler = async (params) => {
      const requestId = params.requestId;
      try {
        if (blocked.has(params.resourceType)) {
          await this.send("Fetch.failRequest", {
            requestId,
            errorReason: "BlockedByClient",
          });
        } else {
          await this.send("Fetch.continueRequest", { requestId });
        }
      } catch {
        try {
          await this.send("Fetch.continueRequest", { requestId });
        } catch {
          /* ignore */
        }
      }
    };

    const off = this.on("Fetch.requestPaused", handler);
    return async () => {
      off();
      try {
        await this.send("Fetch.disable");
      } catch {
        /* ignore */
      }
    };
  }

  /**
   * @param {{ type?: 'jpeg'|'png', quality?: number, fullPage?: boolean }} [options]
   * @returns {Promise<Buffer>}
   */
  async captureScreenshot(options = {}) {
    const format = options.type === "png" ? "png" : "jpeg";
    const params = { format, fromSurface: true };
    if (format === "jpeg") {
      params.quality = Math.min(
        100,
        Math.max(1, Number(options.quality ?? 55) || 55)
      );
    }
    if (options.fullPage) {
      try {
        const layout = await this.send("Page.getLayoutMetrics");
        const content = layout?.contentSize || layout?.cssContentSize;
        if (content?.width && content?.height) {
          params.clip = {
            x: 0,
            y: 0,
            width: content.width,
            height: Math.min(content.height, 12000),
            scale: 1,
          };
        }
      } catch {
        /* viewport fallback */
      }
    }
    const { data } = await this.send("Page.captureScreenshot", params);
    return Buffer.from(data, "base64");
  }

  async close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {{ webSocketDebuggerUrl: string, url?: string }} target
 */
export async function connectCdpTargetPage(target) {
  const session = new CdpSession(target.webSocketDebuggerUrl);
  await session.connect();
  await session.send("Network.enable");

  /** @type {Map<string, string>} */
  const requestUrls = new Map();
  /** @type {Set<Function>} */
  const responseHandlers = new Set();
  /** @type {Set<Function>} */
  const requestHandlers = new Set();
  let currentUrl = target.url || "";
  /** @type {object|null} */
  let relayPageRef = null;

  session.on("Network.requestWillBeSent", (params) => {
    const url = params.request?.url || "";
    if (params.request?.url) requestUrls.set(params.requestId, url);
    const post = params.request?.postData || "";
    if (relayPageRef && url.includes("/api/graphql") && post.includes("lsd=")) {
      void import("../tools/influencer-functions/instagram/instagram-direct-fetch.js").then(
        ({ setIgRelayTemplate }) => setIgRelayTemplate(relayPageRef, post)
      );
    }
    if (requestHandlers.size) {
      const adapter = {
        url: () => url,
        method: () => params.request?.method || "GET",
      };
      for (const handler of [...requestHandlers]) {
        try {
          handler(adapter);
        } catch {
          /* ignore */
        }
      }
    }
  });

  session.on("Network.loadingFinished", (params) => {
    if (!responseHandlers.size) return;
    const url = requestUrls.get(params.requestId) || "";
    void (async () => {
      let text = "";
      try {
        const body = await session.send("Network.getResponseBody", {
          requestId: params.requestId,
        });
        text = body.base64Encoded
          ? Buffer.from(body.body, "base64").toString("utf8")
          : body.body;
      } catch {
        return;
      }
      const adapter = {
        url: () => url,
        text: async () => text,
      };
      for (const handler of [...responseHandlers]) {
        try {
          await handler(adapter);
        } catch {
          /* ignore */
        }
      }
    })();
  });

  const emptyLocator = {
    count: async () => 0,
    isVisible: async () => false,
    click: async () => {},
  };

  const page = {
    /** @type {'cdp'} */
    mode: "cdp",
    _igRelaySessionKey: process.env.CDP_ENDPOINT || "http://127.0.0.1:9222",
    url: () => currentUrl,
    evaluate: (fn, arg) => session.evaluate(fn, arg),
    waitForTimeout: (ms) => new Promise((r) => setTimeout(r, ms)),
    isClosed: () => false,
    bringToFront: async () => {},
    getByRole: () => ({ first: () => emptyLocator }),
    getByText: () => ({ first: () => emptyLocator }),
    goto: async (url, opts = {}) => {
      await session.send("Page.navigate", { url });
      currentUrl = url;
      const waitMs = opts.waitUntil === "commit" ? 2000 : 3500;
      await new Promise((r) => setTimeout(r, waitMs));
      try {
        const href = await session.evaluate(() => location.href);
        if (href) currentUrl = href;
      } catch {
        /* ignore */
      }
    },
    reload: async (opts = {}) => {
      await session.send("Page.reload", { ignoreCache: !!opts.ignoreCache });
      await new Promise((r) => setTimeout(r, opts.ignoreCache ? 3500 : 2500));
      try {
        const href = await session.evaluate(() => location.href);
        if (href) currentUrl = href;
      } catch {
        /* ignore */
      }
    },
    on(event, handler) {
      if (event === "response") responseHandlers.add(handler);
      if (event === "request") requestHandlers.add(handler);
    },
    off(event, handler) {
      if (event === "response") responseHandlers.delete(handler);
      if (event === "request") requestHandlers.delete(handler);
    },
    watchInstagramApiResponses(handler) {
      const wrapped = async (adapter) => handler(adapter.url(), await adapter.text());
      responseHandlers.add(wrapped);
      return () => responseHandlers.delete(wrapped);
    },
    async getInstagramCookies() {
      const { cookies } = await session.send("Network.getAllCookies");
      const map = {};
      for (const c of cookies || []) {
        if (String(c.domain || "").includes("instagram.com")) {
          map[c.name] = c.value;
        }
      }
      return map;
    },
    async getTiktokCookies() {
      const { cookies } = await session.send("Network.getAllCookies");
      const map = {};
      for (const c of cookies || []) {
        if (String(c.domain || "").includes("tiktok.com")) {
          map[c.name] = c.value;
        }
      }
      return map;
    },
    captureGraphqlResponse: async (opts) => {
      const captured = await session.captureGraphqlResponse(opts);
      if (captured?.requestBody) {
        const { setIgRelayTemplate } = await import(
          "../tools/influencer-functions/instagram/instagram-direct-fetch.js"
        );
        setIgRelayTemplate(page, captured.requestBody);
      }
      return captured;
    },
    captureGraphqlViaScroll: async (opts) => {
      const captured = await session.captureGraphqlViaScroll(opts);
      if (captured?.requestBody) {
        const { setIgRelayTemplate } = await import(
          "../tools/influencer-functions/instagram/instagram-direct-fetch.js"
        );
        setIgRelayTemplate(page, captured.requestBody);
      }
      return captured;
    },
    enableLiteResourceBlocker: async (blockedTypeNames) =>
      session.attachLiteResourceBlocker(blockedTypeNames),
    screenshot: async (opts = {}) => session.captureScreenshot(opts),
    async dispose() {
      relayPageRef = null;
      await session.close();
    },
  };

  relayPageRef = page;

  return page;
}

/**
 * @param {string} [cdpEndpoint]
 * @param {{ forceNew?: boolean }} [options]
 */
export async function acquireInstagramCdpPage(cdpEndpoint, options = {}) {
  const endpoint = cdpEndpoint || process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
  let target = null;
  if (!options.forceNew) {
    target = await pickInstagramCdpTarget(endpoint);
  }
  if (target && !(await verifyCdpTargetHealthy(target))) {
    target = null;
  }
  if (!target) {
    target = await openCdpTab(endpoint, "https://www.instagram.com/");
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const list = await listCdpPageTargets(endpoint);
      const t = list.find((x) => x.id === target.id) || list.find((x) => String(x.url).includes("instagram.com"));
      if (t && (await verifyCdpTargetHealthy(t))) {
        target = t;
        break;
      }
    }
  }
  let healthy = target ? await verifyCdpTargetHealthy(target) : false;
  if (!healthy) {
    for (let attempt = 0; attempt < 2; attempt++) {
      target = await openCdpTab(endpoint, "https://www.instagram.com/");
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        if (await verifyCdpTargetHealthy(target)) {
          healthy = true;
          break;
        }
      }
      if (healthy) break;
    }
  }
  if (!healthy) {
    throw new Error(
      "9222 Chrome 的 Instagram 标签实际为 chrome-error（连接被关闭），请确认代理/VPN 已开启并在浏览器中手动打开 instagram.com"
    );
  }
  const page = await connectCdpTargetPage(target);
  try {
    const { getIgRelayTemplate, setIgRelayTemplate } = await import(
      "../tools/influencer-functions/instagram/instagram-direct-fetch.js"
    );
    const cached = getIgRelayTemplate(page);
    if (cached) setIgRelayTemplate(page, cached);
  } catch {
    /* ignore */
  }
  return { page, target, created: false };
}

/**
 * @param {string} [cdpEndpoint]
 * @param {{ forceNew?: boolean }} [options]
 */
export async function acquireTiktokCdpPage(cdpEndpoint, options = {}) {
  const endpoint = cdpEndpoint || process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
  let target = null;
  if (!options.forceNew) {
    target = await pickTiktokCdpTarget(endpoint);
  }
  if (target && !(await verifyTiktokCdpTargetHealthy(target))) {
    target = null;
  }
  if (!target) {
    target = await openCdpTab(endpoint, "https://www.tiktok.com/");
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const list = await listCdpPageTargets(endpoint);
      const t =
        list.find((x) => x.id === target.id) ||
        list.find((x) => String(x.url).includes("tiktok.com"));
      if (t && (await verifyTiktokCdpTargetHealthy(t))) {
        target = t;
        break;
      }
    }
  }
  let healthy = target ? await verifyTiktokCdpTargetHealthy(target) : false;
  if (!healthy) {
    for (let attempt = 0; attempt < 2; attempt++) {
      target = await openCdpTab(endpoint, "https://www.tiktok.com/");
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        if (await verifyTiktokCdpTargetHealthy(target)) {
          healthy = true;
          break;
        }
      }
      if (healthy) break;
    }
  }
  if (!healthy) {
    throw new Error(
      "Chrome 的 TikTok 标签不可用（chrome-error 或未加载），请确认 7897 代理与 tiktok.com 可访问"
    );
  }
  const page = await connectCdpTargetPage(target);
  page._ttApiSessionKey = endpoint;
  return { page, target, created: false };
}
