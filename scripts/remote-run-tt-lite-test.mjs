#!/usr/bin/env node
/** 远程跑 TikTok Lite 全流程（9222 搜索 + 9223 enrich） */
process.env.SCRAPER_MODE = "lite";
process.env.CDP_ENDPOINT = "http://127.0.0.1:9222";
process.env.CDP_ENDPOINT_ENRICH = "http://127.0.0.1:9223";
process.env.ENRICH_NO_ANALYZE = "1";
process.env.LITE_DISABLE_SCREENSHOTS = "true";
process.env.LITE_TT_ENRICH_CONCURRENCY = "1";
process.env.TT_LITE_SEARCH_DELAY_MS = "180";
process.env.ENRICH_BATCH_POLICY = "false";

const keyword = process.argv[2] || "pool cleaner";
const maxEnrich = process.argv[3] || "2";

const { spawnSync } = await import("child_process");
const r = spawnSync(
  process.execPath,
  [
    "--experimental-default-type=module",
    "scripts/test-tiktok-lite-pipeline.mjs",
    keyword,
    maxEnrich,
  ],
  { cwd: process.cwd(), encoding: "utf8", timeout: 900_000, env: process.env }
);
process.stdout.write(r.stdout || "");
process.stderr.write(r.stderr || "");
process.exit(r.status ?? 1);
