/**
 * 评论数据分析 worker：采集近 N 条视频的文案/基础数据/评论文案 → LLM 语义分析 → 落库。
 *
 * 用法:
 *   node scripts/run-comment-analysis.mjs --wondershare --limit=20
 *   node scripts/run-comment-analysis.mjs --campaign=CAMP-xxx
 *   node scripts/run-comment-analysis.mjs --wondershare --force   # 已有数据也重算
 *
 * 默认「已有 ok 数据就跳过」，对应「只更新 1 次」的诉求。
 * 环境变量: CDP_ENDPOINT_TIKTOK(9222) / CDP_ENDPOINT_INSTAGRAM(9223)
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import {
  upsertCommentAnalysisToMaster,
  syncCommentAnalysisToSnapshots,
  listAnalyzedKeys,
} from "../lib/db/comment-analysis-store.js";
import {
  collectTikTokSample,
  collectInstagramSample,
  aggregateOfficialFields,
  analyzeSampleWithLLM,
  normalizeLlmResult,
  computeSampleStats,
  llmSampleComments,
} from "../lib/execution/comment-analysis.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const args = process.argv.slice(2);
const opt = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split("=").slice(1).join("=") : d;
};
const campaignId = String(opt("campaign", ""));
const wondershare = args.includes("--wondershare");
const force = args.includes("--force");
const limit = Number(opt("limit", 20));
const maxVideos = Number(opt("videos", process.env.COMMENT_ANALYSIS_VIDEOS || 10));
const usernameFilter = String(opt("username", ""))
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const platformFilter = String(opt("platform", ""))
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const TT_ENDPOINT = process.env.CDP_ENDPOINT_TIKTOK || "http://127.0.0.1:9222";
const IG_ENDPOINT = process.env.CDP_ENDPOINT_INSTAGRAM || "http://127.0.0.1:9223";
const PLATFORMS = platformFilter.length ? platformFilter : ["tiktok", "instagram"];

/** 万兴科技（Wondershare）旗下品牌关键词 */
const WONDERSHARE_KEYWORDS = [
  "Wondershare",
  "万兴",
  "Virbo",
  "Filmora",
  "DemoCreator",
  "PDFelement",
  "Dr.Fone",
  "UniConverter",
  "Recoverit",
  "EdrawMax",
  "Edraw",
];

async function loadCandidates() {
  const params = [];
  const where = [];
  if (campaignId) {
    where.push("e.campaign_id = ?");
    params.push(campaignId);
  } else if (wondershare) {
    const like = WONDERSHARE_KEYWORDS.map(() => "s.title LIKE ?").join(" OR ");
    const rows = await queryTikTok(
      `SELECT c.id FROM tiktok_campaign c
       LEFT JOIN tiktok_campaign_sessions s ON s.id = c.session_id
       WHERE c.deleted_at IS NULL AND (${like})`,
      WONDERSHARE_KEYWORDS.map((k) => `%${k}%`)
    );
    const ids = rows.map((r) => r.id);
    if (!ids.length) return [];
    where.push(`e.campaign_id IN (${ids.map(() => "?").join(",")})`);
    params.push(...ids);
    console.log(`[comment-analysis] 万兴 campaign ${ids.length} 个: ${ids.join(", ")}`);
  } else {
    throw new Error("必须指定 --campaign=CAMP-xxx 或 --wondershare");
  }
  where.push(`e.stage IN ('quote_submitted','quote_rejected')`);
  where.push(`e.platform IN (${PLATFORMS.map(() => "?").join(",")})`);
  params.push(...PLATFORMS);

  return queryTikTok(
    `SELECT DISTINCT e.campaign_id, e.tiktok_username AS username, e.platform
     FROM tiktok_campaign_execution e
     WHERE ${where.join(" AND ")}
     ORDER BY e.platform, e.tiktok_username`,
    params
  );
}

async function resolveTiktokSecUid(page, username) {
  const tt = await import("../lib/execution/tiktok-comments.js");
  let secUid = await tt.resolveTiktokSecUid(page, username);
  if (!secUid) {
    const rows = await queryTikTok(
      "SELECT tiktok_sec_uid FROM tiktok_influencer WHERE username = ?",
      [username]
    );
    secUid = String(rows?.[0]?.tiktok_sec_uid || "").trim() || null;
    if (secUid) console.log(`  (user/detail 空返回，使用库内 secUid)`);
  }
  return secUid;
}

