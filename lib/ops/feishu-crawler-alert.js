import crypto from "node:crypto";

function feishuSignature(timestamp, secret) {
  const stringToSign = `${timestamp}\n${secret}`;
  return crypto.createHmac("sha256", stringToSign).update("").digest("base64");
}

function metricLine(window) {
  const rate = window.effectiveSuccessRate == null
    ? "-"
    : `${Math.round(window.effectiveSuccessRate * 100)}%`;
  return `有效成功 ${window.effectiveSucceeded}/${window.completed}，失败 ${window.failed}，无效成功 ${window.invalidSucceeded}，成功率 ${rate}`;
}

export async function sendCrawlerFeishuAlert({ title, level, machine, message, recovery = false }) {
  const webhook = String(process.env.FEISHU_CRAWLER_ALERT_WEBHOOK || "").trim();
  const secret = String(process.env.FEISHU_CRAWLER_ALERT_SECRET || "").trim();
  if (!webhook || !secret) return { sent: false, skipped: "not_configured" };
  if (!/^https:\/\//i.test(webhook)) throw new Error("FEISHU_CRAWLER_ALERT_WEBHOOK 必须是 HTTPS URL");
  const webhookUrl = new URL(webhook);
  if (webhookUrl.hostname !== "open.feishu.cn" || !webhookUrl.pathname.startsWith("/open-apis/bot/v2/hook/")) {
    throw new Error("FEISHU_CRAWLER_ALERT_WEBHOOK 不是飞书群机器人地址");
  }
  const timestamp = String(Math.floor(Date.now() / 1000));
  const opsBase = String(process.env.CRAWLER_OPS_BASE_URL || process.env.APP_BASE_URL || "").replace(/\/$/, "");
  const color = recovery ? "green" : level === "fault" ? "red" : "orange";
  const fields = machine
    ? [
        `**机器**：${machine.displayName || machine.ip}`,
        `**平台**：${machine.platform}`,
        `**近10分钟**：${metricLine(machine.operational.tenMinutes)}`,
        `**近1小时**：${metricLine(machine.operational.oneHour)}`,
        `**最后成功**：${machine.operational.lastSuccessAt || "无"}`,
      ]
    : [];
  const body = {
    timestamp,
    sign: feishuSignature(timestamp, secret),
    msg_type: "interactive",
    card: {
      header: { template: color, title: { tag: "plain_text", content: title } },
      elements: [
        { tag: "div", text: { tag: "lark_md", content: [...fields, message].filter(Boolean).join("\n") } },
        ...(opsBase
          ? [{ tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "打开运维台" }, url: `${opsBase}/ops`, type: "primary" }] }]
          : []),
      ],
    },
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || Number(result.code || result.StatusCode || 0) !== 0) {
      throw new Error(`飞书告警发送失败: HTTP ${response.status} ${JSON.stringify(result).slice(0, 300)}`);
    }
    return { sent: true };
  } finally {
    clearTimeout(timer);
  }
}

export function crawlerAlertFingerprint(parts) {
  return crypto.createHash("sha256").update(parts.filter(Boolean).join("|")).digest("hex").slice(0, 32);
}
