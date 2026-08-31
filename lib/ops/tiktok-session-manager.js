/**
 * tk-ip 会话管理器（TikTok 专用机）
 *
 * 职责：
 * - 任务边界主动轮换：改写 mihomo 配置中的会话 id（新 sid = 新 IP），重启对应 mihomo；
 * - IP 准入校验：轮换后/任务认领前用综合搜索（general/full）探测当前出口 IP 是否真的能出数据；
 * - 失败升级：当前 IP 探测不过 → 轮换（最多 N 次）→ 仍不行则标记 unhealthy + 冷却。
 *
 * 非 tk-ip 机器（无 _s_<sid>_ttl_ 配置）自动 no-op，不影响其他代理形态。
 *
 * 支持三种形态：
 * - tk-ip：username 含 _s_<sid>_ttl_<n>m，轮换改 sid；
 * - kookeey 提取模式：password 形如 <authpwd>-<geo>-<8位session>，轮换改 8 位 session；
 * - 青果短效代理（按量提取）：username=9OLWSHRE + password=48E7FD1890BB，
 *   轮换 = 调 /get 提取新 server:port -> 改 mihomo 配置 -> 重启 mihomo -> 校验美国出口。
 */
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const CONFIG_DIR = path.join(PROJECT_ROOT, "config");
const MIHOMO_EXE =
  process.env.MIHOMO_EXE || "C:\\Program Files\\Clash Verge\\verge-mihomo.exe";

const PORT_MAP = {
  7897: { config: "crawler-clash.yaml", runtime: "mihomo-runtime" },
  7898: { config: "crawler-clash-enrich-9223.yaml", runtime: "mihomo-enrich-9223" },
  7899: { config: "crawler-clash-enrich-9224.yaml", runtime: "mihomo-enrich-9224" },
  7900: { config: "crawler-clash-enrich-9225.yaml", runtime: "mihomo-enrich-9225" },
};

const TKIP_USER_RE = /_s_\d+_ttl_\d+m/i;
// kookeey 提取模式：password 形如 <authpwd>-<geo>-<8位session>，如 6b1998dcda-US-62220001
const KOOKEEY_PASS_RE = /^[0-9a-f]{8,}-[A-Za-z_]+-\d{8}$/i;
// 青果短效代理（按量提取）：https://www.qg.net/doc/2144.html
const QG_USER = "9OLWSHRE";
const QG_PASS = "48E7FD1890BB";
const QG_GET_URL =
  "https://overseas.proxy.qg.net/get?key=9OLWSHRE&area=US&num=1&keep_alive=60";
const QG_US_EGRESS_TRIES = 8;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(p, ms, label) {
  let t;
  return Promise.race([
    p,
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

function runProcess(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        windowsHide: true,
        maxBuffer: opts.maxBuffer || 4 * 1024 * 1024,
        timeout: opts.timeout || 60000,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `${cmd} failed: ${String(err.message || err)} ${String(stderr || "").slice(0, 200)}`
            )
          );
        } else {
          resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
        }
      }
    );
  });
}

function tcpOk(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

async function waitPort(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tcpOk("127.0.0.1", port, 1200)) return true;
    await sleep(1000);
  }
  return false;
}

export function resolveTkIpProxyPort() {
  const raw = String(
    process.env.HTTPS_PROXY ||
      process.env.HTTP_PROXY ||
      process.env.CLASH_MIXED_PORT ||
      "7897"
  ).trim();
  const m = raw.match(/:(\d+)\s*$/);
  const port = Number(m?.[1] || raw);
  return Number.isFinite(port) ? port : 7897;
}

export function resolveTkIpConfig(proxyPort) {
  const info = PORT_MAP[Number(proxyPort)];
  if (!info) return null;
  const configPath = path.join(CONFIG_DIR, info.config);
  if (!fs.existsSync(configPath)) return null;
  return {
    configPath,
    runtimeDir: path.join(CONFIG_DIR, info.runtime),
    proxyPort: Number(proxyPort),
  };
}

