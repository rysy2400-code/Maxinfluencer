/**
 * 生成合同 PDF 供人工预览（不发送、不写任何业务表）。
 *
 * 用法：
 *   node scripts/preview-contract.mjs --campaign CAMP-xxx --handle shinwamystery
 */
import { generateContractForExecution } from "../lib/contract/generate-contract.js";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

async function main() {
  const campaignId = arg("campaign");
  const handle = arg("handle");
  const influencerId = arg("influencerId");
  const contractNo = arg("contractNo");

  if (!campaignId || (!handle && !influencerId)) {
    console.error("用法: node scripts/preview-contract.mjs --campaign <id> --handle <handle> [--contractNo <no>]");
    process.exit(1);
  }

  const result = await generateContractForExecution({
    campaignId,
    influencerHandle: handle,
    influencerId,
    contractNo,
  });

  console.log("=== CONTRACT GENERATED (preview only, nothing sent) ===");
  console.log(JSON.stringify({
    contractNo: result.contractNo,
    contractDate: result.contractDate,
    approvedAt: result.approvedAt,
    versionStamp: result.versionStamp,
    approvedAt: result.approvedAt,
    versionStamp: result.versionStamp,
    campaignId: result.campaignId,
    influencerId: result.influencerId,
    handle: result.handle,
    displayName: result.displayName,
    email: result.email,
    feeAmount: result.feeAmount,
    currency: result.currency,
    storageKey: result.storageKey,
    absPath: result.absPath,
  }, null, 2));
  console.log("\n=== DELIVERABLES SECTION (LLM) ===\n");
  console.log(result.deliverablesText);
  process.exit(0);
}

main().catch((e) => {
  console.error("ERR", e?.stack || e);
  process.exit(1);
});
