/**
 * Campaign Execution Agent 工具定义
 *
 * 用于发布 campaign 后的执行阶段，支持：
 * 1. 定时汇报（配置汇报间隔、内容偏好、执行速度）
 * 2. 修改 campaign（整体或单个红人，并同步给红人经纪人 agent）
 * 3. 与红人沟通特殊情况（传给红人经纪人 agent，回收反馈并同步广告主）
 */

import {
  getCampaignById,
  updateCampaign,
  getCampaignExecutionStatus as getStatusFromDao,
  getExecutionRow,
  updateExecutionStage,
} from "../../db/campaign-dao.js";
import { getReportConfigByCampaignId, upsertReportConfig } from "../../db/campaign-report-config-dao.js";
import { createSpecialRequest, getSpecialRequestByRequestId } from "../../db/influencer-special-request-dao.js";
import { runExecutionHeartbeatTick } from "../../heartbeat/execution-heartbeat.js";

// ==================== Tool Schemas（供 LLM 意图识别 / 函数调用） ====================

/**
 * 工具定义列表，格式兼容 OpenAI function calling / DeepSeek 工具格式
 */
export const CAMPAIGN_EXECUTION_TOOL_SCHEMAS = [
  {
    name: "set_report_schedule",
    description: "设置广告主的定时汇报偏好。可配置汇报时间间隔（以小时为单位，如 24h、48h、168h）、汇报时间点（如每天 9:00）、汇报内容偏好（简要/详细、包含哪些指标）。用户说「每两天上午 9 点汇报一次」「每 6 小时汇报一次」「以后日报里多加一下待审核草稿数」等，都应该调用此工具。",
    parameters: {
      type: "object",
      properties: {
        campaignId: {
          type: "string",
          description: "Campaign ID",
        },
        intervalHours: {
          type: "number",
          description: "两次汇报之间的间隔（小时）。例如：24=每天一次，48=每2天一次，168=每周一次。支持 0.5–336 小时区间。",
        },
        reportTime: {
          type: "string",
          description: "汇报时间，格式 HH:mm（24 小时制），如 09:00",
        },
        contentPreference: {
          type: "string",
          enum: ["brief", "detailed", "summary_only"],
          description: "汇报内容偏好：brief=简要, detailed=详细, summary_only=仅汇总",
        },
        includeMetrics: {
          type: "array",
          items: { type: "string" },
          description:
            "希望包含的指标，如 ['pending_price_count', 'pending_sample_count', 'pending_draft_count', 'published_count']。当需要在原有基础上“多加一个指标”时，请先读取现有配置，再在数组中追加新指标整体写回。",
        },
      },
      required: ["campaignId"],
    },
  },
  {
    name: "set_execution_pacing",
    description: "设置 campaign 执行速度，控制每天联系多少位红人。如每天 5 位、10 位等。用户说「每天联系 20 位」「以后每天只联系 3 个」等，优先使用 influencersPerDay 填入用户给出的数字；只有在用户没有给出具体数字、只说「慢一点/快一点/正常」时，才使用 pacingMode。",
    parameters: {
      type: "object",
      properties: {
        campaignId: {
          type: "string",
          description: "Campaign ID",
        },
        influencersPerDay: {
          type: "number",
          description: "每天联系的红人数量",
        },
        pacingMode: {
          type: "string",
          enum: ["slow", "normal", "fast", "custom"],
          description: "预设节奏：slow=慢(3/天), normal=正常(5/天), fast=快(10/天), custom=自定义（用 influencersPerDay）",
        },
      },
      required: ["campaignId"],
    },
  },
  {
    name: "set_campaign_status",
    description:
      "调整 campaign 生命周期状态（仅影响自动拉新与定时汇报；队列中搜索会跑完；红人回信与手动操作不受影响）。pause=暂停自动拉新；resume=恢复自动拉新；complete=标记 campaign 已完成并停止自动拉新/汇报。用户说「暂停」「pause campaign」等 → pause；「继续」「resume」等 → resume；「campaign 完成了」「可以结束了」「mark complete」「end campaign」等 → complete。",
    parameters: {
      type: "object",
      properties: {
        campaignId: {
          type: "string",
          description: "Campaign ID",
        },
        action: {
          type: "string",
          enum: ["pause", "resume", "complete"],
          description: "pause=暂停自动拉新；resume=恢复；complete=标记已完成",
        },
        status: {
          type: "string",
          enum: ["running", "paused", "completed"],
          description: "与 action 二选一：paused/running/completed",
        },
      },
      required: ["campaignId"],
    },
  },
  {
    name: "modify_campaign",
    description:
      "修改已发布 campaign 的内容。可针对整体或单个红人修改。整体修改支持：投放与预算（publishTimeRange/budget 等）、红人画像 screeningConditions（与 influencer_profile 对齐：followerRange 粉丝量、viewRange 播放量、accountType 帐号类型/内容方向）、内容要求 contentRequirements、关键词策略 keywordStrategy（供搜索关键词生成参考）。修改后需同步给红人经纪人 agent。",
    parameters: {
      type: "object",
      properties: {
        campaignId: {
          type: "string",
          description: "Campaign ID",
        },
        scope: {
          type: "string",
          enum: ["whole", "single_influencer"],
          description:
            "修改范围：whole=整单（关键词策略 keywordStrategy、红人画像 screeningConditions、内容要求等均必须用 whole）；single_influencer=仅单个红人且必须带 influencerId。改关键词策略时只能填 whole。",
        },
        influencerId: {
          type: "string",
          description: "当 scope 为 single_influencer 时必填，红人 ID",
        },
        changes: {
          type: "object",
          description: "具体修改内容",
          properties: {
            screeningConditions: {
              type: "object",
              description:
                "红人画像字段，写入 tiktok_campaign.influencer_profile：followerRange（粉丝量要求）、viewRange（播放量要求）、accountType（帐号类型与内容方向，可为长文本）。可只改其中若干项。",
            },
            publishTimeRange: {
              type: "string",
              description: "发布时间范围，如 2024-04-01 至 2024-04-15",
            },
            contentRequirements: {
              type: "object",
              description: "内容要求",
            },
            budget: { type: "number" },
            commission: { type: "number" },
            platform: { type: "string" },
            region: { type: "string" },
            notes: {
              type: "string",
              description: "其他修改说明",
            },
            keywordStrategy: {
              type: "string",
              description:
                "红人搜索关键词策略（简短文本）。用户说明优先搜哪些词、避开哪些方向时使用；供执行心跳生成关键词参考。可为「暂无」表示清空策略。",
            },
          },
        },
      },
      required: ["campaignId", "scope", "changes"],
    },
  },
  {
    name: "ask_influencer_special_request",
    description: "向某个红人发起特殊沟通请求（如询问是否可延后发布时间）。将请求传给红人经纪人 agent，经纪人基于与红人的上下文与红人沟通，回收反馈后同步给广告主。",
    parameters: {
      type: "object",
      properties: {
        campaignId: {
          type: "string",
          description: "Campaign ID",
        },
        influencerId: {
          type: "string",
          description: "红人 ID",
        },
        requestType: {
          type: "string",
          enum: ["delay_publish", "change_content", "adjust_price", "other"],
          description: "请求类型：delay_publish=延后发布, change_content=修改内容, adjust_price=调整报价, other=其他",
        },
        requestDetail: {
          type: "string",
          description: "请求详情，如「是否可将发布时间延后 2 天至 4 月 5 日」",
        },
        deadline: {
          type: "string",
          description: "期望得到红人回复的截止时间，ISO 8601 格式",
        },
      },
      required: ["campaignId", "influencerId", "requestType", "requestDetail"],
    },
  },
  {
    name: "get_influencer_special_request_feedback",
    description: "获取之前发起的红人特殊请求的反馈。当红人经纪人 agent 收到红人回复后，可通过此工具查询并同步给广告主。",
    parameters: {
      type: "object",
      properties: {
        requestId: {
          type: "string",
          description: "之前 ask_influencer_special_request 返回的 requestId",
        },
      },
      required: ["requestId"],
    },
  },
  {
    name: "get_campaign_execution_status",
    description: "获取 campaign 当前执行状态，包括进度、各红人状态、最近事件等。用于生成汇报或回答广告主询问。",
    parameters: {
      type: "object",
      properties: {
        campaignId: {
          type: "string",
          description: "Campaign ID",
        },
      },
      required: ["campaignId"],
    },
  },
  {
    name: "approve_quote",
    description: "同意某位红人的报价，将其从「待审核价格」推进到「待寄送样品」阶段。用户说「同意 alice 的报价」「通过 alice_fashion」等时调用。",
    parameters: {
      type: "object",
      properties: {
        campaignId: { type: "string", description: "Campaign ID" },
        influencerId: { type: "string", description: "红人 ID（用户名或 id）" },
      },
      required: ["campaignId", "influencerId"],
    },
  },
  {
    name: "reject_quote",
    description: "暂不通过某位红人的报价。用户说「暂不通过 alice」「拒绝 bob 的报价」等时调用。",
    parameters: {
      type: "object",
      properties: {
        campaignId: { type: "string", description: "Campaign ID" },
        influencerId: { type: "string", description: "红人 ID" },
        reason: { type: "string", description: "拒绝原因（可选）" },
      },
      required: ["campaignId", "influencerId"],
    },
  },
  {
    name: "confirm_ship",
    description: "确认已向某位红人寄送样品，将其从「待寄送样品」推进到「待审核草稿」阶段。用户说「已给 carol 寄样」「确认寄样给 dave_tech」等时调用。",
    parameters: {
      type: "object",
      properties: {
        campaignId: { type: "string", description: "Campaign ID" },
        influencerId: { type: "string", description: "红人 ID" },
        shippingAddress: {
          type: "object",
          description: "寄样地址（可选）",
          properties: {
            sku: { type: "string" },
            fullName: { type: "string" },
            country: { type: "string" },
            state: { type: "string" },
            city: { type: "string" },
            addressLine: { type: "string" },
            zipCode: { type: "string" },
            telephone: { type: "string" },
          },
        },
      },
      required: ["campaignId", "influencerId"],
    },
  },
  {
    name: "approve_draft",
    description: "通过某位红人的视频草稿，将其从「待审核草稿」推进到「已发布视频」阶段。用户说「通过 emma 的草稿」「emma_fit 的草稿可以」等时调用。",
    parameters: {
      type: "object",
      properties: {
        campaignId: { type: "string", description: "Campaign ID" },
        influencerId: { type: "string", description: "红人 ID" },
        draftLink: { type: "string", description: "草稿链接（可选）" },
      },
      required: ["campaignId", "influencerId"],
    },
  },
  {
    name: "reject_draft",
    description: "不通过某位红人的视频草稿，需提供修改建议。用户说「emma 的草稿不通过，需要加强产品特写」「frank 的草稿要改」等时调用。",
    parameters: {
      type: "object",
      properties: {
        campaignId: { type: "string", description: "Campaign ID" },
        influencerId: { type: "string", description: "红人 ID" },
        feedback: { type: "string", description: "修改建议（必填）" },
        draftLink: { type: "string", description: "草稿链接（可选）" },
      },
      required: ["campaignId", "influencerId", "feedback"],
    },
  },
  {
    name: "update_published",
    description: "更新某位已发布红人的视频数据（链接、投流码、播放量、点赞、评论）。用户说「grace 的视频已发布，链接是 xxx」「更新 henry 的播放量 12 万」等时调用。",
    parameters: {
      type: "object",
      properties: {
        campaignId: { type: "string", description: "Campaign ID" },
        influencerId: { type: "string", description: "红人 ID" },
        videoLink: { type: "string", description: "视频发布链接" },
        promoCode: { type: "string", description: "投流码" },
        views: { type: "string", description: "播放量" },
        likes: { type: "string", description: "点赞量" },
        comments: { type: "string", description: "评论量" },
      },
      required: ["campaignId", "influencerId"],
    },
  },
];

