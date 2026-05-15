import { NextResponse } from "next/server";
import { listInfluencerInboxByProject } from "../../../../../lib/db/influencer-inbox-by-project-dao.js";

export const dynamic = "force-dynamic";

function decodeAccountCursor(cursor) {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(String(cursor), "base64url").toString("utf8");
    const o = JSON.parse(raw);
    if (!o || typeof o.companyName !== "string" || typeof o.advertiserUsername !== "string") return null;
    return { companyName: o.companyName, advertiserUsername: o.advertiserUsername };
  } catch {
    return null;
  }
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const q = searchParams.get("q") || null;
    const accountCursor = searchParams.get("accountCursor");
    const limit = searchParams.get("accountLimit");

    if (accountCursor && !decodeAccountCursor(accountCursor)) {
      return NextResponse.json({ success: false, error: "accountCursor 非法" }, { status: 400 });
    }

    const result = await listInfluencerInboxByProject({
      q,
      accountCursor,
      accountLimit: limit ? Number(limit) : 50,
    });

    return NextResponse.json({
      success: true,
      view: "byProject",
      ...result,
    });
  } catch (error) {
    console.error("[Influencer Conversations By Project API] 失败:", error);
    return NextResponse.json(
      { success: false, error: error?.message || "获取按项目分组列表失败" },
      { status: 500 }
    );
  }
}
