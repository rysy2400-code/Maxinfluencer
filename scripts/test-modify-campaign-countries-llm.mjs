#!/usr/bin/env node
/**
 * 验证 LLM 调度器能否把用户口语里的 "uk/UK" 识别为官方 ISO 代码 GB。
 *
 * 用法：node scripts/test-modify-campaign-countries-llm.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { decideExecutionSchedulerTurn } from "../lib/agents/campaign-execution-agent.js";
import { CAMPAIGN_EXECUTION_TOOL_SCHEMAS } from "../lib/tools/campaign-execution/campaign-execution-tools.js";
import { normalizeModifyCampaignChanges } from "../lib/campaign/normalize-modify-campaign-changes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const toolsDesc = CAMPAIGN_EXECUTION_TOOL_SCHEMAS.map(
  (t) => `- ${t.name}: ${t.description}`
).join("\n");

async function main() {
  const cases = [
    { message: "投放地区改为 uk", expected: ["GB"] },
    { message: "投放地区改为 欧洲", expected: null, minLength: 2 },
  ];

  for (const item of cases) {
    const input = {
      campaignId: "CAMP-LLM-TEST",
      campaignStatusHint: "",
      campaignSnapshotHint: "",
      contractFinalizationContext: "",
      lastMessage: item.message,
      recentMessages: `user: ${item.message}`,
      attachmentsContext: "",
      toolsDesc,
    };
    const { decision } = await decideExecutionSchedulerTurn(input);
    console.log(`=== ${item.message} 调度器输出 ===`);
    console.log(JSON.stringify(decision, null, 2));

    const changes = decision.params?.changes || {};
    const normalized = normalizeModifyCampaignChanges(changes);
    const countries = normalized.changes?.countries || null;

    if (decision.needTool !== true || decision.toolName !== "modify_campaign") {
      console.error(`FAIL: ${item.message} 未走 modify_campaign`);
      process.exit(1);
    }
    if (normalized.error) {
      console.error(`FAIL: ${item.message} 归一化失败: ${normalized.error}`);
      process.exit(1);
    }
    if (item.expected) {
      if (JSON.stringify(countries) !== JSON.stringify(item.expected)) {
        console.error(`FAIL: 期望 countries =`, item.expected);
        process.exit(1);
      }
    } else if (!Array.isArray(countries) || countries.length < item.minLength) {
      console.error(`FAIL: 期望展开成至少 ${item.minLength} 个 ISO`);
      process.exit(1);
    }
    console.log(`OK: ${item.message} → ${JSON.stringify(countries)}`);
  }

  console.log("OK: LLM 已将 uk 识别为 GB，且欧洲可展开为 ISO 列表");
  process.exit(0);
}

main().catch((err) => {
  console.error("调用 LLM 失败:", err?.message || err);
  process.exit(1);
});
