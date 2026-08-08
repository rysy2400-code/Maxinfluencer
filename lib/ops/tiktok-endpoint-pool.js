/**
 * TikTok 端点池健康管理（9222 base + 9223/9224/9225 enrich 共用）。
 *
 * 职责：
 * - 从订阅（CLASH_SUB_URL）拉取 vless/anytls 节点，DNS/TCP 健康筛选；
 * - 重建 base（crawler-clash.yaml）与三个 enrich（crawler-clash-enrich-<port>.yaml）mihomo 配置；
 * - 重启对应 mihomo 实例并验证代理端口；
 * - 任务前预检 / guard 周期自愈共用的端点探测。
 */
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import dns from "node:dns/promises";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
// override：进程环境可能残留空/旧值（如 CLASH_SUB_URL），以机器上的 .env/.env.local 为准
dotenv.config({ path: path.join(PROJECT_ROOT, ".env"), override: true });
dotenv.config({ path: path.join(PROJECT_ROOT, ".env.local"), override: true });
const CONFIG_DIR = path.join(PROJECT_ROOT, "config");
const LOG_DIR = path.join(PROJECT_ROOT, "logs");
const BASE_CONFIG = path.join(CONFIG_DIR, "crawler-clash.yaml");
const ENV_LOCAL = path.join(PROJECT_ROOT, ".env.local");
const MIHOMO_EXE =
  process.env.MIHOMO_EXE || "C:\\Program Files\\Clash Verge\\verge-mihomo.exe";
const SUB_URL = String(process.env.CLASH_SUB_URL || "").trim();
const CURL = process.platform === "win32" ? "curl.exe" : "curl";

export const BASE_PROXY_PORT = (() => {
  const n = Number(process.env.CLASH_MIXED_PORT);
  return Number.isFinite(n) && n > 0 ? n : 7897;
})();

const DEFAULT_POOL = [
  { cdpPort: 9223, proxyPort: 7898, controllerPort: 9108 },
  { cdpPort: 9224, proxyPort: 7899, controllerPort: 9109 },
  { cdpPort: 9225, proxyPort: 7900, controllerPort: 9110 },
];

const BLOCKED_REGION_RE =
  /\b(?:hk|tw|mo|hkg|twn)\b|香港|台湾|澳门|直连|direct/i;

/** 从 TT_LITE_ENDPOINT_POOL_MAP 或默认值解析端点池 */
export function resolveEndpointPool() {
  const raw = String(process.env.TT_LITE_ENDPOINT_POOL_MAP || "").trim();
  if (raw) {
    const items = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((seg) => {
        const parts = seg.split(":");
        return {
          cdpPort: Number(parts[0]),
          proxyPort: Number(parts[1]),
          controllerPort: Number(parts[2]),
          node: parts.slice(3).join(":") || "",
        };
      })
      .filter((i) => Number.isFinite(i.cdpPort) && Number.isFinite(i.proxyPort));
    if (items.length) return items;
  }
  return DEFAULT_POOL;
}

function log(msg) {
  const line = `${new Date().toISOString()} [tiktok-endpoint-pool] ${msg}`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, "endpoint-pool.log"), `${line}\n`, "utf8");
  } catch {
    /* ignore */
  }
  console.log(line);
}

function runProcess(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        windowsHide: true,
        maxBuffer: opts.maxBuffer || 8 * 1024 * 1024,
        timeout: opts.timeout || 120000,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `${cmd} failed: ${String(err.message || err)} ${String(stderr || "").slice(0, 400)}`
            )
          );
        } else {
          resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
        }
      }
    );
  });
}

function decodeFragment(frag) {
  try {
    return decodeURIComponent(String(frag || ""));
  } catch {
    return String(frag || "");
  }
}