/** 采集 + LLM 分析一条 */
/** 阶段一：采集（顺序执行，尊重平台风控） */
async function collectFor({ platform, page, username }) {
  if (platform === "tiktok") {
    const secUid = await resolveTiktokSecUid(page, username);
    if (!secUid) return { error: "secuid_unresolved" };
    return collectTikTokSample({ page, username, secUid, maxVideos });
  }
  const sample = await collectInstagramSample({ page, username, maxVideos });
  return sample.error ? { error: sample.error } : sample;
}

/** 阶段二：官方字段聚合 + LLM 分析（I/O 等待，可并发） */
async function finalizeOne({ platform, username, sample }) {
  const { videos, comments } = sample;
  if (!comments.length) return { status: "failed", error: "no_comments_collected", videos, comments };

  const official = aggregateOfficialFields(comments);
  const stats = computeSampleStats(videos, comments);
  const llmRaw = await analyzeSampleWithLLM({
    platform,
    username,
    videos,
    comments,
    official,
    stats,
  });
  const llm = normalizeLlmResult(llmRaw);
  if (!llm) return { status: "failed", error: "llm_parse_failed", videos, comments, stats };
  if (llm.languageCounts) {
    const sum = Object.values(llm.languageCounts).reduce((s, n) => s + n, 0);
    const promptSize = llmSampleComments(comments).length;
    console.log(
      `    [llm] @${username} 语言计数 ${sum}/${promptSize}${sum === promptSize ? " ✓" : " ⚠对不上"} ${JSON.stringify(llm.languageCounts)}`
    );
  }

  // 官方优先、缺失回落 LLM（两项都标记 source）
  const languageMix = official.language.mix
    ? official.language.mix
    : llm.languageMix;
  const languageSource = official.language.mix ? "official" : "llm";
  const purchaseIntentRatio =
    official.purchaseIntent.ratio != null ? official.purchaseIntent.ratio : llm.purchaseIntentRatio;
  const purchaseIntentSource = official.purchaseIntent.ratio != null ? "official" : "llm";

  return {
    status: "ok",
    videosAnalyzed: videos.length,
    commentsSampled: comments.length,
    qualityCommentRatio: llm.qualityCommentRatio,
    qualityCommentReason: llm.qualityCommentReason,
    purchaseIntentRatio,
    purchaseIntentSource,
    purchaseIntentRatioOfficial: official.purchaseIntent.ratio,
    purchaseIntentRatioLlm: llm.purchaseIntentRatio,
    languageMix,
    languageSource,
    contentDirections: llm.contentDirections,
    fanLoyalty: llm.fanLoyalty,
    analysisSummary: llm.summary,
    videos: videos.map((v) => ({
      videoId: v.videoId,
      desc: String(v.desc || "").slice(0, 200),
      views: v.views,
      likes: v.likes,
      comments: v.comments,
    })),
    llmModel: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
    stats,
    official,
  };
}

