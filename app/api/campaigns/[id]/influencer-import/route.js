import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** @deprecated 请使用聊天 📎 薄上传 + import_influencer_list 工具链路 */
export async function POST() {
  return NextResponse.json(
    {
      success: false,
      error: "请通过聊天框 📎 上传附件并发送消息，由 Bin 处理导入。",
    },
    { status: 410 }
  );
}