// ==================== Tool Executor ====================

/**
 * 执行 Campaign Execution 工具
 * @param {string} toolName - 工具名称
 * @param {Object} params - 工具参数
 * @param {Object} context - 上下文（campaignId, influencerAgentClient 等）
 * @returns {Promise<Object>} - { success: boolean, data?: any, message?: string }
 */
export async function executeCampaignExecutionTool(toolName, params, context = {}) {
  const { campaignId, influencerAgentClient } = context;

  switch (toolName) {
    case "set_report_schedule":
      return await setReportSchedule(params, context);

    case "set_execution_pacing":
      return await setExecutionPacing(params, context);

    case "set_campaign_status":
      return await setCampaignStatus(params, context);

    case "modify_campaign":
      return await modifyCampaign(params, context);

    case "ask_influencer_special_request":
      return await askInfluencerSpecialRequest(params, context);

    case "get_influencer_special_request_feedback":
      return await getInfluencerSpecialRequestFeedback(params, context);

    case "get_campaign_execution_status":
      return await getCampaignExecutionStatus(params, context);

    case "approve_quote":
      return await updateExecutionStageAction(params, context, "approveQuote");
    case "reject_quote":
      return await updateExecutionStageAction(params, context, "rejectQuote");
    case "confirm_ship":
      return await updateExecutionStageAction(params, context, "confirmShip");
    case "approve_draft":
      return await updateExecutionStageAction(params, context, "approveDraft");
    case "reject_draft":
      return await updateExecutionStageAction(params, context, "rejectDraft");
    case "update_published":
      return await updateExecutionStageAction(params, context, "updatePublished");

    default:
      return {
        success: false,
        message: `未知工具: ${toolName}`,
      };
  }
}

