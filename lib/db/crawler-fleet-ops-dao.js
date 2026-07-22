/**
 * 虚拟机运维台：14 台机器任务消费快照（搜索 / 导入 + 健康）
 */
import { queryTikTok } from "./mysql-tiktok.js";
import {
  getRegisteredCrawlerFleetSnapshot,
  isCrawlerRegistryUnavailable,
} from "./crawler-ops-registry-dao.js";

/** 运维白名单：固定 14 台爬虫公网 IP */
export const CRAWLER_FLEET_IPS = [
  "36.255.223.141",
  "36.255.223.151",
  "103.218.240.130",
  "107.150.119.142",
  "128.1.132.49",
  "128.1.132.174",
  "152.32.174.193",
  "152.32.174.208",
  "152.32.187.186",
  "152.32.187.244",
  "152.32.188.48",
  "152.32.192.65",
  "152.32.211.203",
  "152.32.252.45",
];

export const CRAWLER_FLEET_PLATFORMS = ["tiktok", "instagram", "youtube"];

const ONLINE_TIMEOUT_SEC = Number(process.env.CRAWLER_HEALTH_TIMEOUT_SEC || 120) || 120;
const COMPLETED_STATUSES = ["succeeded", "failed"];

function toIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function isMissingTableError(error) {
  return error?.code === "ER_NO_SUCH_TABLE" || error?.message?.includes("doesn't exist");
}

function ipPlaceholders(count) {
  return Array(count).fill("?").join(", ");
}

function mapSearchTaskRow(row) {
  if (!row) return null;
  return {
    taskId: Number(row.id),
    campaignId: row.campaign_id || null,
    keyword: row.keyword || null,
    platform: row.platform || null,
    status: row.status,
    finishedAt: toIso(row.finished_at),
    errorMessage: row.error_message || null,
    progress: {
      searchFoundCount: Number(row.progress_search_found_count || 0),
      profileBrowsedCount: Number(row.progress_profile_browsed_count || 0),
      analyzedCount: Number(row.progress_analyzed_count || 0),
      recommendedCount: Number(row.progress_recommended_count || 0),
      contactableCount: Number(row.progress_contactable_count || 0),
    },
  };
}

function mapImportTaskRow(row) {
  if (!row) return null;
  return {
    taskId: Number(row.id),
    campaignId: row.campaign_id || null,
    status: row.status,
    finishedAt: toIso(row.finished_at),
    sourceFileName: row.source_file_name || null,
    totalRows: Number(row.total_rows || 0),
    errorMessage: row.error_message || null,
    progress: {
      countryCheckedCount: Number(row.progress_country_checked_count || 0),
      countryPassedCount: Number(row.progress_country_passed_count || 0),
      enrichedCount: Number(row.progress_enriched_count || 0),
      analyzedCount: Number(row.progress_analyzed_count || 0),
      recommendedCount: Number(row.progress_recommended_count || 0),
    },
  };
}

function mapHealthRow(row) {
  if (!row) return null;
  const lastSeenAt = toIso(row.last_seen_at);
  const lastSeenMs = lastSeenAt ? new Date(lastSeenAt).getTime() : 0;
  const fresh = lastSeenMs > 0 && Date.now() - lastSeenMs <= ONLINE_TIMEOUT_SEC * 1000;
  const workerAlive = Number(row.worker_alive || 0) === 1;
  const cdp9222Ok = Number(row.cdp_9222_ok || 0) === 1;
  const online = fresh && workerAlive;

  return {
    workerHost: row.worker_host || null,
    workerIp: row.worker_ip || null,
    workerId: row.worker_id || null,
    online,
    workerAlive,
    cdp9222Ok,
    cdp9222FailStreak: Number(row.cdp_9222_fail_streak || 0),
    lastSeenAt,
    lastError: row.last_error || null,
  };
}

function mapRepairRow(row) {
  if (!row) return null;
  return {
    actionType: row.action_type,
    triggerReason: row.trigger_reason || null,
    result: row.result,
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
    detail: row.detail || null,
  };
}

async function safeQuery(sql, params, fallback = []) {
  try {
    return await queryTikTok(sql, params);
  } catch (error) {
    if (isMissingTableError(error)) return fallback;
    throw error;
  }
}

/**
 * 运维台机器矩阵快照
 */
