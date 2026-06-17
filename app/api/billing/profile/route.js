import { NextResponse } from "next/server";
import { requireBillingAccess } from "../../../../lib/auth/require-billing-access.js";
import {
  getBillingProfile,
  upsertBillingProfile,
} from "../../../../lib/billing/billing-profile-dao.js";

export const dynamic = "force-dynamic";

function mapProfile(row) {
  if (!row) return null;
  return {
    companyLegalName: row.company_legal_name,
    companyAddress: row.company_address,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    taxId: row.tax_id || "",
    country: row.country || "",
    updatedAt: row.updated_at,
  };
}

export async function GET(req) {
  try {
    const gate = await requireBillingAccess(req);
    if (!gate.ok) return gate.response;

    const row = await getBillingProfile(gate.auth.effectiveUser.advertiserId);
    return NextResponse.json({ success: true, profile: mapProfile(row) });
  } catch (error) {
    console.error("[billing/profile GET]", error);
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
    const companyLegalName = String(body.companyLegalName || "").trim();
    const companyAddress = String(body.companyAddress || "").trim();
    const contactName = String(body.contactName || "").trim();
    const contactEmail = String(body.contactEmail || "").trim();

    if (!companyLegalName || !companyAddress || !contactName || !contactEmail) {
      return NextResponse.json(
        { success: false, error: "请填写完整的开票信息" },
        { status: 400 }
      );
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
      return NextResponse.json({ success: false, error: "联系邮箱格式无效" }, { status: 400 });
    }

    const row = await upsertBillingProfile(
      gate.auth.effectiveUser.advertiserId,
      {
        companyLegalName,
        companyAddress,
        contactName,
        contactEmail,
        taxId: String(body.taxId || "").trim() || null,
        country: String(body.country || "").trim() || null,
      },
      gate.auth.realUser.advertiserUserId
    );

    return NextResponse.json({ success: true, profile: mapProfile(row) });
  } catch (error) {
    console.error("[billing/profile PUT]", error);
    return NextResponse.json(
      { success: false, error: error.message || "保存失败" },
      { status: 500 }
    );
  }
}
