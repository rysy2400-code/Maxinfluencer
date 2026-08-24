import { tiktokPool, queryTikTok } from "../db/mysql-tiktok.js";
import {
  SQL_EXECUTION_CREATOR_MATCH,
  paramsExecutionCreatorMatch,
} from "../db/campaign-execution-keys.js";
import { resolveNeedSample } from "../execution/need-sample.js";

function parseJson(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value) || {};
  } catch {
    return {};
  }
}

export async function refundSystemSuggestedQuote({
  campaignId,
  influencerId,
  reason,
}) {
  const chargeKey = `quote_approve:${campaignId}:${String(influencerId).trim()}:system_profile`;
  const refundKey = `system_quote_refund:${campaignId}:${String(influencerId).trim()}`;
  const conn = await tiktokPool.getConnection();
  try {
    await conn.beginTransaction();
    const [existingRefund] = await conn.execute(
      `SELECT id, amount, balance_after FROM tiktok_advertiser_balance_ledger
       WHERE idempotency_key = ? LIMIT 1 FOR UPDATE`,
      [refundKey]
    );
    if (existingRefund?.length) {
      await conn.commit();
      return {
        success: true,
        refundedAmount: Number(existingRefund[0].amount) || 0,
        balanceAfter: Number(existingRefund[0].balance_after) || 0,
        alreadyProcessed: true,
      };
    }
    const [chargeRows] = await conn.execute(
      `SELECT * FROM tiktok_advertiser_balance_ledger
       WHERE idempotency_key = ? AND type = 'quote_approve' LIMIT 1 FOR UPDATE`,
      [chargeKey]
    );
    if (!chargeRows?.length) {
      await conn.rollback();
      return { success: false, message: "未找到系统建议价扣款流水" };
    }
    const charge = chargeRows[0];
    const refundAmount = Math.abs(Number(charge.amount) || 0);
    const influencerAmount = Math.abs(Number(charge.influencer_amount) || 0);
    const platformFeeAmount = Math.abs(Number(charge.platform_fee_amount) || 0);
    const [advRows] = await conn.execute(
      `SELECT balance_amount FROM tiktok_advertiser WHERE id = ? LIMIT 1 FOR UPDATE`,
      [charge.advertiser_id]
    );
    if (!advRows?.length) throw new Error("广告主账户不存在");
    const balanceAfter = Math.round(
      ((Number(advRows[0].balance_amount) || 0) + refundAmount) * 10000
    ) / 10000;
    await conn.execute(
      `UPDATE tiktok_advertiser SET balance_amount = ?, balance_currency = 'USD' WHERE id = ?`,
      [balanceAfter, charge.advertiser_id]
    );
    await conn.execute(
      `INSERT INTO tiktok_advertiser_balance_ledger
        (advertiser_id, amount, balance_after, currency, type, campaign_id, influencer_id,
         influencer_amount, platform_fee_amount, platform_fee_rate, influencer_source,
         campaign_name, influencer_display_name, note, idempotency_key)
       VALUES (?, ?, ?, 'USD', 'adjustment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        charge.advertiser_id,
        refundAmount,
        balanceAfter,
        campaignId,
        influencerId,
        influencerAmount,
        platformFeeAmount,
        charge.platform_fee_rate,
        charge.influencer_source,
        charge.campaign_name,
        charge.influencer_display_name,
        `系统建议价未获红人确认，全额退款：${String(reason || "creator_declined").slice(0, 1000)}`,
        refundKey,
      ]
    );
    await conn.commit();
    return { success: true, refundedAmount: refundAmount, balanceAfter };
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}

export async function applySystemQuoteCreatorResponse({
  campaignId,
  influencerId,
  response,
  newAmountUsd = null,
  note = null,
  sourceMessageId = null,
}) {
  const normalized = String(response || "").trim();
  if (!new Set(["accepted", "declined", "countered"]).has(normalized)) {
    throw new Error("无效的系统建议价红人回复类型");
  }
  const currentRows = await queryTikTok(
    `SELECT stage, quote_origin FROM tiktok_campaign_execution
     WHERE campaign_id = ? AND ${SQL_EXECUTION_CREATOR_MATCH} LIMIT 1`,
    [campaignId, ...paramsExecutionCreatorMatch(influencerId)]
  );
  if (
    !currentRows?.[0] ||
    currentRows[0].stage !== "pending_creator_confirmation" ||
    currentRows[0].quote_origin !== "commerce_profile_estimate"
  ) {
    return { success: false, message: "执行记录不在系统建议价待红人确认状态" };
  }
  if (normalized !== "accepted") {
    const refunded = await refundSystemSuggestedQuote({
      campaignId,
      influencerId,
      reason: note || normalized,
    });
    if (!refunded.success) return refunded;
  }

  const conn = await tiktokPool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT e.*, c.product_info FROM tiktok_campaign_execution e
       JOIN tiktok_campaign c ON c.id = e.campaign_id
       WHERE e.campaign_id = ? AND ${SQL_EXECUTION_CREATOR_MATCH} LIMIT 1 FOR UPDATE`,
      [campaignId, ...paramsExecutionCreatorMatch(influencerId)]
    );
    const row = rows?.[0];
    if (!row || row.stage !== "pending_creator_confirmation") {
      await conn.rollback();
      return { success: false, message: "执行记录不在待红人确认状态" };
    }
    const lastEvent = parseJson(row.last_event);
    const historyRaw = parseJson(row.quote_negotiation);
    const history = Array.isArray(historyRaw) ? historyRaw : [];
    const now = new Date().toISOString();
    let stage;
    let flatFee = row.flat_fee;
    let quoteOrigin = row.quote_origin;
    let nextHistory = history;
    if (normalized === "accepted") {
      const product = parseJson(row.product_info);
      const needSample = resolveNeedSample(product);
      stage = needSample ? "pending_shipping_address" : "pending_script";
      lastEvent.quoteApprovedAt = now;
      lastEvent.creatorConfirmedSystemQuoteAt = now;
    } else if (normalized === "countered") {
      const amount = Number(newAmountUsd);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("红人新报价无效");
      stage = "quote_submitted";
      flatFee = amount;
      quoteOrigin = "creator_quote";
      nextHistory = [...history, {
        role: "influencer",
        amount,
        currency: "USD",
        reason: note || null,
        type: "counter",
        source: "creator_system_quote_response",
        at: now,
      }];
      lastEvent.systemQuoteRefundedAt = now;
      lastEvent.creatorCounteredSystemQuoteAt = now;
    } else {
      stage = "quote_rejected";
      lastEvent.systemQuoteRefundedAt = now;
      lastEvent.creatorDeclinedSystemQuoteAt = now;
    }
    lastEvent.systemQuoteCreatorResponse = {
      response: normalized,
      note: note || null,
      sourceMessageId,
      at: now,
    };
    await conn.execute(
      `UPDATE tiktok_campaign_execution
       SET stage = ?, flat_fee = ?, currency = 'USD', quote_origin = ?,
           quote_negotiation = ?, last_event = ?
       WHERE campaign_id = ? AND ${SQL_EXECUTION_CREATOR_MATCH}`,
      [
        stage,
        flatFee,
        quoteOrigin,
        JSON.stringify(nextHistory),
        JSON.stringify(lastEvent),
        campaignId,
        ...paramsExecutionCreatorMatch(influencerId),
      ]
    );
    await conn.commit();
    return { success: true, stage };
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}
