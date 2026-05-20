/**
 * 扫描同一 session 下多条非 deleted 的 tiktok_campaign；可选自动合并到 canonical。
 *
 *   node scripts/dedupe-campaigns-by-session.js
 *   node scripts/dedupe-campaigns-by-session.js --apply
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import {
  listSessionsWithDuplicateCampaigns,
  findDuplicateCampaignsForSession,
  mergeCampaignInto,
} from "../lib/db/merge-campaigns.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const apply = process.argv.includes("--apply");

async function main() {
  const dupes = await listSessionsWithDuplicateCampaigns();
  if (!dupes.length) {
    console.log("未发现重复 campaign（按 session_id）。");
    return;
  }

  console.log(`发现 ${dupes.length} 个会话存在重复 campaign:\n`);
  for (const d of dupes) {
    console.log(`  session=${d.sessionId} count=${d.count} ids=${d.campaignIds.join(", ")}`);
  }

  if (!apply) {
    console.log("\n加 --apply 将按 canonical 规则自动合并（不删除数据，仅软删旧 campaign 行）。");
    return;
  }

  console.log("\n开始合并...\n");
  for (const d of dupes) {
    const plan = await findDuplicateCampaignsForSession(d.sessionId);
    if (!plan?.oldIds?.length) continue;
    for (const oldId of plan.oldIds) {
      const stats = await mergeCampaignInto(plan.canonicalId, oldId);
      console.log(`merged ${oldId} → ${plan.canonicalId}`, stats);
    }
  }
  console.log("\n全部完成。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
