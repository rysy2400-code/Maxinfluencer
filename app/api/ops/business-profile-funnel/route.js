import { NextResponse } from "next/server";
import { requireCrawlerOpsSuperAdmin } from "../../../../lib/auth/require-crawler-ops-super-admin.js";
import { getBusinessProfileOpsSnapshot } from "../../../../lib/db/business-profile-ops-dao.js";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function shanghaiDateString(date) {
  return new Date(date.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function startOfShanghaiDayUtc(dateString) {
  return new Date(`${dateString}T00:00:00+08:00`);
}

function isCalendarDate(dateString) {
  if (!DATE_RE.test(dateString)) return false;
  const parsed = new Date(`${dateString}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === dateString;
}

function parseRange(searchParams, now) {
  const today = shanghaiDateString(now);
  const start = searchParams.get("start") || addDays(today, -29);
  const end = searchParams.get("end") || today;
  if (!isCalendarDate(start) || !isCalendarDate(end)) throw new Error("日期格式必须为有效的 YYYY-MM-DD");
  const startAt = startOfShanghaiDayUtc(start);
  const endExclusive = startOfShanghaiDayUtc(addDays(end, 1));
  if (!Number.isFinite(startAt.getTime()) || !Number.isFinite(endExclusive.getTime())) {
    throw new Error("日期无效");
  }
  const days = Math.round((endExclusive.getTime() - startAt.getTime()) / 86400000);
  if (days <= 0) throw new Error("结束日期不能早于开始日期");
  if (days > 366) throw new Error("单次最多查询 366 天");
  return { start, end, startAt, endExclusive };
}

export async function GET(request) {
  try {
    const auth = await requireCrawlerOpsSuperAdmin(request);
    if (!auth) return NextResponse.json({ success: false, error: "无权限" }, { status: 403 });
    const now = new Date();
    const range = parseRange(new URL(request.url).searchParams, now);
    const snapshot = await getBusinessProfileOpsSnapshot({
      startAt: range.startAt,
      endAt: range.endExclusive,
      now,
    });
    return NextResponse.json({
      success: true,
      range: { start: range.start, end: range.end, timezone: "Asia/Shanghai" },
      ...snapshot,
    });
  } catch (error) {
    const message = error?.message || "红人合作漏斗查询失败";
    const isInputError = /日期|366/.test(message);
    console.error("[ops/business-profile-funnel]", error);
    return NextResponse.json({ success: false, error: message }, { status: isInputError ? 400 : 500 });
  }
}
