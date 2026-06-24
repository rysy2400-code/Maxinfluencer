const STAGE_QUOTE_SUBMITTED = "quote_submitted";
const STAGE_QUOTE_REJECTED = "quote_rejected";

/** 待审核价格 Tab 数字：仅 quote_submitted */
export function countPendingPriceReviewItems(items) {
  return (items || []).filter((item) => item?.stage === STAGE_QUOTE_SUBMITTED)
    .length;
}

/** 待审核价格列表分组与排序（待审核在上、已拒绝在下） */
export function partitionPendingPriceItems(items) {
  const pendingReviewItems = [];
  const rejectedItems = [];
  for (const item of items || []) {
    if (item?.stage === STAGE_QUOTE_REJECTED) {
      rejectedItems.push(item);
    } else {
      pendingReviewItems.push(item);
    }
  }
  pendingReviewItems.sort((a, b) => {
    const ta = a.lastInboundReplyAt
      ? new Date(a.lastInboundReplyAt).getTime()
      : 0;
    const tb = b.lastInboundReplyAt
      ? new Date(b.lastInboundReplyAt).getTime()
      : 0;
    return tb - ta;
  });
  rejectedItems.sort((a, b) => {
    const ta = a.quoteRejectedAt ? new Date(a.quoteRejectedAt).getTime() : 0;
    const tb = b.quoteRejectedAt ? new Date(b.quoteRejectedAt).getTime() : 0;
    return tb - ta;
  });
  return { pendingReviewItems, rejectedItems };
}

/** 导出 Excel：待审核在前、已拒绝在后 */
export function sortPendingPriceForExport(items) {
  const { pendingReviewItems, rejectedItems } = partitionPendingPriceItems(items);
  return [...pendingReviewItems, ...rejectedItems];
}

/** 导出/展示用状态文案 */
export function pendingPriceStatusLabel(stage) {
  return stage === STAGE_QUOTE_REJECTED ? "已拒绝" : "待审核";
}