function parseVless(uri) {
  const m = String(uri).match(
    /^vless:\/\/([^@]+)@([^:/]+):(\d+)(?:\/?)(\?[^#]*)?(?:#(.*))?$/
  );
  if (!m) return null;
  const [, uuid, server, port, qs, frag] = m;
  const q = new URLSearchParams(qs || "");
  const security = String(q.get("security") || "none");
  return {
    type: "vless",
    name: decodeFragment(frag) || server,
    server,
    port: Number(port),
    uuid,
    network: q.get("type") || "tcp",
    flow: q.get("flow") || "",
    sni: q.get("sni") || "",
    pbk: q.get("pbk") || "",
    sid: q.get("sid") || "",
    fp: q.get("fp") || "chrome",
    insecure: String(q.get("insecure") || "0") === "1",
    tls: security === "reality" || security === "tls",
    reality: security === "reality",
  };
}

function parseAnyTls(uri) {
  const m = String(uri).match(
    /^anytls:\/\/([^@]+)@([^:/]+):(\d+)(?:\/?)(\?[^#]*)?(?:#(.*))?$/
  );
  if (!m) return null;
  const [, password, server, port, qs, frag] = m;
  const q = new URLSearchParams(qs || "");
  return {
    type: "anytls",
    name: decodeFragment(frag) || server,
    server,
    port: Number(port),
    password,
    sni: q.get("sni") || "",
    fp: q.get("fp") || "chrome",
    insecure: String(q.get("insecure") || "0") === "1",
    tls: true,
  };
}

/** 从订阅响应解析节点：支持 clash yaml、base64 URI 列表、明文 URI 列表 */
export async function fetchSubscriptionNodes() {
  if (!SUB_URL) throw new Error("CLASH_SUB_URL is not set");
  const { stdout } = await runProcess(
    CURL,
    ["-sL", "--max-time", "60", SUB_URL],
    { maxBuffer: 12 * 1024 * 1024 }
  );
  const body = String(stdout || "").trim();
  if (!body) throw new Error("empty subscription response");

  let text = body;
  if (!/^(proxies:|mixed-port:)/m.test(body)) {
    try {
      text = Buffer.from(body, "base64").toString("utf8");
    } catch {
      text = body;
    }
  }

  const nodes = [];
  for (const line of String(text).split(/\r?\n/)) {
    const l = line.trim();
    if (l.startsWith("vless://")) {
      const n = parseVless(l);
      if (n) nodes.push(n);
    } else if (l.startsWith("anytls://")) {
      const n = parseAnyTls(l);
      if (n) nodes.push(n);
    }
  }
  if (!nodes.length) throw new Error("no vless/anytls nodes found in subscription");

  const seen = new Set();
  const out = [];
  for (const n of nodes) {
    const key = `${n.type}|${n.server}:${n.port}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(n);
    }
  }
  return out;
}

function regionPriority(node) {
  const s = String(node.server || "").toLowerCase();
  const n = String(node.name || "").toLowerCase();
  if (BLOCKED_REGION_RE.test(`${s} ${n}`)) return -1;
  if (s.startsWith("us") || n.includes("美国")) return 5;
  if (s.startsWith("jp") || n.includes("日本")) return 4;
  if (s.startsWith("sg") || n.includes("新加坡")) return 3;
  if (s.startsWith("kr") || n.includes("韩国")) return 2;
  if (s.startsWith("ca") || n.includes("加拿大")) return 1;
  return 0;
}

function uniqueNodeName(node, used) {
  const prefix = String(node.server || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 4)
    .toUpperCase();
  const base = prefix || "NODE";
  let name = base;
  let i = 1;
  while (used.has(name)) {
    i += 1;
    name = `${base}${i}`;
  }
  used.add(name);
  return name;
}

async function resolveHost(host) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const a = await dns.resolve4(host);
      if (a?.length) return a[0];
    } catch {
      /* try v6 */
    }
    try {
      const a = await dns.resolve6(host);
      if (a?.length) return a[0];
    } catch {
      /* none */
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

function tcpOk(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (!done) {
        done = true;
        sock.destroy();
        resolve(ok);
      }
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    sock.connect(port, host);
  });
}

async function nodeHealthy(node, timeoutMs = 6000) {
  const ip = await resolveHost(node.server);
  if (!ip) return false;
  return tcpOk(ip, node.port, timeoutMs);
}

/** 按地区优先级 + DNS/TCP 健康筛选，返回最多 wanted 个可用节点 */
export async function selectHealthyNodes(nodes, wanted = 3, { timeoutMs = 6000 } = {}) {
  const usable = nodes
    .filter((n) => regionPriority(n) >= 0)
    .sort(
      (a, b) =>
        regionPriority(b) - regionPriority(a) ||
        String(a.server).localeCompare(String(b.server))
    );
  const healthy = [];
  for (const n of usable) {
    if (healthy.length >= wanted) break;
    if (await nodeHealthy(n, timeoutMs)) healthy.push(n);
  }
  return healthy;
}

function renderProxyEntry(node) {
  const lines = [
    `  - name: "${node.name}"`,
    `    type: ${node.type}`,
    `    server: ${node.server}`,
    `    port: ${node.port}`,
  ];
  if (node.type === "vless") {
    lines.push(`    uuid: "${node.uuid}"`);
    lines.push(`    network: ${node.network}`);
    if (node.tls) lines.push(`    tls: true`);
    lines.push(`    udp: true`);
    if (node.flow) lines.push(`    flow: ${node.flow}`);
    if (node.sni) lines.push(`    servername: ${node.sni}`);
    if (node.reality) {
      lines.push(`    reality-opts:`);
      lines.push(`      public-key: "${node.pbk}"`);
      lines.push(`      short-id: "${node.sid}"`);
    }
    lines.push(`    client-fingerprint: ${node.fp}`);
  } else {
    lines.push(`    password: "${node.password}"`);
    // anytls 在 mihomo 中使用 sni 键（vless 才用 servername）
    if (node.sni) lines.push(`    sni: ${node.sni}`);
    lines.push(`    client-fingerprint: ${node.fp}`);
  }
  lines.push(`    skip-cert-verify: ${node.insecure ? "true" : "false"}`);
  return lines.join("\n");
}

export function renderBaseConfig(nodes) {
  const entries = nodes.map((n) => renderProxyEntry(n)).join("\n");
  const groupEntries = nodes.map((n) => `      - "${n.name}"`).join("\n");
  return `# Auto-generated by tiktok-endpoint-pool. TikTok via subscription (non-HK); IG/YT direct.
mixed-port: ${BASE_PROXY_PORT}
allow-lan: false
mode: rule
log-level: warning
ipv6: false
external-controller: 127.0.0.1:9090
unified-delay: true

proxies:
${entries}

proxy-groups:
  - name: TikTokProxy
    type: select
    proxies:
${groupEntries}

rules:
  - DOMAIN-SUFFIX,tiktok.com,TikTokProxy
  - DOMAIN-SUFFIX,tiktokcdn.com,TikTokProxy
  - DOMAIN-SUFFIX,tiktokv.com,TikTokProxy
  - DOMAIN-SUFFIX,byteoversea.com,TikTokProxy
  - DOMAIN-SUFFIX,musical.ly,TikTokProxy
  - DOMAIN-SUFFIX,ibytedtos.com,TikTokProxy
  - DOMAIN-SUFFIX,ibyteimg.com,TikTokProxy
  - DOMAIN-SUFFIX,instagram.com,DIRECT
  - DOMAIN-SUFFIX,cdninstagram.com,DIRECT
  - DOMAIN-KEYWORD,instagram,DIRECT
  - DOMAIN-SUFFIX,youtube.com,DIRECT
  - DOMAIN-SUFFIX,googlevideo.com,DIRECT
  - DOMAIN-SUFFIX,ytimg.com,DIRECT
  - DOMAIN-SUFFIX,google.com,DIRECT
  - DOMAIN-SUFFIX,gstatic.com,DIRECT
  - MATCH,DIRECT
`;
}

export function renderEnrichConfig(baseYaml, proxyPort, controllerPort, nodeName) {
  return baseYaml
    .replace(/^mixed-port: \d+$/m, `mixed-port: ${proxyPort}`)
    .replace(
      /^external-controller: .+$/m,
      `external-controller: 127.0.0.1:${controllerPort}`
    )
    .replace(/^rules:[\s\S]*$/m, `rules:\n  - MATCH,${nodeName}`);
}

function enrichConfigPath(p) {
  return path.join(CONFIG_DIR, `crawler-clash-enrich-${p.cdpPort}.yaml`);
}

function setEnvLine(file, key, value) {
  const lines = fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").split(/\r?\n/)
    : [];
  const re = new RegExp(
    "^\\s*" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*="
  );
  const out = [];
  let found = false;
  for (const line of lines) {
    if (re.test(line)) {
      out.push(`${key}=${value}`);
      found = true;
    } else {
      out.push(line);
    }
  }
  if (!found) out.push(`${key}=${value}`);
  fs.writeFileSync(file, out.join("\n"), "utf8");
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
  fs.mkdirSync(runtimeDir, { recursive: true });
  const child = spawn(MIHOMO_EXE, ["-f", configPath, "-d", runtimeDir], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

export async function waitPort(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tcpOk("127.0.0.1", port, 1500)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function validateConfig(configPath, runtimeDir) {
  try {
    await runProcess(
      MIHOMO_EXE,
      ["-t", "-f", configPath, "-d", runtimeDir],
      { timeout: 30000 }
    );
    return true;
  } catch (e) {
    log(`config validation failed ${configPath}: ${e.message}`);
    return false;
  }
}

/** 通过端点本地代理端口探测 TikTok 可达性（curl 直连代理） */
export async function probeProxyPort(port, { timeoutMs = 25000 } = {}) {
  const t0 = Date.now();
  try {
    const { stdout } = await runProcess(
      CURL,
      [
        "-s",
        "-o",
        "NUL",
        "-w",
        "%{http_code}",
        "-x",
        `http://127.0.0.1:${port}`,
        "--max-time",
        String(Math.max(5, Math.floor(timeoutMs / 1000))),
        "https://www.tiktok.com/",
      ],
      { timeout: timeoutMs + 5000 }
    );
    const code = String(stdout || "").trim();
    return { ok: code === "200", status: code, ms: Date.now() - t0, port };
  } catch (e) {
    return { ok: false, status: null, ms: Date.now() - t0, port, error: e.message };
  }
}

/**
 * 重建端点池：拉订阅 → 健康筛选 → 写 base + enrich 配置 → 校验 → 重启 mihomo → 等待端口 → 探测。
 */
export async function rebuildTiktokEndpointPool({ wanted = 3, verify = true } = {}) {
  const pool = resolveEndpointPool();
  const nodes = await fetchSubscriptionNodes();
  const healthy = await selectHealthyNodes(nodes, Math.max(wanted, 6));
  if (!healthy.length) throw new Error("no healthy nodes from subscription");

  const used = new Set();
  for (const n of healthy) n.name = uniqueNodeName(n, used);
  const pinned = healthy.slice(0, wanted);

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backups = [];
  for (const f of [BASE_CONFIG, ...pool.map(enrichConfigPath)]) {
    const bak = `${f}.bak-${ts}`;
    if (fs.existsSync(f)) fs.copyFileSync(f, bak);
    backups.push({ src: f, bak });
  }

  const baseYaml = renderBaseConfig(healthy);
  fs.writeFileSync(BASE_CONFIG, baseYaml, "utf8");

  const enrichFiles = [];
  for (let i = 0; i < pool.length; i += 1) {
    const p = pool[i];
    const node = pinned[i] || pinned[pinned.length - 1];
    const cfg = renderEnrichConfig(baseYaml, p.proxyPort, p.controllerPort, node.name);
    const cf = enrichConfigPath(p);
    fs.writeFileSync(cf, cfg, "utf8");
    enrichFiles.push({ ...p, config: cf, node: node.name });
  }

  const map = pool
    .map((p, i) => `${p.cdpPort}:${p.proxyPort}:${p.controllerPort}:${(pinned[i] || pinned[pinned.length - 1]).name}`)
    .join(",");
  setEnvLine(ENV_LOCAL, "TT_LITE_ENDPOINT_POOL_MAP", map);
  const allNames = healthy.map((n) => n.name).join(",");
  setEnvLine(ENV_LOCAL, "TT_LITE_PROXY_NODE_ALLOWLIST", allNames);
  setEnvLine(ENV_LOCAL, "TT_LITE_PROXY_NODE_PRIORITY", allNames);

  const baseRuntime = path.join(CONFIG_DIR, "mihomo-runtime");
  if (!(await validateConfig(BASE_CONFIG, baseRuntime))) {
    throw new Error("base config validation failed; abort rebuild");
  }
  for (const f of enrichFiles) {
    const rt = path.join(CONFIG_DIR, `mihomo-enrich-${f.cdpPort}`);
    if (!(await validateConfig(f.config, rt))) {
      throw new Error(`enrich config validation failed ${f.config}; abort rebuild`);
    }
  }

  await stopMihomoByConfig(BASE_CONFIG);
  startMihomo(BASE_CONFIG, baseRuntime);
  for (const f of enrichFiles) {
    await stopMihomoByConfig(f.config);
    startMihomo(f.config, path.join(CONFIG_DIR, `mihomo-enrich-${f.cdpPort}`));
  }

  const ports = [BASE_PROXY_PORT, ...pool.map((p) => p.proxyPort)];
  const waitResults = {};
  for (const port of ports) waitResults[port] = await waitPort(port, 30000);

  // 校验：所有代理端口必须真实可访问 TikTok（HTTP 200），否则回滚到重建前配置。
  const probeResults = {};
  for (const port of ports) {
    probeResults[port] = await probeProxyPort(port);
  }
  const allOk = Object.values(waitResults).every(Boolean) &&
    Object.values(probeResults).every((r) => r.ok);
  if (!allOk) {
    log(
      `rebuild VERIFY FAILED wait=${JSON.stringify(waitResults)} probe=${JSON.stringify(probeResults)}; rolling back`
    );
    for (const b of backups) {
      if (fs.existsSync(b.bak)) fs.copyFileSync(b.bak, b.src);
    }
    await stopMihomoByConfig(BASE_CONFIG);
    startMihomo(BASE_CONFIG, path.join(CONFIG_DIR, "mihomo-runtime"));
    for (const f of enrichFiles) {
      await stopMihomoByConfig(f.config);
      startMihomo(f.config, path.join(CONFIG_DIR, `mihomo-enrich-${f.cdpPort}`));
    }
    for (const port of ports) await waitPort(port, 30000);
    return {
      rolledBack: true,
      error: "rebuild verification failed; restored previous configs",
      waitResults,
      probeResults,
    };
  }

  let details = null;
  if (verify) {
    details = { base: probeResults[BASE_PROXY_PORT], endpoints: [] };
    for (const f of enrichFiles) {
      details.endpoints.push({
        cdpPort: f.cdpPort,
        proxyPort: f.proxyPort,
        node: f.node,
        ...probeResults[f.proxyPort],
      });
    }
  }

  log(
    `rebuild done nodes=${healthy.map((n) => `${n.server}:${n.port}`).join(",")} ` +
      `pinned=${pinned.map((n) => n.name).join(",")} wait=${JSON.stringify(waitResults)}`
  );
  return {
    healthy: healthy.map((n) => ({ name: n.name, server: n.server, port: n.port })),
    pinned: pinned.map((n) => n.name),
    waitResults,
    probeResults,
    details,
    map,
  };
}

let lastPreflightRebuildAt = 0;
const preflightFailCounts = new Map();

/**
 * 任务前预检：探测 base + 全部 enrich 端点；有失败则触发重建（带冷却），再复测。
 */
export async function preflightTikTokEndpoints({
  timeoutMs = 25000,
  rebuildCooldownMs = 300000,
} = {}) {
  const pool = resolveEndpointPool();
  const ports = [BASE_PROXY_PORT, ...pool.map((p) => p.proxyPort)];
  const results = {};
  let anyFail = false;
  for (const port of ports) {
    results[port] = await probeProxyPort(port, { timeoutMs });
    if (!results[port].ok) anyFail = true;
  }

  // 滞回：同一端口连续 2 次预检失败才触发重建，避免单次抖动误重建。
  let needRebuild = false;
  for (const port of ports) {
    if (results[port].ok) {
      preflightFailCounts.delete(port);
    } else {
      const count = (preflightFailCounts.get(port) || 0) + 1;
      preflightFailCounts.set(port, count);
      if (count >= 2) needRebuild = true;
    }
  }

  if (needRebuild && Date.now() - lastPreflightRebuildAt > rebuildCooldownMs) {
    lastPreflightRebuildAt = Date.now();
    log(
      `preflight unhealthy streak: ${JSON.stringify(
        Object.fromEntries(preflightFailCounts)
      )}; rebuilding pool`
    );
    try {
      const rb = await rebuildTiktokEndpointPool({ verify: false });
      if (rb.rolledBack) {
        log(`preflight rebuild rolled back: ${rb.error}`);
      }
    } catch (e) {
      log(`preflight rebuild failed: ${e.message}`);
    }
    preflightFailCounts.clear();
    for (const port of ports) {
      results[port] = await probeProxyPort(port, { timeoutMs });
    }
  }

  const ok = Object.values(results).every((r) => r.ok);
  log(`preflight ok=${ok} results=${JSON.stringify(results)}`);
  return { ok, results };
}
