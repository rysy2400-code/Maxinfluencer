/** tiktok_campaign.status：展示 Bin 工作区（执行总览 / 工作实况） */
export const EXECUTION_UI_CAMPAIGN_STATUSES = ["running", "paused", "completed"];

/**
 * @param {string|null|undefined} status
 * @returns {boolean}
 */
export function isExecutionUiCampaignStatus(status) {
  return (
    typeof status === "string" &&
    EXECUTION_UI_CAMPAIGN_STATUSES.includes(status)
  );
}

/**
 * @param {{ campaignId?: string|null, campaignStatus?: string|null }} meta
 * @returns {boolean}
 */
export function shouldShowBinComputerPanel(meta = {}) {
  const id =
    meta.campaignId != null && String(meta.campaignId).trim()
      ? String(meta.campaignId).trim()
      : null;
  return !!id && isExecutionUiCampaignStatus(meta.campaignStatus);
}