/** 读取 mihomo 配置里的会话；非 tk-ip/kookeey/青果形态返回 null */
export function readTkIpSession(proxyPort) {
  const info = resolveTkIpConfig(proxyPort);
  if (!info) return null;
  try {
    const text = fs.readFileSync(info.configPath, "utf8");
    const m = text.match(/username:\s*(\S+)/);
    const p = text.match(/password:\s*(\S+)/);
    if (!m || !p) return null;
    const username = m[1].trim();
    const password = p[1].trim();
    if (TKIP_USER_RE.test(username)) {
      return { ...info, username, password, provider: "tkip" };
    }
    if (username === QG_USER) {
      return { ...info, username, password, provider: "qg" };
    }
    if (KOOKEEY_PASS_RE.test(password)) {
      return { ...info, username, password, provider: "kookeey" };
    }
    return null;
  } catch {
    return null;
  }
}

function stopMihomoByConfig(configPath) {
  const esc = String(configPath).replace(/'/g, "''");
  const script =
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'verge-mihomo.exe' -and $_.CommandLine -and $_.CommandLine -match [regex]::Escape('" +
    esc +
    "') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  return runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: 30000,
  }).catch(() => {});
}

function startMihomo(configPath, runtimeDir) {
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
  } catch {
    /* ignore */
  }
  const child = spawn(MIHOMO_EXE, ["-f", configPath, "-d", runtimeDir], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

/** 通过本地代理端口拿出口 IP（undici ProxyAgent） */
export async function getProxyIp(proxyPort, { timeoutMs = 12000 } = {}) {
  try {
    const { ProxyAgent } = await import("undici");
    const dispatcher = new ProxyAgent(`http://127.0.0.1:${proxyPort}`);
    const res = await fetch("https://ipinfo.io/json", {
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const j = await res.json();
    return typeof j?.ip === "string" ? j.ip : null;
  } catch {
    return null;
  }
}

/** 通过本地代理端口拿出口 IP + 国家（undici ProxyAgent） */
async function getProxyInfo(proxyPort, { timeoutMs = 12000 } = {}) {
  try {
    const { ProxyAgent } = await import("undici");
    const dispatcher = new ProxyAgent(`http://127.0.0.1:${proxyPort}`);
    const res = await fetch("https://ipinfo.io/json", {
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const j = await res.json();
    return {
      ip: typeof j?.ip === "string" ? j.ip : null,
      country: String(j?.country || "").toUpperCase(),
      org: String(j?.org || "").slice(0, 60),
    };
  } catch {
    return null;
  }
}

/** 调青果 /get 提取一个短效代理（按量提取，area=US） */
async function extractQgProxy() {
  const res = await fetch(QG_GET_URL, { signal: AbortSignal.timeout(20000) });
  const obj = await res.json();
  const d = obj?.data?.[0];
  if (!d?.server) {
    throw new Error(`qg extract bad: ${JSON.stringify(obj).slice(0, 200)}`);
  }
  const [host, port] = String(d.server).split(":");
  return {
    host,
    port: Number(port),
    proxyIp: d.proxy_ip,
    area: d.area,
    deadline: d.deadline,
  };
}

/**
 * 轮换青果短效代理：提取新 server:port -> 改写 mihomo 配置 -> 重启 mihomo ->
 * 校验出口国家为 US（不合格自动重抽，最多 QG_US_EGRESS_TRIES 次）。
 * 返回 { ok, skipped, sid: "host:port", ip, proxyPort, error? }
 */
export async function rotateQgShortProxy(proxyPort = resolveTkIpProxyPort()) {
  const ses = readTkIpSession(proxyPort);
  if (!ses || ses.provider !== "qg") {
    return { ok: false, skipped: true, proxyPort };
  }
  let lastErr = "";
  for (let i = 0; i < QG_US_EGRESS_TRIES; i++) {
    let pr = null;
    try {
      pr = await extractQgProxy();
    } catch (e) {
      lastErr = `extract:${String(e.message || e).slice(0, 100)}`;
      console.log(`[tkip-session] qg extract fail #${i + 1}: ${lastErr}`);
      await sleep(2000);
      continue;
    }
    try {
      let text = fs.readFileSync(ses.configPath, "utf8");
      text = text.replace(/^(\s{4}server:\s*)\S+$/m, `$1${pr.host}`);
      text = text.replace(/^(\s{4}port:\s*)\d+$/m, `$1${pr.port}`);
      fs.writeFileSync(ses.configPath, text, "utf8");
    } catch (e) {
      lastErr = `write config: ${String(e.message || e).slice(0, 100)}`;
      continue;
    }
    await stopMihomoByConfig(ses.configPath);
    await sleep(2500);
    startMihomo(ses.configPath, ses.runtimeDir);
    const up = await waitPort(ses.proxyPort, 25000);
    if (!up) {
      lastErr = `port ${ses.proxyPort} not listening`;
      console.log(`[tkip-session] qg rotate #${i + 1} ${lastErr}`);
      continue;
    }
    await sleep(3000);
    let info = await getProxyInfo(ses.proxyPort);
    for (let k = 0; k < 3 && !info?.ip; k++) {
      await sleep(4000);
      info = await getProxyInfo(ses.proxyPort);
    }
    console.log(
      `[tkip-session] qg rotate #${i + 1}/${QG_US_EGRESS_TRIES} server=${pr.host}:${pr.port} ip=${info?.ip || "-"} country=${info?.country || "-"} ${info?.org || ""}`
    );
    if (info?.country === "US") {
      return {
        ok: true,
        skipped: false,
        sid: `${pr.host}:${pr.port}`,
        ip: info.ip,
        proxyPort: ses.proxyPort,
      };
    }
    lastErr = `non-US egress: ${info?.country || "unknown"}`;
  }
  return {
    ok: false,
    skipped: false,
    proxyPort,
    error: lastErr || "no US egress in tries",
  };
}

/**
 * 轮换 tk-ip 会话：改 sid → 重启对应 mihomo → 等端口 → 验证新 IP。
 * 返回 { ok, skipped, sid, ip, proxyPort }
 */
export async function rotateTkIpSession(proxyPort = resolveTkIpProxyPort()) {
  const ses = readTkIpSession(proxyPort);
  if (!ses) return { ok: false, skipped: true, proxyPort };
  if (ses.provider === "qg") {
    return rotateQgShortProxy(proxyPort);
  }
  const newSid = String(Math.floor(10_000_000 + Math.random() * 89_999_999));
  let from, to;
  if (ses.provider === "kookeey") {
    from = ses.password;
    to = ses.password.replace(/-\d{8}$/, `-${newSid}`);
  } else {
    from = ses.username;
    to = ses.username.replace(/_s_\d+_ttl_/i, `_s_${newSid}_ttl_`);
  }
  try {
    const text = fs.readFileSync(ses.configPath, "utf8").replace(from, to);
    fs.writeFileSync(ses.configPath, text, "utf8");
  } catch (e) {
    return { ok: false, error: `write config: ${e.message}`, proxyPort };
  }
  await stopMihomoByConfig(ses.configPath);
  await sleep(2500);
  startMihomo(ses.configPath, ses.runtimeDir);
  const up = await waitPort(ses.proxyPort, 25000);
  if (!up) return { ok: false, error: `port ${ses.proxyPort} not listening`, proxyPort };
  await sleep(3000);
  let ip = await getProxyIp(ses.proxyPort);
  for (let i = 0; i < 3 && !ip; i++) {
    await sleep(5000);
    ip = await getProxyIp(ses.proxyPort);
  }
  return { ok: !!ip, skipped: false, sid: newSid, ip, proxyPort: ses.proxyPort };
}

/**
 * IP 准入校验：在该 CDP 端点的 Chrome 上开新 tab，bootstrap + 综合搜索（count=5），
 * 返回 videos>0 才算合格。结束后关闭 tab，避免堆积。
 */
export async function admissionCheckTikTok(
  cdpEndpoint,
  { keyword = "student", count = 5, timeoutMs = 60000, proxyPort, forceNew = false } = {}
) {
  const { acquireTiktokCdpPage, closeCdpTarget, listCdpPageTargets } = await import(
    "../cdp/cdp-target-page.js"
  );
  const { bootstrapTiktokWebSession } = await import(
    "../tools/influencer-functions/tiktok/tiktok-api-client.js"
  );
  const { fetchSearchGeneralFullAll } = await import(
    "../tools/influencer-functions/tiktok/tiktok-direct-fetch.js"
  );
  const t0 = Date.now();
  let targetId = null;
  const prevCount = process.env.TT_LITE_SEARCH_COUNT;
  if (count) process.env.TT_LITE_SEARCH_COUNT = String(count);
  try {
    // 优先复用现有健康 tiktok tab，避免每次开新 tab 残留；无健康 tab 才新建。
    let existingIds = new Set();
    try {
      const list = await listCdpPageTargets(cdpEndpoint);
      existingIds = new Set(list.map((t) => t.id));
    } catch {
      /* ignore */
    }
    const r = await withTimeout(
      acquireTiktokCdpPage(cdpEndpoint, { forceNew }),
      30000,
      "admission-acquire"
    );
    targetId = r.target?.id || null;
    const page = r.page;
    const created = !existingIds.has(targetId);
    try {
      await withTimeout(bootstrapTiktokWebSession(page), 45000, "admission-bootstrap");
      const batches = await withTimeout(
        fetchSearchGeneralFullAll(page, keyword, { maxPages: 1 }),
        timeoutMs,
        "admission-search"
      );
      const videos = batches.reduce(
        (n, b) => n + (Array.isArray(b?.data) ? b.data.filter((x) => x?.type === 1).length : 0),
        0
      );
      const ip = proxyPort ? await getProxyIp(proxyPort) : null;
      return { ok: videos > 0, videos, ms: Date.now() - t0, ip };
    } finally {
      try {
        await page.dispose();
      } catch {
        /* ignore */
      }
      if (targetId && created) {
        try {
          await closeCdpTarget(cdpEndpoint, targetId);
        } catch {
          /* ignore */
        }
      }
      // 保证 chrome 至少保留 1 个 tab，否则浏览器进程会直接退出（9224/9225 无 guard 拉起）。
      try {
        const left = await listCdpPageTargets(cdpEndpoint);
        if (!left.length) {
          const { openCdpTab } = await import("../cdp/cdp-target-page.js");
          await openCdpTab(cdpEndpoint, "about:blank");
        }
      } catch { /* ignore */ }
    }
  } catch (e) {
    return { ok: false, videos: 0, ms: Date.now() - t0, error: String(e.message || e).slice(0, 160) };
  } finally {
    if (prevCount == null) delete process.env.TT_LITE_SEARCH_COUNT;
    else process.env.TT_LITE_SEARCH_COUNT = prevCount;
  }
}
const states = new Map();

export function getTkIpSessionState(cdpEndpoint) {
  let s = states.get(cdpEndpoint);
  if (!s) {
    s = { healthy: false, ip: null, checkedAt: 0, lastAttemptAt: 0, rotations: 0 };
    states.set(cdpEndpoint, s);
  }
  return s;
}

/**
 * 确保会话健康（任务认领前调用）：
 * 1) 上次校验通过且 <10min → 直接放行；
 * 2) 否则在当前 IP 上跑准入探测，通过即健康；
 * 3) 不通过 → 轮换（最多 maxRotations 次）逐次探测；
 * 4) 全失败 → unhealthy + 冷却（调用方 sleep 后再试）。
 */
export async function ensureTkIpSessionHealthy(
  cdpEndpoint,
  {
    proxyPort = resolveTkIpProxyPort(),
    maxRotations = Number(process.env.TT_TKIP_MAX_ROTATIONS ?? 5),
    cooldownMs = 30000,
    force = false,
  } = {}
) {
  const ses = readTkIpSession(proxyPort);
  if (!ses) return { ok: true, skipped: true, reason: "no-tkip-config" };
  const st = getTkIpSessionState(cdpEndpoint);
  if (!force && st.healthy && Date.now() - st.checkedAt < 10 * 60_000) {
    return { ok: true, state: st, reason: "fresh" };
  }
  if (!force && st.lastAttemptAt && Date.now() - st.lastAttemptAt < cooldownMs) {
    return { ok: st.healthy, state: st, reason: "cooldown" };
  }
  st.lastAttemptAt = Date.now();

  // 当前 IP 先探测（轮换后未验证的情况）；轮换过则直接开新 tab（旧 tab 大概率已挂）
  const cur = await admissionCheckTikTok(cdpEndpoint, { proxyPort, forceNew: !!st.forceFresh });
  console.log(`[tkip-session] current-ip admission ok=${cur.ok} videos=${cur.videos} ms=${cur.ms}${cur.error ? ' err=' + cur.error : ''}`);
  if (cur.ok) {
    st.healthy = true;
    st.ip = cur.ip;
    st.checkedAt = Date.now();
    st.forceFresh = false;
    return { ok: true, state: st, reason: "current-ip-pass", check: cur };
  }

  // 当前 IP 不合格 → 轮换 + 探测，最多 maxRotations 次
  for (let i = 0; i < maxRotations; i++) {
    console.log(`[tkip-session] current-ip 不合格，轮换 #${i + 1}/${maxRotations}`);
    const rot = await rotateTkIpSession(proxyPort);
    if (!rot.ok || rot.skipped) {
      await sleep(5000);
      continue;
    }
    const check = await admissionCheckTikTok(cdpEndpoint, { proxyPort, forceNew: true });
    console.log(`[tkip-session] rotate#${i + 1} ok=${rot.ok} sid=${rot.sid || '-'} ip=${rot.ip || '-'} admission=${check.ok} videos=${check.videos}${check.error ? ' err=' + check.error : ''}`);
    if (check.ok) {
      st.healthy = true;
      st.ip = check.ip || rot.ip;
      st.checkedAt = Date.now();
      st.forceFresh = false;
      st.rotations += i + 1;
      return { ok: true, state: st, reason: "rotated-pass", rotations: i + 1, check };
    }
  }

  st.healthy = false;
  st.checkedAt = Date.now();
  return { ok: false, state: st, reason: "no-clean-ip" };
}

/** 清理端点上的多余 tiktok tab，控制 renderer 数量；chrome-error/非 tiktok 页优先关 */
export async function cleanupTkIpTabs(cdpEndpoint, { keep = 1 } = {}) {
  try {
    const { listCdpPageTargets, closeCdpTarget } = await import("../cdp/cdp-target-page.js");
    const list = await listCdpPageTargets(cdpEndpoint);
    const isWww = (u) => {
      try {
        return new URL(String(u || "")).hostname === "www.tiktok.com";
      } catch {
        return false;
      }
    };
    const tiktok = list.filter((t) => isWww(t.url));
    const junk = list.filter((t) => !isWww(t.url));
    let closed = 0;
    // Never close the last tab: chrome exits when all tabs are gone (9224/9225 have no guard to revive it). Only clean when total > keep.
    let toClose = Math.max(0, list.length - keep);
    for (const t of junk) {
      if (toClose <= 0) break;
      try { await closeCdpTarget(cdpEndpoint, t.id); closed++; } catch { /* ignore */ }
      toClose--;
    }
    // 保留“最新”的 keep 个 www tab（列表顺序≈创建顺序，尾部最新）；
    // 轮换后旧 tab 网络栈可能已断，优先关旧留新。
    for (let i = 0; i < Math.min(toClose, tiktok.length); i++) {
      try { await closeCdpTarget(cdpEndpoint, tiktok[i].id); closed++; } catch { /* ignore */ }
    }
    if (closed > 0) console.log(`[tkip-session] cleanup tabs closed=${closed} endpoint=${cdpEndpoint}`);
    return closed;
  } catch {
    return 0;
  }
}