// ==================== 各工具实现（接入 DB / InfluencerAgent） ====================

async function setReportSchedule(params, context) {
  const cid = params.campaignId || context.campaignId;
  const existing = await getReportConfigByCampaignId(cid);

  // 1）归一化汇报间隔（以小时为单位），支持中文/别名，最终落到 0.5–336 小时区间
  let intervalHours =
    typeof params.intervalHours === "number" && Number.isFinite(params.intervalHours)
      ? params.intervalHours
      : null;

  if (intervalHours == null) {
    const rawInterval = params.interval;
    if (typeof rawInterval === "string") {
      const t = rawInterval.trim().toLowerCase();
      if (["daily", "每天", "everyday", "1d"].includes(t)) {
        intervalHours = 24;
      } else if (["every_2_days", "每2天", "每两天", "2d"].includes(t)) {
        intervalHours = 48;
      } else if (["every_3_days", "每3天", "每三天", "3d"].includes(t)) {
        intervalHours = 72;
      } else if (["weekly", "每周", "每星期", "1w"].includes(t)) {
        intervalHours = 168;
      }
    }
  }

  if (intervalHours == null) {
    intervalHours =
      typeof existing?.intervalHours === "number" && Number.isFinite(existing.intervalHours)
        ? existing.intervalHours
        : 24;
  }
  intervalHours = Math.min(Math.max(intervalHours, 0.5), 336);

  // 2）归一化时间：如果没给就沿用已有或默认 09:00
  const reportTime = params.reportTime || existing?.reportTime || "09:00";

  // 3）归一化内容偏好（支持中文），落到 ENUM：brief / detailed / summary_only
  const rawPref = params.contentPreference || existing?.contentPreference || "brief";
  let contentPreference = rawPref;
  if (typeof rawPref === "string") {
    const p = rawPref.trim().toLowerCase();
    if (["brief", "简要", "概览"].includes(p)) {
      contentPreference = "brief";
    } else if (["detailed", "详细", "完整版"].includes(p)) {
      contentPreference = "detailed";
    } else if (["summary_only", "summary-only", "only_summary", "只要汇总", "仅汇总", "仅数字"].includes(p)) {
      contentPreference = "summary_only";
    } else if (!["brief", "detailed", "summary_only"].includes(p)) {
      contentPreference = "brief";
    }
  } else {
    contentPreference = existing?.contentPreference || "brief";
  }

  let includeMetrics = params.includeMetrics;
  if (!includeMetrics) {
    includeMetrics =
      existing?.includeMetrics ||
      ["pending_price_count", "pending_sample_count", "pending_draft_count", "published_count"];
  }
  // 去重，避免 LLM 重复项
  includeMetrics = Array.from(new Set(includeMetrics));

  const campaign = await getCampaignById(cid);
  if (!campaign) {
    return { success: false, message: `Campaign ${cid} 不存在` };
  }

  await upsertReportConfig({
    campaignId: cid,
    intervalHours,
    reportTime,
    contentPreference,
    includeMetrics,
  });

  const hasExplicitTime = typeof params.reportTime === "string" && params.reportTime.trim() !== "";
  const intervalLabel =
    intervalHours % 24 === 0
      ? `每 ${intervalHours / 24} 天`
      : `每 ${intervalHours} 小时`;

  return {
    success: true,
    data: { campaignId: cid, intervalHours, reportTime, contentPreference, includeMetrics },
    message: hasExplicitTime
      ? `已设置汇报：${intervalLabel}，时间 ${reportTime}`
      : `已设置汇报：${intervalLabel}。`,
  };
}

