/**
 * 9222 Chrome 重启信号：worker 写 flag，guard-chrome-9222.ps1 统一杀进程并拉起。
 */
import fs from "fs";
import path from "path";
import { execFile } from "node:child_process";

const DEFAULT_WIN_SIGNAL =
  process.platform === "win32" ? "C:\\maxinfluencer\\signals\\restart-chrome-9222.flag" : null;

export function cdp9222EndpointForHealth() {
  const raw =
    process.env.CDP_ENDPOINT ||
    process.env.CRAWLER_CDP_SEARCH_ENDPOINT ||
    process.env.CDP_ENDPOINT_ENRICH ||
    "http://127.0.0.1:9222";
  return String(raw).replace(/\/$/, "");
}

export function restartChrome9222SignalPath() {
  const fromEnv = String(process.env.CDP_RESTART_SIGNAL_FILE || "").trim();
  if (fromEnv) return fromEnv;
  if (DEFAULT_WIN_SIGNAL) return DEFAULT_WIN_SIGNAL;
  return path.join("/tmp", "restart-chrome-9222.flag");
}

function restartDebounceMs() {
  const n = Number(process.env.CDP_RESTART_DEBOUNCE_MS);
  return Number.isFinite(n) && n >= 0 ? n : 180_000;
}

function debounceStatePath(signalPath) {
  return signalPath.replace(/\.flag$/i, ".debounce") || `${signalPath}.debounce`;
}

function readDebounceTimestamp(statePath) {
  try {
    if (!fs.existsSync(statePath)) return null;
    const line = fs.readFileSync(statePath, "utf8").trim().split(/\s+/)[0];
    const ts = Number(line);
    return Number.isFinite(ts) ? ts : null;
  } catch {
    return null;
  }
}

function writeDebounceTimestamp(statePath, reason) {
  try {
    fs.writeFileSync(
      statePath,
      `${Date.now()} ${String(reason || "cdp_connect_failed").slice(0, 200)}\n`,
      "utf8"
    );
  } catch {
    /* ignore */
  }
}

function ensureSignalDir(filePath) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {
    /* ignore */
  }
}

/**
 * @param {string} reason
 * @returns {Promise<boolean>} 是否已写入信号（false = 防抖跳过）
 */
export async function requestChrome9222Restart(reason = "cdp_connect_failed") {
  const signalPath = restartChrome9222SignalPath();
  const debouncePath = debounceStatePath(signalPath);
  ensureSignalDir(signalPath);

  const debounceMs = restartDebounceMs();
  const lastTs = readDebounceTimestamp(debouncePath);
  if (lastTs != null && Date.now() - lastTs < debounceMs) {
    console.warn(
      `[cdp-restart] skip signal (debounce ${debounceMs}ms): ${reason}`
    );
    return false;
  }

  const line = `${Date.now()} ${String(reason || "cdp_connect_failed").slice(0, 200)}\n`;
  try {
    fs.writeFileSync(signalPath, line, "utf8");
    writeDebounceTimestamp(debouncePath, reason);
    console.warn(`[cdp-restart] wrote restart signal: ${signalPath} reason=${reason}`);
    // Linux 没有 guard 进程监听 flag：直接杀掉对应端口的 Chrome，
    // systemd Restart=always 会自动重新拉起，CDP 随即恢复。
    if (process.platform !== "win32") {
      const endpoint = cdp9222EndpointForHealth();
      const portMatch = String(endpoint).match(/:(\d+)$/);
      const port = portMatch ? portMatch[1] : "9222";
      execFile("pkill", ["-f", `remote-debugging-port=${port}`], () => {});
      console.warn(`[cdp-restart] linux: killed chrome on port ${port} (systemd will relaunch)`);
    }
    return true;
  } catch (e) {
    console.warn(`[cdp-restart] failed to write signal: ${e?.message || e}`);
    return false;
  }
}

/**
 * @param {number} [maxWaitMs]
 */
export async function waitForCdp9222Ready(maxWaitMs = 30_000) {
  const endpoint = cdp9222EndpointForHealth();
  const url = `${endpoint}/json/version`;
  const deadline = Date.now() + maxWaitMs;
  let lastErr = null;

  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) return true;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.warn(
    `[cdp-restart] waitForCdp9222Ready timeout after ${maxWaitMs}ms: ${lastErr?.message || lastErr}`
  );
  return false;
}

/**
 * @param {import('playwright').Browser|null|undefined} browser
 */
export async function disconnectCdpBrowser(browser) {
  if (!browser) return;
  try {
    if (typeof browser.disconnect === "function") {
      await browser.disconnect();
    } else {
      await browser.close();
    }
  } catch {
    /* ignore */
  }
}