async function getLegacyCrawlerFleetSnapshot() {
  const ips = CRAWLER_FLEET_IPS;
  const ipPh = ipPlaceholders(ips.length);
  const statusPh = COMPLETED_STATUSES.map(() => "?").join(", ");
  const platformPh = CRAWLER_FLEET_PLATFORMS.map(() => "?").join(", ");

  const healthRows = await safeQuery(
    `
    SELECT *
    FROM tiktok_crawler_worker_health
    WHERE worker_ip IN (${ipPh})
  `,
    ips
  );

  const searchRows = await safeQuery(
    `
    SELECT t.*
    FROM tiktok_influencer_search_task t
    INNER JOIN (
      SELECT t2.worker_ip, t2.platform, MAX(t2.id) AS max_id
      FROM tiktok_influencer_search_task t2
      INNER JOIN (
        SELECT worker_ip, platform, MAX(finished_at) AS max_finished_at
        FROM tiktok_influencer_search_task
        WHERE worker_ip IN (${ipPh})
          AND status IN (${statusPh})
          AND finished_at IS NOT NULL
          AND platform IN (${platformPh})
        GROUP BY worker_ip, platform
      ) latest_finished
        ON t2.worker_ip = latest_finished.worker_ip
       AND t2.platform = latest_finished.platform
       AND t2.finished_at = latest_finished.max_finished_at
      WHERE t2.status IN (${statusPh})
      GROUP BY t2.worker_ip, t2.platform
    ) latest_task ON t.id = latest_task.max_id
  `,
    [...ips, ...COMPLETED_STATUSES, ...CRAWLER_FLEET_PLATFORMS, ...COMPLETED_STATUSES]
  );

  const importRows = await safeQuery(
    `
    SELECT t.*
    FROM tiktok_influencer_import_task t
    INNER JOIN (
      SELECT t2.worker_ip, MAX(t2.id) AS max_id
      FROM tiktok_influencer_import_task t2
      INNER JOIN (
        SELECT worker_ip, MAX(finished_at) AS max_finished_at
        FROM tiktok_influencer_import_task
        WHERE worker_ip IN (${ipPh})
          AND status IN (${statusPh})
          AND finished_at IS NOT NULL
        GROUP BY worker_ip
      ) latest_finished
        ON t2.worker_ip = latest_finished.worker_ip
       AND t2.finished_at = latest_finished.max_finished_at
      WHERE t2.status IN (${statusPh})
      GROUP BY t2.worker_ip
    ) latest_task ON t.id = latest_task.max_id
  `,
    [...ips, ...COMPLETED_STATUSES, ...COMPLETED_STATUSES]
  );

  const processingSearchRows = await safeQuery(
    `
    SELECT worker_ip, platform, COUNT(*) AS cnt
    FROM tiktok_influencer_search_task
    WHERE worker_ip IN (${ipPh})
      AND status = 'processing'
      AND platform IN (${platformPh})
    GROUP BY worker_ip, platform
  `,
    [...ips, ...CRAWLER_FLEET_PLATFORMS]
  );

  const processingImportRows = await safeQuery(
    `
    SELECT worker_ip, COUNT(*) AS cnt
    FROM tiktok_influencer_import_task
    WHERE worker_ip IN (${ipPh})
      AND status = 'processing'
    GROUP BY worker_ip
  `,
    ips
  );

  const repairRows = await safeQuery(
    `
    SELECT r.*
    FROM tiktok_crawler_repair_action_log r
    INNER JOIN (
      SELECT worker_ip, MAX(id) AS max_id
      FROM tiktok_crawler_repair_action_log
      WHERE worker_ip IN (${ipPh})
      GROUP BY worker_ip
    ) latest_repair ON r.id = latest_repair.max_id
  `,
    ips
  );

  const healthByIp = new Map();
  for (const row of healthRows || []) {
    if (row.worker_ip) healthByIp.set(row.worker_ip, mapHealthRow(row));
  }

  const searchByIpPlatform = new Map();
  for (const row of searchRows || []) {
    if (!row.worker_ip || !row.platform) continue;
    searchByIpPlatform.set(`${row.worker_ip}:${row.platform}`, mapSearchTaskRow(row));
  }

  const importByIp = new Map();
  for (const row of importRows || []) {
    if (row.worker_ip) importByIp.set(row.worker_ip, mapImportTaskRow(row));
  }

  const processingSearchByIp = new Map();
  for (const row of processingSearchRows || []) {
    if (!row.worker_ip) continue;
    const key = row.worker_ip;
    const prev = processingSearchByIp.get(key) || { total: 0, byPlatform: {} };
    const cnt = Number(row.cnt || 0);
    prev.total += cnt;
    prev.byPlatform[row.platform] = cnt;
    processingSearchByIp.set(key, prev);
  }

  const processingImportByIp = new Map();
  for (const row of processingImportRows || []) {
    if (row.worker_ip) processingImportByIp.set(row.worker_ip, Number(row.cnt || 0));
  }

  const repairByIp = new Map();
  for (const row of repairRows || []) {
    if (row.worker_ip) repairByIp.set(row.worker_ip, mapRepairRow(row));
  }

  const machines = ips.map((ip) => {
    const health = healthByIp.get(ip) || {
      workerHost: null,
      workerIp: ip,
      workerId: null,
      online: false,
      workerAlive: false,
      cdp9222Ok: false,
      cdp9222FailStreak: 0,
      lastSeenAt: null,
      lastError: null,
    };

    const searchTasks = {};
    for (const platform of CRAWLER_FLEET_PLATFORMS) {
      searchTasks[platform] = searchByIpPlatform.get(`${ip}:${platform}`) || null;
    }

    const processingSearch = processingSearchByIp.get(ip) || { total: 0, byPlatform: {} };
    const processingImport = processingImportByIp.get(ip) || 0;

    return {
      ip,
      health: {
        ...health,
        processingSearchTotal: processingSearch.total,
        processingSearchByPlatform: processingSearch.byPlatform,
        processingImportTotal: processingImport,
        lastRepair: repairByIp.get(ip) || null,
      },
      searchTasks,
      importTask: importByIp.get(ip) || null,
    };
  });

  const onlineCount = machines.filter((m) => m.health.online).length;
  const offlineCount = machines.length - onlineCount;

  return {
    snapshotAt: new Date().toISOString(),
    onlineTimeoutSec: ONLINE_TIMEOUT_SEC,
    fleetIps: ips,
    platforms: CRAWLER_FLEET_PLATFORMS,
    summary: {
      machineCount: machines.length,
      onlineCount,
      offlineCount,
    },
    machines,
  };
}

export async function getCrawlerFleetSnapshot() {
  try {
    return await getRegisteredCrawlerFleetSnapshot();
  } catch (error) {
    if (!isCrawlerRegistryUnavailable(error)) throw error;
    const legacy = await getLegacyCrawlerFleetSnapshot();
    return { ...legacy, registryBacked: false };
  }
}