async function setExecutionPacing(params, context) {
  const cid = params.campaignId || context.campaignId;
  const campaign = await getCampaignById(cid);
  if (!campaign) {
    return { success: false, message: `Campaign ${cid} 不存在` };
  }

  const current = typeof campaign.influencersPerDay === "number" && campaign.influencersPerDay > 0
    ? campaign.influencersPerDay
    : 5;

  let daily = params.influencersPerDay;

  // 当用户给出具体数字时，优先使用该数字
  if (typeof daily !== "number" || !Number.isFinite(daily) || daily <= 0) {
    const mode = params.pacingMode;
    if (mode === "slow") {
      daily = Math.max(1, Math.round(current * 0.5));
    } else if (mode === "fast") {
      daily = Math.max(1, Math.round(current * 1.5));
    } else if (mode === "normal") {
      daily = current;
    } else {
      // 未指定明确模式时，保持当前值
      daily = current;
    }
  }

  await updateCampaign(cid, { influencersPerDay: daily });

  try {
    await runExecutionHeartbeatTick(new Date());
  } catch (hbErr) {
    console.warn(
      "[set_execution_pacing] 保存后触发 execution heartbeat 失败:",
      hbErr?.message || hbErr
    );
  }

  return {
    success: true,
    data: { campaignId: cid, influencersPerDay: daily },
    message: `已设置执行速度：每天联系 ${daily} 位红人`,
  };
}

