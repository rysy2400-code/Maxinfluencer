import { NextResponse } from "next/server";
import {
  countPendingAttributionQueue,
  listPendingAttributionQueue,
} from "../../../../lib/db/email-attribution-queue-dao.js";
import { requireInboxAdmin } from "../../../../lib/auth/influencer-inbox-auth-http.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const gate = await requireInboxAdmin(req);
    if (!gate.ok) return gate.response;

    const { searchParams } = new URL(req.url);
    const limit = Number(searchParams.get("limit") || 50);
    const [items, count] = await Promise.all([
      listPendingAttributionQueue({ limit }),
      countPendingAttributionQueue(),
    ]);

    return NextResponse.json({ success: true, items, count });
  } catch (error) {
    console.error("[Email Attribution Queue API] 失败:", error);
    return NextResponse.json(
      { success: false, error: error?.message || "获取未归属邮件队列失败" },
      { status: 500 }
    );
  }
}
