/**
 * 合并重复 tiktok_campaign 到 canonical ID。
 *
 * 神眸默认：
 *   node scripts/merge-campaigns.js
 *
 * 指定 ID：
 *   node scripts/merge-campaigns.js --canonical CAMP-xxx --merge CAMP-yyy
 *
 * 按 session：
 *   node scripts/merge-campaigns.js --session dd7b7a6f-840c-4c3d-9aed-8bbfcd71de60
 *
 * 预演：
 *   node scripts/merge-campaigns.js --dry-run
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import {
  mergeCampaignInto,
  findDuplicateCampaignsForSession,
} from "../lib/db/merge-campaigns.js";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const DEFAULT_CANONICAL = "CAMP-1779282660977-6H2FAB1G3";
const DEFAULT_OLD = "CAMP-1779282508785-LNET3FS0Q";
const DEFAULT_SESSION = "dd7b7a6f-840c-4c3d-9aed-8bbfcd71de60";

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--canonical" && argv[i + 1]) out.canonical = argv[++i];
    else if (a === "--merge" && argv[i + 1]) out.merge = argv[++i];
    else if (a === "--session" && argv[i + 1]) out.session = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  let canonicalId = args.canonical;
  let oldIds = args.merge ? [args.merge] : [];

  if (args.session || (!canonicalId && !oldIds.length)) {
    const sessionId = args.session || DEFAULT_SESSION;
    const dup = await findDuplicateCampaignsForSession(sessionId);
    if (!dup || dup.oldIds.length === 0) {
      console.log(`会话 ${sessionId} 无重复 campaign，无需合并。`);
      if (dup?.canonicalId) console.log(`当前 canonical: ${dup.canonicalId}`);
      return;
    }
    canonicalId = dup.canonicalId;
    oldIds = dup.oldIds;
    console.log(`会话 ${sessionId} → canonical=${canonicalId}, 待合并: ${oldIds.join(", ")}`);
  }

  if (!canonicalId) canonicalId = DEFAULT_CANONICAL;
  if (!oldIds.length) oldIds = [DEFAULT_OLD];

  console.log(`\n=== 合并 campaign ${args.dryRun ? "(dry-run)" : ""} ===`);
  console.log(`保留: ${canonicalId}`);
  console.log(`并入并软删: ${oldIds.join(", ")}\n`);

  for (const oldId of oldIds) {
    const stats = await mergeCampaignInto(canonicalId, oldId, { dryRun: args.dryRun });
    console.log(JSON.stringify(stats, null, 2));
  }

  if (!args.dryRun) {
    const camp = await queryTikTok(
      `SELECT session_id FROM tiktok_campaign WHERE id = ? LIMIT 1`,
      [canonicalId]
    );
    const sessionId = camp?.[0]?.session_id;
    if (sessionId) {
      const sess = await queryTikTok(
        `SELECT id, context FROM tiktok_campaign_sessions WHERE id = ?`,
        [sessionId]
      );
      if (sess?.[0]) {
        let ctx = {};
        try {
          ctx = sess[0].context ? JSON.parse(sess[0].context) : {};
        } catch {
          ctx = typeof sess[0].context === "object" ? sess[0].context : {};
        }
        ctx.campaignId = canonicalId;
        ctx.published = true;
        ctx.workflowState = "published";
        await queryTikTok(
          `UPDATE tiktok_campaign_sessions SET context = ?, updated_at = NOW() WHERE id = ?`,
          [JSON.stringify(ctx), sessionId]
        );
        console.log(`\n已同步会话 context.campaignId = ${canonicalId}`);
      }
    }
  }

  console.log("\n完成。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
