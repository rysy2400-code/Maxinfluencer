import { createRequire } from "node:module";
import {
  getCampaignById,
  getCampaignExecutionStatus,
} from "../db/campaign-dao.js";
import { getCampaignSessionById } from "../db/campaign-session-dao.js";
import {
  avgViewsFromSnapshot,
  formatEcpmFromFlatAndViews,
} from "../influencer/avg-views.js";
import { formatCountryForDisplay } from "../influencer/campaign-country-codes.js";

const require = createRequire(import.meta.url);

/** Next/webpack 下 `import XLSX from "xlsx"` 的 default 可能为 undefined */
function loadXlsx() {
  const mod = require("xlsx");
  return mod?.utils ? mod : mod?.default;
}

/** 前端执行进度 Tab key → 导出 stage 参数 */
export const EXECUTION_EXPORT_STAGES = {
  contacted: { title: "已联系", columnKey: "contacted" },
  pendingPrice: { title: "待审核价格", columnKey: "pendingPrice" },
  pendingSample: { title: "待寄样品", columnKey: "pendingSample" },
  pendingDraft: { title: "待审核草稿", columnKey: "pendingDraft" },
  published: { title: "已发布视频", columnKey: "published" },
};

function buildTikTokProfileUrl(handle) {
  const u = String(handle || "")
    .trim()
    .replace(/^@/, "");
  if (!u) return "";
  return `https://www.tiktok.com/@${encodeURIComponent(u)}`;
}

function buildInstagramProfileUrl(handle) {
  const u = String(handle || "")
    .trim()
    .replace(/^@/, "");
  if (!u) return "";
  return `https://www.instagram.com/${encodeURIComponent(u)}/`;
}

function buildYoutubeProfileUrl(handle) {
  const u = String(handle || "")
    .trim()
    .replace(/^@/, "");
  if (!u) return "";
  return `https://www.youtube.com/@${encodeURIComponent(u)}`;
}

function resolveInfluencerPlatform(item) {
  const raw = item?.platform ?? item?.Platform ?? "";
  const s = String(raw).trim().toLowerCase();
  if (s.includes("instagram") || s === "ig" || s === "ins") return "Instagram";
  if (s.includes("youtube") || s === "yt" || s === "ytb") return "YouTube";
  const url = String(item?.profileUrl || item?.profile_url || "").toLowerCase();
  if (url.includes("instagram.com")) return "Instagram";
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "YouTube";
  return "TikTok";
}

function buildInfluencerProfileUrl(item) {
  const direct = item?.profileUrl || item?.profile_url;
  if (typeof direct === "string" && direct.trim().startsWith("http")) {
    return direct.trim();
  }
  const handle = item?.id || item?.username || "";
  const platform = resolveInfluencerPlatform(item);
  if (platform === "Instagram") return buildInstagramProfileUrl(handle);
  if (platform === "YouTube") return buildYoutubeProfileUrl(handle);
  return buildTikTokProfileUrl(handle);
}

function formatStat(v) {
  if (v == null || v === "") return "";
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    if (typeof v.display === "string" && v.display.trim()) return v.display.trim();
    if (typeof v.count === "number" && Number.isFinite(v.count)) {
      return String(v.count);
    }
    return "";
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return String(v);
}

/** 与前端 ExecutionProgressMetricsLine / formatInfluencerStat 一致 */
function formatInfluencerStatDisplay(v) {
  if (v == null || v === "") return "—";
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    if (typeof v.display === "string" && v.display.trim()) return v.display.trim();
    if (typeof v.count === "number" && Number.isFinite(v.count)) {
      return v.count.toLocaleString("en-US");
    }
    return "—";
  }
  if (typeof v === "number" && Number.isFinite(v)) return v.toLocaleString("en-US");
  return String(v);
}

function resolveVideoPublishCountry(item) {
  const v = item?.videoPublishCountry ?? item?.video_publish_country;
  if (v == null || v === "") return null;
  return String(v).trim();
}

