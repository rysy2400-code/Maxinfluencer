/**
 * X-Client-Transaction-Id 生成（X/Twitter 反爬必需头，SearchTimeline/TweetDetail 校验）。
 * 算法移植自 MIT 项目：
 *   - elongator (github.com/FxEmbed/elongator) — FxTwitter 官方代理服务
 *   - x-client-transaction-id (github.com/Lqm1/x-client-transaction-id) — 逆向作者
 *   - twitter-scraper (github.com/the-convocation/twitter-scraper)
 * 用法：从已登录的 x.com 页面 harvest 初始化数据，再按请求生成 header。
 */

import crypto from "node:crypto";

const DEFAULT_KEYWORD = "obfiowerehiring";
const ADDITIONAL_RANDOM_NUMBER = 3;
const EPOCH = 1682924400;

/** 从 ondemand bundle 提取 key byte indices */
const INDICES_REGEX = /\(\w\[(\d{1,2})\],\s*16\)/g;

const ON_DEMAND_SRC_REGEX = /ondemand\.s\.([0-9a-f]+)a\.js/i;
const ON_DEMAND_FILE_REGEX = /,(\d+):["']ondemand\.s["']/;
const ON_DEMAND_HASH_PATTERN = (index) => new RegExp(`,${index}:"([0-9a-f]+)"`);

const bundleCache = new Map();

/** @type {Map<string, string>} 进程内缓存 harvested 的 key/animationKey（按 siteVerification 维度） */
const transactionCache = new Map();

class Cubic {
  constructor(curves) {
    this.curves = curves;
  }

  getValue(time) {
    const curves = this.curves;
    let start = 0;
    let end = 1;
    let mid = 0;
    if (time <= 0) {
      const startGrad =
        curves[0] > 0 ? curves[1] / curves[0] : curves[1] === 0 && curves[2] > 0 ? curves[3] / curves[2] : 0;
      return startGrad * time;
    }
    if (time >= 1) {
      const endGrad =
        curves[2] < 1 ? (curves[3] - 1) / (curves[2] - 1) : curves[2] === 1 && curves[0] < 1 ? (curves[1] - 1) / (curves[0] - 1) : 0;
      return 1 + endGrad * (time - 1);
    }
    while (start < end) {
      mid = (start + end) / 2;
      const xEst = Cubic.calculate(curves[0], curves[2], mid);
      if (Math.abs(time - xEst) < 0.00001) {
        return Cubic.calculate(curves[1], curves[3], mid);
      }
      if (xEst < time) start = mid;
      else end = mid;
    }
    return Cubic.calculate(curves[1], curves[3], mid);
  }

  static calculate(a, b, m) {
    return 3 * a * (1 - m) * (1 - m) * m + 3 * b * (1 - m) * m * m + m * m * m;
  }
}

function interpolate(from, to, f) {
  if (from.length !== to.length) throw new Error("Mismatched interpolation args");
  return from.map((v, i) => v * (1 - f) + to[i] * f);
}

function convertRotationToMatrix(deg) {
  const rad = (deg * Math.PI) / 180;
  return [Math.cos(rad), -Math.sin(rad), Math.sin(rad), Math.cos(rad)];
}

function isOdd(num) {
  return num % 2 ? -1 : 0;
}

function floatToHex(xInput) {
  const result = [];
  let x = xInput;
  let quotient = Math.floor(x);
  const fraction = x - quotient;
  while (quotient > 0) {
    const q = Math.floor(x / 16);
    const rem = Math.floor(x - q * 16);
    if (rem > 9) result.unshift(String.fromCharCode(rem + 55));
    else result.unshift(rem.toString());
    x = q;
    quotient = Math.floor(x);
  }
  if (fraction === 0) return result.join("");
  result.push(".");
  let frac = fraction;
  while (frac > 0) {
    frac *= 16;
    const integer = Math.floor(frac);
    frac -= integer;
    if (integer > 9) result.push(String.fromCharCode(integer + 55));
    else result.push(integer.toString());
  }
  return result.join("");
}

function solve(value, minVal, maxVal, rounding) {
  const res = ((value * (maxVal - minVal)) / 255) + minVal;
  return rounding ? Math.floor(res) : parseFloat(res.toFixed(2));
}

function animate(frames, targetTime) {
  const fromColor = [...frames.slice(0, 3).map((v) => v), 1];
  const toColor = [...frames.slice(3, 6).map((v) => v), 1];
  const toRot = [solve(frames[6], 60, 360, true)];
  const curves = frames.slice(7).map((v, i) => solve(v, isOdd(i), 1, false));
  const cubic = new Cubic(curves);
  const f = cubic.getValue(targetTime);
  const color = interpolate(fromColor, toColor, f).map((v) => Math.max(0, Math.min(255, v)));
  const rot = interpolate([0], toRot, f);
  const matrix = convertRotationToMatrix(rot[0]);
  const hexArr = [];
  color
    .slice(0, -1)
    .forEach((v) => hexArr.push(Math.round(v).toString(16)));
  matrix.forEach((val) => {
    let rv = parseFloat(val.toFixed(2));
    if (rv < 0) rv = -rv;
    const hx = floatToHex(rv);
    if (hx.startsWith(".")) hexArr.push(("0" + hx).toLowerCase());
    else if (hx) hexArr.push(hx.toLowerCase());
    else hexArr.push("0");
  });
  hexArr.push("0", "0");
  return hexArr.join("").replace(/[.-]/g, "");
}

function getAnimationKey({ keyBytes, defaultRowIndex, defaultKeyBytesIndices, animFramePaths }) {
  const total = 4096;
  const rowIndex = keyBytes[defaultRowIndex] % 16;
  let frameTime = defaultKeyBytesIndices
    .map((i) => keyBytes[i] % 16)
    .reduce((a, b) => a * b, 1);
  frameTime = Math.round(frameTime / 10) * 10;
  const idx = keyBytes[5] % 4;
  const d = animFramePaths[idx];
  if (!d) throw new Error("X txid: 页面缺少 loading-x-anim SVG path");
  const grid = d
    .slice(9)
    .split("C")
    .map((item) =>
      item
        .replace(/[^\d]+/g, " ")
        .trim()
        .split(/\s+/)
        .map((n) => parseInt(n, 10))
        .filter((n) => Number.isFinite(n))
    )
    .filter((row) => row.length >= 3);
  const row = grid[rowIndex] || grid[0];
  const t = frameTime / total;
  return animate(row, t);
}

/**
 * 从已登录 x.com 页面 harvest txid 初始化数据（无需 Node 侧请求 x.com）。
 * @param {import('playwright').Page} page
 */
export async function harvestTransactionInitFromPage(page) {
  const data = await page.evaluate(() => {
    const meta = document.querySelector('meta[name="twitter-site-verification"]');
    const siteVerification = meta ? meta.getAttribute("content") || "" : "";
    const scripts = Array.from(document.querySelectorAll("script[src]")).map((s) => s.getAttribute("src") || "");
    const inline = Array.from(document.querySelectorAll("script:not([src])")).map((s) => s.textContent || "");
    const animPaths = Array.from(document.querySelectorAll('[id^="loading-x-anim"]')).map((el) => {
      const g = el.firstElementChild;
      if (!g) return "";
      const path = g.children && g.children[1];
      return path && path.getAttribute ? path.getAttribute("d") || "" : "";
    });
    return { siteVerification, scripts, inline, animPaths };
  });
  if (!data.siteVerification) {
    throw new Error("X txid: 页面未找到 twitter-site-verification（未登录或页面未加载完成）");
  }
  let ondemandHash = null;
  for (const src of data.scripts) {
    const m = src.match(ON_DEMAND_SRC_REGEX);
    if (m) {
      ondemandHash = m[1];
      break;
    }
  }
  if (!ondemandHash) {
    const allText = [...data.scripts, ...data.inline].join("\n");
    const indexMatch = ON_DEMAND_FILE_REGEX.exec(allText);
    if (indexMatch?.[1]) {
      const hashMatch = ON_DEMAND_HASH_PATTERN(indexMatch[1]).exec(allText);
      if (hashMatch?.[1]) ondemandHash = hashMatch[1];
    }
  }
  return {
    siteVerification: data.siteVerification,
    ondemandHash,
    animFramePaths: data.animPaths,
  };
}

async function fetchBundleText(hash) {
  if (bundleCache.has(hash)) return bundleCache.get(hash);
  const url = `https://abs.twimg.com/responsive-web/client-web/ondemand.s.${hash}a.js`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
      },
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`ondemand bundle HTTP ${resp.status}`);
    const text = await resp.text();
    bundleCache.set(hash, text);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 生成 X-Client-Transaction-Id。
 * @param {{ siteVerification: string, ondemandHash: string, animFramePaths: string[] }} init
 */
