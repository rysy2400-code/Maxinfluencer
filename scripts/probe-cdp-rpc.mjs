#!/usr/bin/env node

const endpoint = String(process.argv[2] || "http://127.0.0.1:9222").replace(/\/$/, "");
const timeoutMs = Math.max(1000, Number(process.argv[3] || 8000));

async function probe() {
  if (typeof WebSocket !== "function") {
    // Node <22 无全局 WebSocket：退化为 HTTP /json/version 健康检查，避免 guard 误判 RPC 故障而循环重启 Chrome。
    console.log("[cdp-rpc-probe] skip: WebSocket API unavailable (Node <22), using HTTP health check only");
    const response = await fetch(`${endpoint}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
    const version = await response.json();
    if (!version?.webSocketDebuggerUrl) throw new Error("CDP websocket URL missing");
    return;
  }
  const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
  const version = await response.json();
  if (!version?.webSocketDebuggerUrl) throw new Error("CDP websocket URL missing");

  await new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    const timer = setTimeout(() => finish(new Error("CDP Browser.getVersion timeout")), timeoutMs);
    function finish(error = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      if (error) reject(error);
      else resolve();
    }
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
    });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data || ""));
        if (message?.id === 1 && message?.result?.product) finish();
      } catch {}
    });
    socket.addEventListener("error", () => finish(new Error("CDP websocket error")));
    socket.addEventListener("close", () => finish(new Error("CDP websocket closed")));
  });
}

probe()
  .then(() => {
    console.log("[cdp-rpc-probe] ok");
    process.exit(0);
  })
  .catch((error) => {
    console.error(`[cdp-rpc-probe] failed: ${error?.message || error}`);
    process.exit(1);
  });
