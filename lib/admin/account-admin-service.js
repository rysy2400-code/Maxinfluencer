import { tiktokPool } from "../db/mysql-tiktok.js";
import { hashPasswordForStorage } from "../db/tiktok-advertiser-dao.js";
import { makeManualReference } from "./account-admin-validation.js";

function isDuplicate(error) {
  return error?.code === "ER_DUP_ENTRY" || /duplicate entry/i.test(String(error?.message || ""));
}

async function queryRows(sql, params = []) {
  const [rows] = await tiktokPool.query(sql, params);
  return rows;
}

export async function listAdminCompanies({ q = "", limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const term = String(q || "").trim();
  const params = [];
  let where = "";
  if (term) {
    where = "WHERE a.name LIKE ?";
    params.push(`%${term.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`);
  }
  const rows = await queryRows(
    `SELECT a.id, a.name, a.balance_amount, a.balance_currency,
            COUNT(u.id) AS user_count
     FROM tiktok_advertiser a
     LEFT JOIN tiktok_advertiser_user u ON u.advertiser_id = a.id
     ${where}
     GROUP BY a.id, a.name, a.balance_amount, a.balance_currency
     ORDER BY a.name ASC LIMIT ${safeLimit}`,
    params
  );
  return (rows || []).map((row) => ({
    advertiserId: row.id,
    companyName: row.name,
    balance: Number(row.balance_amount) || 0,
    currency: row.balance_currency || "USD",
    userCount: Number(row.user_count) || 0,
  }));
}

export async function createAdvertiserAccount({ companyName, username, password, role, createdByUserId }) {
  const conn = await tiktokPool.getConnection();
  try {
    await conn.beginTransaction();
    const [companies] = await conn.query(
      "SELECT id FROM tiktok_advertiser WHERE name = ? LIMIT 1 FOR UPDATE",
      [companyName]
    );
    let advertiserId = companies?.[0]?.id;
    let companyCreated = false;
    if (!advertiserId) {
      try {
        const [result] = await conn.query(
          `INSERT INTO tiktok_advertiser (name, balance_amount, balance_currency)
           VALUES (?, 0, 'USD')`,
          [companyName]
        );
        advertiserId = result.insertId;
        companyCreated = true;
      } catch (error) {
        if (!isDuplicate(error)) throw error;
        const [existing] = await conn.query(
          "SELECT id FROM tiktok_advertiser WHERE name = ? LIMIT 1 FOR UPDATE",
          [companyName]
        );
        advertiserId = existing?.[0]?.id;
      }
    }
    if (!advertiserId) throw new Error("创建或读取公司失败");

    const passwordHash = hashPasswordForStorage(password);
    let result;
    try {
      [result] = await conn.query(
        `INSERT INTO tiktok_advertiser_user
          (advertiser_id, username, password_hash, is_active, is_admin, is_company_admin)
         VALUES (?, ?, ?, 1, 0, ?)`,
        [advertiserId, username, passwordHash, role === "company_admin" ? 1 : 0]
      );
    } catch (error) {
      if (isDuplicate(error)) {
        const duplicate = new Error("该公司下已存在相同用户名");
        duplicate.code = "ACCOUNT_EXISTS";
        throw duplicate;
      }
      throw error;
    }
    const advertiserUserId = result.insertId;
    await conn.query(
      `INSERT INTO admin_action_log
        (real_advertiser_user_id, effective_advertiser_user_id, action, resource_type, resource_id, meta)
       VALUES (?, ?, 'create_account', 'advertiser_user', ?, ?)`,
      [
        createdByUserId,
        advertiserUserId,
        String(advertiserUserId),
        JSON.stringify({ advertiserId, companyName, username, role, companyCreated }),
      ]
    );
    await conn.commit();
    return { advertiserId, advertiserUserId, companyName, username, role, companyCreated };
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
}

export async function recordTopUp({ advertiserId, amountUsd, receivedAt, bankReference, noBankReference, note, createdByUserId }) {
  const conn = await tiktokPool.getConnection();
  try {
    await conn.beginTransaction();
    const [companies] = await conn.query(
      `SELECT id, name, balance_amount, balance_currency
       FROM tiktok_advertiser WHERE id = ? LIMIT 1 FOR UPDATE`,
      [advertiserId]
    );
    const company = companies?.[0];
    if (!company) {
      const error = new Error("公司不存在");
      error.code = "COMPANY_NOT_FOUND";
      throw error;
    }
    if (company.balance_currency && company.balance_currency !== "USD") {
      throw new Error("该公司余额币种不是 USD，无法入账");
    }

    let reference = noBankReference ? makeManualReference() : bankReference;
    if (noBankReference) {
      for (let i = 0; i < 4; i += 1) {
        const [rows] = await conn.query(
          "SELECT id FROM tiktok_advertiser_top_up WHERE bank_reference = ? LIMIT 1",
          [reference]
        );
        if (!rows?.length) break;
        reference = makeManualReference();
      }
    }
    const idempotencyKey = `topup:${reference}`;
    const [existing] = await conn.query(
      `SELECT t.id, t.advertiser_id, t.ledger_id
       FROM tiktok_advertiser_top_up t WHERE t.bank_reference = ? LIMIT 1`,
      [reference]
    );
    if (existing?.length) {
      const error = new Error("该银行流水号已经入账");
      error.code = "TOPUP_EXISTS";
      throw error;
    }

    const currentBalance = Number(company.balance_amount) || 0;
    const amount = Number(amountUsd);
    const balanceAfter = ((Math.round(currentBalance * 100) + Math.round(amount * 100)) / 100).toFixed(4);
    const [ledgerResult] = await conn.query(
      `INSERT INTO tiktok_advertiser_balance_ledger
        (advertiser_id, amount, balance_after, currency, type, note, idempotency_key, created_by_user_id)
       VALUES (?, ?, ?, 'USD', 'top_up', ?, ?, ?)`,
      [advertiserId, amountUsd, balanceAfter, note || null, idempotencyKey, createdByUserId]
    );
    const [topUpResult] = await conn.query(
      `INSERT INTO tiktok_advertiser_top_up
        (advertiser_id, amount_usd, received_at, bank_reference, note, ledger_id, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [advertiserId, amountUsd, receivedAt, reference, note || null, ledgerResult.insertId, createdByUserId]
    );
    await conn.query(
      "UPDATE tiktok_advertiser SET balance_amount = ?, balance_currency = 'USD' WHERE id = ?",
      [balanceAfter, advertiserId]
    );
    await conn.query(
      `INSERT INTO admin_action_log
        (real_advertiser_user_id, effective_advertiser_user_id, action, resource_type, resource_id, meta)
       VALUES (?, ?, 'top_up', 'advertiser', ?, ?)`,
      [createdByUserId, createdByUserId, String(advertiserId), JSON.stringify({
        companyName: company.name,
        amountUsd: Number(amountUsd),
        receivedAt,
        bankReference: reference,
        topUpId: topUpResult.insertId,
        ledgerId: ledgerResult.insertId,
        balanceBefore: currentBalance,
        balanceAfter: Number(balanceAfter),
      })]
    );
    await conn.commit();
    return {
      topUpId: topUpResult.insertId,
      ledgerId: ledgerResult.insertId,
      advertiserId,
      companyName: company.name,
      amountUsd: Number(amountUsd),
      bankReference: reference,
      referenceType: noBankReference ? "internal" : "bank",
      balanceBefore: currentBalance,
      balanceAfter: Number(balanceAfter),
      receivedAt,
    };
  } catch (error) {
    await conn.rollback().catch(() => {});
    if (isDuplicate(error)) {
      const duplicate = new Error("该银行流水号已经入账");
      duplicate.code = "TOPUP_EXISTS";
      throw duplicate;
    }
    throw error;
  } finally {
    conn.release();
  }
}

export async function listAdminTopUps({ advertiserId, from, to, reference, page = 1, pageSize = 20 } = {}) {
  const safePage = Math.max(Number(page) || 1, 1);
  const safePageSize = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
  const where = ["1=1"];
  const params = [];
  if (advertiserId) {
    where.push("t.advertiser_id = ?");
    params.push(Number(advertiserId));
  }
  if (from) {
    where.push("t.received_at >= ?");
    params.push(from);
  }
  if (to) {
    where.push("t.received_at <= ?");
    params.push(to);
  }
  if (reference) {
    where.push("t.bank_reference LIKE ?");
    params.push(`%${String(reference).replace(/%/g, "\\%").replace(/_/g, "\\_")}%`);
  }
  const sqlWhere = where.join(" AND ");
  const [countRows, rows] = await Promise.all([
    queryRows(`SELECT COUNT(*) AS cnt FROM tiktok_advertiser_top_up t WHERE ${sqlWhere}`, params),
    queryRows(
      `SELECT t.id, t.advertiser_id, a.name AS company_name, t.amount_usd, t.received_at,
              t.bank_reference, t.note, t.created_at, t.created_by_user_id,
              u.username AS created_by_username, l.balance_after
       FROM tiktok_advertiser_top_up t
       INNER JOIN tiktok_advertiser a ON a.id = t.advertiser_id
       LEFT JOIN tiktok_advertiser_user u ON u.id = t.created_by_user_id
       LEFT JOIN tiktok_advertiser_balance_ledger l ON l.id = t.ledger_id
       WHERE ${sqlWhere}
       ORDER BY t.received_at DESC, t.id DESC
       LIMIT ${safePageSize} OFFSET ${(safePage - 1) * safePageSize}`,
      params
    ),
  ]);
  return {
    page: safePage,
    pageSize: safePageSize,
    total: Number(countRows?.[0]?.cnt) || 0,
    items: (rows || []).map((row) => ({
      id: row.id,
      advertiserId: row.advertiser_id,
      companyName: row.company_name,
      amountUsd: Number(row.amount_usd),
      balanceBefore: Number(row.balance_after) - Number(row.amount_usd),
      balanceAfter: Number(row.balance_after),
      receivedAt: row.received_at,
      bankReference: row.bank_reference,
      referenceType: String(row.bank_reference || "").startsWith("MANUAL-") ? "internal" : "bank",
      note: row.note || "",
      createdAt: row.created_at,
      createdByUsername: row.created_by_username || "—",
    })),
  };
}
