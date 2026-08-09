#!/usr/bin/env node
/** CLI：重建 TikTok 端点池（订阅拉取 + 健康筛选 + mihomo 重启 + 验证）。供 guard 周期自愈调用。 */
import { rebuildTiktokEndpointPool } from "../lib/ops/tiktok-endpoint-pool.js";

const summary = await rebuildTiktokEndpointPool({ verify: true });
console.log(JSON.stringify(summary, null, 2));

const allPortsOk = Object.values(summary.waitResults || {}).every(Boolean);
process.exit(allPortsOk ? 0 : 1);
