#!/usr/bin/env node
/**
 * 从 Excel 读取 TikTok 红人主页链接，抓取主页&近50视频数据，并回填到 Excel 右侧列。
 *
 * 用法示例：
 *   node scripts/enrich-tiktok-from-xlsx.mjs "/path/to/file.xlsx"
 *   node scripts/enrich-tiktok-from-xlsx.mjs "/path/to/file.xlsx" --sheet "Sheet1" --urlCol "tiktok主页链接" --inplace
 *
 * 说明：
 * - 优先使用 CDP 连接模式（更稳定加载 TikTok）。
 * - 默认连接 9223（与 scripts/launch-chrome-remote-debug-enrich.sh 约定一致）。
 * - 如果 CDP 端口未开启，默认会自动启动一个本地 Chrome 实例（macOS）。
 */
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import net from "net";
import XLSX from "xlsx";
import { chromium } from "playwright";
import { extractUserProfileFromPageCDP } from "../lib/tools/influencer-functions/extract-user-profile-cdp.js";

function parseArgs(argv) {
  const args = {
    input: null,
    output: null,
    inplace: false,
    sheet: null,
    urlCol: null, // header name or 0-based index string
    headerRow: 1, // 1-based
    startRow: 2, // 1-based
    cdpPort: 9223,
    cdpEndpoint: null,
    userDataDir: null,
    launchChrome: true,
    maxRows: null,
    concurrency: 1,
    humanLike: true,
  };

  const rest = argv.slice(2);
  if (!rest.length) return args;

  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = rest[i + 1];
    const takeValue = () => {
      if (next == null || next.startsWith("--")) return null;
      i++;
      return next;
    };

    if (key === "help" || key === "h") {
      args.help = true;
      continue;
    }
    if (key === "inplace") {
      args.inplace = true;
      continue;
    }
    if (key === "no-launch") {
      args.launchChrome = false;
      continue;
    }
    if (key === "sheet") {
      args.sheet = takeValue();
      continue;
    }
    if (key === "urlCol") {
      args.urlCol = takeValue();
      continue;
    }
    if (key === "headerRow") {
      const v = takeValue();
      args.headerRow = v ? Number(v) : args.headerRow;
      continue;
    }
    if (key === "startRow") {
      const v = takeValue();
      args.startRow = v ? Number(v) : args.startRow;
      continue;
    }
    if (key === "out") {
      args.output = takeValue();
      continue;
    }
    if (key === "cdpPort") {
      const v = takeValue();
      args.cdpPort = v ? Number(v) : args.cdpPort;
      continue;
    }
    if (key === "cdpEndpoint") {
      args.cdpEndpoint = takeValue();
      continue;
    }
    if (key === "userDataDir") {
      args.userDataDir = takeValue();
      continue;
    }
    if (key === "maxRows") {
      const v = takeValue();
      args.maxRows = v ? Number(v) : null;
      continue;
    }
    if (key === "concurrency") {
      const v = takeValue();
      args.concurrency = Math.max(1, Number(v || 1) || 1);
      continue;
    }
    if (key === "humanLike") {
      const v = takeValue();
      args.humanLike = String(v || "true") !== "false";
      continue;
    }
  }

  if (positional[0]) args.input = positional[0];
  return args;
}

function printHelp() {
  console.log(`
用法:
  node scripts/enrich-tiktok-from-xlsx.mjs <input.xlsx> [options]

Options:
  --sheet <name>           指定工作表名（默认第一个 sheet）
  --urlCol <name|index>    指定“TikTok 主页链接”列：表头名 或 0-based 列索引
  --headerRow <n>          表头所在行（1-based，默认 1）
  --startRow <n>           数据起始行（1-based，默认 2）
  --inplace                原文件覆盖写回（默认输出到新文件）
  --out <output.xlsx>      指定输出路径（不与 --inplace 同时使用）
  --cdpPort <port>         CDP 端口（默认 9223）
  --cdpEndpoint <url>      CDP 地址（默认 http://127.0.0.1:<cdpPort>）
  --userDataDir <dir>      Chrome user-data-dir（默认 <project>/.tiktok-user-data-enrich）
  --no-launch              若无法连接 CDP，不自动启动 Chrome
  --maxRows <n>            最多处理多少行（从 startRow 开始计数）
  --concurrency <n>         并发数（默认 1，建议 1-2）
  --humanLike <true|false> 是否启用更“拟人”滚动等待（默认 true）
  --help                   显示帮助
`);
}

