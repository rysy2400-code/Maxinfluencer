/**
 * X GQL 元数据刷新：从 FxEmbed/atmosphere（社区活跃维护的 catalog）拉取最新
 * queryId / features / fieldToggles 并写回 x-gql-config.json。
 * 也可被运行时 404/(336) 错误自动触发（best-effort）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_CONFIG_PATH = path.join(__dirname, "x-gql-config.json");
const QUERIES_RAW_URL =
  "https://raw.githubusercontent.com/FxEmbed/FxEmbed/main/packages/atmosphere/src/providers/twitter/graphql/queries.ts";
const FEATURES_RAW_URL =
  "https://raw.githubusercontent.com/FxEmbed/FxEmbed/main/packages/atmosphere/src/providers/twitter/graphql/features.ts";

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "maxinfluencer-x-gql-refresh/1.0" },
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${url}`);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseQueryBlocks(ts) {
  const out = new Map();
  const re = /export const (\w+Query): GraphQLQuery = \{([\s\S]*?)\n\};/g;
  let m;
  while ((m = re.exec(ts)) !== null) {
    const block = m[2];
    const nameMatch = block.match(/queryName:\s*'([^']+)'/);
    const queryName = nameMatch?.[1];
    if (!queryName) continue;
    const queryId = block.match(/queryId:\s*'([^']+)'/)?.[1] || null;
    const featureKeys = block.match(/featureKeys:\s*(\w+)/)?.[1] || null;
    const fieldTogglesRaw = block.match(/fieldToggles:\s*\{([\s\S]*?)\}/)?.[1] || null;
    const fieldToggles = {};
    if (fieldTogglesRaw) {
      const pairRe = /(\w+):\s*(true|false)/g;
      let pm;
      while ((pm = pairRe.exec(fieldTogglesRaw)) !== null) {
        fieldToggles[pm[1]] = pm[2] === "true";
      }
    }
    const httpMethod = block.includes("httpMethod: 'POST'") ? "POST" : "GET";
    out.set(queryName, { queryId, featureKeys, fieldToggles, httpMethod });
  }
  return out;
}

function parseFeatureLists(ts) {
  const lists = new Map();
  const re = /const (\w+FeatureKeys) = \[([\s\S]*?)\] as const/g;
  let m;
  while ((m = re.exec(ts)) !== null) {
    const keys = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    lists.set(m[1], keys);
  }
  return lists;
}

function parseFeatureValues(ts) {
  const values = {};
  const m = ts.match(/TWITTER_GRAPHQL_FEATURES = \{([\s\S]*?)\} as const/);
  if (!m) return values;
  const pairRe = /(\w+):\s*(true|false)/g;
  let pm;
  while ((pm = pairRe.exec(m[1])) !== null) {
    values[pm[1]] = pm[2] === "true";
  }
  return values;
}

/**
 * 刷新本地 X GQL 配置（保留 catalog 未覆盖的查询）。
 * @param {{ quiet?: boolean, forcePinned?: boolean }} [opts]
 * @returns {Promise<{ changed: boolean, refreshedAt: string, queries: string[] }>}
 */
export async function refreshXGqlConfigFromCatalog(opts = {}) {
  const { quiet = false, forcePinned = false } = opts;
  const configPath = process.env.X_GQL_CONFIG_PATH || DEFAULT_CONFIG_PATH;
  const existing = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const [queriesTs, featuresTs] = await Promise.all([
    fetchText(QUERIES_RAW_URL),
    fetchText(FEATURES_RAW_URL),
  ]);
  const queryBlocks = parseQueryBlocks(queriesTs);
  const featureLists = parseFeatureLists(queriesTs);
  const featureValues = parseFeatureValues(featuresTs);
  const refreshedAt = new Date().toISOString();

  let changed = false;
  const refreshed = [];
  for (const [queryName, info] of queryBlocks) {
    const current = existing.queries?.[queryName];
    if (!current) continue; // 只刷新我们需要的查询
    const pinnedId = existing.pinnedQueryIds?.[queryName] || null;
    if (
      pinnedId &&
      info.queryId &&
      info.queryId !== current.queryId &&
      !forcePinned
    ) {
      if (!quiet) {
        console.warn(
          `[x-gql-refresh] ${queryName}: catalog=${info.queryId} 与人工核实值 ${pinnedId} 不一致，保留人工值（--force 可覆盖）`
        );
      }
      continue;
    }
    const features = {};
    const keys = info.featureKeys ? featureLists.get(info.featureKeys) : [];
    if (keys) {
      for (const key of keys) {
        if (key in featureValues) features[key] = featureValues[key];
      }
    }
    const updated = {
      ...current,
      queryId: info.queryId || current.queryId,
      httpMethod: info.httpMethod || current.httpMethod,
      needsTransactionId: current.needsTransactionId ?? info.queryName === "SearchTimeline",
      features: Object.keys(features).length ? features : current.features,
      fieldToggles: Object.keys(info.fieldToggles).length ? info.fieldToggles : current.fieldToggles || {},
    };
    if (
      updated.queryId !== current.queryId ||
      JSON.stringify(updated.features) !== JSON.stringify(current.features) ||
      JSON.stringify(updated.fieldToggles) !== JSON.stringify(current.fieldToggles)
    ) {
      changed = true;
      refreshed.push(queryName);
      existing.queries[queryName] = updated;
    }
  }

  if (changed) {
    existing.refreshedAt = refreshedAt;
    existing.source = existing.source || "FxEmbed/atmosphere";
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n", "utf8");
    if (!quiet) {
      console.log(`[x-gql-refresh] 已刷新 ${refreshed.join(",")} -> ${configPath}`);
    }
  } else if (!quiet) {
    console.log(`[x-gql-refresh] catalog 与本地一致，无需更新`);
  }
  return { changed, refreshedAt, queries: refreshed };
}
