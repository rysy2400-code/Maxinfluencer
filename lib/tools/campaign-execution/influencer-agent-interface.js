/**
 * 红人经纪人 Agent 接口定义
 *
 * Campaign Execution Agent 调用以下方法，将任务委托给 InfluencerAgent（红人经纪人）。
 * 实现 InfluencerAgent 时需实现此接口。
 */

/**
 * @typedef {Object} SyncCampaignChangesParams
 * @property {string} campaignId
 * @property {'whole'|'single_influencer'} scope
 * @property {string} [influencerId]
 * @property {Object} changes - 修改内容（screeningConditions, publishTimeRange, contentRequirements 等）
 */

/**
 * 同步 campaign 修改给红人
 * Campaign Execution Agent 在 modify_campaign 时调用，由 InfluencerAgent 基于与红人的历史上下文，将变更通知红人。
 *
 * @param {SyncCampaignChangesParams} params
 * @returns {Promise<void>}
 */
// async function syncCampaignChanges(params) {}

/**
 * @typedef {Object} ForwardSpecialRequestParams
 * @property {string} requestId
 * @property {string} campaignId
 * @property {string} influencerId
 * @property {string} requestType - delay_publish | change_content | adjust_price | other
 * @property {string} requestDetail
 * @property {string} [deadline] - ISO 8601
 */

/**
 * 将特殊请求转发给红人
 * Campaign Execution Agent 在 ask_influencer_special_request 时调用。
 * InfluencerAgent 与红人沟通后，将反馈写入存储，供 getSpecialRequestFeedback 查询。
 *
 * @param {ForwardSpecialRequestParams} params
 * @returns {Promise<void>}
 */
// async function forwardSpecialRequest(params) {}

/**
 * @typedef {Object} SpecialRequestFeedback
 * @property {string} requestId
 * @property {'pending'|'replied'|'failed'} status
 * @property {string|null} influencerReply - 红人回复内容
 * @property {boolean} syncedToAdvertiser
 */

/**
 * 获取红人对特殊请求的反馈
 * Campaign Execution Agent 在 get_influencer_special_request_feedback 时调用。
 *
 * @param {{ requestId: string }} params
 * @returns {Promise<SpecialRequestFeedback>}
 */
// async function getSpecialRequestFeedback(params) {}