async function main() {
  let queue = await loadCandidates();
  if (!force) {
    const done = await listAnalyzedKeys();
    const before = queue.length;
    queue = queue.filter((r) => !done.has(`${r.platform}:${r.username}`));
    console.log(
      `[comment-analysis] 候选 ${before} 个，已有数据跳过 ${before - queue.length} 个，待处理 ${queue.length} 个`
    );
  } else {
    console.log(`[comment-analysis] 候选 ${queue.length} 个（--force 全量重算）`);
  }
  if (usernameFilter.length) {
    queue = queue.filter((r) => usernameFilter.includes(String(r.username).toLowerCase()));
  }
  if (limit > 0) queue = queue.slice(0, limit);
  if (!queue.length) {
    console.log("[comment-analysis] 没有需要处理的红人");
    process.exit(0);
  }

  const byPlatform = { tiktok: [], instagram: [] };
  for (const r of queue) {
    const p = String(r.platform || "").toLowerCase();
    if (byPlatform[p]) byPlatform[p].push(r);
  }
  console.log(
    `[comment-analysis] 本次处理 ${queue.length} 个（tiktok=${byPlatform.tiktok.length} instagram=${byPlatform.instagram.length}）videos=${maxVideos}`
  );

  const records = [];
  const t0 = Date.now();

  // 采集页：按需获取（每个平台一个会话）
  const pages = {};
  let igSession = null;
  if (byPlatform.tiktok.length) {
    const { acquireTiktokCdpPage } = await import("../lib/cdp/cdp-target-page.js");
    const { bootstrapTiktokWebSession } = await import(
      "../lib/tools/influencer-functions/tiktok/tiktok-api-client.js"
    );
    const { page } = await acquireTiktokCdpPage(TT_ENDPOINT, {});
    await bootstrapTiktokWebSession(page);
    pages.tiktok = page;
  }
  if (byPlatform.instagram.length) {
    const { acquireInstagramApiSession } = await import(
      "../lib/tools/influencer-functions/instagram/instagram-direct-fetch.js"
    );
    igSession = await acquireInstagramApiSession(null, { endpointKey: IG_ENDPOINT });
    pages.instagram = igSession.page;
  }

  // 流水线：采集顺序执行（尊重风控），LLM 并发在飞（I/O 等待，不阻塞下一条采集）
  const concurrency = Math.max(1, Number(process.env.COMMENT_ANALYSIS_LLM_CONCURRENCY || 4));
  console.log(
    `[comment-analysis] LLM 并发=${concurrency}（采集顺序执行；每完成 1 个立刻落库）`
  );

  let persisted = 0;
  const persistOne = async (rec) => {
    if (rec?.status !== "ok") return;
    try {
      const { updated, missing } = await upsertCommentAnalysisToMaster([rec]);
      const snap = await syncCommentAnalysisToSnapshots([rec]);
      persisted += updated;
      console.log(
        `    [db] @${rec.username} 主档=${updated}${missing.length ? "(主档缺失)" : ""} 快照:候选${snap.candidate}/执行${snap.execution}`
      );
    } catch (e) {
      console.log(`    [db] @${rec.username} 落库失败: ${String(e?.message || e).slice(0, 140)}`);
    }
  };

  const inflight = [];
  const drainOldest = async () => {
    const job = inflight.shift();
    const rec = await job;
    records.push(rec);
    await persistOne(rec);
  };

  for (const r of queue) {
    const platform = String(r.platform || "").toLowerCase();
    const page = pages[platform];
    const c0 = Date.now();
    let sample = null;
    let collectError = null;
    try {
      sample = page ? await collectFor({ platform, page, username: r.username }) : null;
      if (!page) collectError = "no_page_for_platform";
      else if (sample?.error) collectError = sample.error;
    } catch (e) {
      collectError = String(e?.message || e).slice(0, 200);
    }
    const collectSec = ((Date.now() - c0) / 1000).toFixed(1);

    if (collectError || !sample) {
      records.push({
        campaignId: r.campaign_id,
        platform,
        username: r.username,
        status: "failed",
        error: collectError || "collect_failed",
      });
      console.log(`  ${platform} @${r.username}\tfailed\t采集 ${collectSec}s\t${collectError}`);
      continue;
    }
    const job = finalizeOne({ platform, username: r.username, sample })
      .then((rec) => ({ campaignId: r.campaign_id, platform, username: r.username, ...rec }))
      .catch((e) => ({
        campaignId: r.campaign_id,
        platform,
        username: r.username,
        status: "failed",
        error: String(e?.message || e).slice(0, 200),
      }))
      .then((rec) => {
        console.log(
          `  ${platform} @${r.username}\t${rec.status}\t视频=${rec.videosAnalyzed ?? "-"}\t评论=${rec.commentsSampled ?? "-"}\t高质量=${fmtPct(rec.qualityCommentRatio)}\t购买意向=${fmtPct(rec.purchaseIntentRatio)}(${rec.purchaseIntentSource || "-"})\t语言=${rec.languageSource || "-"}\t采集${collectSec}s\t${rec.error || ""}`
        );
        return rec;
      });
    inflight.push(job);
    if (inflight.length >= concurrency) await drainOldest();
  }
  while (inflight.length) await drainOldest();
  await igSession?.dispose?.().catch(() => {});

  const okRecords = records.filter((r) => r.status === "ok");
  console.log(`[comment-analysis] 完成 ${okRecords.length} 条，主档已增量写入 ${persisted} 条`);
  const failed = records.filter((r) => r.status !== "ok");
  if (failed.length) {
    console.log(
      `[comment-analysis] 失败 ${failed.length} 条（不会写入主档/快照，下轮会重试）: ${failed
        .slice(0, 5)
        .map((r) => `@${r.username}(${r.error || "-"})`)
        .join(", ")}`
    );
  }
  console.log(`[comment-analysis] 总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
}

function fmtPct(v) {
  return v == null ? "-" : `${Math.round(Number(v) * 100)}%`;
}

main().catch((e) => {
  console.error("[comment-analysis] FAILED:", e?.stack || e?.message || e);
  process.exit(1);
});