/** 与前端 formatGmvStat 一致；Instagram 不导出 GMV（空字符串） */
function formatGmvForExport(item) {
  const platform = resolveInfluencerPlatform(item);
  if (platform === "Instagram") return "";
  const raw = item?.gmv;
  if (raw == null || raw === "") return "—";
  const n = Number(raw);
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/** 执行进度卡片指标行：国家 · 粉丝 · 播放 · GMV */
function executionProgressMetricsColumns(item) {
  const platform = resolveInfluencerPlatform(item);
  const isYt = platform === "YouTube";
  const countryRaw = resolveVideoPublishCountry(item);
  const country =
    countryRaw != null
      ? formatCountryForDisplay(countryRaw) ?? countryRaw
      : isYt
        ? ""
        : "—";
  return {
    国家: country,
    粉丝数: formatInfluencerStatDisplay(
      item?.followers ?? item?.followerCount ?? item?.follower_count
    ),
    播放量: formatInfluencerStatDisplay(
      item?.avg_views ?? item?.avgViews ?? item?.views
    ),
    GMV: formatGmvForExport(item),
  };
}

function flatFeeFields(item) {
  const flatUsd =
    item.flatFeeUsd ??
    item.flat_fee ??
    item.flatFeeUSD ??
    item.campaignAgentDecision?.flatFeeUSD ??
    null;
  const currency = item.currency || "USD";
  const viewsNum = avgViewsFromSnapshot(item);
  const ecpmRaw =
    item.ecpm != null && item.ecpm !== ""
      ? String(item.ecpm)
      : formatEcpmFromFlatAndViews(flatUsd, viewsNum, currency);
  const ecpm = ecpmRaw === "—" ? "" : ecpmRaw;
  return {
    报价金额: flatUsd != null && flatUsd !== "" ? Number(flatUsd) : "",
    币种: currency,
    eCPM: ecpm,
  };
}

function formatDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function textField(raw) {
  if (raw == null || raw === "") return "";
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
}

function recommendReason(item) {
  const raw =
    item.analysisSummary ||
    item.reason ||
    item.analysis_summary ||
    item.match_analysis_summary ||
    "";
  return textField(raw);
}

function profileAnalysis(item) {
  const matchObj =
    item.matchAnalysis && typeof item.matchAnalysis === "object"
      ? item.matchAnalysis
      : null;
  return textField(
    (matchObj && matchObj.analysis) || item.analysis || item.profile_analysis || ""
  );
}

function formatQuoteNegotiation(entries, defaultCurrency) {
  if (!Array.isArray(entries) || entries.length === 0) return "";
  return [...entries]
    .reverse()
    .map((entry, idx) => {
      const roleLabel =
        entry.role === "advertiser"
          ? "广告主"
          : entry.role === "influencer"
          ? "红人"
          : entry.role || "—";
      const typeLabel =
        entry.type === "counter"
          ? "还价"
          : entry.type === "quote_rejected"
          ? "拒绝报价"
          : entry.type === "reopen"
          ? "撤销拒绝"
          : entry.type || "";
      const amt =
        entry.amount != null && Number.isFinite(Number(entry.amount))
          ? `${Number(entry.amount)} ${entry.currency || defaultCurrency || "USD"}`
          : "";
      const at = entry.at ? formatDateTime(entry.at) : "";
      const reason = entry.reason ? String(entry.reason) : "";
      return [
        `#${idx + 1}`,
        [roleLabel, typeLabel].filter(Boolean).join(" · "),
        amt,
        at,
        reason,
      ]
        .filter(Boolean)
        .join(" | ");
    })
    .join("\n");
}

function shippingFields(item) {
  const shippingRaw =
    item.executionShippingInfo ||
    item.shippingAddress ||
    item.shipping_info ||
    {};
  const s =
    typeof shippingRaw === "object" && shippingRaw !== null ? shippingRaw : {};
  return {
    fullName: s.fullName || s.name || "",
    country: s.country || "",
    state: s.state || s.province || "",
    city: s.city || "",
    addressLine: s.addressLine || s.addressLine1 || s.address || "",
    postalCode: s.postalCode || s.zip || "",
    telephone: s.phone || s.telephone || "",
  };
}

function draftLinkFromItem(item) {
  let draftLink = item.draftLink || item.videoDraftLink;
  const vd = item.executionVideoDraft;
  if (!draftLink && Array.isArray(vd) && vd.length) {
    const last = vd[vd.length - 1];
    draftLink = last?.draftLink || last?.link || last?.url;
  }
  if (!draftLink && vd && typeof vd === "object" && !Array.isArray(vd)) {
    draftLink = vd.draftLink || vd.link || vd.url;
  }
  return draftLink || "";
}

function formatRevisionHistory(history) {
  if (!Array.isArray(history) || history.length === 0) return "";
  return history
    .map((rev, idx) => {
      const parts = [`#${idx + 1}`];
      if (rev.draftLink) parts.push(`链接: ${rev.draftLink}`);
      if (rev.feedback) parts.push(`建议: ${rev.feedback}`);
      if (rev.rejectedAt) parts.push(`时间: ${formatDateTime(rev.rejectedAt)}`);
      return parts.join(" | ");
    })
    .join("\n");
}

const STAGE_LABELS = {
  pending_quote: "待报价",
  quote_submitted: "待审核报价",
  quote_rejected: "已拒绝报价",
  pending_sample: "待寄样",
  pending_draft: "待提交草稿",
  draft_submitted: "已提交草稿",
  published: "已发布",
};

function baseRow(item) {
  const username = item.id || "";
  const platform = resolveInfluencerPlatform(item);
  return {
    平台: platform,
    账号: username ? `@${username.replace(/^@/, "")}` : "",
    主页链接: buildInfluencerProfileUrl(item),
    显示名称: item.name || "",
  };
}

function rowsForStage(stageKey, items) {
  switch (stageKey) {
    case "contacted":
      return items.map((item) => ({
        ...baseRow(item),
        进入执行时间: formatDateTime(item.executionCreatedAt),
        粉丝数: formatStat(item.followers ?? item.followerCount ?? item.follower_count),
        播放量: formatStat(item.avg_views ?? item.avgViews ?? item.views),
        画像分析: profileAnalysis(item),
        推荐理由: recommendReason(item),
        执行阶段: STAGE_LABELS[item.stage] || item.stage || "",
      }));
    case "pendingPrice": {
      return items.map((item) => {
        const quote = flatFeeFields(item);
        return {
          ...baseRow(item),
          ...executionProgressMetricsColumns(item),
          执行阶段: STAGE_LABELS[item.stage] || item.stage || "",
          推荐理由: recommendReason(item),
          ...quote,
          砍价记录: formatQuoteNegotiation(item.quoteNegotiation, quote.币种),
        };
      });
    }
    case "pendingSample":
      return items.map((item) => {
        const ship = shippingFields(item);
        const quote = flatFeeFields(item);
        return {
          ...baseRow(item),
          ...executionProgressMetricsColumns(item),
          ...quote,
          "Full Name": ship.fullName,
          Country: ship.country,
          "State/Province": ship.state,
          City: ship.city,
          "Address Line": ship.addressLine,
          "Post/Zip Code": ship.postalCode,
          Telephone: ship.telephone,
        };
      });
    case "pendingDraft":
      return items.map((item) => {
        const quote = flatFeeFields(item);
        return {
          ...baseRow(item),
          ...executionProgressMetricsColumns(item),
          ...quote,
          草稿链接: draftLinkFromItem(item),
          修改建议: textField(item.draftFeedback || item.feedback || ""),
          修订记录: formatRevisionHistory(item.revisionHistory),
        };
      });
    case "published":
      return items.map((item) => {
        const publishedLink =
          item.videoLink || item.executionVideoLink || item.video_link;
        const flatUsd =
          item.flatFeeUsd ??
          item.flat_fee ??
          item.flatFeeUSD ??
          item.campaignAgentDecision?.flatFeeUSD ??
          null;
        const currency = item.currency || "USD";
        const viewsNum = avgViewsFromSnapshot(item);
        const ecpmRaw =
          item.ecpm != null && item.ecpm !== ""
            ? String(item.ecpm)
            : formatEcpmFromFlatAndViews(flatUsd, viewsNum, currency);
        const ecpm = ecpmRaw === "—" ? "" : ecpmRaw;
        return {
          ...baseRow(item),
          报价金额: flatUsd != null && flatUsd !== "" ? Number(flatUsd) : "",
          币种: currency,
          eCPM: ecpm,
          视频链接: publishedLink || "",
          播放量: formatStat(item.views),
          点赞数: formatStat(item.likes),
          评论数: formatStat(item.comments),
          CPM: item.cpm != null ? String(item.cpm) : "",
        };
      });
    default:
      return [];
  }
}

function sanitizeFilenamePart(s, maxLen = 80) {
  return String(s || "")
    .replace(/[/\\?%*:|"<>]/g, "_")
    .trim()
    .slice(0, maxLen);
}

/** 导出文件名时间戳：北京时间 YYYYMMDD-HHmmss */
function formatBeijingExportTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}-${get("hour")}${get("minute")}${get("second")}`;
}

/** 与前端左侧栏一致的 campaign 显示名（session.title） */
async function resolveCampaignExportDisplayName(campaignId) {
  const c = await getCampaignById(campaignId);
  if (!c?.sessionId) return "未命名 Campaign";
  const session = await getCampaignSessionById(c.sessionId);
  const title =
    session?.title != null ? String(session.title).trim() : "";
  return title || "未命名 Campaign";
}

function buildExecutionExportFilename(stageTitle, campaignDisplayName) {
  const ts = formatBeijingExportTimestamp();
  return `${sanitizeFilenamePart(stageTitle)}-${sanitizeFilenamePart(campaignDisplayName, 40)}-${ts}.xlsx`;
}

/**
 * @param {string} campaignId
 * @param {string} stageKey - contacted | pendingPrice | pendingSample | pendingDraft | published
 */
export async function buildExecutionStageXlsx(campaignId, stageKey) {
  const meta = EXECUTION_EXPORT_STAGES[stageKey];
  if (!meta) {
    const err = new Error(`不支持的导出阶段: ${stageKey}`);
    err.code = "INVALID_STAGE";
    throw err;
  }

  const status = await getCampaignExecutionStatus(campaignId);
  if (!status) {
    const err = new Error("Campaign 不存在");
    err.code = "NOT_FOUND";
    throw err;
  }

  if (stageKey === "pendingSample" && status.needSample === false) {
    const err = new Error("当前 Campaign 不需要寄样，无法导出待寄样品");
    err.code = "STAGE_DISABLED";
    throw err;
  }

  const items = status.columns?.[meta.columnKey] || [];
  const rows = rowsForStage(stageKey, items);
  const XLSX = loadXlsx();
  if (!XLSX?.utils) {
    throw new Error("xlsx 模块加载失败");
  }
  const sheet = XLSX.utils.json_to_sheet(
    rows.length > 0 ? rows : [{ 提示: "该阶段暂无红人数据" }]
  );
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, meta.title.slice(0, 31));

  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const campaignDisplayName = await resolveCampaignExportDisplayName(campaignId);
  const filename = buildExecutionExportFilename(meta.title, campaignDisplayName);

  return { buffer, filename, count: items.length, stageTitle: meta.title };
}
