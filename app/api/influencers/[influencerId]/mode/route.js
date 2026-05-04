import { NextResponse } from "next/server";
import {
  getInfluencerHandoverMode,
  setInfluencerHandoverMode,
} from "../../../../../lib/db/influencer-handover-dao.js";

export async function GET(_req, { params }) {
  try {
    const influencerId = params?.influencerId;
    if (!influencerId) {
      return NextResponse.json(
        { success: false, error: "缺少 influencerId" },
        { status: 400 }
      );
    }
    const mode = (await getInfluencerHandoverMode(influencerId)) || "assist";
    return NextResponse.json({ success: true, mode });
  } catch (error) {
    console.error("[Influencer Mode API] 获取失败:", error);
    return NextResponse.json(
      { success: false, error: error?.message || "获取 mode 失败" },
      { status: 500 }
    );
  }
}

export async function PATCH(req, { params }) {
  try {
    const influencerId = params?.influencerId;
    if (!influencerId) {
      return NextResponse.json(
        { success: false, error: "缺少 influencerId" },
        { status: 400 }
      );
    }
    const body = await req.json().catch(() => ({}));
    const mode = body?.mode;
    if (mode !== "auto" && mode !== "assist") {
      return NextResponse.json(
        { success: false, error: "mode 必须为 auto 或 assist" },
        { status: 400 }
      );
    }
    const saved = await setInfluencerHandoverMode(influencerId, mode);
    return NextResponse.json({ success: true, mode: saved });
  } catch (error) {
    console.error("[Influencer Mode API] 更新失败:", error);
    return NextResponse.json(
      { success: false, error: error?.message || "更新 mode 失败" },
      { status: 500 }
    );
  }
}

