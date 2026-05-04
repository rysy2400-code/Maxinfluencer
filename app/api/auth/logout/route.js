import { NextResponse } from "next/server";
import { COOKIE_NAME, cookieIsSecure } from "../../../../lib/auth/advertiser-jwt.js";

export async function POST(req) {
  const res = NextResponse.json({ success: true });
  res.cookies.set(COOKIE_NAME, "", {
    httpOnly: true,
    secure: cookieIsSecure(req),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
