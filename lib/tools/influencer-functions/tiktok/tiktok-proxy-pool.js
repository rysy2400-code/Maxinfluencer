/**
 * TikTok 代理池：失败重试 1 次(2s) → 切换池内节点 → 直到成功。
 * 组读取：mihomo /proxies API（base=9090，enrich=9108/9109/9110）。
 * 状态：每节点失败次数/冷却（模块级 Map，进程内共享）。
 */

const NODE_STATE = new Map(); // key `${control}:${group}:${node}` -> { failStreak, cooldownUntil }

function stateKey(controlUrl, groupName, node) {
  return `${controlUrl}:${groupName}:${node}`;
}

function resolveControlUrl() {
  return String(process.env.TT_LITE_PROXY_CONTROL_URL || "http://127.0.0.1:9090").replace(
    /\/+$/,
    ""
  );
}

function resolveGroupName() {
  return String(process.env.TT_LITE_PROXY_GROUP || "TikTokProxy");
}

/** 读取组当前节点 + 可用节点（alive 且非 Selector/URLTest 组） */
export async function readProxyGroup(controlUrl = resolveControlUrl(), groupName = resolveGroupName()) {
  const res = await fetch(`${controlUrl}/proxies`);
  if (!res.ok) throw new Error(`mihomo proxies status=${res.status}`);
  const json = await res.json();
  const proxies = json?.proxies || {};
  const group = proxies[groupName];
  if (!group) throw new Error(`mihomo group not found: ${groupName} @ ${controlUrl}`);
  const all = Array.isArray(group.all) ? group.all : [];
  const nodes = all.filter((n) => {
    const p = proxies[n];
    return p && p.alive === true && p.type !== "Selector" && p.type !== "URLTest";
  });
  return { now: group.now || group.fixed || null, nodes };
}

function nodeInCooldown(controlUrl, groupName, node) {
  const st = NODE_STATE.get(stateKey(controlUrl, groupName, node));
  return st && st.cooldownUntil > Date.now();
}

/** 标记节点失败：连续 2 次失败进入冷却（默认 5 分钟） */
export function markProxyNodeFailure(controlUrl, groupName, node, reason = "") {
  if (!node) return;
  const key = stateKey(controlUrl, groupName, node);
  const st = NODE_STATE.get(key) || { failStreak: 0, cooldownUntil: 0 };
  st.failStreak += 1;
  const threshold = Math.max(1, Number(process.env.TT_LITE_PROXY_NODE_FAIL_THRESHOLD || 2));
  if (st.failStreak >= threshold) {
    const cooldownMs = Math.max(
      10000,
      Number(process.env.TT_LITE_PROXY_NODE_COOLDOWN_MS || 5 * 60 * 1000)
    );
    st.cooldownUntil = Date.now() + cooldownMs;
    console.warn(
      `[tt-proxy-pool] ${groupName}@${controlUrl} node ${node} cooldown ${cooldownMs}ms (failStreak=${st.failStreak}, reason=${reason})`
    );
  }
  NODE_STATE.set(key, st);
}

export function markProxyNodeSuccess(controlUrl, groupName, node) {
  if (!node) return;
  const key = stateKey(controlUrl, groupName, node);
  if (NODE_STATE.has(key)) {
    NODE_STATE.delete(key);
  }
}

/** 切换组到池内下一个未尝试/未冷却的节点；无可用节点返回 null */
export async function switchProxyGroupNode(controlUrl, groupName, triedNodes = new Set()) {
  const state = await readProxyGroup(controlUrl, groupName);
  if (state.now) triedNodes.add(state.now);
  const candidates = state.nodes.filter(
    (n) => !triedNodes.has(n) && !nodeInCooldown(controlUrl, groupName, n)
  );
  const next = candidates[0] || null;
  if (!next) {
    console.warn(
      `[tt-proxy-pool] ${groupName}@${controlUrl} no node left (tried=${[...triedNodes].join(",")})`
    );
    return null;
  }
  const res = await fetch(
    `${controlUrl}/proxies/${encodeURIComponent(groupName)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: next }),
    }
  );
  if (!res.ok) throw new Error(`switch ${groupName} -> ${next} status=${res.status}`);
  console.log(`[tt-proxy-pool] ${groupName}@${controlUrl} -> ${next}`);
  await new Promise((r) =>
    setTimeout(r, Math.max(500, Number(process.env.TT_LITE_PROXY_SWITCH_WAIT_MS || 1500)))
  );
  return next;
}

/**
 * 带池重试的 fetch：
 *  失败 → 等 retryDelayMs(2s) 重试 1 次 → 再失败切换池内下一节点 → 重试，直到成功或池耗尽。
 * @param {{ fn: () => Promise<T>, page?: object, controlUrl?: string, groupName?: string, label?: string }} opts
 */
export async function fetchWithPoolRetry({
  fn,
  page,
  controlUrl,
  groupName,
  label = "fetch",
  maxNodeSwitches: maxNodeSwitchesOpt,
}) {
  const control = controlUrl || resolveControlUrl();
  const group = groupName || resolveGroupName();
  const retryDelayMs = Math.max(1000, Number(process.env.TT_LITE_POOL_RETRY_DELAY_MS || 2000));
  const maxNodeSwitches = Math.max(
    1,
    Number(maxNodeSwitchesOpt ?? process.env.TT_LITE_POOL_MAX_SWITCHES ?? 5)
  );
  const triedNodes = new Set();
  let currentNode = null;
  try {
    const st = await readProxyGroup(control, group);
    currentNode = st.now;
  } catch (e) {
    console.warn(`[tt-proxy-pool] read group failed ${group}@${control}: ${e.message}`);
  }

  let lastErr = null;
  for (let round = 0; round <= maxNodeSwitches; round += 1) {
    // 每节点最多 2 次尝试（第 1 次 + 隔 2s 重试 1 次）
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const value = await fn();
        if (currentNode) markProxyNodeSuccess(control, group, currentNode);
        return value;
      } catch (e) {
        lastErr = e;
        if (attempt === 1) {
          await new Promise((r) => setTimeout(r, retryDelayMs));
        }
      }
    }
    if (currentNode) markProxyNodeFailure(control, group, currentNode, lastErr?.message || label);
    const next = await switchProxyGroupNode(control, group, triedNodes).catch((e) => {
      console.warn(`[tt-proxy-pool] switch failed: ${e.message}`);
      return null;
    });
    if (!next) break;
    triedNodes.add(next);
    currentNode = next;
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  throw lastErr || new Error(`${label} failed after pool retry`);
}

/** 从 TT_LITE_ENDPOINT_POOL_MAP 解析 cdpPort -> controllerPort */
export function resolveEnrichControllerForCdp(cdpPort) {
  const map = String(process.env.TT_LITE_ENDPOINT_POOL_MAP || "");
  for (const entry of map.split(",")) {
    const parts = entry.trim().split(":");
    if (parts.length >= 3 && parts[0] === String(cdpPort)) {
      return `http://127.0.0.1:${parts[2]}`;
    }
  }
  return null;
}

/** 从页面 key（如 http://127.0.0.1:9223#target）推断 cdp 端口 */
export function resolveCdpPortFromPage(page) {
  const key = String(page?._ttApiSessionKey || page?._ttApiEndpoint || "");
  const m = key.match(/:(\d+)/);
  return m ? m[1] : null;
}
