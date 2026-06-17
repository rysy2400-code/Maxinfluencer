import { NextResponse } from "next/server";
import { requireBillingAccess } from "../../../../lib/auth/require-billing-access.js";
import {
  getBillingNotificationConfig,
  upsertBillingNotificationConfig,
} from "../../../../lib/billing/billing-profile-dao.js";

export const dynamic = "force-dynamic";

function parseEmails(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e) => String(e || "").trim().toLowerCase())
    .filter((e) => e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
}

export async function GET(req) {
  try {
    const gate = await requireBillingAccess(req);
    if (!gate.ok) return gate.response;

    const config = await getBillingNotificationConfig(gate.auth.effectiveUser.advertiserId);
    return NextResponse.json({ success: true, config });
  } catch (error) {
    console.error("[billing/notification-config GET]", error);
    return NextResponse.json(
      { success: false, error: error.message || "读取失败" },
      { status: 500 }
    );
  }
}

export async function PUT(req) {
  try {
    const gate = await requireBillingAccess(req);
    if (!gate.ok) return gate.response;

    const body = await req.json().catch(() => ({}));
    const emails = parseEmails(body.financeNotifyEmails);
    if (!emails.length) {
      return NextResponse.json(
        { success: false, error: "请至少填写一个有效的财务通知邮箱" },
        { status: 400 }
      );
    }

    const config = await upsertBillingNotificationConfig(
      gate.auth.effectiveUser.advertiserId,
      emails,
      gate.auth.realUser.advertiserUserId
    );

    return NextResponse.json({ success: true, config });
  } catch (error) {
    console.error("[billing/notification-config PUT]", error);
    return NextResponse.json(
      { success: false, error: error.message || "保存失败" },
      { status: 500 }
    );
  }
}
