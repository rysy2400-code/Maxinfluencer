/**
 * 验证 INSERT IGNORE：同一 (campaign_id, influencer_id) 第二次写入不改变行。
 * 用法：node scripts/test-candidate-insert-ignore.js
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { upsertCandidatesForCampaign } from "../lib/db/campaign-candidates-dao.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const TEST_CAMPAIGN = "__TEST_INSERT_IGNORE_CAMPAIGN__";
const TEST_INF = "__test_influencer_insert_ignore__";

async function main() {
  await queryTikTok(
    `DELETE FROM tiktok_campaign_influencer_candidates WHERE campaign_id = ? AND influencer_id = ?`,
    [TEST_CAMPAIGN, TEST_INF]
  );

  const baseInf = {
    influencerId: TEST_INF,
    username: TEST_INF,
    score: 10,
    isRecommended: false,
    analysis: "first-analysis-body",
    reason: "first-short",
  };

  const r1 = await upsertCandidatesForCampaign(
    TEST_CAMPAIGN,
    [baseInf],
    { taskId: 1, runId: "r1", searchKeyword: "kw-a" }
  );
  const row1 = await queryTikTok(
    `SELECT id, match_score, analysis_summary, match_analysis, updated_at FROM tiktok_campaign_influencer_candidates WHERE campaign_id = ? AND influencer_id = ?`,
    [TEST_CAMPAIGN, TEST_INF]
  );
  const u1 = row1?.[0]?.updated_at;

  const r2 = await upsertCandidatesForCampaign(
    TEST_CAMPAIGN,
    [{ ...baseInf, score: 99, analysis: "second-should-not-persist", reason: "second-short" }],
    { taskId: 2, runId: "r2", searchKeyword: "kw-b" }
  );
  const row2 = await queryTikTok(
    `SELECT id, match_score, analysis_summary, match_analysis, updated_at FROM tiktok_campaign_influencer_candidates WHERE campaign_id = ? AND influencer_id = ?`,
    [TEST_CAMPAIGN, TEST_INF]
  );
  const u2 = row2?.[0]?.updated_at;

  const ma1 = typeof row1?.[0]?.match_analysis === "string" ? JSON.parse(row1[0].match_analysis) : row1?.[0]?.match_analysis;
  const ma2 = typeof row2?.[0]?.match_analysis === "string" ? JSON.parse(row2[0].match_analysis) : row2?.[0]?.match_analysis;

  await queryTikTok(
    `DELETE FROM tiktok_campaign_influencer_candidates WHERE campaign_id = ? AND influencer_id = ?`,
    [TEST_CAMPAIGN, TEST_INF]
  );

  const ok =
    r1.inserted === 1 &&
    r2.inserted === 0 &&
    Number(row2?.[0]?.match_score) === 10 &&
    String(row2?.[0]?.analysis_summary || "").includes("first") &&
    String(ma2?.analysis || "") === "first-analysis-body" &&
    String(u1) === String(u2);

  console.log(
    JSON.stringify(
      {
        ok,
        insertedFirst: r1.inserted,
        insertedSecond: r2.inserted,
        match_score_after_second: row2?.[0]?.match_score,
        analysis_summary_after_second: row2?.[0]?.analysis_summary,
        match_analysis_taskId: ma2?.taskId,
        updated_at_unchanged: String(u1) === String(u2),
      },
      null,
      2
    )
  );

  if (!ok) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
