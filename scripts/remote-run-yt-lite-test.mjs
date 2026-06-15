#!/usr/bin/env node
/** 远程跑 YouTube Lite 全流程（9222 innertube，不重启 Chrome） */
process.env.SCRAPER_MODE = "lite";
process.env.CDP_ENDPOINT = "http://127.0.0.1:9222";
process.env.CDP_ENDPOINT_ENRICH = "http://127.0.0.1:9222";
process.env.ENRICH_NO_ANALYZE = "1";
process.env.LITE_DISABLE_SCREENSHOTS = "true";
process.env.LITE_ENRICH_SCREENSHOTS = process.env.LITE_ENRICH_SCREENSHOTS || "true";
process.env.LITE_YT_ENRICH_CONCURRENCY = "1";
process.env.ENRICH_BATCH_POLICY = "false";
process.env.YT_LITE_SESSION_SETTLE_MS = "2000";
process.env.YT_ALLOW_ABOUT_FALLBACK = process.env.YT_ALLOW_ABOUT_FALLBACK || "1";
process.env.LITE_ENRICH_SCREENSHOTS = process.env.LITE_ENRICH_SCREENSHOTS || "true";

const keyword = process.argv[2] || "cat litter box";
const maxEnrich = process.argv[3] || "3";

const { spawnSync } = await import("child_process");
const r = spawnSync(
  process.execPath,
  [
    "--experimental-default-type=module",
    "scripts/test-youtube-lite-pipeline.mjs",
    keyword,
    maxEnrich,
  ],
  { cwd: process.cwd(), encoding: "utf8", timeout: 900_000, env: process.env }
);
process.stdout.write(r.stdout || "");
process.stderr.write(r.stderr || "");
process.exit(r.status ?? 1);