function toAbs(p) {
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

function guessOutputPath(inputAbs) {
  const dir = path.dirname(inputAbs);
  const ext = path.extname(inputAbs) || ".xlsx";
  const base = path.basename(inputAbs, ext);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return path.join(dir, `${base}-enriched-${stamp}${ext}`);
}

function isTikTokUrl(v) {
  if (v == null) return false;
  const s = String(v).trim();
  return /tiktok\.com/i.test(s) && /\/@/i.test(s);
}

function extractUsernameFromTikTokUrl(url) {
  if (!url) return null;
  const s = String(url).trim();
  const m = s.match(/tiktok\.com\/@([^\/\?\s]+)/i);
  if (!m) return null;
  return m[1].replace(/^@/, "").trim() || null;
}

function formatInt(n) {
  if (n == null || Number.isNaN(Number(n))) return "";
  return String(Math.round(Number(n)));
}

function safeText(v) {
  if (v == null) return "";
  return String(v).replace(/\s+/g, " ").trim();
}

function avg(arr) {
  const nums = arr.filter((x) => Number.isFinite(Number(x))).map((x) => Number(x));
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function makeRecommendation({ followers, avgViews, avgLikes, avgComments, avgFavorites, bio, recentTexts }) {
  const f = Number(followers || 0) || 0;
  const v = Number(avgViews || 0) || 0;
  const l = Number(avgLikes || 0) || 0;
  const c = Number(avgComments || 0) || 0;
  const fav = Number(avgFavorites || 0) || 0;

  const erViews = v > 0 ? (l + c) / v : null;
  const signalsText = safeText([bio, ...(recentTexts || [])].filter(Boolean).join(" "));
  const topicHint = /tv|television|home\s*theater|projector|soundbar|gaming|ps5|xbox|movie|cinema|tech|electronics|smart\s*home|4k|hdr|dolby|netflix|youtube|review|unboxing|电视|投影|家庭影院|音响|回音壁|游戏|主机|电影|评测|开箱|家电|智能家居/i.test(
    signalsText
  );

  const reasons = [];
  if (f >= 100000) reasons.push("粉丝体量较大");
  else if (f >= 20000) reasons.push("粉丝体量中等偏上");
  else if (f > 0) reasons.push("粉丝体量偏小");

  if (v >= 50000) reasons.push("近50条视频平均播放很强");
  else if (v >= 10000) reasons.push("近50条视频平均播放较好");
  else if (v > 0) reasons.push("近50条视频平均播放偏低");

  if (erViews != null) {
    if (erViews >= 0.06) reasons.push("互动率（赞+评/播放）较高");
    else if (erViews >= 0.03) reasons.push("互动率（赞+评/播放）正常偏好");
    else reasons.push("互动率（赞+评/播放）偏低");
  }

  if (fav >= 200) reasons.push("收藏意向（平均收藏）不错");

  if (topicHint) reasons.push("内容方向与电视/家庭影音消费场景相关");
  else reasons.push("内容方向与电视品类相关性不明显（仅基于简介/近50文案粗判）");

  // 基础推荐规则（可后续按你们规则调整）
  const passViews = v >= 10000;
  const passFollowers = f >= 20000;
  const passEr = erViews == null ? false : erViews >= 0.03;
  const passTopic = topicHint;

  const score = [passViews, passFollowers, passEr, passTopic].filter(Boolean).length;
  const isRecommended = score >= 3;

  const summary = [
    `followers=${formatInt(f)}`,
    `avgViews50=${formatInt(v)}`,
    `avgLikes50=${formatInt(l)}`,
    `avgComments50=${formatInt(c)}`,
    `avgFavorites50=${formatInt(fav)}`,
    erViews == null ? null : `ER(v)=${(erViews * 100).toFixed(1)}%`,
  ]
    .filter(Boolean)
    .join(", ");

  const reasonText = `${reasons.join("；")}。(${summary})`;

  return {
    isRecommended: isRecommended ? "推荐" : "不推荐",
    reason: reasonText,
    erViews: erViews == null ? "" : (erViews * 100).toFixed(2) + "%",
  };
}

async function waitForPort(host, port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(800);
      socket.once("error", () => resolve(false));
      socket.once("timeout", () => resolve(false));
      socket.connect(port, host, () => {
        socket.end();
        resolve(true);
      });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function findChromePathMac() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function startChromeRemoteDebugMac({ chromePath, port, userDataDir }) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  const child = spawn(chromePath, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { pid: child.pid };
}

function sheetToMatrix(sheet) {
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
}

function matrixToSheet(matrix) {
  return XLSX.utils.aoa_to_sheet(matrix);
}

function ensureHeader(matrix, headerRowIdx0, headerName) {
  while (matrix.length <= headerRowIdx0) matrix.push([]);
  const headerRow = matrix[headerRowIdx0];
  const idx = headerRow.findIndex((x) => safeText(x).toLowerCase() === safeText(headerName).toLowerCase());
  if (idx >= 0) return idx;
  headerRow.push(headerName);
  return headerRow.length - 1;
}

function findUrlColumnIndex(matrix, headerRowIdx0, startRowIdx0, specifiedUrlCol) {
  const headerRow = matrix[headerRowIdx0] || [];

  if (specifiedUrlCol != null && specifiedUrlCol !== "") {
    const asNum = Number(specifiedUrlCol);
    if (Number.isInteger(asNum) && String(asNum) === String(specifiedUrlCol).trim()) {
      return asNum;
    }
    const idx = headerRow.findIndex(
      (h) => safeText(h).toLowerCase() === safeText(specifiedUrlCol).toLowerCase()
    );
    if (idx >= 0) return idx;
    throw new Error(`未在表头行找到列名: ${specifiedUrlCol}`);
  }

  // 1) header 语义匹配
  const headerHints = headerRow.map((h) => safeText(h).toLowerCase());
  const hinted = headerHints.findIndex((h) => /(tiktok|抖音|主页|profile|link|url)/i.test(h));
  if (hinted >= 0) return hinted;

  // 2) 扫描数据行中最像 TikTok 链接的列
  const scanRows = matrix.slice(startRowIdx0, Math.min(matrix.length, startRowIdx0 + 50));
  let bestIdx = -1;
  let bestScore = 0;
  const maxCols = Math.max(...scanRows.map((r) => (Array.isArray(r) ? r.length : 0)), headerRow.length, 0);
  for (let c = 0; c < maxCols; c++) {
    let score = 0;
    for (const r of scanRows) {
      const v = r?.[c];
      if (isTikTokUrl(v)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = c;
    }
  }
  if (bestIdx >= 0 && bestScore > 0) return bestIdx;
  throw new Error("无法自动识别 TikTok 主页链接列（请使用 --urlCol 指定表头名或列索引）");
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.input) {
    printHelp();
    process.exit(args.help ? 0 : args.input ? 0 : 1);
  }

  const inputAbs = toAbs(args.input);
  if (!fs.existsSync(inputAbs)) {
    console.error(`❌ 找不到输入文件: ${inputAbs}`);
    process.exit(1);
  }

  const outputAbs = args.inplace ? inputAbs : toAbs(args.output) || guessOutputPath(inputAbs);
  if (!args.inplace && fs.existsSync(outputAbs)) {
    console.error(`❌ 输出文件已存在，为避免覆盖请换个 --out: ${outputAbs}`);
    process.exit(1);
  }

  const cdpEndpoint = args.cdpEndpoint || `http://127.0.0.1:${args.cdpPort}`;
  const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const defaultUserDataDir = path.join(projectRoot, ".tiktok-user-data-enrich");
  const userDataDir = toAbs(args.userDataDir) || defaultUserDataDir;

  // 准备 CDP Chrome
  const host = "127.0.0.1";
  const port = Number(String(cdpEndpoint).match(/:([0-9]+)\b/)?.[1] || args.cdpPort);
  let hasPort = await waitForPort(host, port, 1000);
  let startedChrome = null;

  if (!hasPort && args.launchChrome) {
    if (process.platform !== "darwin") {
      console.error("❌ 当前仅内置了 macOS 自动启动 Chrome 逻辑。请先手动启动 CDP Chrome 后重试。");
      process.exit(1);
    }
    const chromePath = findChromePathMac();
    if (!chromePath) {
      console.error("❌ 未找到本机 Chrome/Chromium，请先安装 Google Chrome。");
      process.exit(1);
    }

    fs.mkdirSync(userDataDir, { recursive: true });
    startedChrome = startChromeRemoteDebugMac({ chromePath, port, userDataDir });
    hasPort = await waitForPort(host, port, 30000);
    if (!hasPort) {
      console.error(`❌ Chrome 启动超时，CDP 端口未就绪: ${cdpEndpoint}`);
      process.exit(1);
    }
  }

  if (!hasPort) {
    console.error(`❌ 无法连接到 CDP: ${cdpEndpoint}。你可以先运行 scripts/launch-chrome-remote-debug-enrich.sh`);
    process.exit(1);
  }

  console.log(`[xlsx-enrich] input=${inputAbs}`);
  console.log(`[xlsx-enrich] output=${outputAbs} ${args.inplace ? "(inplace)" : ""}`);
  console.log(`[xlsx-enrich] CDP=${cdpEndpoint} ${startedChrome?.pid ? `(auto-start pid=${startedChrome.pid})` : ""}`);

  const wb = XLSX.readFile(inputAbs, { cellDates: true });
  const sheetName = args.sheet || wb.SheetNames?.[0];
  if (!sheetName || !wb.Sheets?.[sheetName]) {
    console.error(`❌ 找不到 sheet: ${sheetName || "(empty)"}。可用 sheets: ${wb.SheetNames.join(", ")}`);
    process.exit(1);
  }

  const matrix = sheetToMatrix(wb.Sheets[sheetName]);
  const headerRowIdx0 = Math.max(0, Number(args.headerRow || 1) - 1);
  const startRowIdx0 = Math.max(0, Number(args.startRow || 2) - 1);

  const urlColIdx = findUrlColumnIndex(matrix, headerRowIdx0, startRowIdx0, args.urlCol);
  console.log(`[xlsx-enrich] urlColIdx=${urlColIdx} header="${safeText((matrix[headerRowIdx0] || [])[urlColIdx])}"`);

  const colFollowers = ensureHeader(matrix, headerRowIdx0, "粉丝数");
  const colAvgViews = ensureHeader(matrix, headerRowIdx0, "近50条平均播放量");
  const colAvgLikes = ensureHeader(matrix, headerRowIdx0, "近50条平均点赞量");
  const colAvgComments = ensureHeader(matrix, headerRowIdx0, "近50条平均评论量");
  const colAvgFavorites = ensureHeader(matrix, headerRowIdx0, "近50条平均收藏量");
  const colErViews = ensureHeader(matrix, headerRowIdx0, "互动率(赞+评/播)");
  const colRec = ensureHeader(matrix, headerRowIdx0, "是否推荐(电视品牌)");
  const colReason = ensureHeader(matrix, headerRowIdx0, "推荐理由");
  const colUpdatedAt = ensureHeader(matrix, headerRowIdx0, "抓取时间");
  const colStatus = ensureHeader(matrix, headerRowIdx0, "抓取状态");

  const browser = await chromium.connectOverCDP(cdpEndpoint, { timeout: 15000 });
  const contexts = browser.contexts();
  const context = contexts.length ? contexts[0] : await browser.newContext();

  const rowsToProcess = [];
  for (let r = startRowIdx0; r < matrix.length; r++) {
    const row = matrix[r];
    if (!Array.isArray(row)) continue;
    const url = row[urlColIdx];
    if (!isTikTokUrl(url)) continue;
    const username = extractUsernameFromTikTokUrl(url);
    if (!username) continue;
    rowsToProcess.push({ r, url: String(url).trim(), username });
    if (args.maxRows && rowsToProcess.length >= args.maxRows) break;
  }

  if (!rowsToProcess.length) {
    console.log("[xlsx-enrich] 未找到可处理的 TikTok 主页链接行。");
    process.exit(0);
  }

  console.log(`[xlsx-enrich] 待处理行数: ${rowsToProcess.length}`);
  const runStartedAt = new Date();

  for (let i = 0; i < rowsToProcess.length; i++) {
    const item = rowsToProcess[i];
    const row = matrix[item.r];
    const displayRowNo = item.r + 1;

    // 如果已经写过状态且成功，默认跳过（避免重复抓取）
    const existingStatus = safeText(row[colStatus]);
    if (/^ok$/i.test(existingStatus)) {
      console.log(`[xlsx-enrich] (${i + 1}/${rowsToProcess.length}) skip row=${displayRowNo} @${item.username} (status=ok)`);
      continue;
    }

    console.log(`[xlsx-enrich] (${i + 1}/${rowsToProcess.length}) row=${displayRowNo} @${item.username}`);
    let page = null;
    try {
      page = await context.newPage();
      const profileData = await extractUserProfileFromPageCDP(page, item.username, {
        humanLikeBehavior: !!args.humanLike,
      });

      if (!profileData?.success) {
        throw new Error(profileData?.error || "extract_failed");
      }

      const followers = profileData.userInfo?.followers?.count ?? null;
      const stats = profileData.statistics || {};
      const avgViews = stats.avgViews ?? null;
      const avgLikes = stats.avgLikes ?? null;
      const avgComments = stats.avgComments ?? null;
      const avgFavorites = stats.avgFavorites ?? null;

      const recentTexts = (profileData.videos || [])
        .slice(0, 50)
        .map((v) => v?.caption || v?.description || "")
        .filter(Boolean)
        .slice(0, 50);

      const rec = makeRecommendation({
        followers,
        avgViews,
        avgLikes,
        avgComments,
        avgFavorites,
        bio: profileData.userInfo?.bio || "",
        recentTexts,
      });

      row[colFollowers] = followers == null ? "" : Number(followers);
      row[colAvgViews] = avgViews == null ? "" : Number(avgViews);
      row[colAvgLikes] = avgLikes == null ? "" : Number(avgLikes);
      row[colAvgComments] = avgComments == null ? "" : Number(avgComments);
      row[colAvgFavorites] = avgFavorites == null ? "" : Number(avgFavorites);
      row[colErViews] = rec.erViews || "";
      row[colRec] = rec.isRecommended;
      row[colReason] = rec.reason;
      row[colUpdatedAt] = new Date().toISOString();
      row[colStatus] = "ok";
    } catch (err) {
      row[colUpdatedAt] = new Date().toISOString();
      row[colStatus] = `error: ${String(err?.message || err).slice(0, 180)}`;
      console.warn(`[xlsx-enrich] row=${displayRowNo} failed:`, err?.message || err);
    } finally {
      if (page) {
        try {
          await page.close();
        } catch {}
      }
    }

    // 每处理一行就落盘，避免中途崩溃丢结果
    const newSheet = matrixToSheet(matrix);
    wb.Sheets[sheetName] = newSheet;
    XLSX.writeFile(wb, outputAbs);
  }

  try {
    await browser.close();
  } catch {}

  console.log(
    `[xlsx-enrich] 完成。rows=${rowsToProcess.length}, startedAt=${runStartedAt.toISOString()}, endedAt=${new Date().toISOString()}`
  );
}

main().catch((err) => {
  console.error("❌ xlsx enrich failed:", err?.message || err);
  process.exit(1);
});

