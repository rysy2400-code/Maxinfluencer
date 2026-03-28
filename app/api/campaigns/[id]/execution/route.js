import { NextResponse } from "next/server";
import {
  getCampaignById,
  getExecutionRow,
  updateExecutionStage,
} from "../../../../../lib/db/campaign-dao.js";

/**
 * PATCH /api/campaigns/[id]/execution
 * 更新红人执行阶段（同意价格、寄样、通过草稿等）
 * Body: { influencerId, action, payload? }
 * action: approveQuote | rejectQuote | confirmShip | approveDraft | rejectDraft | publishVideo
 */
export async function PATCH(req, { params }) {
  try {
    const { id: campaignId } = params;
    if (!campaignId) {
      return NextResponse.json(
        { success: false, error: "缺少 campaign ID" },
        { status: 400 }
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
    let lastEvent = {};

    switch (action) {
      case "updateShipping":
        lastEvent = { shippingAddress: payload.shippingAddress || payload };
        break;
      case "updateDraft":
        lastEvent = { draftLink: payload.draftLink || payload };
        break;
      case "approveQuote":
        stage = "pending_sample";
        lastEvent = { quoteApprovedAt: new Date().toISOString() };
        break;
      case "rejectQuote":
        stage = "failed";
        lastEvent = { quoteRejectedAt: new Date().toISOString(), ...payload };
        break;
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
        stage = "draft_submitted";
        const existing = await getExecutionRow(campaignId, influencerId);
        const prevHistory = existing?.lastEvent?.revisionHistory || [];
        const draftLink = payload.draftLink || existing?.lastEvent?.draftLink;
        const feedback = payload.feedback || payload.draftFeedback || "";
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
    });

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
