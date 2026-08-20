import { NextResponse } from "next/server";
import {
  claimAttributionQueueItem,
  ignoreAttributionQueueItem,
} from "../../../../../lib/db/email-attribution-queue-dao.js";
import { normalizeCanonicalInfluencerId } from "../../../../../lib/influencer/influencer-id-resolver.js";
import { requireInboxAdmin } from "../../../../../lib/auth/influencer-inbox-auth-http.js";

export const dynamic = "force-dynamic";

export async function POST(req, { params }) {
  try {
    const gate = await requireInboxAdmin(req);
    if (!gate.ok) return gate.response;

    const id = Number(params?.id);
    if (!Number.isFinite(id) || id <= 0) {
      return NextResponse.json(
        { success: false, error: "id 非法" },
        { status: 400 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const action = body?.action;
    if (action === "ignore") {
      await ignoreAttributionQueueItem(id);
      return NextResponse.json({ success: true });
    }
    if (action === "claim") {
      const influencerId = await normalizeCanonicalInfluencerId(
        body?.influencerId
      );
      if (!influencerId) {
        return NextResponse.json(
          { success: false, error: "无法解析该红人标识，请检查 influencer_id / username" },
          { status: 400 }
        );
      }
      const result = await claimAttributionQueueItem(id, influencerId);
      if (!result.ok) {
        return NextResponse.json(
          { success: false, error: result.error || "认领失败" },
          { status: 409 }
        );
      }
      return NextResponse.json({ success: true });
    }
    return NextResponse.json(
      { success: false, error: "action 必须为 claim 或 ignore" },
      { status: 400 }
    );
  } catch (error) {
    console.error("[Email Attribution Queue Item API] 失败:", error);
    return NextResponse.json(
      { success: false, error: error?.message || "处理失败" },
      { status: 500 }
    );
  }
}
