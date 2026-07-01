import { NextResponse } from "next/server";
import {
  getCampaignById,
  getExecutionRow,
  updateExecutionStage,
} from "../../../../../lib/db/campaign-dao.js";
import { enqueueAdvertiserExecutionFollowup } from "../../../../../lib/execution/enqueue-advertiser-followup.js";
import { getAuthenticatedAdvertiserUser } from "../../../../../lib/auth/advertiser-auth-http.js";
import { assertUserCanAccessCampaign } from "../../../../../lib/auth/campaign-access.js";
import { executeApproveQuote } from "../../../../../lib/execution/approve-quote.js";
import { precheckQuoteApproveCharge } from "../../../../../lib/billing/approve-quote-charge.js";

/**
 * PATCH /api/campaigns/[id]/execution
 * 更新红人执行阶段（同意价格、寄样、通过草稿等）
 * Body: { influencerId, action, payload? }
 * action: precheckApproveQuote | submitQuote | reopenQuote | approveQuote | rejectQuote | confirmShip | approveDraft | rejectDraft | publishVideo | updatePublished | updateShipping | updateDraft
 */
export async function PATCH(req, { params }) {
  try {
    const auth = await getAuthenticatedAdvertiserUser(req);
    if (!auth) {
      return NextResponse.json(
        { success: false, error: "请先登录" },
        { status: 401 }
      );
    }

    const { id: campaignId } = params;
    if (!campaignId) {
      return NextResponse.json(
        { success: false, error: "缺少 campaign ID" },
        { status: 400 }
      );
    }

    const access = await assertUserCanAccessCampaign(campaignId, auth);
    if (!access.ok) {
      return NextResponse.json(
        {
          success: false,
          error:
            access.status === 403
              ? "无权操作该 Campaign"
              : access.status === 404
                ? "Campaign 不存在"
                : "无权操作",
        },
        { status: access.status }
      );
    }

    const body = await req.json().catch(() => ({}));
    const { influencerId, action, payload = {} } = body;
    if (!influencerId || !action) {
      return NextResponse.json(
        { success: false, error: "缺少 influencerId 或 action" },
        { status: 400 }
      );
    }

    const campaign = await getCampaignById(campaignId);
    if (!campaign) {
      return NextResponse.json(
        { success: false, error: "Campaign 不存在" },
        { status: 404 }
      );
    }

    let stage = null;
    let lastEvent = null;
    let quoteAppend = null;

    switch (action) {
      case "precheckApproveQuote": {
        const precheck = await precheckQuoteApproveCharge({
          campaignId,
          influencerId,
          advertiserId: auth.advertiserId,
        });
        if (!precheck.success) {
          return NextResponse.json(
            {
              success: false,
              error: precheck.message,
              code: precheck.code || null,
              chargeAmount: precheck.chargeAmount ?? null,
              currentBalance: precheck.currentBalance ?? null,
            },
            { status: 400 }
          );
        }
        return NextResponse.json({
          success: true,
          chargeAmount: precheck.chargeAmount,
          currentBalance: precheck.currentBalance,
          balanceAfter: precheck.balanceAfter,
          influencerAmount: precheck.influencerAmount,
          platformFeeAmount: precheck.platformFeeAmount,
        });
      }
      case "submitQuote": {
        const amount = Number(payload.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
          return NextResponse.json(
            { success: false, error: "submitQuote 需要有效正数 amount" },
            { status: 400 }
          );
        }
        const reason =
          typeof payload.reason === "string" ? payload.reason.trim().slice(0, 2000) : "";
        quoteAppend = {
          role: "advertiser",
          amount,
          currency: payload.currency || undefined,
          reason: reason || null,
          type: "counter",
          source: "advertiser_portal",
        };
        lastEvent = { advertiserCounterQuoteAt: new Date().toISOString() };
        break;
      }
      case "reopenQuote": {
        const existing = await getExecutionRow(campaignId, influencerId);
        if (!existing || existing.stage !== "quote_rejected") {
          return NextResponse.json(
            { success: false, error: "仅 quote_rejected 状态可撤销拒绝" },
            { status: 400 }
          );
        }
        const reopenReason = String(payload.reopenReason || "").trim();
        if (!reopenReason) {
          return NextResponse.json(
            { success: false, error: "请填写撤销原因 reopenReason" },
            { status: 400 }
          );
        }
        stage = "quote_submitted";
        lastEvent = {
          quoteReopenedAt: new Date().toISOString(),
          reopenReason: reopenReason.slice(0, 2000),
          reopenedBy: payload.reopenedBy || "advertiser",
        };
        quoteAppend = {
          role: "advertiser",
          amount: null,
          currency: existing.currency || "USD",
          reason: reopenReason.slice(0, 2000),
          type: "reopen",
          source: "advertiser_portal",
        };
        break;
      }
      case "updateShipping":
        lastEvent = { shippingAddress: payload.shippingAddress || payload };
        break;
      case "updateDraft":
        lastEvent = { draftLink: payload.draftLink || payload };
        break;
      case "approveQuote": {
        const chargeResult = await executeApproveQuote({
          campaignId,
          influencerId,
          advertiserId: auth.advertiserId,
          advertiserUserId: auth.advertiserUserId,
          payload,
        });
        if (!chargeResult.success) {
          return NextResponse.json(
            { success: false, error: chargeResult.message },
            { status: 400 }
          );
        }
        return NextResponse.json({
          success: true,
          stage: chargeResult.stage,
          chargedAmount: chargeResult.chargedAmount,
          balanceAfter: chargeResult.balanceAfter,
          message: chargeResult.alreadyProcessed ? "已同意报价" : "更新成功",
        });
      }
      case "rejectQuote": {
        const rejectReason = String(payload.rejectReason || "").trim();
        if (!rejectReason) {
          return NextResponse.json(
            { success: false, error: "请填写拒绝原因 rejectReason" },
            { status: 400 }
          );
        }
        const row = await getExecutionRow(campaignId, influencerId);
        stage = "quote_rejected";
        lastEvent = {
          quoteRejectedAt: new Date().toISOString(),
          rejectReason: rejectReason.slice(0, 2000),
        };
        quoteAppend = {
          role: "advertiser",
          amount: null,
          currency: row?.currency || "USD",
          reason: rejectReason.slice(0, 2000),
          type: "quote_rejected",
          source: "advertiser_portal",
        };
        break;
      }
      case "confirmShip":
        stage = "pending_draft";
        lastEvent = {
          shippingAddress: payload.shippingAddress || payload,
          sampleSentAt: new Date().toISOString(),
        };
        break;
      case "approveDraft":
        stage = "published";
        lastEvent = {
          draftApprovedAt: new Date().toISOString(),
          ...payload,
        };
        break;
      case "rejectDraft": {
        const feedback = String(
          payload.feedback || payload.draftFeedback || ""
        ).trim();
        if (!feedback) {
          return NextResponse.json(
            { success: false, error: "请填写修改建议 feedback" },
            { status: 400 }
          );
        }
        stage = "draft_submitted";
        const existing = await getExecutionRow(campaignId, influencerId);
        const prevHistory = existing?.lastEvent?.revisionHistory || [];
        const draftLink = payload.draftLink || existing?.lastEvent?.draftLink;
        lastEvent = {
          draftFeedback: feedback.slice(0, 2000),
          draftLink,
          draftRejectedAt: new Date().toISOString(),
          revisionHistory: [
            ...prevHistory,
            {
              draftLink,
              feedback: feedback.slice(0, 2000),
              rejectedAt: new Date().toISOString(),
            },
          ],
        };
        break;
      }
      case "publishVideo":
        stage = "published";
        lastEvent = {
          videoLink: payload.videoLink,
          promoCode: payload.promoCode,
          views: payload.views,
          likes: payload.likes,
          comments: payload.comments,
          publishedAt: new Date().toISOString(),
        };
        break;
      case "updatePublished":
        lastEvent = {
          ...(payload.videoLink != null && { videoLink: payload.videoLink }),
          ...(payload.promoCode != null && { promoCode: payload.promoCode }),
          ...(payload.views != null && { views: payload.views }),
          ...(payload.likes != null && { likes: payload.likes }),
          ...(payload.comments != null && { comments: payload.comments }),
        };
        break;
      default:
        return NextResponse.json(
          { success: false, error: `未知 action: ${action}` },
          { status: 400 }
        );
    }

    await updateExecutionStage(campaignId, influencerId, {
      stage,
      lastEvent,
      quoteAppend,
    });

    try {
      const executionRow = await getExecutionRow(campaignId, influencerId);
      await enqueueAdvertiserExecutionFollowup({
        campaignId,
        influencerId,
        action,
        campaign,
        executionRow,
        payload,
      });
    } catch (enqueueErr) {
      console.warn(
        "[Campaign Execution API] 写入 Influencer Agent 跟进队列失败（不影响 stage 更新）:",
        enqueueErr?.message || enqueueErr
      );
    }

    return NextResponse.json({
      success: true,
      stage,
      message: "更新成功",
    });
  } catch (error) {
    console.error("[Campaign Execution API] 更新执行阶段失败:", error);
    return NextResponse.json(
      { success: false, error: error.message || "更新失败" },
      { status: 500 }
    );
  }
}
