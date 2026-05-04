import { NextResponse } from "next/server";
import { COOKIE_NAME } from "../../../../lib/auth/advertiser-jwt.js";

export async function POST() {
  const res = NextResponse.json({ success: true });
  res.cookies.set(COOKIE_NAME, "", {
    httpOnly: true,
    path: "/",
    maxAge: 0,
  });
  return res;
}