export const CAMPAIGN_STATUS_UI_LABEL = {
  running: "进行中",
  paused: "已暂停",
  completed: "已完成",
};

function resolveCampaignStatusAction(params = {}) {
  const action = typeof params.action === "string" ? params.action.trim().toLowerCase() : "";
  if (action === "pause") return "paused";
  if (action === "resume") return "running";
  if (action === "complete") return "completed";
  const status = typeof params.status === "string" ? params.status.trim().toLowerCase() : "";
  if (status === "paused" || status === "running" || status === "completed") return status;
  return null;
}

function campaignStatusHint(status) {
  return CAMPAIGN_STATUS_UI_LABEL[status] || status || "未知";
}

async function setCampaignStatus(params, context) {
  const cid = params.campaignId || context.campaignId;
  const targetStatus = resolveCampaignStatusAction(params);
  if (!targetStatus) {
    return {
      success: false,
      message: "请指定 action（pause / resume / complete）或 status（running / paused / completed）。",
    };
  }

  const campaign = await getCampaignById(cid);
  if (!campaign) {
    return { success: false, message: `Campaign ${cid} 不存在` };
  }

  const current = campaign.status;
  if (current === "deleted" || current === "draft") {
    return {
      success: false,
      message: `当前 Campaign 状态为「${campaignStatusHint(current)}」，无法通过对话调整运行状态。`,
    };
  }

  if (current === "completed") {
    if (targetStatus === "completed") {
      return {
        success: true,
        data: { campaignId: cid, status: "completed", statusLabel: CAMPAIGN_STATUS_UI_LABEL.completed },
        message: "Campaign 已是已完成状态。",
      };
    }
    return {
      success: false,
      message: "Campaign 已标记为已完成，无法暂停或恢复自动拉新；已有红人的跟进仍可照常进行。",
    };
  }

  if (targetStatus === "completed") {
    if (current !== "running" && current !== "paused") {
      return {
        success: false,
        message: `当前 Campaign 状态为「${campaignStatusHint(current)}」，无法标记为已完成。`,
      };
    }
    await updateCampaign(cid, { status: "completed" });
    return {
      success: true,
      data: {
        campaignId: cid,
        status: "completed",
        statusLabel: CAMPAIGN_STATUS_UI_LABEL.completed,
      },
      message:
        "已将 Campaign 标记为已完成：不再自动搜索、联系新红人或发送定时汇报；队列中的搜索任务会继续跑完，已有红人的跟进不受影响。",
    };
  }

  if (current !== "running" && current !== "paused") {
    return {
      success: false,
      message: `当前 Campaign 状态为「${campaignStatusHint(current)}」，仅「进行中」与「已暂停」之间可暂停或恢复。`,
    };
  }

  const statusLabel = CAMPAIGN_STATUS_UI_LABEL[targetStatus] || targetStatus;

  if (current === targetStatus) {
    return {
      success: true,
      data: { campaignId: cid, status: targetStatus, statusLabel },
      message:
        targetStatus === "paused"
          ? "Campaign 已是暂停状态，不会自动联系新红人。"
          : "Campaign 已在运行中，会继续按节奏自动联系新红人。",
    };
  }

  await updateCampaign(cid, { status: targetStatus });

  if (targetStatus === "running") {
    try {
      await runExecutionHeartbeatTick(new Date());
    } catch (hbErr) {
      console.warn(
        "[set_campaign_status] 恢复后触发 execution heartbeat 失败:",
        hbErr?.message || hbErr
      );
    }
  }

  return {
    success: true,
    data: { campaignId: cid, status: targetStatus, statusLabel },
    message:
      targetStatus === "paused"
        ? "已暂停 Campaign：不会再自动搜索或联系新红人；队列中的搜索任务会继续跑完，已有红人的跟进不受影响。"
        : "已恢复 Campaign：将按设定节奏自动搜索并联系新红人。",
  };
}

