#!/usr/bin/env node
import { createRequire } from "module";
import { listCdpPageTargets } from "../lib/cdp/cdp-target-page.js";

const require = createRequire(import.meta.url);
const { ws: WebSocketCtor } = require("playwright-core/lib/utilsBundle");

const CDP = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
const targets = await listCdpPageTargets(CDP);

for (const t of targets) {
  const ws = new WebSocketCtor(t.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  let id = 0;
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      const handler = (data) => {
        const msg = JSON.parse(String(data));
        if (msg.id !== msgId) return;
        ws.off("message", handler);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      };
      ws.on("message", handler);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  await send("Runtime.enable");
  const { result } = await send("Runtime.evaluate", {
    expression: "({href: location.href, title: document.title})",
    returnByValue: true,
  });
  ws.close();
  console.log(JSON.stringify({ cdpUrl: t.url, ...result.value }));
}
