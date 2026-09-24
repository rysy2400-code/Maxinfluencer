/**
 * 在 103 上为两个 mihomo 实例加「静态资源拦截」规则（省流量）。
 *  - 7897 (IG/YT metrics): 在 ensure 脚本里注入规则并重写当前配置
 *  - 7896 (TikTok, ipweb): 追加 TikTok CDN 拦截
 * 只改 rules 段，其余保持不动；改前备份，改后用 mihomo -t 校验。
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const ROOT = "C:\\maxinfluencer";
const MIHOMO = "C:\\Program Files\\Clash Verge\\verge-mihomo.exe";

const BLOCK_RULES = [
  // TikTok
  "  - DOMAIN-KEYWORD,webapp,REJECT",
  "  - DOMAIN-SUFFIX,ttwstatic.com,REJECT",
  "  - DOMAIN-SUFFIX,tiktokcdn.com,REJECT",
  "  - DOMAIN-SUFFIX,tiktokcdn-us.com,REJECT",
  "  - DOMAIN-SUFFIX,tiktokcdn-eu.com,REJECT",
  // Instagram / Facebook
  "  - DOMAIN-SUFFIX,cdninstagram.com,REJECT",
  "  - DOMAIN-SUFFIX,fbcdn.net,REJECT",
  // YouTube
  "  - DOMAIN-SUFFIX,ytimg.com,REJECT",
  "  - DOMAIN-SUFFIX,googlevideo.com,REJECT",
  "  - DOMAIN-SUFFIX,ggpht.com,REJECT",
  // 自家服务直连（避免走代理）
  "  - DOMAIN-SUFFIX,bluemediagroup.cn,DIRECT",
];

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const log = [];

function backup(p) {
  const b = `${p}.bak-${stamp}`;
  fs.copyFileSync(p, b);
  return b;
}

function validate(cfg, dir) {
  const out = execFileSync(MIHOMO, ["-t", "-f", cfg, "-d", dir], { encoding: "utf8" });
  return out;
}

// ---------- 1) 7897 当前配置：插入规则 ----------
const cfg7897 = `${ROOT}\\config\\metrics-us-proxy.yaml`;
if (fs.existsSync(cfg7897)) {
  backup(cfg7897);
  let t = fs.readFileSync(cfg7897, "utf8");
  if (!t.includes("cdninstagram.com")) {
    t = t.replace(/^rules:\s*$/m, `rules:\n${BLOCK_RULES.join("\n")}`);
    fs.writeFileSync(cfg7897, t, "utf8");
    log.push("7897 配置: 已插入 " + BLOCK_RULES.length + " 条规则");
  } else {
    log.push("7897 配置: 已存在规则，跳过");
  }
  try {
    validate(cfg7897, `${ROOT}\\config\\mihomo-metrics-runtime`);
    log.push("7897 配置校验: OK");
  } catch (e) {
    log.push("7897 配置校验失败: " + String(e.stdout || e.message).slice(0, 200));
  }
}

// ---------- 2) ensure 脚本：让规则持久化 ----------
const ensure = `${ROOT}\\scripts\\ensure-metrics-us-proxy.ps1`;
if (fs.existsSync(ensure)) {
  backup(ensure);
  let s = fs.readFileSync(ensure, "utf8");
  if (!s.includes("cdninstagram.com")) {
    const needle = '$raw = $ruleParts[0] + "rules:`n  - MATCH,$groupName`n"';
    const rulesPs = BLOCK_RULES.map((r) => r.trim()).join("`n");
    const repl =
      '$raw = $ruleParts[0] + "rules:`n' + rulesPs + '`n  - MATCH,$groupName`n"';
    if (s.includes(needle)) {
      s = s.replace(needle, repl);
      fs.writeFileSync(ensure, s, "utf8");
      log.push("ensure 脚本: 已注入规则（重新生成配置时保留）");
    } else {
      log.push("ensure 脚本: 未找到目标行，跳过注入（下次重生成配置会丢规则）");
    }
  } else {
    log.push("ensure 脚本: 已存在规则，跳过");
  }
}

// ---------- 3) 7896 ipweb 配置：追加 TikTok CDN 拦截 ----------
const cfg7896 = `${ROOT}\\config\\tiktok-ipweb-7896.yaml`;
if (fs.existsSync(cfg7896)) {
  backup(cfg7896);
  let t = fs.readFileSync(cfg7896, "utf8");
  if (!t.includes("tiktokcdn.com")) {
    t = t.replace(/^  - MATCH,G\s*$/m, `${BLOCK_RULES.filter((r) => /tiktok|ttwstatic|webapp|bluemediagroup/.test(r)).join("\n")}\n  - MATCH,G`);
    fs.writeFileSync(cfg7896, t, "utf8");
    log.push("7896 配置: 已追加 TikTok CDN 拦截");
  } else {
    log.push("7896 配置: 已存在规则，跳过");
  }
  try {
    validate(cfg7896, `${ROOT}\\config\\mihomo-tiktok-7896`);
    log.push("7896 配置校验: OK");
  } catch (e) {
    log.push("7896 配置校验失败: " + String(e.stdout || e.message).slice(0, 200));
  }
}

console.log(log.join("\n"));
