/**
 * 一次性导入「仅排重/不联系」名单：
 * 1. 解析 xlsx（支持达人链接表头、多语言 handle、>10k 行）；
 * 2. 本 campaign 候选表仅插入新行（do_not_contact=1），已有行不做修改；
 *    不写入全局排除表（Campaign 专属名单，只影响本 campaign）。
 *
 * 用法：
 *   node scripts/import-contact-exclusion-xlsx.mjs [xlsx路径] [campaignId] [来源文件名]
 */
import fs from "fs";
import path from "path";
import { parseInfluencerListXlsx } from "../lib/influencer/parse-influencer-list-xlsx.js";
import {
  applyContactExclusions,
  formatExclusionImportSummary,
} from "../lib/db/contact-exclusion-dao.js";

const DEFAULT_XLSX =
  "/Users/duanzijun/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_jf2onc8i63xr22_0979/msg/file/2026-08/maxin-vase-排重触达记录-20260825.xlsx";
const DEFAULT_CAMPAIGN = "CAMP-1782463190123-3BETBZB1B";

async function main() {
  const xlsxPath = process.argv[2] || DEFAULT_XLSX;
  const campaignId = process.argv[3] || DEFAULT_CAMPAIGN;
  const sourceFile =
    process.argv[4] || path.basename(String(xlsxPath).split("?")[0]) || "contact-exclusion.xlsx";

  if (!fs.existsSync(xlsxPath)) {
    console.error(`文件不存在: ${xlsxPath}`);
    process.exit(1);
  }

  console.log(`[import] 解析 ${xlsxPath} …`);
  const t0 = Date.now();
  const parsed = parseInfluencerListXlsx(fs.readFileSync(xlsxPath), {
    maxRows: 200000,
  });
  console.log(
    `[import] 解析完成: 有效 ${parsed.rows.length} 行，无法解析 ${parsed.parseErrors.length} 行，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`
  );

  const errSample = parsed.parseErrors.slice(0, 5).map((e) => e.reason);
  if (errSample.length) console.log("[import] 解析失败示例:", errSample);

  const batchId = `EXC-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const result = await applyContactExclusions({
    campaignId,
    rows: parsed.rows,
    batchId,
    sourceFile,
  });

  console.log("\n===== 导入结果 =====");
  console.log(formatExclusionImportSummary(result));
  console.log(`[import] batchId=${batchId} campaignId=${campaignId}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[import] failed:", e?.message || e);
    process.exit(1);
  });
