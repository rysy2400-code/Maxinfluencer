/**
 * 回归测试：Campaign 执行阶段「单一工具调度器」合并后（导入单链路移除）的路由行为。
 *
 * 覆盖场景：
 * 1. @红人 + 回复/协商/报价 → ask_influencer_special_request（修复「暂不支持直接向达人发送消息」误路由）
 * 2. 名单导入第一轮（仅名单未同意）→ needTool=false + 确认回复
 * 3. 名单导入第二轮（用户「是的」）→ import_influencer_list + 从历史自动恢复 textItems
 * 4. Excel 附件导入 → import_influencer_list + 自动生成 attachmentPlan
 * 5. 导入但无任何名单来源 → 转成确认/引导，不调用工具
 * 6. 暂停/恢复 campaign → set_campaign_status
 * 7. 调整执行节奏 → set_execution_pacing
 * 8. 纯配置询问 → needTool=false 且 reply 留空（走配置快照回答）
 * 9. prompt 内含特殊请求优先级与导入两轮确认规则
 *
 * 运行：node scripts/test-execution-scheduler-merge.mjs
 * 真实 LLM 冒烟（可选，需 DEEPSEEK_API_KEY）：EXEC_SMOKE=1 node scripts/test-execution-scheduler-merge.mjs
 */
import assert from "node:assert/strict";
import {
  buildExecutionSchedulerPrompt,
  decideExecutionSchedulerTurn,
  parseExecutionSchedulerDecision,
} from "../lib/agents/campaign-execution-agent.js";
import { callDeepSeekLLM } from "../lib/utils/llm-client.js";

const BASE_INPUT = {
  campaignId: "camp-kspeaker",
  campaignStatusHint: "【当前 Campaign 数据库状态】running（自主模式）",
  campaignSnapshotHint: "【当前 Campaign 配置快照】品牌：Kspeaker；产品：K2BL 音响",
  toolsDesc: "- ask_influencer_special_request: 特殊请求\n- import_influencer_list: 导入名单\n- set_campaign_status: 状态\n- set_execution_pacing: 节奏",
};