/**
 * 意图模型常把 keywordStrategy 等放在 params 顶层，或把 changes 写成 {}。
 * 合并进 changes，并兼容 change 别名。
 */
function normalizeModifyCampaignParams(raw = {}) {
  const p = { ...raw };
  let nested =
    p.changes != null && typeof p.changes === "object" && !Array.isArray(p.changes)
      ? { ...p.changes }
      : p.change != null && typeof p.change === "object" && !Array.isArray(p.change)
        ? { ...p.change }
        : {};
  const liftKeys = [
    "keywordStrategy",
    "screeningConditions",
    "contentRequirements",
    "publishTimeRange",
    "budget",
    "commission",
    "platform",
    "region",
    "notes",
  ];
  for (const k of liftKeys) {
    if (p[k] !== undefined && nested[k] === undefined) {
      nested[k] = p[k];
    }
  }
  return { ...p, changes: nested };
}

async function modifyCampaign(params, context) {
  const normalized = normalizeModifyCampaignParams(params);
  const cid = normalized.campaignId || context.campaignId;
  const { scope, influencerId } = normalized;
  const influencerAgentClient = context.influencerAgentClient;

  const campaign = await getCampaignById(cid);
  if (!campaign) {
    return { success: false, message: `Campaign ${cid} 不存在` };
  }

  let ch =
    normalized.changes && typeof normalized.changes === "object"
      ? { ...normalized.changes }
      : {};
  let changeKeys = Object.keys(ch);

  const ctxLast =
    typeof context?.lastUserMessage === "string" ? context.lastUserMessage.trim() : "";
  if (changeKeys.length === 0 && ctxLast) {
    if (
      /关键词|竞品|搜索|多搜|keyword|strategy|例如|比如/i.test(ctxLast) ||
      /^修改/i.test(ctxLast)
    ) {
      ch = { keywordStrategy: ctxLast };
      changeKeys = Object.keys(ch);
    }
  }
  /** 这些字段只存在于「整单」维度，模型若误传 single_influencer 会导致 DB 不更新且回复里出现 undefined */
  const impliesWholeCampaign =
    ch.keywordStrategy !== undefined ||
    ch.screeningConditions != null ||
    ch.contentRequirements != null ||
    ch.publishTimeRange != null ||
    ch.budget != null ||
    ch.commission != null ||
    ch.platform != null ||
    ch.region != null ||
    ch.notes != null;

  let effectiveScope =
    scope === "whole" || scope === "single_influencer" ? scope : "whole";
  if (impliesWholeCampaign) {
    effectiveScope = "whole";
  }

  if (effectiveScope === "single_influencer") {
    const iid = influencerId != null ? String(influencerId).trim() : "";
    if (!iid) {
      return {
        success: false,
        message:
          "未识别到要修改的红人用户名。若你要改的是整单「关键词策略」或「红人画像筛选」，请直接说明；我会按整单（whole）写入。若只改某位红人，请带上其 TikTok 用户名。",
      };
    }
  }

  if (effectiveScope === "whole" && changeKeys.length === 0) {
    return {
      success: false,
      message: "未收到具体修改项（changes 为空）。请说明要更新的关键词策略全文，或要改的粉丝量/播放量/帐号类型等。",
    };
  }

  if (effectiveScope === "whole" && changeKeys.length > 0) {
    const nextCampaignInfo = { ...(campaign.campaignInfo || {}) };
    const nextInfluencerProfile = { ...(campaign.influencerProfile || {}) };
    const nextContentScript = { ...(campaign.contentScript || {}) };
    if (ch.publishTimeRange != null) nextCampaignInfo.publishTimeRange = ch.publishTimeRange;
    if (ch.budget != null) nextCampaignInfo.budget = ch.budget;
    if (ch.commission != null) nextCampaignInfo.commission = ch.commission;
    if (ch.platform != null) nextCampaignInfo.platform = ch.platform;
    if (ch.region != null) nextCampaignInfo.region = ch.region;
    if (ch.screeningConditions != null) Object.assign(nextInfluencerProfile, ch.screeningConditions);
    if (ch.contentRequirements != null) Object.assign(nextContentScript, ch.contentRequirements);

    const patch = {
      campaignInfo: nextCampaignInfo,
      influencerProfile: nextInfluencerProfile,
      contentScript: nextContentScript,
    };
    if (ch.keywordStrategy !== undefined) {
      const ks = String(ch.keywordStrategy || "").trim();
      patch.keywordStrategy = ks || null;
    }
    await updateCampaign(cid, patch);
  }

  if (influencerAgentClient && typeof influencerAgentClient.syncCampaignChanges === "function") {
    await influencerAgentClient.syncCampaignChanges({
      campaignId: cid,
      scope: effectiveScope,
      influencerId: effectiveScope === "whole" ? null : influencerId,
      changes: ch,
    });
  }

  return {
    success: true,
    data: { campaignId: cid, scope: effectiveScope, requestedScope: scope, changes: ch },
    message:
      effectiveScope === "whole"
        ? "已修改整体 campaign 配置，并通知红人经纪人同步给相关红人"
        : `已修改红人 ${influencerId} 的配置，并通知红人经纪人同步`,
  };
}

