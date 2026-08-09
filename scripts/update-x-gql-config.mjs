#!/usr/bin/env node
/**
 * 刷新 X GQL 元数据（queryId/features/fieldToggles）：
 * 从 FxEmbed/atmosphere 社区 catalog 拉取并写回 lib/tools/influencer-functions/x/x-gql-config.json。
 *
 * 用法: node scripts/update-x-gql-config.mjs [--force]
 *   --force: 允许用 catalog 覆盖人工核实过的 pinned queryId
 * 环境: X_GQL_CONFIG_PATH 可覆盖写回路径
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const { refreshXGqlConfigFromCatalog } = await import(
  "../lib/tools/influencer-functions/x/x-gql-refresh.js"
);

try {
  const forcePinned = process.argv.includes("--force");
  const result = await refreshXGqlConfigFromCatalog({ quiet: false, forcePinned });
  console.log(
    result.changed
      ? `✅ 已刷新: ${result.queries.join(", ")}`
      : "✅ catalog 与本地一致，无需更新"
  );
  process.exit(0);
} catch (e) {
  console.error("❌ 刷新失败:", e.message);
  process.exit(1);
}
