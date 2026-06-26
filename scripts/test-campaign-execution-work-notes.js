/**
 * 按工作笔记顺序测试 Campaign 执行 Agent：工具调用 + DB + report-config 工作笔记字段
 *
 * 用法：node scripts/test-campaign-execution-work-notes.js
 * 可选：CAMPAIGN_ID=... SESSION_ID=... node scripts/test-campaign-execution-work-notes.js
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { AgentRouter } from "../lib/utils/agent-router.js";
import { getCampaignById } from "../lib/db/campaign-dao.js";
import { getReportConfigByCampaignId } from "../lib/db/campaign-report-config-dao.js";
import { buildCampaignWorkNotesSummary } from "../lib/campaign/format-work-notes-summary.js";
import { CAMPAIGN_STATUS_UI_LABEL } from "../lib/tools/campaign-execution/campaign-execution-tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const CAMPAIGN_ID = process.env.CAMPAIGN_ID || "CAMP-1781189169673-I97DAPHV2";
const SESSION_ID = process.env.SESSION_ID || "bd30b9e3-ae7e-4719-85f5-c771669139bb";
const TEST_IDS = process.env.TEST_IDS
  ? process.env.TEST_IDS.split(",").map((s) => s.trim()).filter(Boolean)
  : null;

const METRIC_LABELS = {
  pending_price_count: "待审核价格数量",
  pending_sample_count: "待寄样品数量",
  pending_draft_count: "待审核草稿数量",
  published_count: "已发布视频数量",
};

function buildWorkNotesView(campaign, reportConfig) {
  const summary = buildCampaignWorkNotesSummary(campaign) || {};
  const status = campaign?.status || "running";
  const rc = reportConfig || {};
  return {
    brand: summary.brand,
    product: summary.product,
    platform: summary.platform,
    region: summary.region,
    publishTimeRange: summary.publishTimeRange,
    totalBudget: summary.totalBudget,
    commission: summary.commission,
    pricingStrategy: summary.pricingStrategy,
    deliverables: summary.deliverables,
    followerRange: summary.followerRange,
    viewRange: summary.viewRange,
    accountType: summary.accountType,
    influencersPerDay: campaign?.influencersPerDay ?? null,
    statusLabel: CAMPAIGN_STATUS_UI_LABEL[status] || status,
    intervalHours: rc.intervalHours ?? null,
    reportTime: rc.reportTime ?? null,
    contentPreference: rc.contentPreference ?? null,
    includeMetrics: Array.isArray(rc.includeMetrics) ? rc.includeMetrics : [],
    keywordStrategy: campaign?.keywordStrategy || null,
  };
}

function includesMetric(metrics, key) {
  return Array.isArray(metrics) && metrics.includes(key);
}

/** @type {Array<{ id: string, message: string, expectTool: string, verify: (c: object, rc: object, wn: object) => boolean|string }>} */
const CASES = [
  {
    id: "brand",
    message: "品牌改为 Anker",
    expectTool: "modify_campaign",
    verify: (c) => c.productInfo?.brandName === "Anker",
  },
  {
    id: "product",
    message: "产品名改为 SmartRing",
    expectTool: "modify_campaign",
    verify: (c) => c.productInfo?.productName === "SmartRing",
  },
  {
    id: "platform",
    message: "投放平台改为 YouTube",
    expectTool: "modify_campaign",
    verify: (c) => {
      const p = c.campaignInfo?.platform;
      return p === "YouTube" || (Array.isArray(p) && p.includes("YouTube"));
    },
  },
  {
    id: "region",
    message: "投放地区改为 英国",
    expectTool: "modify_campaign",
    verify: (c) => String(c.campaignInfo?.region || "").includes("英国"),
  },
  {
    id: "publishTimeRange",
    message: "发布时间段改为 8月-9月",
    expectTool: "modify_campaign",
    verify: (c) => c.campaignInfo?.publishTimeRange === "8月-9月",
  },
  {
    id: "budget",
    message: "总预算改为 50000",
    expectTool: "modify_campaign",
    verify: (c) => Number(c.campaignInfo?.budget) === 50000,
  },
  {
    id: "commission",
    message: "佣金改为 15",
    expectTool: "modify_campaign",
    verify: (c) => Number(c.campaignInfo?.commission) === 15,
  },
  {
    id: "pricing",
    message: "ecpm 改成 5，上限 800",
    expectTool: "modify_campaign",
    verify: (c) => {
      const p = c.campaignInfo?.influencerPricing;
      return p && Number(p.ecpmUsd) === 5 && Number(p.maxFlatFeeUsd) === 800;
    },
  },
  {
    id: "deliverables",
    message: "交付结果改为 2 条专属视频，Bio 链接保留 30 天",
    expectTool: "modify_campaign",
    verify: (c) => {
      const d = c.campaignInfo?.deliverables;
      return typeof d === "string" && d.includes("2") && d.includes("30");
    },
  },
  {
    id: "followerRange",
    message: "红人粉丝量要求改为 1万-50万",
    expectTool: "modify_campaign",
    verify: (c) => c.influencerProfile?.followerRange === "1万-50万",
  },
  {
    id: "viewRange",
    message: "红人播放量要求改为 5万以上",
    expectTool: "modify_campaign",
    verify: (c) => c.influencerProfile?.viewRange === "5万以上",
  },
  {
    id: "accountType",
    message: "红人帐号类型改为 健身博主",
    expectTool: "modify_campaign",
    verify: (c) => c.influencerProfile?.accountType === "健身博主",
  },
  {
    id: "pacing",
    message: "每天联系50位红人",
    expectTool: "set_execution_pacing",
    verify: (c) => c.influencersPerDay === 50,
  },
  {
    id: "resume",
    message: "恢复campaign",
    expectTool: "set_campaign_status",
    verify: (c) => c.status === "running",
  },
  {
    id: "pause",
    message: "暂停campaign",
    expectTool: "set_campaign_status",
    verify: (c) => c.status === "paused",
  },
  {
    id: "intervalHours",
    message: "每2天汇报一次",
    expectTool: "set_report_schedule",
    verify: (_c, rc) => rc?.intervalHours === 48,
  },
  {
    id: "reportTime",
    message: "汇报时间改为每日09:00",
    expectTool: "set_report_schedule",
    verify: (_c, rc) => rc?.reportTime === "09:00",
  },
  {
    id: "contentPreference",
    message: "汇报形式改为详细报告",
    expectTool: "set_report_schedule",
    verify: (_c, rc) => rc?.contentPreference === "detailed",
  },
  {
    id: "includeMetrics",
    message: "日报里多加待寄样品数量",
    expectTool: "set_report_schedule",
    verify: (_c, rc) => includesMetric(rc?.includeMetrics, "pending_sample_count"),
  },
  {
    id: "keywordStrategy",
    message: "关键词策略改为 大学生社交App",
    expectTool: "modify_campaign",
    verify: (c) => String(c.keywordStrategy || "").includes("大学生社交App"),
  },
];