function stubLlm(decisionJson) {
  return async () => JSON.stringify(decisionJson);
}

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✔ ${name}`);
}

async function run() {
  console.log("【1】解析器：兼容 markdown 代码块包裹的 JSON");
  {
    const d = parseExecutionSchedulerDecision(
      '```json\n{"needTool":true,"toolName":"set_campaign_status","params":{"action":"pause"}}\n```'
    );
    assert.equal(d.needTool, true);
    assert.equal(d.toolName, "set_campaign_status");
    assert.equal(d.params.action, "pause");
    ok("fenced JSON 解析");
  }

  console.log("【2】prompt 内容：特殊请求优先级 + 导入两轮确认规则");
  {
    const prompt = buildExecutionSchedulerPrompt({
      ...BASE_INPUT,
      lastMessage: "帮我回复下达人 @904outdoor，希望给出具体报价",
    });
    assert.match(prompt, /回复\/协商\/报价/);
    assert.match(prompt, /ask_influencer_special_request/);
    assert.match(prompt, /不要当作红人名单导入/);
    assert.match(prompt, /名单导入两轮确认/);
    assert.match(prompt, /import_influencer_list/);
    assert.match(prompt, /904outdoor/);
    ok("prompt 含特殊请求与导入规则");
  }

  console.log("【3】特殊请求：@红人 + 回复/报价 → ask_influencer_special_request");
  {
    const requestDetail =
      "帮我回复下达人 @904outdoor，我们认可你的内容，希望以「产品赞助+拍摄稿费+销售佣金」合作，请给出具体报价，合作细则如下：……";
    const { decision } = await decideExecutionSchedulerTurn(
      {
        ...BASE_INPUT,
        lastMessage: requestDetail,
        recentMessages: `user: ${requestDetail}`,
        messages: [{ role: "user", content: requestDetail }],
      },
      {
        callLlm: stubLlm({
          needTool: true,
          toolName: "ask_influencer_special_request",
          params: {
            influencerId: "@904outdoor",
            requestType: "adjust_price",
            requestDetail,
          },
        }),
      }
    );
    assert.equal(decision.toolName, "ask_influencer_special_request");
    assert.equal(decision.params.influencerId, "@904outdoor");
    assert.equal(decision.params.requestDetail, requestDetail);
    assert.equal(decision.params.requestType, "adjust_price");
    ok("回复达人消息路由到特殊请求");
  }

  console.log("【4】名单导入第一轮：仅名单未同意 → 确认回复，不调工具");
  {
    const { decision } = await decideExecutionSchedulerTurn(
      {
        ...BASE_INPUT,
        lastMessage: "https://www.tiktok.com/@alice_offroad 帮我看看这批红人",
        messages: [
          {
            role: "user",
            content: "https://www.tiktok.com/@alice_offroad 帮我看看这批红人",
          },
        ],
      },
      {
        callLlm: stubLlm({
          needTool: false,
          toolName: null,
          params: null,
          reply: "我看到你提供了 1 个红人主页链接，是否导入并分析后按节奏联系？",
        }),
      }
    );
    assert.equal(decision.needTool, false);
    assert.match(decision.reply, /是否导入/);
    ok("第一轮确认回复");
  }

  console.log("【5】名单导入第二轮：用户「是的」→ import + 历史恢复 textItems");
  {
    const messages = [
      {
        role: "user",
        content:
          "https://www.tiktok.com/@alice_offroad\nhttps://www.instagram.com/bob_trails 导入这批红人",
      },
      { role: "assistant", content: "我看到你提供了 2 个红人主页链接，是否导入并分析后联系？" },
      { role: "user", content: "是的" },
    ];
    const { decision } = await decideExecutionSchedulerTurn(
      {
        ...BASE_INPUT,
        lastMessage: "是的",
        recentMessages: messages.map((m) => `${m.role}: ${m.content}`).join("\n"),
        messages,
      },
      {
        callLlm: stubLlm({
          needTool: true,
          toolName: "import_influencer_list",
          params: {},
        }),
      }
    );
    assert.equal(decision.toolName, "import_influencer_list");
    assert.ok(Array.isArray(decision.params.textItems));
    assert.equal(decision.params.textItems.length, 2);
    assert.ok(decision.params.textItems.some((t) => t.profileUrl.includes("alice_offroad")));
    assert.equal(decision.params.userMessage, "是的");
    ok("确认后自动恢复名单");
  }

  console.log("【6】Excel 附件导入 → 自动生成 attachmentPlan");
  {
    const attachment = { storageKey: "sess-kspeaker/list.xlsx", name: "list.xlsx" };
    const { decision } = await decideExecutionSchedulerTurn(
      {
        ...BASE_INPUT,
        lastMessage: "这是名单，请导入",
        messages: [
          { role: "user", content: "这是名单，请导入", attachments: [attachment] },
        ],
        attachmentsForImport: [attachment],
      },
      {
        callLlm: stubLlm({
          needTool: true,
          toolName: "import_influencer_list",
          params: {},
        }),
      }
    );
    assert.equal(decision.toolName, "import_influencer_list");
    assert.equal(decision.params.attachmentPlan?.storageKey, "sess-kspeaker/list.xlsx");
    assert.equal(decision.params.attachmentPlan?.fileName, "list.xlsx");
    ok("附件导入 attachmentPlan 自动生成");
  }

  console.log("【7】导入但无名单来源 → 转成确认/引导，不调工具");
  {
    const { decision } = await decideExecutionSchedulerTurn(
      {
        ...BASE_INPUT,
        lastMessage: "好的",
        messages: [{ role: "user", content: "好的" }],
      },
      {
        callLlm: stubLlm({
          needTool: true,
          toolName: "import_influencer_list",
          params: {},
        }),
      }
    );
    assert.equal(decision.needTool, false);
    assert.equal(decision.toolName, null);
    assert.match(decision.reply, /没有识别到可导入的红人链接或附件/);
    ok("无名单来源时安全降级");
  }

  console.log("【8】暂停 campaign → set_campaign_status(pause)");
  {
    const { decision } = await decideExecutionSchedulerTurn(
      { ...BASE_INPUT, lastMessage: "暂停 campaign", messages: [{ role: "user", content: "暂停 campaign" }] },
      {
        callLlm: stubLlm({
          needTool: true,
          toolName: "set_campaign_status",
          params: { action: "pause" },
        }),
      }
    );
    assert.equal(decision.toolName, "set_campaign_status");
    assert.equal(decision.params.action, "pause");
    ok("状态切换路由");
  }

  console.log("【9】调整执行节奏 → set_execution_pacing");
  {
    const { decision } = await decideExecutionSchedulerTurn(
      { ...BASE_INPUT, lastMessage: "每天联系 20 位", messages: [{ role: "user", content: "每天联系 20 位" }] },
      {
        callLlm: stubLlm({
          needTool: true,
          toolName: "set_execution_pacing",
          params: { influencersPerDay: 20 },
        }),
      }
    );
    assert.equal(decision.toolName, "set_execution_pacing");
    assert.equal(decision.params.influencersPerDay, 20);
    ok("节奏调整路由");
  }

  console.log("【10】纯配置询问 → needTool=false 且 reply 留空（走配置快照）");
  {
    const { decision } = await decideExecutionSchedulerTurn(
      {
        ...BASE_INPUT,
        lastMessage: "交付结果是什么？",
        messages: [{ role: "user", content: "交付结果是什么？" }],
      },
      {
        callLlm: stubLlm({
          needTool: false,
          toolName: null,
          params: null,
          reply: "",
        }),
      }
    );
    assert.equal(decision.needTool, false);
    assert.equal(decision.reply, "");
    ok("配置询问路由");
  }

  // 可选：真实 LLM 冒烟（验证 prompt 对真实模型的引导效果）
  if (process.env.EXEC_SMOKE === "1") {
    console.log("【11】真实 LLM 冒烟（EXEC_SMOKE=1）");
    const requestDetail =
      "帮我回复下达人 @904outdoor，我们是满意该达人的内容的并且比较想和该达人合作，希望达人能根据我们的需求给到具体的报价，以下是合作的细则：非常感谢你的坦诚反馈！我们决定升级为「产品赞助+拍摄稿费+销售佣金」的商业模式。";
    for (const [label, statusHint] of [
      ["running（自主模式）", "running（自主模式）"],
      ["paused（已暂停）", "paused（已暂停）"],
      ["running_passive（名单模式）", "running_passive（名单模式）"],
    ]) {
      const { decision } = await decideExecutionSchedulerTurn(
        {
          ...BASE_INPUT,
          campaignStatusHint: `【当前 Campaign 数据库状态】${statusHint}`,
          lastMessage: requestDetail,
          recentMessages: `user: ${requestDetail}`,
          messages: [{ role: "user", content: requestDetail }],
        },
        { callLlm: callDeepSeekLLM }
      );
      console.log(`  [${label}] 决策:`, JSON.stringify({
        needTool: decision.needTool,
        toolName: decision.toolName,
        influencerId: decision.params?.influencerId,
        requestType: decision.params?.requestType,
      }));
      assert.equal(decision.needTool, true);
      assert.equal(decision.toolName, "ask_influencer_special_request");
      ok(`真实 LLM 识别回复达人意图（${label}）`);
    }
  }

  console.log(`\n全部通过：${passed} 项 ✔`);
}

run().catch((err) => {
  console.error("\n测试失败:", err);
  process.exit(1);
});
