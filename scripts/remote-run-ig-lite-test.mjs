#!/usr/bin/env node
/** 远程跑 IG Lite 全流程（不重启 Chrome，避免长时间等待） */
process.env.SCRAPER_MODE = "lite";
process.env.CDP_ENDPOINT = "http://127.0.0.1:9222";
process.env.ENRICH_NO_ANALYZE = "1";
process.env.LITE_DISABLE_SCREENSHOTS = "true";
process.env.LITE_ENRICH_SCREENSHOTS = process.env.LITE_ENRICH_SCREENSHOTS || "true";
process.env.LITE_IG_ENRICH_CONCURRENCY = "10";
process.env.IG_ABOUT_WAIT_MS = "8000";

const keyword = process.argv[2] || "pool cleaner";
const maxEnrich = process.argv[3] || "3";

const { spawnSync } = await import("child_process");
const r = spawnSync(
  process.execPath,
  ["--experimental-default-type=module", "scripts/test-instagram-lite-pipeline.mjs", keyword, maxEnrich],
  { cwd: process.cwd(), encoding: "utf8", timeout: 900_000, env: process.env }
);
process.stdout.write(r.stdout || "");
process.stderr.write(r.stderr || "");
process.exit(r.status ?? 1);