function isReplyTooVerbose(reply) {
  const text = String(reply || "");
  return (
    text.includes("当前工作笔记将显示") ||
    text.includes("并通知红人经纪人同步给相关红人") ||
    /投放平台.*投放地区.*总预算/s.test(text)
  );
}

async function runCase(testCase, context) {
  const router = new AgentRouter();
  const messages = [{ role: "user", content: testCase.message }];
  const started = Date.now();
  const result = await router.process(messages, context);
  const elapsedMs = Date.now() - started;

  const toolName = result.thinking?.toolCall?.toolName || null;
  const toolOk = toolName === testCase.expectTool;

  const campaign = await getCampaignById(CAMPAIGN_ID);
  const reportConfig = await getReportConfigByCampaignId(CAMPAIGN_ID);
  const workNotes = buildWorkNotesView(campaign, reportConfig);

  let dbOk = false;
  let dbDetail = "";
  try {
    const v = testCase.verify(campaign, reportConfig, workNotes);
    if (v === true) dbOk = true;
    else if (v === false) dbOk = false;
    else {
      dbOk = false;
      dbDetail = String(v);
    }
  } catch (e) {
    dbDetail = e.message;
  }

  const reply = result.reply || "";
  const replyOk = !isReplyTooVerbose(reply) && reply.length <= 120;

  return {
    id: testCase.id,
    message: testCase.message,
    expectTool: testCase.expectTool,
    actualTool: toolName,
    toolOk,
    dbOk,
    dbDetail,
    replyOk,
    reply: reply.slice(0, 200),
    elapsedMs,
    workNotes,
    subAgentSuccess: result.thinking?.subAgentResult?.success,
  };
}

async function main() {
  console.log(`\n========== Campaign 执行 Agent 工作笔记测试 ==========`);
  console.log(`Campaign: ${CAMPAIGN_ID}`);
  console.log(`Session:  ${SESSION_ID}\n`);

  const context = {
    campaignId: CAMPAIGN_ID,
    sessionId: SESSION_ID,
    published: true,
    workflowState: "published",
  };

  const casesToRun = TEST_IDS ? CASES.filter((c) => TEST_IDS.includes(c.id)) : CASES;
  if (TEST_IDS && casesToRun.length === 0) {
    console.error(`TEST_IDS 未匹配任何 case: ${TEST_IDS.join(", ")}`);
    process.exit(1);
  }

  const results = [];
  for (const testCase of casesToRun) {
    process.stdout.write(`[${testCase.id}] ${testCase.message} ... `);
    try {
      const r = await runCase(testCase, context);
      results.push(r);
      const pass = r.toolOk && r.dbOk && r.replyOk;
      console.log(pass ? "PASS" : "FAIL");
      if (!pass) {
        if (!r.toolOk) console.log(`  tool: expected ${testCase.expectTool}, got ${r.actualTool}`);
        if (!r.dbOk) console.log(`  db: not updated${r.dbDetail ? ` (${r.dbDetail})` : ""}`);
        if (!r.replyOk) console.log(`  reply: too verbose or long → ${r.reply}`);
      }
    } catch (e) {
      console.log("ERROR");
      console.log(`  ${e.message}`);
      results.push({
        id: testCase.id,
        message: testCase.message,
        error: e.message,
        toolOk: false,
        dbOk: false,
        replyOk: false,
      });
    }
  }

  const passed = results.filter((r) => r.toolOk && r.dbOk && r.replyOk).length;
  const failed = results.filter((r) => !(r.toolOk && r.dbOk && r.replyOk));

  console.log(`\n========== 汇总: ${passed}/${casesToRun.length} 通过 ==========\n`);
  if (failed.length) {
    console.log("失败项:");
    for (const f of failed) {
      console.log(`- ${f.id}: tool=${f.actualTool || f.error} db=${f.dbOk} reply=${f.replyOk}`);
    }
  }

  const outPath = path.join(projectRoot, "scripts", "test-campaign-execution-work-notes-result.json");
  fs.writeFileSync(outPath, JSON.stringify({ campaignId: CAMPAIGN_ID, passed, total: casesToRun.length, results }, null, 2));
  console.log(`\n详细结果: ${outPath}\n`);

  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
