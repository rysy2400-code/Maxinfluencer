import { NextResponse } from "next/server";
import {
  findAdvertiserByDisplayName,
  findUserByAdvertiserAndUsername,
  verifyPassword,
} from "../../../../lib/db/tiktok-advertiser-dao.js";
import { setInboxAuthCookie } from "../../../../lib/auth/advertiser-auth-cookie.js";
import { insertAdminActionLog } from "../../../../lib/db/admin-action-log-dao.js";

export const dynamic = "force-dynamic";

/** POST /api/influencers/auth/login — 仅管理员，独立 Cookie */
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

    if (!userRow.is_admin) {
      return NextResponse.json({ success: false, error: "需要管理员账号" }, { status: 403 });
    }

    const ok = await verifyPassword(password, userRow.password_hash);
    if (!ok) {
      return NextResponse.json({ success: false, error: "公司名或账号错误" }, { status: 401 });
    }

    const res = NextResponse.json({
      success: true,
      user: {
        companyName: advertiser.name,
        username: userRow.username,
        isAdmin: true,
      },
    });

    await setInboxAuthCookie(res, req, userRow.id);

    await insertAdminActionLog({
      realAdvertiserUserId: userRow.id,
      effectiveAdvertiserUserId: userRow.id,
      action: "inbox_login",
      meta: { companyName: advertiser.name, username: userRow.username },
    });

    return res;
  } catch (error) {
    console.error("[influencers/auth/login]", error);
    return NextResponse.json(
      { success: false, error: error.message || "登录失败" },
      { status: 500 }
    );
  }
}
