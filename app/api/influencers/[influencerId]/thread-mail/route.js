import { NextResponse } from "next/server";
import { getInfluencerById } from "../../../../../lib/db/influencer-dao.js";
import { resolveInfluencerThreadMailContext } from "../../../../../lib/email/influencer-thread-mail.js";

function accountEmail(acc) {
  if (!acc) return null;
  return (
    acc.email ||
    acc.email_address ||
    acc.username ||
    acc.account ||
    null
  );
}

export async function GET(_req, { params }) {
  try {
    const influencerId = params?.influencerId;
    if (!influencerId) {
      return NextResponse.json(
        { success: false, error: "缺少 influencerId" },
        { status: 400 }
      );
    }

    const influencer = await getInfluencerById(influencerId).catch(() => null);
    const ctx = await resolveInfluencerThreadMailContext({
      influencerId,
      influencer,
    });

    const outboundEmail = accountEmail(ctx.fromAccount);

    return NextResponse.json({
      success: true,
      outboundEmail,
      usedRandomSender: !!ctx.usedRandomSender,
    });
  } catch (error) {
    console.error("[Influencer ThreadMail API] 解析发件账号失败:", error);
    return NextResponse.json(
      {
        success: false,
        error: error?.message || "解析发件账号失败",
        outboundEmail: null,
      },
      { status: 500 }
    );
  }
}
