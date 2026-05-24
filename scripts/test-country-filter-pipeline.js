#!/usr/bin/env node
/**
 * 冒烟测试：搜索 → 视频发布地采集 → 国家过滤 →（可选）enrich
 *
 * 用法:
 *   node scripts/test-country-filter-pipeline.js
 *   node scripts/test-country-filter-pipeline.js "robot vacuum" 3
 *   node scripts/test-country-filter-pipeline.js "robot vacuum" 3 --full
 *   node scripts/test-country-filter-pipeline.js "robot vacuum" 3 --countries US,CA,AU,MY
 *   node scripts/test-country-filter-pipeline.js "robot vacuum" 3 --task-id 123
 *
 * 前置:
 *   - node scripts/add-video-publish-country-columns.js
 *   - 9222: bash scripts/launch-chrome-remote-debug.sh（已登录 TikTok）
 *   - --full 时需 9223: bash scripts/launch-chrome-remote-debug-enrich.sh
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { searchAndExtractInfluencers } from "../lib/tools/influencer-functions/search-and-extract-influencers.js";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

function parseArgs(argv) {
  const positional = [];
  let full = false;
  let fast = false;
  let countries = ["US", "CA", "AU", "MY"];
  let taskId = null;

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--full") full = true;
    else if (a === "--fast") fast = true;
    else if (a === "--country-only") full = false;
    else if (a.startsWith("--countries=")) {
      countries = a
        .slice("--countries=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === "--countries" && argv[i + 1]) {
      countries = argv[++i]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a.startsWith("--task-id=")) {
      taskId = Number(a.slice("--task-id=".length)) || null;
    } else if (a === "--task-id" && argv[i + 1]) {
      taskId = Number(argv[++i]) || null;
    } else if (!a.startsWith("--")) {
      positional.push(a);
    }
  }

  return {
    keyword: positional[0] || "robot vacuum",
    batchSize: Math.min(Math.max(Number(positional[1] || 3), 1), 10),
    full,
    countries,
    taskId,
    fast,
  };
}

async function checkCdp(url, label) {
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    const json = await res.json();
    console.log(`  ${label}: ✅ ${json.Browser || "connected"}`);
    return true;
  } catch {
    console.log(`  ${label}: ❌ 无法连接 ${url}`);
    return false;
  }
}

async function printDbSnapshot(usernames) {
  if (!usernames.length) return;
  const placeholders = usernames.map(() => "?").join(",");
  const rows = await queryTikTok(
    `
    SELECT username, video_publish_country, video_publish_country_checked_at
    FROM TikTok_influencer
    WHERE username IN (${placeholders})
  `,
    usernames.map((u) => u.replace(/^@/, ""))
  );
  console.log("\n--- DB TikTok_influencer ---");
  for (const row of rows) {
    console.log(
      `  @${row.username} | video_publish_country=${row.video_publish_country ?? "NULL"} | checked_at=${row.video_publish_country_checked_at ?? "-"}`
    );
  }
}

async function printTaskSnapshot(taskId) {
  if (!taskId) return;
  const rows = await queryTikTok(
    `
    SELECT id, status, progress_country_checked_count, progress_country_passed_count,
           progress_enriched_count, last_progress_at,
           JSON_EXTRACT(payload, '$.countryFilter.outcomes') AS outcomes
    FROM tiktok_influencer_search_task
    WHERE id = ?
    LIMIT 1
  `,
    [taskId]
  );
  if (!rows?.[0]) {
    console.log(`\n--- 任务 #${taskId} 未找到 ---`);
    return;
  }
  const t = rows[0];
  console.log(`\n--- 任务 #${t.id} (${t.status}) ---`);
  console.log(
    `  country_checked=${t.progress_country_checked_count} passed=${t.progress_country_passed_count} enriched=${t.progress_enriched_count}`
  );
  console.log(`  last_progress_at=${t.last_progress_at}`);
  if (t.outcomes) {
    try {
      const list = typeof t.outcomes === "string" ? JSON.parse(t.outcomes) : t.outcomes;
      if (Array.isArray(list)) {
        for (const o of list) {
          console.log(
            `    @${o.username} country=${o.video_publish_country ?? "null"} reason=${o.enrich_skipped_reason ?? "-"} passed=${o.country_passed}`
          );
        }
      }
    } catch {
      console.log(`  outcomes(raw): ${String(t.outcomes).slice(0, 200)}`);
    }
  }
}

async function main() {
  const { keyword, batchSize, full, fast, countries, taskId } = parseArgs(process.argv);
  const videoDelay = fast ? { min: 2000, max: 3500 } : { min: 5000, max: 10000 };
  const enrichDelay = fast ? { min: 2000, max: 4000 } : { min: 5000, max: 10000 };

  console.log("=".repeat(60));
  console.log("国家过滤流水线冒烟测试");
  console.log("=".repeat(60));
  console.log(`关键词: ${keyword}`);
  console.log(`采样人数: ${batchSize}`);
  console.log(`允许国家: ${countries.join(", ")}`);
  console.log(`enrich: ${full ? "是（9223）" : "否（仅国家阶段）"}`);
  console.log(`快速模式: ${fast ? "是（缩短间隔）" : "否"}`);
  if (taskId) console.log(`任务 ID: ${taskId}`);
  console.log("");

  console.log("CDP 检查:");
  const cdp9222 = await checkCdp(
    process.env.CDP_ENDPOINT || "http://127.0.0.1:9222/json/version",
    "9222 搜索+国家"
  );
  const enrichEndpoint =
    process.env.CDP_ENDPOINT_ENRICH || "http://127.0.0.1:9223/json/version";
  const cdp9223 = full ? await checkCdp(enrichEndpoint, "9223 enrich") : null;

  if (!cdp9222) {
    console.error("\n❌ 请先启动 9222 Chrome（需登录 TikTok）");
    process.exit(2);
  }
  if (full && !cdp9223) {
    console.error("\n❌ --full 需要 9223，请运行 launch-chrome-remote-debug-enrich.sh");
    process.exit(2);
  }

  const onStepUpdate = (u) => {
    const t = new Date().toLocaleTimeString();
    const step = u?.step || u?.type || "progress";
    const msg = u?.message || u?.detail || "";
    console.log(`[${t}] ${step}: ${msg}`);
  };

  if (fast) {
    process.env.COUNTRY_VIDEO_DELAY_MIN = "2000";
    process.env.COUNTRY_VIDEO_DELAY_MAX = "3500";
  }

  const t0 = Date.now();
  const result = await searchAndExtractInfluencers(
    {
      keywords: { search_queries: [keyword] },
      platforms: ["TikTok"],
      countries,
      productInfo: { productName: "smoke-test" },
      campaignInfo: { platforms: ["TikTok"], countries, region: countries[0] },
      influencerProfile: null,
      campaignId: null,
    },
    {
      maxResults: batchSize,
      maxEnrichCount: batchSize,
      enrichProfileData: full,
      taskId,
      onStepUpdate,
      delayBetweenBatches: fast ? 2000 : 3000,
    }
  );

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("\n" + "=".repeat(60));
  console.log(`完成 (${elapsed}s) success=${result.success}`);
  console.log("=".repeat(60));

  const cf = result.countryFilter || {};
  console.log("\n国家过滤统计:", cf);
  if (result.countryFilterOutcomes?.length) {
    console.log("\n逐人结果:");
    for (const o of result.countryFilterOutcomes) {
      console.log(
        `  @${o.username} | ${o.video_publish_country ?? "null"} | ${o.enrich_skipped_reason ?? "ok/enriched"} | passed=${o.country_passed}`
      );
    }
  }

  const usernames = (result.influencers || []).map((i) => i.username).filter(Boolean);
  try {
    await printDbSnapshot(usernames);
    await printTaskSnapshot(taskId);
  } catch (e) {
    console.warn("\nDB 查询跳过:", e.message);
  }

  const passed = Number(cf.passed || 0);
  const checked = Number(cf.checked || 0);
  if (!result.success) {
    console.error("\n❌ 流水线失败:", result.error || "unknown");
    process.exit(1);
  }
  if (checked === 0) {
    console.error("\n❌ 未检查到任何红人（搜索可能为空）");
    process.exit(1);
  }
  const withCountry = (result.countryFilterOutcomes || []).filter(
    (o) => o.video_publish_country
  ).length;
  if (withCountry === 0) {
    console.warn("\n⚠️  无人拿到 locationCreated，请检查 9222 登录与网络");
    process.exit(1);
  }

  console.log(`\n✅ 冒烟通过: 检查 ${checked} 人，有发布地 ${withCountry} 人，符合国家 ${passed} 人`);
  if (!full) {
    console.log("   （未跑 enrich；完整链路请加 --full 并启动 9223）");
  }
}

main().catch((e) => {
  console.error("\n❌ 测试异常:", e.message);
  if (e.stack) console.error(e.stack.split("\n").slice(0, 5).join("\n"));
  process.exit(1);
});
