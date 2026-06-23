/**
 * 从 influencer_snapshot.bio（及 match_analysis.analysis 兜底）解析邮箱，
 * 回填 tiktok_campaign_influencer_candidates.email / has_email，并同步 tiktok_influencer。
 *
 * 用法：
 *   node scripts/backfill-candidate-email-from-bio.mjs --campaign CAMP-xxx --dry-run
 *   node scripts/backfill-candidate-email-from-bio.mjs --campaign CAMP-xxx
 *   node scripts/backfill-candidate-email-from-bio.mjs --petpivot --dry-run
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import {
  extractEmailFromBio,
  describeEmailExtractionReason,
} from "../lib/influencer/extract-email-from-bio.js";
import { resolveCandidateEmail } from "../lib/db/campaign-candidates-dao.js";
import { upsertInfluencer } from "../lib/db/influencer-dao.js";
import { avgViewsFromSnapshot } from "../lib/influencer/avg-views.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

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
  const out = { campaignId: null, petpivot: false, dryRun: false, allRecommended: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--petpivot") out.petpivot = true;
    else if (a === "--all-recommended") out.allRecommended = true;
    else if (a === "--campaign" && argv[i + 1]) {
      out.campaignId = argv[++i];
    }
  }
  return out;
}

async function resolveCampaignId({ campaignId, petpivot }) {
  if (campaignId) return campaignId;
  if (!petpivot) {
    throw new Error("请指定 --campaign <id> 或 --petpivot");
  }
  const rows = await queryTikTok(
    `
    SELECT id
    FROM tiktok_campaign
    WHERE LOWER(CAST(product_info AS CHAR)) LIKE '%petpivot%'
       OR LOWER(CAST(campaign_info AS CHAR)) LIKE '%petpivot%'
    ORDER BY updated_at DESC
    LIMIT 1
  `,
    []
  );
  if (!rows?.[0]?.id) {
    throw new Error("未找到名称/配置含 petpivot 的 campaign");
  }
  return rows[0].id;
}

function resolveEmailFromRow(snap, matchAnalysis) {
  const resolved = resolveCandidateEmail(snap);
  if (resolved) {
    const bio = snap?.bio || snap?.profile_data?.userInfo?.bio || "";
    return {
      email: resolved,
      source: snap?.email === resolved ? "snapshot" : "profile_data",
      reason:
        describeEmailExtractionReason(bio, resolved) ||
        "profile_data 含 public_email/business_email 或 mailto",
    };
  }
  const fromBio = extractEmailFromBio(snap?.bio);
  if (fromBio) {
    return {
      email: fromBio,
      source: "bio",
      reason: describeEmailExtractionReason(snap?.bio, fromBio),
    };
  }
  const fromAnalysis = extractEmailFromBio(matchAnalysis?.analysis);
  if (fromAnalysis) {
    return {
      email: fromAnalysis,
      source: "match_analysis",
      reason: describeEmailExtractionReason(matchAnalysis?.analysis, fromAnalysis),
    };
  }
  return { email: null, source: null, reason: null };
}

async function syncExecutionSnapshotEmail(campaignId, row) {
  const tiktokUsername = row.tiktokUsername;
  const email = row.email;
  const snapshot = row.snapshot;
  const platformInfluencerId = row.platformInfluencerId;
  const matchScore = row.matchScore ?? null;

  const existing = await queryTikTok(
    `
    SELECT id, influencer_snapshot
    FROM tiktok_campaign_execution
    WHERE campaign_id = ? AND tiktok_username = ?
    LIMIT 1
  `,
    [campaignId, tiktokUsername]
  );

  if (existing?.length) {
    const prevSnap = parseJson(existing[0].influencer_snapshot) || {};
    const nextSnap = { ...prevSnap, ...snapshot, email };
    await queryTikTok(
      `
      UPDATE tiktok_campaign_execution
      SET influencer_snapshot = ?,
          influencer_id = COALESCE(?, influencer_id),
          updated_at = CURRENT_TIMESTAMP
      WHERE campaign_id = ? AND tiktok_username = ?
    `,
      [
        JSON.stringify(nextSnap),
        platformInfluencerId,
        campaignId,
        tiktokUsername,
      ]
    );
    return { action: "updated" };
  }

  const insertResult = await queryTikTok(
    `
    INSERT IGNORE INTO tiktok_campaign_execution (
      campaign_id, tiktok_username, influencer_id, influencer_snapshot, stage, last_event
    ) VALUES (?, ?, ?, ?, 'pending_quote', ?)
  `,
    [
      campaignId,
      tiktokUsername,
      platformInfluencerId,
      JSON.stringify(snapshot),
      JSON.stringify({
        createdBy: "backfill-candidate-email-from-bio",
        createdAt: new Date().toISOString(),
        note: "bio 邮箱回填后写入执行表，待联系红人报价。",
        matchScore: matchScore ?? undefined,
      }),
    ]
  );
  const affected =
    typeof insertResult?.affectedRows === "number" ? insertResult.affectedRows : 0;
  return affected > 0 ? { action: "inserted" } : { action: "insert_ignored" };
}

function followerCountFromSnapshot(s) {
  const f = s?.followers;
  if (typeof f === "number" && Number.isFinite(f)) return f;
  if (f && typeof f.count === "number" && Number.isFinite(f.count)) return f.count;
  return null;
}

async function syncGlobalInfluencer(campaignId, row) {
  const snap = row.snapshot;
  const url = snap?.profileUrl;
  const platformInfluencerId = row.platformInfluencerId;
  if (!url || !platformInfluencerId) return false;
  const uname =
    typeof snap.username === "string"
      ? snap.username.replace(/^@/, "").trim() || row.tiktokUsername
      : row.tiktokUsername;
  await upsertInfluencer({
    influencerId: String(platformInfluencerId).trim(),
    platform: snap.platform || "tiktok",
    username: uname,
    displayName: snap.displayName || uname,
    profileUrl: url.trim(),
    followerCount: followerCountFromSnapshot(snap),
    avgViews: avgViewsFromSnapshot(snap),
    influencerEmail: row.email,
    source: "web_search",
    sourceRef: campaignId,
    sourcePayload: {
      origin: "backfill-candidate-email-from-bio",
      campaignId,
    },
    lastFetchedAt: new Date(),
  });
  return true;
}

async function main() {
  const args = parseArgs(process.argv);
  const campaignId = await resolveCampaignId(args);
  const dry = args.dryRun;

  console.log(
    `[backfill-email] campaign=${campaignId} dryRun=${dry} onlyUnpicked=${!args.allRecommended}`
  );

  const rows = await queryTikTok(
    `
    SELECT
      id,
      tiktok_username,
      influencer_id,
      email,
      has_email,
      picked_at,
      influencer_snapshot,
      match_analysis
    FROM tiktok_campaign_influencer_candidates
    WHERE campaign_id = ?
      AND should_contact = 1
      AND has_email = 0
      AND match_analysis IS NOT NULL
      ${args.allRecommended ? "" : "AND picked_at IS NULL"}
    ORDER BY id ASC
  `,
    [campaignId]
  );

  let scanned = 0;
  let wouldUpdate = 0;
  let updated = 0;
  let synced = 0;
  let executionInserted = 0;
  let executionUpdated = 0;
  const skipped = [];
  const found = [];

  for (const row of rows || []) {
    scanned += 1;
    const snap = parseJson(row.influencer_snapshot) || {};
    const matchAnalysis = parseJson(row.match_analysis);
    const { email, source, reason } = resolveEmailFromRow(snap, matchAnalysis);
    if (!email) {
      skipped.push(row.tiktok_username);
      continue;
    }

    const nextSnap = { ...snap, email };
    wouldUpdate += 1;
    found.push({
      username: row.tiktok_username,
      email,
      source,
      reason,
    });

    console.log(
      `  ${dry ? "[dry-run] " : ""}@${row.tiktok_username} <- ${email} (${source}) — ${reason || ""}`
    );

    if (dry) continue;

    await queryTikTok(
      `
      UPDATE tiktok_campaign_influencer_candidates
      SET email = ?,
          has_email = 1,
          influencer_snapshot = ?,
          updated_at = NOW()
      WHERE id = ?
        AND campaign_id = ?
        AND has_email = 0
    `,
      [email, JSON.stringify(nextSnap), row.id, campaignId]
    );
    updated += 1;

    try {
      const execResult = await syncExecutionSnapshotEmail(campaignId, {
        tiktokUsername: row.tiktok_username,
        platformInfluencerId: row.influencer_id || null,
        email,
        snapshot: nextSnap,
        matchScore:
          typeof matchAnalysis?.score === "number" ? matchAnalysis.score : null,
      });
      if (execResult.action === "inserted") executionInserted += 1;
      if (execResult.action === "updated") executionUpdated += 1;
    } catch (e) {
      console.warn(
        `  [warn] sync execution @${row.tiktok_username}:`,
        e?.message || e
      );
    }

    if (row.influencer_id) {
      try {
        const ok = await syncGlobalInfluencer(campaignId, {
          tiktokUsername: row.tiktok_username,
          platformInfluencerId: row.influencer_id,
          email,
          snapshot: nextSnap,
        });
        if (ok) synced += 1;
      } catch (e) {
        console.warn(
          `  [warn] sync tiktok_influencer @${row.tiktok_username}:`,
          e?.message || e
        );
      }
    }
  }

  console.log(
    `[backfill-email] 完成: scanned=${scanned} wouldUpdate=${wouldUpdate} updated=${updated} executionInserted=${executionInserted} executionUpdated=${executionUpdated} syncedInfluencer=${synced} stillNoEmail=${skipped.length}`
  );
  if (found.length) {
    console.log("[backfill-email] 新识别邮箱明细:");
    for (const f of found) {
      console.log(
        `  @${f.username} ${f.email} [${f.source}] ${f.reason || ""}`
      );
    }
  }
  if (skipped.length) {
    console.log(`[backfill-email] 仍无邮箱: ${skipped.join(", ")}`);
  }
}

main().catch((e) => {
  console.error("[backfill-email] 失败:", e?.message || e);
  process.exit(1);
});