async function askInfluencerSpecialRequest(params, context) {
  const cid = params.campaignId || context.campaignId;
  const { influencerId, requestType, requestDetail, deadline } = params;
  const influencerAgentClient = context.influencerAgentClient;

  const campaign = await getCampaignById(cid);
  if (!campaign) {
    return { success: false, message: `Campaign ${cid} 不存在` };
  }

  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  await createSpecialRequest({
    requestId,
    campaignId: cid,
    influencerId,
    requestType,
    requestDetail,
    deadline: deadline || null,
  });

  if (influencerAgentClient && typeof influencerAgentClient.forwardSpecialRequest === "function") {
    await influencerAgentClient.forwardSpecialRequest({
      requestId,
      campaignId: cid,
      influencerId,
      requestType,
      requestDetail,
      deadline,
    });
  }

  return {
    success: true,
    data: {
      requestId,
      campaignId: cid,
      influencerId,
      requestType,
      requestDetail,
      status: "pending",
    },
    message: `已向红人 ${influencerId} 发起请求，待红人回复后会同步给你。requestId: ${requestId}`,
  };
}

async function getInfluencerSpecialRequestFeedback(params, context) {
  const { requestId } = params;

  let feedback = await getSpecialRequestByRequestId(requestId);
  if (!feedback && context.influencerAgentClient?.getSpecialRequestFeedback) {
    feedback = await context.influencerAgentClient.getSpecialRequestFeedback({ requestId });
  }
  if (!feedback) {
    feedback = { requestId, status: "pending", influencerReply: null, syncedToAdvertiser: false };
  }

  return {
    success: true,
    data: feedback,
    message: feedback.status === "replied"
      ? `红人已回复：${feedback.influencerReply || "（无正文）"}`
      : "红人尚未回复，请稍后查询",
  };
}

