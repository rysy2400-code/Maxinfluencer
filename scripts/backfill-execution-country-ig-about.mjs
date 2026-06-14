/**
 * 用本地 9222（已登录 Instagram）补齐 campaign 执行红人 video_publish_country
 * 并同步 tiktok_campaign_execution.influencer_snapshot.videoPublishCountry
 *
 * 用法:
 *   CDP_ENDPOINT=http://127.0.0.1:9222 node scripts/backfill-execution-country-ig-about.mjs --campaign CAMP-1780390702505-LQFEI5RJE
 *   CDP_ENDPOINT=http://127.0.0.1:9222 node scripts/backfill-execution-country-ig-about.mjs --songmics --dry-run
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { saveVideoPublishCountry } from "../lib/db/tiktok-influencer-dao.js";
import { extractInstagramAboutCountryFromPage } from "../lib/tools/influencer-functions/instagram/extract-instagram-about-country.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const STAGES = ["pending_quote", "quote_submitted", "quote_rejected"];

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const out = { campaignId: null, songmics: false, dryRun: false, limit: 0 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--songmics") out.songmics = true;
    else if (a === "--campaign" && argv[i + 1]) out.campaignId = argv[++i];
    else if (a === "--limit" && argv[i + 1]) out.limit = Number(argv[++i]) || 0;
  }
  return out;
}

async function resolveCampaignId({ campaignId, songmics }) {
  if (campaignId) return campaignId;
  if (!songmics) {
    throw new Error("请指定 --campaign <id> 或 --songmics");
  }
  const rows = await queryTikTok(
    `
    SELECT id, status
    FROM tiktok_campaign
    WHERE status != 'deleted'
      AND (
        LOWER(CAST(product_info AS CHAR)) LIKE '%songmics%'
        OR LOWER(CAST(campaign_info AS CHAR)) LIKE '%songmics%'
        OR LOWER(CAST(product_info AS CHAR)) LIKE '%bürostuhl%'
        OR LOWER(CAST(product_info AS CHAR)) LIKE '%burostuhl%'
      )
    ORDER BY updated_at DESC
    LIMIT 1
  `,
    []
  );
  if (!rows?.[0]?.id) throw new Error("未找到 SONGMICS campaign");
  return rows[0].id;
}

function hasCountry(snap, dbCountry) {
  const c = snap?.videoPublishCountry || dbCountry;
  return c != null && String(c).trim() !== "";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function loadTargets(campaignId) {
  const rows = await queryTikTok(
    `
    SELECT e.id AS exec_id, e.tiktok_username, e.stage, e.influencer_snapshot,
           ti.video_publish_country
    FROM tiktok_campaign_execution e
    LEFT JOIN TikTok_influencer ti ON ti.username = e.tiktok_username
    WHERE e.campaign_id = ?
      AND e.stage IN (?, ?, ?)
    ORDER BY e.stage, e.tiktok_username
  `,
    [campaignId, ...STAGES]
  );

  const targets = [];
  for (const row of rows || []) {
    const snap = parseJson(row.influencer_snapshot) || {};
    if (hasCountry(snap, row.video_publish_country)) continue;
    const username = String(row.tiktok_username || snap.username || "")
      .replace(/^@/, "")
      .trim();
    if (!username) continue;
    targets.push({
      execId: row.exec_id ?? row.id,
      username,
      stage: row.stage,
      snapshot: snap,
      profileUrl:
        snap.profileUrl || `https://www.instagram.com/${username}/`,
    });
  }
  return targets;
}

async function patchExecutionSnapshot(execId, campaignId, username, snap, iso, raw, source) {
  const next = {
    ...snap,
    videoPublishCountry: iso,
    accountCountryRaw: raw || null,
    accountCountrySource: source || null,
  };
  const json = JSON.stringify(next);
  if (execId != null) {
    await queryTikTok(
      `
      UPDATE tiktok_campaign_execution
      SET influencer_snapshot = ?, updated_at = NOW()
      WHERE id = ?
    `,
      [json, execId]
    );
    return;
  }
  await queryTikTok(
    `
    UPDATE tiktok_campaign_execution
    SET influencer_snapshot = ?, updated_at = NOW()
    WHERE campaign_id = ? AND tiktok_username = ?
  `,
    [json, campaignId, username]
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const campaignId = await resolveCampaignId(args);
  let targets = await loadTargets(campaignId);
  if (args.limit > 0) targets = targets.slice(0, args.limit);

  console.log(
    `[backfill-country] campaign=${campaignId} targets=${targets.length} dryRun=${args.dryRun}`
  );
  if (!targets.length) {
    console.log("[backfill-country] 无需补齐");
    return;
  }

  if (args.dryRun) {
    targets.forEach((t, i) =>
      console.log(`  ${i + 1}. @${t.username} (${t.stage})`)
    );
    return;
  }

  const endpoint = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 20000 });
  const context = browser.contexts()[0] || (await browser.newContext());
  let page =
    context.pages().find((p) => p.url().includes("instagram.com")) ||
    (await context.newPage());

  const results = { ok: 0, fail: 0, rows: [] };

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const progress = `${i + 1}/${targets.length}`;
    console.log(`\n[${progress}] @${t.username} (${t.stage})`);

    if (i > 0) {
      await sleep(6000 + Math.floor(Math.random() * 4000));
    }

    try {
      const r = await extractInstagramAboutCountryFromPage(page, t.username, {
        waitAfterAboutMs: Number(process.env.IG_ABOUT_WAIT_MS) || 10_000,
      });
      const iso = r.videoPublishCountry || null;
      const raw = r.accountCountryRaw || r.accountCountry || null;

      if (!iso) {
        results.fail += 1;
        results.rows.push({
          username: t.username,
          ok: false,
          error: r.error || "no_country",
        });
        console.log(`  ❌ ${r.error || "未获取国家"}`);
        continue;
      }

      await saveVideoPublishCountry({
        username: t.username,
        videoPublishCountry: iso,
        locationSource: `ig_about:${r.source || "unknown"}`,
      });
      await patchExecutionSnapshot(
        t.execId,
        campaignId,
        t.username,
        t.snapshot,
        iso,
        raw,
        r.source
      );

      results.ok += 1;
      results.rows.push({
        username: t.username,
        ok: true,
        iso,
        raw,
        source: r.source,
      });
      console.log(`  ✅ ${raw || iso} → ${iso} (${r.source})`);
    } catch (e) {
      results.fail += 1;
      results.rows.push({ username: t.username, ok: false, error: e.message });
      console.log(`  ❌ ${e.message}`);
    }
  }

  try {
    await browser.close();
  } catch {
    /* disconnect */
  }

  console.log(`\n[backfill-country] 完成 ok=${results.ok} fail=${results.fail}`);
  console.log(JSON.stringify(results.rows, null, 2));
}

main().catch((e) => {
  console.error("[backfill-country] failed:", e.message);
  process.exit(1);
});
