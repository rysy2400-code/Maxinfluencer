/**
 * 合同交付邮件正文：由 LLM 生成（整封正文，含称呼与签名）。
 *
 * 设计约束（已与业务确认）：
 * - 关键字段与「合同条款原文」由系统以结构化数据喂给 LLM，LLM 只负责组织语言，不负责记事实；
 * - 首版：概括重要条款（费用金额+币种、付款时间与验收规则、交付内容要点；如有 Additional Terms 一并提）；
 * - 修订版：只提 changeSummary，并说明替代上一版；
 * - 首版与修订版都必须提到「回复确认即可，不需要马上签字回传」；
 * - 纯英文；尽量简洁；以红人经纪人口吻沟通，维护红人利益；
 * - 系统不做内容校验（业务决定）：生成失败则不发送并标记失败。
 */
import { callDeepSeekLLM } from "../utils/llm-client.js";

/** 生成失败时抛出，调用方据此把事件标记为 failed */
export class ContractEmailGenerationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContractEmailGenerationError";
  }
}

const SIGNATURE_BLOCK = "Best,\nBin\nBinfluencer\nhttps://www.binfluencer.xyz";

const FIRST_VERSION_RULES = [
  "This email is the FIRST version of the agreement being sent to the creator.",
  "- Briefly summarise the key terms from the provided clauses: the fee (amount and currency), the payment timing and the acceptance rule, and the key deliverables points.",
  '- If "clauses.additionalTerms" is not empty, briefly mention those terms too.',
].join("\n");

function revisionRules(rev, previousContractNo) {
  const prev = previousContractNo ? ` (${previousContractNo})` : "";
  return [
    `This email is a REVISED version (revision ${rev}) of an agreement already sent to the creator.`,
    `- Say clearly that this version replaces the earlier version${prev}, and that it is now the current and complete version.`,
    '- Mention ONLY the change described in "changeSummary". Do NOT restate the other terms (fee, payment timing, acceptance, deliverables) — the attached agreement is the reference for those.',
  ].join("\n");
}

function buildSystemPrompt({ isRevision, revision, previousContractNo }) {
  return [
    'You are "Bin", the AI talent manager at Binfluencer. You represent the creator and manage their brand collaborations, so you always communicate in the creator\'s interest.',
    "",
    "You are writing a short email to the creator that accompanies an attached collaboration agreement (PDF). Output ONLY the email body in English, plain text.",
    "",
    "Voice and length:",
    "- Write as the creator's talent manager: clear, warm, professional, protective of the creator's interests.",
    "- Keep it as concise as possible.",
    "- English only. No markdown, no bullet points, no subject line, no JSON, no extra commentary.",
    "- Start with a greeting using the creator's display name from the input.",
    "- End with EXACTLY this signature block:",
    SIGNATURE_BLOCK,
    "",
    "Hard rules:",
    "- You MUST explicitly include BOTH the exact fileName AND the exact contractNo from the input, verbatim and unchanged.",
    '- State the contract number as a separate, clearly identifiable element (for example: "Agreement No. <contractNo>"). It is NOT enough for the number to appear only inside the file name, and it is NOT enough for the file name to be omitted because the number is present.',
    "- If either the file name or the contract number is missing, altered, or paraphrased, the email is invalid — include both exactly, every time.",
    '- Base every statement ONLY on the provided "clauses" and field values. Never add, remove, soften, strengthen, or reinterpret any term.',
    "- Never promise anything that is not in the provided clauses (no extra dates, payments, rights, or usage permissions).",
    "- Always include, in your own words, that the creator does not need to sign and return anything right away, and that a simple reply confirming they are happy with the terms is enough.",
    "",
    isRevision
      ? revisionRules(revision, previousContractNo)
      : FIRST_VERSION_RULES,
  ].join("\n");
}

/**
 * @param {{
 *   displayName?: string|null,
 *   handle?: string|null,
 *   contractNo: string,
 *   fileName: string,
 *   revision?: number|null,
 *   previousContractNo?: string|null,
 *   changeSummary?: string|null,
 *   brandName?: string|null,
 *   productName?: string|null,
 *   productLink?: string|null,
 *   campaignId?: string|null,
 *   clauses?: object|null,
 * }} opts
 * @returns {Promise<string>}
 */
export async function generateContractEmailBody({
  displayName = null,
  handle = null,
  contractNo,
  fileName,
  revision = 1,
  previousContractNo = null,
  changeSummary = null,
  brandName = null,
  productName = null,
  productLink = null,
  campaignId = null,
  clauses = null,
}) {
  if (!contractNo || !fileName) {
    throw new ContractEmailGenerationError("缺少 contractNo 或 fileName，无法生成合同邮件");
  }

  const rev = Number(revision) >= 2 ? Math.floor(Number(revision)) : 1;
  const isRevision = rev >= 2;

  const clauseTexts = {
    deliverables: String(clauses?.deliverables || "").trim() || null,
    fee: String(clauses?.fee || "").trim() || null,
    paymentTiming: String(clauses?.paymentTiming || "").trim() || null,
    acceptance: String(clauses?.acceptance || "").trim() || null,
    paymentMethod: String(clauses?.paymentMethod || "").trim() || null,
    additionalTerms: Array.isArray(clauses?.additionalTerms) ? clauses.additionalTerms : [],
  };

  const context = {
    creator: {
      displayName: displayName || null,
      handle: handle ? `@${String(handle).replace(/^@/, "")}` : null,
    },
    agreement: {
      contractNo,
      fileName,
      revision: rev,
      previousContractNo: isRevision ? previousContractNo : null,
    },
    changeSummary: isRevision ? changeSummary : null,
    campaign: { campaignId, brandName, productName, productLink },
    clauses: clauseTexts,
  };

  const systemPrompt = buildSystemPrompt({
    isRevision,
    revision: rev,
    previousContractNo,
  });

  const userContent = `Input (JSON):
${JSON.stringify(context, null, 2)}

Output ONLY the email body in English (plain text).`;

  let raw = null;
  try {
    raw = await callDeepSeekLLM([{ role: "user", content: userContent }], systemPrompt);
  } catch (err) {
    throw new ContractEmailGenerationError(
      `合同邮件生成失败（LLM 调用异常）：${err?.message || String(err)}`
    );
  }

  const body = String(raw || "")
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  if (!body) {
    throw new ContractEmailGenerationError("合同邮件生成失败：LLM 返回为空");
  }
  return body;
}
