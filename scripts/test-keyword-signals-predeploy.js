/**
 * 部署前检查：关键词信号池 + worker consume 路径。
 * 用法: node scripts/test-keyword-signals-predeploy.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

function runNodeScript(relPath) {
  const r = spawnSync("node", [path.join(projectRoot, relPath)], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (r.status !== 0) {
    throw new Error(`${relPath} failed:\n${r.stdout}\n${r.stderr}`);
  }
  return r.stdout.trim();
}

// 1) 离线单元测试
const unitScripts = [
  "scripts/test-extract-keyword-signals.js",
  "scripts/test-keyword-signals-match.js",
  "scripts/test-keyword-signals-flow.js",
];
for (const s of unitScripts) {
  const out = runNodeScript(s);
  console.log(out.split("\n").pop());
}

// 2) DB 集成（30s 超时，失败不阻断静态检查）
try {
  const r = spawnSync("node", [path.join(projectRoot, "scripts/test-keyword-signals-db.js")], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 30000,
  });
  if (r.status === 0) {
    console.log(String(r.stdout).trim().split("\n").pop());
  } else {
    console.warn("⚠️ DB 集成测试失败:", String(r.stderr || r.stdout).split("\n")[0]);
  }
} catch (e) {
  console.warn("⚠️ DB 集成测试跳过:", e.message.split("\n")[0]);
}

// 3) worker 源码：throw / succeeded / failed / empty 路径均含 consume
const workerSrc = fs.readFileSync(
  path.join(projectRoot, "scripts/worker-influencer-search.js"),
  "utf8"
);

assert(
  workerSrc.includes("searchAndExtractInfluencers throw:") &&
    /catch \(err\)[\s\S]*?await consumeSignalForCompletedTask/.test(workerSrc),
  "worker throw 分支缺少 consumeSignalForCompletedTask"
);

const consumeCalls = (workerSrc.match(/await consumeSignalForCompletedTask/g) || []).length;
assert(consumeCalls >= 4, `worker consume 调用过少: ${consumeCalls}`);

// 4) heartbeat 守卫 A + 批量派单
const hbSrc = fs.readFileSync(
  path.join(projectRoot, "lib/heartbeat/execution-heartbeat.js"),
  "utf8"
);
assert(
  hbSrc.includes("pending/processing") && hbSrc.includes("跳过该平台关键词规划"),
  "heartbeat 队列守卫 A 缺失（应存在平台级 pending/processing 守卫）"
);
assert(
  !hbSrc.includes("plans.slice(0, 1)") || hbSrc.includes("for (const plan of plans)"),
  "heartbeat 可能仍为单 task 派单"
);
assert(hbSrc.includes("getPromptKeywordSignals"), "heartbeat 未接入 signal prompt");

console.log("✅ predeploy checks passed (unit + worker paths + heartbeat)");
