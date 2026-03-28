# BinAgent 与子 Agent 确认流程 — 修改建议

## 一、当前逻辑简要结论

- **产品信息确认**：用户说「确认」等 → BinAgent 后处理强制调用 `product_info_agent` → Router 调用 `ProductInfoAgent.confirmProductInfo` → 返回 `isConfirmed` → Router 将状态推进到 `step_2_campaign_info` 并 **直接 return**，本次请求结束。
- **投放信息确认**：用户说「确认」等 → BinAgent 后处理强制调用 `campaign_info_agent` → Router 调用 `CampaignInfoAgent.collectCampaignInfo` → 返回 `isConfirmed` → Router 将状态推进到 `step_3_influencer_profile` 并 **直接 return**，本次请求结束。
- **红人画像阶段**：`step_3` 且 **没有** `influencerProfile` 时，BinAgent 会在**下一次**用户发消息时自动调用 `influencer_profile_agent`；但若**已有** `influencerProfile` 且用户说「确认」，Prompt 要求 **不调用工具**，导致不会调用任何子 agent，Router 无法得到 `isConfirmed`，**状态无法从 step_3 推进到 step_4**。
- **内容/脚本确认**：同理，`step_4` 且用户说「确认」时 Prompt 要求不调用工具，**状态无法从 step_4 推进到 step_5**。
- **发布确认**：`step_5_publish_confirm` 时 BinAgent 开头会强制调用 `campaign_publish_agent`，逻辑正确。

---

## 二、你期望的规则（目标）

- 用户**确认产品信息**后 → **调用下一阶段子 agent**：即 `campaign_info_agent`（收集/询问投放信息）。
- 用户**确认投放信息**后 → **调用下一阶段子 agent**：即红人画像确认 agent（`influencer_profile_agent`）。
- 用户**确认红人画像**后 → **调用下一阶段子 agent**：即 `content_requirement_agent`（生成脚本）。
- 用户**确认脚本/内容要求**后 → **调用下一阶段子 agent**：即 `campaign_publish_agent`（发布确认）。

即：**每次「确认」都应触发「当前阶段确认 + 下一阶段子 agent 被调用」**。

---

## 三、存在的问题

### 1. 确认后没有「立刻」进入下一阶段（仅更新状态就结束）

- **产品确认**：状态变为 `step_2` 后直接 return，没有在同一轮里再调用 `campaign_info_agent` 来输出「请提供投放信息：平台、地区…」。
- **投放确认**：状态变为 `step_3` 后直接 return，没有在同一轮里调用 `influencer_profile_agent` 开始推荐红人（用户需要再发一条消息才会触发推荐）。

**影响**：用户说「确认」后，需要多发一条消息才能进入下一阶段，体验不连贯。

### 2. 红人画像 / 内容要求「仅确认」时没有调用当前阶段 agent

- **step_3 + 已有 influencerProfile + 用户说「确认」**：Prompt 要求此时 **不调用工具** → BinAgent 返回 `needTool: false` → Router 不调用 `influencer_profile_agent` → 无法得到 `isConfirmed` → **状态不会从 step_3 推进到 step_4**。
- **step_4 + 已有 contentScript + 用户说「确认」**：同样不调用 `content_requirement_agent` → **状态不会从 step_4 推进到 step_5**。

**影响**：用户确认红人画像或确认脚本后，流程卡在当前步骤，无法自动进入下一步。

### 3. 链式调用下一阶段的方式未统一

- 目前只有 `step_3` 无 profile 时在**下一次**用户消息自动调 `influencer_profile_agent`；`step_5` 时自动调 `campaign_publish_agent`。
- 产品确认 → 投放、投放确认 → 红人、红人确认 → 脚本，都**没有**在「确认当轮」链式调用下一阶段 agent。

---

## 四、修改建议（仅建议，不直接改代码）

### 建议 1：BinAgent — 增加「仅确认」时的强制调用（补洞）

**目的**：保证「用户只说确认」时，当前阶段 agent 仍被调用并返回 `isConfirmed`，Router 才能推进状态。

- **红人画像确认**  
  - 条件：`!toolDecision.needTool` 且 `currentWorkflowState === step_3_influencer_profile` 且 `context.influencerProfile` 存在，且用户消息包含确认类关键词（如「确认」「可以」「没问题」「继续」「下一步」等）。  
  - 动作：**后处理**强制 `toolDecision = { needTool: true, toolName: "influencer_profile_agent", params: {} }`。  
  - 效果：Router 会调用 `InfluencerProfileAgent.recommendInfluencers`；agent 内已有「已有 profile + 非调整」的短路逻辑，会直接走 `detectConfirmation` 并返回 `isConfirmed: true`，Router 即可把状态推进到 step_4。

- **内容要求确认**  
  - 条件：`!toolDecision.needTool` 且 `currentWorkflowState === step_4_content_requirement` 且 `context.contentScript` 存在，且用户消息包含确认类关键词。  
  - 动作：**后处理**强制 `toolDecision = { needTool: true, toolName: "content_requirement_agent", params: {} }`。  
  - 效果：ContentRequirementAgent 内部会走确认逻辑并返回 `isConfirmed`，Router 可推进到 step_5。

这样无需改 Prompt 的「确认时不调用」规则，只需在后处理里对「纯确认」做补丁，即可解决状态不推进的问题。

---

### 建议 2：AgentRouter — 确认当轮「链式调用」下一阶段 agent

**目的**：用户确认某阶段后，**同一次请求**内就进入下一阶段并执行对应子 agent，而不是等用户再发一条消息。

