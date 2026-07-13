/**
 * 部署前验证：worker 各任务结束路径均会触发 signal consume。
 * 用法: node scripts/test-worker-signal-consume-paths.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { consumeKeywordSignalForSearch } from "../lib/db/campaign-keyword-signals-dao.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// 1) 静态检查：throw 分支后必须调用 consume
{
  const workerSrc = fs.readFileSync(
    path.join(projectRoot, "scripts/worker-influencer-search.js"),
    "utf8"
  );
  const throwBlock = workerSrc.match(
    /searchAndExtract throw[\s\S]*?await publishKeywordNote\(\{[\s\S]*?status: "failed"[\s\S]*?\}\);([\s\S]*?)return;/
  );
  assert(throwBlock, "throw catch block not found");
  assert(
    throwBlock[1].includes("consumeSignalForCompletedTask"),
    "throw catch block must call consumeSignalForCompletedTask before return"
  );

  const consumeCalls = (workerSrc.match(/consumeSignalForCompletedTask/g) || []).length;
  assert(consumeCalls >= 4, `expected >=4 consume call sites, got ${consumeCalls}`);
  console.log(`✅ static: worker has ${consumeCalls} consumeSignalForCompletedTask call sites (incl. throw path)`);
}

// 2) 模拟 Lovart 失败任务 keyword → DAO consume 可匹配
{
  const CAMPAIGN_ID = "CAMP-1782909291412-WWBAE7U1O";
  const samples = [
    { keyword: "#music", platform: "youtube" },
    { keyword: "#vidcon", platform: "youtube" },
    { keyword: "@KhAnubis", platform: "youtube" },
  ];

  for (const { keyword, platform } of samples) {
    const result = await consumeKeywordSignalForSearch({
      campaignId: CAMPAIGN_ID,
      platform,
      keyword,
      newRecommendedCount: 0,
    });
    console.log(
      `  simulate throw-path consume: ${keyword} -> consumed=${result.consumed}${result.signalValue ? ` (${result.signalValue})` : ""}`
    );
    assert(result.consumed === true, `expected consume hit for ${keyword}`);
  }
  console.log("✅ simulate: Lovart signal keywords consumable after task end");
}

console.log("\n✅ pre-deploy worker signal consume checks passed");
