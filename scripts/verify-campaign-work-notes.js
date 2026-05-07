/**
 * 验证某 campaign 的关键词任务与工作笔记 API 数据是否一致。
 *
 * 用法：
 *   node scripts/verify-campaign-work-notes.js CAMP-xxx
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const campaignId = process.argv[2];
const API_LIMIT = 50;

async function main() {
  if (!campaignId) {
    console.error("用法: node scripts/verify-campaign-work-notes.js <campaign_id>");
    process.exit(1);
  }

  console.log(`Campaign: ${campaignId}\n`);

  const [totalRow] = await queryTikTok(
    `SELECT COUNT(*) AS n FROM tiktok_influencer_search_task WHERE campaign_id = ?`,
    [campaignId]
  );
  const totalTasks = Number(totalRow?.n ?? 0);
  console.log(`tiktok_influencer_search_task 总行数: ${totalTasks}`);

  const [withKeywordRow] = await queryTikTok(
    `
    SELECT COUNT(*) AS n
    FROM tiktok_influencer_search_task
    WHERE campaign_id = ?
      AND keyword IS NOT NULL
      AND TRIM(keyword) <> ''
    `,
    [campaignId]
  );
  console.log(`其中 keyword 非空的任务数: ${Number(withKeywordRow?.n ?? 0)}`);

  const lim = Math.min(Math.max(Number(API_LIMIT) || 50, 1), 500);
  const apiSliceRows = await queryTikTok(
    `
    SELECT t.id AS taskId, t.keyword, COALESCE(t.started_at, t.created_at) AS noteTime
    FROM tiktok_influencer_search_task t
    WHERE t.campaign_id = ?
    ORDER BY COALESCE(t.started_at, t.created_at) DESC, t.id DESC
    LIMIT ${lim}
    `,
    [campaignId]
  );
  console.log(
    `API 默认逻辑返回的任务条数 (LIMIT ${API_LIMIT}, DESC): ${(apiSliceRows || []).length}`
  );
  if (totalTasks > API_LIMIT) {
    console.log(
      `  ⚠️ 总任务数 ${totalTasks} > ${API_LIMIT}，更早的任务不会出现在 /work-notes 默认响应中`
    );
  }

  const joinStats = await queryTikTok(
    `
    SELECT
      SUM(CASE WHEN r1.id IS NOT NULL THEN 1 ELSE 0 END) AS hit_task_id,
      SUM(CASE WHEN r1.id IS NULL AND r2.id IS NOT NULL THEN 1 ELSE 0 END) AS hit_fallback_run_kw,
      SUM(CASE WHEN r1.id IS NULL AND r2.id IS NULL THEN 1 ELSE 0 END) AS no_result_row
    FROM tiktok_influencer_search_task t
    LEFT JOIN tiktok_keyword_run_result r1 ON r1.task_id = t.id
    LEFT JOIN tiktok_keyword_run_result r2
      ON r1.id IS NULL
     AND r2.campaign_id = t.campaign_id
     AND r2.run_id = t.run_id
     AND r2.keyword = t.keyword
    WHERE t.campaign_id = ?
      AND t.keyword IS NOT NULL
      AND TRIM(t.keyword) <> ''
    `,
    [campaignId]
  );
  const j = joinStats?.[0] || {};
  console.log("\n与 tiktok_keyword_run_result 关联（仅 keyword 非空任务）:");
  console.log(`  通过 task_id 命中: ${Number(j.hit_task_id ?? 0)}`);
  console.log(`  仅通过 campaign_id+run_id+keyword 命中: ${Number(j.hit_fallback_run_kw ?? 0)}`);
  console.log(`  两行都未命中: ${Number(j.no_result_row ?? 0)}`);

  const orphanSample = await queryTikTok(
    `
    SELECT t.id, t.keyword, t.run_id, t.status,
           COALESCE(t.started_at, t.created_at) AS t_time
    FROM tiktok_influencer_search_task t
    LEFT JOIN tiktok_keyword_run_result r1 ON r1.task_id = t.id
    LEFT JOIN tiktok_keyword_run_result r2
      ON r1.id IS NULL
     AND r2.campaign_id = t.campaign_id
     AND r2.run_id = t.run_id
     AND r2.keyword = t.keyword
    WHERE t.campaign_id = ?
      AND t.keyword IS NOT NULL
      AND TRIM(t.keyword) <> ''
      AND r1.id IS NULL
      AND r2.id IS NULL
    ORDER BY t.id DESC
    LIMIT 8
    `,
    [campaignId]
  );
  if (orphanSample?.length) {
    console.log("\n未关联到 run_result 的样例 (最多 8 条):");
    for (const r of orphanSample) {
      console.log(
        `  task_id=${r.id} status=${r.status} run_id=${r.run_id} kw=${JSON.stringify(r.keyword)}`
      );
    }
  }

  const enrichStats = await queryTikTok(
    `
    SELECT
      MIN(COALESCE(r1.enrich_success_count, r2.enrich_success_count)) AS min_e,
      MAX(COALESCE(r1.enrich_success_count, r2.enrich_success_count)) AS max_e,
      AVG(COALESCE(r1.enrich_success_count, r2.enrich_success_count)) AS avg_e,
      SUM(CASE WHEN COALESCE(r1.enrich_success_count, r2.enrich_success_count) IS NULL THEN 1 ELSE 0 END) AS null_enrich
    FROM tiktok_influencer_search_task t
    LEFT JOIN tiktok_keyword_run_result r1 ON r1.task_id = t.id
    LEFT JOIN tiktok_keyword_run_result r2
      ON r1.id IS NULL
     AND r2.campaign_id = t.campaign_id
     AND r2.run_id = t.run_id
     AND r2.keyword = t.keyword
    WHERE t.campaign_id = ?
      AND t.keyword IS NOT NULL
      AND TRIM(t.keyword) <> ''
    `,
    [campaignId]
  );
  const e = enrichStats?.[0];
  if (e) {
    console.log("\nenrich_success_count（API 展示的「已提取」来源）:");
    console.log(`  min=${e.min_e} max=${e.max_e} avg=${Number(e.avg_e || 0).toFixed(2)}`);
    console.log(`  关联后计数仍为 NULL 的任务数: ${Number(e.null_enrich ?? 0)}`);
  }

  console.log("\n完成。");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
