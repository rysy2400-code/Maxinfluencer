import { NextResponse } from "next/server";
import { getAuthenticatedInboxAdmin } from "../../../../../lib/auth/advertiser-auth-http.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const admin = await getAuthenticatedInboxAdmin(req);
    if (!admin) {
      return NextResponse.json({ success: false, authenticated: false }, { status: 401 });
    }
    return NextResponse.json({
      success: true,
      authenticated: true,
      user: {
        companyName: admin.companyName,
        username: admin.username,
        isAdmin: true,
      },
    });
  } catch (error) {
    console.error("[influencers/auth/me]", error);
    return NextResponse.json(
      { success: false, error: error.message || "读取失败" },
      { status: 500 }
    );
  }
}