async function getCampaignExecutionStatus(params, context) {
  const cid = params.campaignId || context.campaignId;
  const data = await getStatusFromDao(cid);
  if (!data) {
    return { success: false, message: `Campaign ${cid} 不存在` };
  }
  return {
    success: true,
    data,
    message: "已获取 campaign 执行状态",
  };
}

/**
 * 统一执行阶段更新（与 API /api/campaigns/[id]/execution 逻辑一致）
 */
async function updateExecutionStageAction(params, context, action) {
  const cid = params.campaignId || context.campaignId;
  const influencerId = params.influencerId;
  if (!cid || !influencerId) {
    return { success: false, message: "缺少 campaignId 或 influencerId" };
  }

  const campaign = await getCampaignById(cid);
  if (!campaign) {
    return { success: false, message: `Campaign ${cid} 不存在` };
  }

  let stage = null;
  let lastEvent = null;
  let quoteAppend = null;

  switch (action) {
    case "approveQuote": {
      const needSample =
        campaign.productInfo &&
        typeof campaign.productInfo.needSample === "boolean"
          ? campaign.productInfo.needSample
          : true;
      stage = needSample ? "pending_sample" : "pending_draft";
      lastEvent = { quoteApprovedAt: new Date().toISOString() };
      break;
    }
    case "rejectQuote": {
      const row = await getExecutionRow(cid, influencerId);
      stage = "quote_rejected";
      const rejectReason = String(params.reason || "").trim();
      lastEvent = {
        quoteRejectedAt: new Date().toISOString(),
        rejectReason: rejectReason.slice(0, 2000),
      };
      quoteAppend = {
        role: "advertiser",
        amount: null,
        currency: row?.currency || "USD",
        reason: rejectReason || null,
        type: "quote_rejected",
        source: "campaign_execution_agent",
      };
      break;
    }
    case "confirmShip":
      stage = "pending_draft";
      lastEvent = {
        shippingAddress: params.shippingAddress || {},
        sampleSentAt: new Date().toISOString(),
      };
      break;
    case "approveDraft":
      stage = "published";
      lastEvent = {
        draftApprovedAt: new Date().toISOString(),
        draftLink: params.draftLink,
      };
      break;
    case "rejectDraft": {
      stage = "draft_submitted";
      const existing = await getExecutionRow(cid, influencerId);
      const prevHistory = existing?.lastEvent?.revisionHistory || [];
      const draftLink = params.draftLink || existing?.lastEvent?.draftLink;
      const feedback = params.feedback || "";
      lastEvent = {
        draftFeedback: feedback,
        draftLink,
        draftRejectedAt: new Date().toISOString(),
        revisionHistory: [
          ...prevHistory,
          { draftLink, feedback, rejectedAt: new Date().toISOString() },
        ],
      };
      break;
    }
    case "updatePublished":
      lastEvent = {
        ...(params.videoLink != null && { videoLink: params.videoLink }),
        ...(params.promoCode != null && { promoCode: params.promoCode }),
        ...(params.views != null && { views: params.views }),
        ...(params.likes != null && { likes: params.likes }),
        ...(params.comments != null && { comments: params.comments }),
      };
      break;
    default:
      return { success: false, message: `未知 action: ${action}` };
  }

  await updateExecutionStage(cid, influencerId, { stage, lastEvent, quoteAppend });

  const labels = {
    approveQuote: "已同意报价",
    rejectQuote: "已暂不通过",
    confirmShip: "已确认寄样",
    approveDraft: "已通过草稿",
    rejectDraft: "已记录修改建议",
    updatePublished: "已更新发布数据",
  };
  return {
    success: true,
    data: { campaignId: cid, influencerId, stage, action },
    message: `${labels[action]}：${influencerId}`,
  };
}
