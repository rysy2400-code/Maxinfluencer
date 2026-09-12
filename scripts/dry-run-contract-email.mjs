/**
 * 干跑（不发送）：验证合同生成 + 邮件正文 + 线程上下文解析。
 * 用法：node tmp/test-contract-email-dry.mjs
 */
import fs from "fs";
import { getExecutionRow } from "../lib/db/campaign-dao.js";
import { getInfluencerById } from "../lib/db/influencer-dao.js";
import { resolveInfluencerThreadMailContext } from "../lib/email/influencer-thread-mail.js";
import { generateContractForExecution } from "../lib/contract/generate-contract.js";
import { buildContractEmailBody } from "../lib/contract/contract-email.js";

const CAMPAIGN_ID = "CAMP-1788260979200-APW0DKQL7";
const HANDLE = "shinwamystery";

async function main() {
  const execution = await getExecutionRow(CAMPAIGN_ID, HANDLE);
  const platformInfluencerId = String(execution.influencer_id);
  const influencer = await getInfluencerById(platformInfluencerId);

  const contract = await generateContractForExecution({
    campaignId: CAMPAIGN_ID,
    influencerHandle: HANDLE,
    influencerId: platformInfluencerId,
  });
  const pdfBuffer = fs.readFileSync(contract.absPath);
  const fileName = `${contract.contractNo}.pdf`;

  const bodyText = buildContractEmailBody({
    displayName: influencer.displayName,
    contractNo: contract.contractNo,
    fileName,
  });

  const ctx = await resolveInfluencerThreadMailContext({
    influencerId: platformInfluencerId,
    influencer,
    campaignId: CAMPAIGN_ID,
  });

  console.log("=== DRY RUN (nothing sent) ===");
  console.log("to          :", influencer.influencerEmail);
  console.log("fromAccount :", ctx?.fromAccount?.email || ctx?.fromAccount?.email_address || ctx?.fromAccount || null);
  console.log("subject     :", ctx?.subjectForSend);
  console.log("inReplyTo   :", ctx?.inReplyTo || null);
  console.log("attachment  :", fileName, pdfBuffer.length, "bytes");
  console.log("contractNo  :", contract.contractNo, "| date:", contract.contractDate, "| fee:", contract.feeAmount, contract.currency);
  console.log("storageKey  :", contract.storageKey);
  console.log("\n=== EMAIL BODY ===\n");
  console.log(bodyText);
  process.exit(0);
}

main().catch((e) => { console.error("ERR", e?.stack || e); process.exit(1); });
