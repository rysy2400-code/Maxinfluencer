/**
 * 同意报价全流程（用桩替换 DB，不连库）
 * node scripts/test-approve-quote-charge-flow.mjs
 *
 * 覆盖 precheckQuoteApproveCharge + approveQuoteWithCharge，含 0 固定费（纯佣金/置换）。
 * 回归点：approveQuoteWithCharge 曾引用只存在于 resolveQuoteApproveCharge 内的
 * currency 变量，点击「同意」直接抛 ReferenceError: currency is not defined。
 */
import { register } from "node:module";

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

const loaderSource = `
const STUBS = {
  "stub:db/mysql-tiktok":
    "export const tiktokPool = {" +
    "  execute: (...args) => globalThis.__APPROVE_TEST_POOL__.execute(...args)," +
    "  getConnection: (...args) => globalThis.__APPROVE_TEST_POOL__.getConnection(...args)," +
    "};",
  "stub:db/campaign-dao":
    "export const getCampaignCoreById = async () => globalThis.__APPROVE_TEST_CAMPAIGN__;" +
    "export const getExecutionRow = async () => globalThis.__APPROVE_TEST_EXECUTION__;",
  "stub:db/execution-counts-cache": "export const invalidateExecutionCounts = () => {};",
  "stub:db/campaign-session-dao":
    "export const getCampaignSessionById = async () => ({ title: 'POBODO 轻运动服饰' });",
  "stub:db/campaign-execution-keys":
    "export const SQL_EXECUTION_CREATOR_MATCH = 'tiktok_username = ?';" +
    "export const paramsExecutionCreatorMatch = (creatorId) => [creatorId];",
  "stub:execution/need-sample": "export const resolveNeedSample = () => true;",
};

const MATCH = [
  ["db/mysql-tiktok.js", "stub:db/mysql-tiktok"],
  ["db/campaign-dao.js", "stub:db/campaign-dao"],
  ["db/execution-counts-cache.js", "stub:db/execution-counts-cache"],
  ["db/campaign-session-dao.js", "stub:db/campaign-session-dao"],
  ["db/campaign-execution-keys.js", "stub:db/campaign-execution-keys"],
  ["execution/need-sample.js", "stub:execution/need-sample"],
];

export async function resolve(specifier, context, next) {
  for (const [suffix, stubUrl] of MATCH) {
    if (specifier.endsWith(suffix)) {
      return { url: stubUrl, shortCircuit: true };
    }
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.startsWith("stub:")) {
    return { format: "module", source: STUBS[url], shortCircuit: true };
  }
  return next(url, context);
}
`;

register(`data:text/javascript,${encodeURIComponent(loaderSource)}`);

const { precheckQuoteApproveCharge, approveQuoteWithCharge } = await import(
  "../lib/billing/approve-quote-charge.js"
);

function createFakeConn(advertiser) {
  const calls = { ledgerInsert: null, executionUpdate: null, advertiserUpdates: [] };
  return {
    calls,
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async execute(sql, params = []) {
      if (sql.includes("FROM tiktok_advertiser_balance_ledger")) return [[], []];
      if (sql.includes("FROM tiktok_advertiser")) return [[advertiser], []];
      if (sql.includes("UPDATE tiktok_advertiser")) {
        calls.advertiserUpdates.push(params);
        return [{ affectedRows: 1 }, []];
      }
      if (sql.includes("INSERT INTO tiktok_advertiser_balance_ledger")) {
        calls.ledgerInsert = { sql, params };
        return [{ insertId: 1 }, []];
      }
      if (sql.includes("UPDATE tiktok_campaign_execution")) {
        calls.executionUpdate = { sql, params };
        return [{ affectedRows: 1 }, []];
      }
      return [[], []];
    },
  };
}

