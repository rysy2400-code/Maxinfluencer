import { NextResponse } from "next/server";
import { clearInboxAuthCookie } from "../../../../../lib/auth/advertiser-auth-cookie.js";

export async function POST(req) {
  const res = NextResponse.json({ success: true });
  clearInboxAuthCookie(res, req);
  return res;
}
