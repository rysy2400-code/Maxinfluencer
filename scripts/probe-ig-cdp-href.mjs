#!/usr/bin/env node
import { listCdpPageTargets } from "../lib/cdp/cdp-target-page.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { ws: WebSocketCtor } = require("playwright-core/lib/utilsBundle");

class S {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.ws = null;
  }
  async connect() {
    this.ws = new WebSocketCtor(this.wsUrl);
    await new Promise((r, j) => {
      this.ws.once("open", r);
      this.ws.once("error", j);
    });
    this.ws.on("message", (data) => {
      const m = JSON.parse(String(data));
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message || JSON.stringify(m.error)));
        else p.resolve(m.result);
      }
    });
    await this.send("Runtime.enable");
    await this.send("Page.enable");
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
    });
    if (exceptionDetails) {
      throw new Error(
        exceptionDetails.exception?.description || exceptionDetails.text || JSON.stringify(exceptionDetails)
      );
    }
    return result?.value;
  }
  close() {
    this.ws?.close();
  }
}

const tabs = await listCdpPageTargets("http://127.0.0.1:9222");
const t = tabs.find((x) => String(x.url || "").includes("instagram.com"));
if (!t) {
  console.log(JSON.stringify({ error: "NO_TAB" }));
  process.exit(1);
}

const s = new S(t.webSocketDebuggerUrl);
try {
  await s.connect();
  const href = await s.eval("location.href");
  const title = await s.eval("document.title");
  const body = await s.eval("(document.body && document.body.innerText) ? document.body.innerText.slice(0,300) : ''");
  console.log(JSON.stringify({ tabUrl: t.url, href, title, body }, null, 2));
} catch (e) {
  console.log(JSON.stringify({ tabUrl: t.url, error: e.message }));
} finally {
  s.close();
}