function installFixtures({ execution, advertiser }) {
  const conn = createFakeConn(advertiser);
  globalThis.__APPROVE_TEST_CAMPAIGN__ = {
    id: "CAMP-1788776684916-W94JVP9HY",
    sessionId: null,
    campaignInfo: { influencerPricing: { mode: "ask_creator_quote" } },
    productInfo: { needSample: true },
  };
  globalThis.__APPROVE_TEST_EXECUTION__ = execution;
  globalThis.__APPROVE_TEST_POOL__ = {
    async execute(sql) {
      if (sql.includes("FROM tiktok_advertiser")) return [[advertiser], []];
      return [[], []];
    },
    async getConnection() {
      return conn;
    },
  };
  return conn;
}

function readApprovedTerms(conn) {
  const raw = conn.calls.executionUpdate?.params?.[1];
  assert(typeof raw === "string", "stage 更新应写入 last_event JSON");
  return JSON.parse(raw).approvedTerms;
}

const CAMPAIGN_ID = "CAMP-1788776684916-W94JVP9HY";
const ADVERTISER = { balance_amount: 1000, balance_currency: "USD", credit_limit: 0 };

// 场景 1：@mercyy3y 这类 0 固定费 + 10% 佣金（原报错场景），应可同意且不扣款
{
  const execution = {
    stage: "quote_submitted",
    flat_fee: 0,
    commission_percent: 10,
    currency: "USD",
    source: "web_search",
    quote_origin: null,
    tiktok_username: "mercyy3y",
    influencer_id: "6931762170062373893",
    quote_negotiation: [{ role: "influencer", amount: 0, currency: "USD" }],
  };
  const conn = installFixtures({ execution, advertiser: ADVERTISER });

  const precheck = await precheckQuoteApproveCharge({
    campaignId: CAMPAIGN_ID,
    influencerId: "mercyy3y",
    advertiserId: 1,
  });
  assert(precheck.success, `0 固定费预检应通过：${precheck.message || ""}`);
  assert(precheck.chargeAmount === 0, "0 固定费预检扣款为 0");

  const result = await approveQuoteWithCharge({
    campaignId: CAMPAIGN_ID,
    influencerId: "mercyy3y",
    advertiserId: 1,
  });
  assert(result.success, `0 固定费应同意成功：${result.message || ""}`);
  assert(result.chargedAmount === 0, "0 固定费不扣款");
  assert(result.stage === "pending_shipping_address", "0 固定费同意后进入待填收货地址");

  const approvedTerms = readApprovedTerms(conn);
  assert(approvedTerms.currency === "USD", "条款快照必须带币种");
  assert(approvedTerms.fixedFeeUsd === 0, "条款快照固定费为 0");
  assert(approvedTerms.commissionPercent === 10, "条款快照佣金 10%");
  assert(conn.calls.advertiserUpdates.length === 0, "0 固定费不更新余额");
  assert(Number(conn.calls.ledgerInsert?.params?.[1]) === 0, "0 固定费流水金额为 0");
}

// 场景 2：有固定费（平台发现的 5% 服务费）仍按原口径扣款
{
  const execution = {
    stage: "quote_submitted",
    flat_fee: 500,
    commission_percent: 10,
    currency: "USD",
    source: "web_search",
    quote_origin: null,
    tiktok_username: "paid_creator",
    influencer_id: "1",
    quote_negotiation: [{ role: "influencer", amount: 500, currency: "USD" }],
  };
  const conn = installFixtures({ execution, advertiser: ADVERTISER });

  const result = await approveQuoteWithCharge({
    campaignId: CAMPAIGN_ID,
    influencerId: "paid_creator",
    advertiserId: 1,
  });
  assert(result.success, `有固定费应同意成功：${result.message || ""}`);
  assert(result.chargedAmount === 525, "固定费 500 + 5% 服务费 = 扣 525");
  assert(result.balanceAfter === 475, "余额扣减正确");
  assert(conn.calls.advertiserUpdates.length === 1, "有固定费才更新余额");
  assert(readApprovedTerms(conn).currency === "USD", "有固定费条款快照带币种");
}

console.log("✅ test-approve-quote-charge-flow.mjs passed");
