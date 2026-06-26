/** tiktok_campaign.status 活跃 running 态（自主 / 名单） */
export const ACTIVE_RUNNING_STATUSES = ["running", "running_passive"];

/** 工作笔记「Campaign 状态」长文案 */
export const CAMPAIGN_STATUS_WORK_NOTES_LABEL = {
  running: "自主分析联系红人",
  running_passive: "只按名单分析联系红人",
  paused: "已暂停",
  completed: "已完成",
};

/** 侧栏 / 列表短标签 */
export const CAMPAIGN_STATUS_SIDEBAR_LABEL = {
  running: "进行中",
  running_passive: "进行中",
  paused: "已暂停",
  completed: "已完成",
};

/**
 * @param {string|null|undefined} status
 * @returns {boolean}
 */
export function isActiveRunningStatus(status) {
  return (
    typeof status === "string" &&
    ACTIVE_RUNNING_STATUSES.includes(status.trim())
  );
}

/**
 * @param {string|null|undefined} status
 * @returns {boolean}
 */
export function allowsInfluencerListImport(status) {
  return isActiveRunningStatus(status);
}

/**
 * @param {string|null|undefined} status
 * @returns {boolean}
 */
export function skipsSearchDispatch(status) {
  return status === "running_passive";
}

/**
 * @param {string|null|undefined} status
 * @returns {string}
 */
export function campaignStatusWorkNotesLabel(status) {
  if (status == null || status === "") return "未知";
  return CAMPAIGN_STATUS_WORK_NOTES_LABEL[status] || String(status);
}

/**
 * @param {string|null|undefined} status
 * @returns {string}
 */
export function campaignStatusSidebarLabel(status) {
  if (status == null || status === "") return "未知";
  return CAMPAIGN_STATUS_SIDEBAR_LABEL[status] || String(status);
}

/**
 * inbox / 侧栏分组：running 与 running_passive 均归入 running 桶
 * @param {string|null|undefined} status
 * @returns {"running"|"paused"|"completed"|null}
 */
export function campaignStatusSidebarBucket(status) {
  if (isActiveRunningStatus(status)) return "running";
  if (status === "paused") return "paused";
  if (status === "completed") return "completed";
  return null;
}
