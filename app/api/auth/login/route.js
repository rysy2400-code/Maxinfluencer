import { NextResponse } from "next/server";
import {
  findAdvertiserByDisplayName,
  findUserByAdvertiserAndUsername,
  verifyPassword,
} from "../../../../lib/db/tiktok-advertiser-dao.js";
import {
  signAdvertiserToken,
  COOKIE_NAME,
  MAX_AGE_SEC,
  cookieIsSecure,
} from "../../../../lib/auth/advertiser-jwt.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const companyName = typeof body.companyName === "string" ? body.companyName.trim() : "";
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!companyName || !username) {
      return NextResponse.json(
        { success: false, error: "请填写公司名与用户名" },
        { status: 400 }
      );
    }
    if (!/^\d{6}$/.test(password)) {
      return NextResponse.json(
        { success: false, error: "密码须为 6 位数字" },
        { status: 400 }
      );
    }

    const advertiser = await findAdvertiserByDisplayName(companyName);
    if (!advertiser) {
      return NextResponse.json({ success: false, error: "公司名或账号错误" }, { status: 401 });
    }

    const userRow = await findUserByAdvertiserAndUsername(advertiser.id, username);
    if (!userRow) {
      return NextResponse.json({ success: false, error: "公司名或账号错误" }, { status: 401 });
    }

    if (!userRow.is_active) {
      return NextResponse.json(
        { success: false, error: "您的帐号已停用，有需要请联系Maxin AI。" },
        { status: 403 }
      );
    }

    const ok = await verifyPassword(password, userRow.password_hash);
    if (!ok) {
      return NextResponse.json({ success: false, error: "公司名或账号错误" }, { status: 401 });
    }

    const token = await signAdvertiserToken({
      advertiserUserId: userRow.id,
      advertiserId: advertiser.id,
      username: userRow.username,
      companyName: advertiser.name,
      isAdmin: !!userRow.is_admin,
    });

    const res = NextResponse.json({
      success: true,
      user: {
        companyName: advertiser.name,
        username: userRow.username,
        isAdmin: !!userRow.is_admin,
      },
    });

    res.cookies.set(COOKIE_NAME, token, {
      httpOnly: true,
      secure: cookieIsSecure(req),
      sameSite: "lax",
      path: "/",
      maxAge: MAX_AGE_SEC,
    });

    return res;
  } catch (error) {
    console.error("[auth/login]", error);
    return NextResponse.json(
      { success: false, error: error.message || "登录失败" },
      { status: 500 }
    );
  }
}