export function createXClientTransaction(init) {
  const { siteVerification, ondemandHash, animFramePaths } = init;
  const cacheKey = siteVerification;
  const cached = transactionCache.get(cacheKey);
  if (cached) return cached;

  if (!ondemandHash) {
    throw new Error("X txid: 未找到 ondemand bundle hash，无法生成 transaction id");
  }

  const keyBytes = Array.from(Buffer.from(siteVerification, "base64"));
  const indices = [];
  // 异步初始化需要单独入口；这里用同步闭包延迟到 initTransactionState()
  const state = {
    siteVerification,
    keyBytes,
    animFramePaths,
    defaultRowIndex: null,
    defaultKeyBytesIndices: null,
    animationKey: null,
    ondemandHash,
  };
  const tx = {
    state,
    /**
     * 异步完成 bundle 拉取与 indices 解析（幂等，可重入）。
     * @param {boolean} forceRefresh 强制重算（404/feature drift 后调用）
     */
    async ensureReady(forceRefresh = false) {
      if (!forceRefresh && state.animationKey != null) return state;
      const text = await fetchBundleText(state.ondemandHash);
      const localIndices = [];
      let m;
      INDICES_REGEX.lastIndex = 0;
      while ((m = INDICES_REGEX.exec(text)) !== null) {
        localIndices.push(parseInt(m[1], 10));
      }
      if (localIndices.length < 2) {
        throw new Error("X txid: ondemand bundle 中未找到 KEY_BYTE indices");
      }
      state.defaultRowIndex = localIndices[0];
      state.defaultKeyBytesIndices = localIndices.slice(1);
      state.animationKey = getAnimationKey({
        keyBytes: state.keyBytes,
        defaultRowIndex: state.defaultRowIndex,
        defaultKeyBytesIndices: state.defaultKeyBytesIndices,
        animFramePaths: state.animFramePaths,
      });
      transactionCache.set(cacheKey, tx);
      return state;
    },
    generateTransactionId(method, path) {
      if (!state.animationKey) {
        throw new Error("X txid: 尚未 ensureReady()");
      }
      const now = Math.floor(Date.now() / 1000 - EPOCH);
      const timeBytes = [0, 1, 2, 3].map((i) => (now >> (i * 8)) & 0xff);
      const hashInput = `${method}!${path}!${now}${DEFAULT_KEYWORD}${state.animationKey}`;
      const digest = crypto.createHash("sha256").update(hashInput, "utf8").digest();
      const hashBytes = Array.from(digest.subarray(0, 16));
      const rnd = Math.floor(Math.random() * 256);
      const arr = [
        ...state.keyBytes,
        ...timeBytes,
        ...hashBytes.slice(0, 16),
        ADDITIONAL_RANDOM_NUMBER,
      ];
      const xored = arr.map((x) => x ^ rnd);
      const outBytes = Buffer.from([rnd, ...xored]);
      return outBytes.toString("base64").replace(/=+$/, "");
    },
  };
  return tx;
}