- **产品信息确认后（step_1 → step_2）**  
  - 在 `product_info_agent` 分支中：若 `productResult.isConfirmed === true` 且 `nextWorkflowState === step_2_campaign_info`，在写好 `newContext`（含 `workflowState: step_2`）后，**不要直接 return**。  
  - 同一轮内再调用一次 `campaign_info_agent.collectCampaignInfo(messages, newContext)`（不要求用户本条消息带投放信息），用其返回的 `reply` 作为「引导语」（如「请提供投放信息：平台、地区、预算…」）。  
  - 最终回复可拼接：`产品信息已确认。` + campaign 的 reply，或仅用 campaign 的 reply。  
  - 这样用户说「确认产品」后，一次请求内就会看到「请提供投放信息」的引导，无需再发一句。

- **投放信息确认后（step_2 → step_3）**  
  - 在 `campaign_info_agent` 分支中：若 `campaignResult.isConfirmed === true` 且 `nextWorkflowState === step_3_influencer_profile`，在写好 `newContext` 后，**不要直接 return**。  
  - 同一轮内再调用 `influencer_profile_agent.recommendInfluencers(messages, newContext, influencerStepUpdate)`。  
  - 注意：推荐红人会执行搜索、分析等，耗时可较长，需要保留现有 SSE/流式更新（`influencerStepUpdate`），并考虑请求超时与前端等待提示。  
  - 若产品/团队希望「确认投放后先立刻回复一句再后台跑推荐」，可改为：先 return「投放信息已确认，正在为你推荐红人…」+ 更新 context 为 step_3，由**下一次**用户消息再触发 `influencer_profile_agent`（即保持现状）。若要严格符合「确认后立刻调用下一阶段 agent」，则建议采用同一轮链式调用。

- **红人画像确认后（step_3 → step_4）**  
  - 在 `influencer_profile_agent` 分支中：若 `influencerResult.isConfirmed === true` 且 `nextWorkflowState === step_4_content_requirement`，在写好 `newContext` 后，**不要直接 return**。  
  - 同一轮内再调用 `content_requirement_agent.generateContent(messages, newContext)`，用其 `reply`（及生成的脚本等）作为最终回复。  
  - 这样用户说「确认红人」后，一次请求内就会进入脚本生成并看到结果。

- **内容要求确认后（step_4 → step_5）**  
  - 在 `content_requirement_agent` 分支中：若 `contentResult.isConfirmed === true` 且 `nextWorkflowState === step_5_publish_confirm`，在写好 `newContext` 后，**不要直接 return**。  
  - 同一轮内再调用 `campaign_publish_agent.confirmAndPublish(messages, newContext)`，用其 `reply`（汇总信息、确认发布或引导最终确认）作为最终回复。  
  - 这样用户说「确认脚本」后，一次请求内就会进入发布确认阶段。

链式调用时要注意：  
- 每条分支内 `thinking`、`sendThinkingUpdate` 要正确追加「第二段」子 agent 的步骤与结果，避免覆盖前一段。  
- 若第二段是 `influencer_profile_agent`，需保留并传入现有的 `influencerStepUpdate` 等回调，以维持截图、步骤等流式展示。

---

### 建议 3：BinAgent — 意图 Prompt 的微调（可选）

- 在「判断规则」或示例中明确说明：  
  - 「当用户**仅**说确认类词语（如确认、可以、没问题、继续、下一步）且当前阶段信息已齐全时，仍应返回调用**当前阶段**对应的 agent（如 step_3 时返回 `influencer_profile_agent`，step_4 时返回 `content_requirement_agent`），由该 agent 负责判断是否确认并返回 isConfirmed，以便路由推进状态。」  
- 这样 LLM 在「仅确认」场景下更倾向于返回 needTool: true，再配合建议 1 的后处理，可进一步减少漏调。

---

### 建议 4：终端现象与「引导消息」逻辑

- 你提供的终端片段：`[BinAgent] 意图识别返回: needTool: false`，且 `[AgentRouter] 检测到引导消息，不更新工作流状态`。  
- 说明当时 BinAgent 返回了 `toolCall: null` 且带了一条被识别为「引导消息」的 reply。  
- 若当时处于 step_3 且已有 influencerProfile，且用户发的是「确认」类消息，则符合上面「确认时不调用工具」的漏洞：没有调用 `influencer_profile_agent`，状态未更新；若 reply 里包含「当前步骤」「当前任务」等，又会被 Router 判为引导消息，保持状态不变。  
- 落实 **建议 1** 后，同场景下会强制调用 `influencer_profile_agent`，不再走「直接回复 + 引导消息」分支，状态可正常推进。

---

## 五、实施优先级建议

1. **优先**：建议 1（BinAgent 后处理：step_3 / step_4 仅确认时强制调用当前阶段 agent）— 改动小，立刻修复「确认后状态不推进」的问题。  
2. **其次**：建议 2 中 **产品确认 → 链式调用 campaign_info_agent**（step_1 → step_2）— 实现简单，且 campaign_info_agent 仅返回引导语，无长耗时。  
3. **再次**：建议 2 中 **红人确认 → content_requirement_agent**、**脚本确认 → campaign_publish_agent**（step_3→4、step_4→5）— 同轮链式调用，体验连贯。  
4. **最后**：建议 2 中 **投放确认 → influencer_profile_agent**（step_2 → step_3）— 需考虑长耗时与 SSE/超时，可先做「先回复再下次触发」或同轮链式二选一，再按产品需求定稿。  
5. **可选**：建议 3（Prompt 微调），作为对建议 1 的补充。

以上为「只给修改建议、不开发」的完整说明，可按优先级分步实现。
