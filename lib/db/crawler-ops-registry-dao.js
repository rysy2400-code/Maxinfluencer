import { queryTikTok, tiktokPool } from "./mysql-tiktok.js";
import { evaluateCrawlerOperationalHealth } from "../ops/crawler-operational-health.js";

export function isCrawlerRegistryUnavailable(error) {
  return (
    error?.code === "ER_NO_SUCH_TABLE" ||
    String(error?.message || "").includes("tiktok_crawler_machine")
  );
}

function toIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function placeholders(values) {
  return values.map(() => "?").join(",");
}

export async function listRegisteredCrawlerMachines() {
  const rows = await queryTikTok(
    `SELECT m.id, m.machine_key, m.display_name, m.public_ip, m.ssh_host,
            m.expected_worker_host, m.mode, m.enabled,
            mp.platform, mp.is_primary, mp.worker_slots, mp.task_timeout_minutes,
            r.id AS release_id, r.release_sha, r.released_at
     FROM tiktok_crawler_machine m
     JOIN tiktok_crawler_machine_platform mp
       ON mp.machine_id = m.id AND mp.enabled = 1
     LEFT JOIN tiktok_crawler_release r
       ON r.platform = mp.platform AND r.status = 'active'
     WHERE m.enabled = 1
     ORDER BY m.id, mp.is_primary DESC, mp.platform`,
    []
  );
  return (rows || []).map((row) => ({
    id: Number(row.id),
    machineKey: row.machine_key,
    displayName: row.display_name,
    publicIp: row.public_ip,
    sshHost: row.ssh_host,
    expectedWorkerHost: row.expected_worker_host || null,
    mode: row.mode,
    platform: row.platform,
    isPrimary: Number(row.is_primary || 0) === 1,
    workerSlots: Number(row.worker_slots || 1),
    taskTimeoutMinutes: Number(row.task_timeout_minutes || 30),
    activeRelease: row.release_sha
      ? {
          id: Number(row.release_id),
          sha: row.release_sha,
          releasedAt: toIso(row.released_at),
        }
      : null,
  }));
}

export async function getRegisteredCrawlerMachine(machineId) {
  const rows = await queryTikTok(
    `SELECT m.id, m.machine_key, m.display_name, m.public_ip, m.ssh_host,
            m.expected_worker_host, m.mode, m.enabled,
            mp.platform, mp.is_primary, mp.worker_slots, mp.task_timeout_minutes,
            r.id AS release_id, r.release_sha, r.released_at
     FROM tiktok_crawler_machine m
     JOIN tiktok_crawler_machine_platform mp ON mp.machine_id = m.id AND mp.enabled = 1
     LEFT JOIN tiktok_crawler_release r ON r.platform = mp.platform AND r.status = 'active'
     WHERE m.id = ? AND m.enabled = 1
     ORDER BY mp.is_primary DESC, mp.platform`,
    [machineId]
  );
  if (!rows?.length) return null;
  const first = rows[0];
  return {
    id: Number(first.id),
    machineKey: first.machine_key,
    displayName: first.display_name,
    publicIp: first.public_ip,
    sshHost: first.ssh_host,
    expectedWorkerHost: first.expected_worker_host || null,
    mode: first.mode,
    platforms: rows.map((row) => ({
      platform: row.platform,
      isPrimary: Number(row.is_primary || 0) === 1,
      workerSlots: Number(row.worker_slots || 1),
      taskTimeoutMinutes: Number(row.task_timeout_minutes || 30),
      activeRelease: row.release_sha
        ? { id: Number(row.release_id), sha: row.release_sha, releasedAt: toIso(row.released_at) }
        : null,
    })),
  };
}

export async function getActiveCrawlerRelease(platform) {
  const rows = await queryTikTok(
    `SELECT id, platform, release_sha, released_by, released_at, note
     FROM tiktok_crawler_release
     WHERE platform = ? AND status = 'active'
     ORDER BY released_at DESC, id DESC
     LIMIT 1`,
    [platform]
  );
  const row = rows?.[0];
  return row
    ? {
        id: Number(row.id),
        platform: row.platform,
        sha: row.release_sha,
        releasedBy: row.released_by == null ? null : Number(row.released_by),
        releasedAt: toIso(row.released_at),
        note: row.note || null,
      }
    : null;
}

export async function listCrawlerReleases(limit = 100) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 300);
  const rows = await queryTikTok(
    `SELECT id, platform, release_sha, status, released_by, released_at, note,
            created_at, updated_at
     FROM tiktok_crawler_release
     ORDER BY platform, FIELD(status,'active','pending','retired'), released_at DESC, id DESC
     LIMIT ${safeLimit}`,
    []
  );
  return (rows || []).map((row) => ({
    id: Number(row.id),
    platform: row.platform,
    sha: row.release_sha,
    status: row.status,
    releasedBy: row.released_by == null ? null : Number(row.released_by),
    releasedAt: toIso(row.released_at),
    note: row.note || null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }));
}

export async function activateCrawlerRelease({ platform, sha, releasedBy, note = null }) {
  if (!["youtube", "tiktok", "instagram"].includes(platform)) {
    const error = new Error("平台无效");
    error.code = "INVALID_PLATFORM";
    throw error;
  }
  const normalizedSha = String(sha || "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalizedSha)) {
    const error = new Error("release SHA 必须是完整的 40 位 Git SHA");
    error.code = "INVALID_RELEASE_SHA";
    throw error;
  }
  const conn = await tiktokPool.getConnection();
  const lockName = `crawler_release_${platform}`;
  let locked = false;
  try {
    const [lockRows] = await conn.query("SELECT GET_LOCK(?, 5) AS acquired", [lockName]);
    locked = Number(lockRows?.[0]?.acquired || 0) === 1;
    if (!locked) {
      const error = new Error("生产版本正在被其他操作更新，请稍后重试");
      error.code = "RELEASE_UPDATE_BUSY";
      throw error;
    }
    await conn.beginTransaction();
    await conn.query(
      `UPDATE tiktok_crawler_release SET status='retired', updated_at=NOW()
       WHERE platform=? AND status='active'`,
      [platform]
    );
    await conn.query(
      `INSERT INTO tiktok_crawler_release
        (platform, release_sha, status, released_by, released_at, note)
       VALUES (?, ?, 'active', ?, NOW(), ?)
       ON DUPLICATE KEY UPDATE status='active', released_by=VALUES(released_by),
         released_at=NOW(), note=VALUES(note), updated_at=NOW()`,
      [platform, normalizedSha, releasedBy, note ? String(note).trim().slice(0, 500) : null]
    );
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    if (locked) {
      try { await conn.query("SELECT RELEASE_LOCK(?)", [lockName]); } catch {}
    }
    conn.release();
  }
  return getActiveCrawlerRelease(platform);
}

function mapHealth(row) {
  if (!row) return null;
  let tiktokEndpointHealth = [];
  try {
    tiktokEndpointHealth = row.tiktok_endpoint_health
      ? typeof row.tiktok_endpoint_health === "string"
        ? JSON.parse(row.tiktok_endpoint_health)
        : row.tiktok_endpoint_health
      : [];
  } catch {
    tiktokEndpointHealth = [];
  }
  return {
    workerHost: row.worker_host || null,
    workerIp: row.worker_ip || null,
    workerId: row.worker_id || null,
    workerAlive: Number(row.worker_alive || 0) === 1,
    workerLoopOk: row.worker_loop_ok == null ? null : Number(row.worker_loop_ok) === 1,
    cdpHttpOk: Number(row.cdp_9222_ok || 0) === 1,
    cdpRpcOk: row.cdp_9222_rpc_ok == null ? null : Number(row.cdp_9222_rpc_ok) === 1,
    cdpRpcFailStreak: Number(row.cdp_9222_fail_streak || 0),
    tiktokEndpointHealth: Array.isArray(tiktokEndpointHealth) ? tiktokEndpointHealth : [],
    reportedPlatforms: parseList(row.reported_platforms),
    reportedReleaseSha: row.reported_release_sha || null,
    lastSeenAt: toIso(row.last_seen_at),
    lastClaimAt: toIso(row.last_claim_at),
    lastProgressAt: toIso(row.last_progress_at),
    lastError: row.last_error || null,
  };
}

function emptyMetric() {
  return {
    claimed10: 0,
    processing: 0,
    succeeded10: 0,
    invalid10: 0,
    failed10: 0,
    claimed60: 0,
    succeeded60: 0,
    invalid60: 0,
    failed60: 0,
    lastClaimAt: null,
    lastProgressAt: null,
    lastSuccessAt: null,
    oldestProcessingAt: null,
  };
}

export async function getRegisteredCrawlerFleetSnapshot() {
  const registrations = await listRegisteredCrawlerMachines();
  const machineIds = [...new Set(registrations.map((item) => item.id))];
  const ips = [...new Set(registrations.map((item) => item.publicIp))];
  const platforms = [...new Set(registrations.map((item) => item.platform))];
  if (!registrations.length) {
    return { snapshotAt: new Date().toISOString(), registryBacked: true, summary: {}, machines: [] };
  }

  const [activityRows, healthRows, metricRows, recentRows, queueRows, repairRows, nowRows] = await Promise.all([
    queryTikTok(
      `SELECT worker_ip, platform, MAX(started_at) AS last_claim_at,
              MAX(last_progress_at) AS last_progress_at,
              MAX(CASE WHEN status='succeeded' THEN finished_at END) AS last_success_at
       FROM tiktok_influencer_search_task
       WHERE worker_ip IN (${placeholders(ips)}) AND platform IN (${placeholders(platforms)})
       GROUP BY worker_ip, platform`,
      [...ips, ...platforms]
    ),
    queryTikTok(
      `SELECT * FROM tiktok_crawler_worker_health
       WHERE machine_id IN (${placeholders(machineIds)}) OR worker_ip IN (${placeholders(ips)})
       ORDER BY last_seen_at DESC`,
      [...machineIds, ...ips]
    ),
    queryTikTok(
      `SELECT worker_ip, platform,
              SUM(started_at >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)) AS claimed10,
              SUM(status = 'processing') AS processing,
              SUM(status = 'succeeded' AND finished_at >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)) AS succeeded10,
              SUM(status = 'succeeded' AND finished_at >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)
                  AND COALESCE(progress_search_found_count,0)=0
                  AND COALESCE(progress_profile_browsed_count,0)=0
                  AND COALESCE(progress_analyzed_count,0)=0) AS invalid10,
              SUM(status = 'failed' AND finished_at >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)) AS failed10,
              SUM(started_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)) AS claimed60,
              SUM(status = 'succeeded' AND finished_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)) AS succeeded60,
              SUM(status = 'succeeded' AND finished_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
                  AND COALESCE(progress_search_found_count,0)=0
                  AND COALESCE(progress_profile_browsed_count,0)=0
                  AND COALESCE(progress_analyzed_count,0)=0) AS invalid60,
              SUM(status = 'failed' AND finished_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)) AS failed60,
              MAX(started_at) AS last_claim_at,
              MAX(last_progress_at) AS last_progress_at,
              MAX(CASE WHEN status='succeeded' THEN finished_at END) AS last_success_at,
              MIN(CASE WHEN status='processing' THEN started_at END) AS oldest_processing_at
       FROM tiktok_influencer_search_task
       WHERE worker_ip IN (${placeholders(ips)})
         AND platform IN (${placeholders(platforms)})
         AND (started_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR) OR status='processing')
       GROUP BY worker_ip, platform`,
      [...ips, ...platforms]
    ),
    queryTikTok(
      `SELECT worker_ip, platform, status FROM (
         SELECT worker_ip, platform, status,
                ROW_NUMBER() OVER (PARTITION BY worker_ip, platform ORDER BY finished_at DESC, id DESC) AS rn
         FROM tiktok_influencer_search_task
         WHERE worker_ip IN (${placeholders(ips)})
           AND platform IN (${placeholders(platforms)})
           AND finished_at >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)
       ) recent WHERE rn <= 10
       ORDER BY worker_ip, platform, rn`,
      [...ips, ...platforms]
    ),
    queryTikTok(
      `SELECT platform, COUNT(*) AS pending, MIN(created_at) AS oldest_pending_at
       FROM tiktok_influencer_search_task
       WHERE status='pending' AND platform IN (${placeholders(platforms)})
       GROUP BY platform`,
      platforms
    ),
    queryTikTok(
      `SELECT r.* FROM tiktok_crawler_repair_action_log r
       JOIN (SELECT machine_id, MAX(id) AS max_id FROM tiktok_crawler_repair_action_log
             WHERE machine_id IN (${placeholders(machineIds)}) GROUP BY machine_id) latest
         ON latest.max_id = r.id`,
      machineIds
    ),
    queryTikTok("SELECT NOW() AS now_value"),
  ]);

  const now = nowRows?.[0]?.now_value || new Date();
  const healthByMachine = new Map();
  const healthByIp = new Map();
  for (const row of healthRows || []) {
    if (row.machine_id != null && !healthByMachine.has(Number(row.machine_id))) {
      healthByMachine.set(Number(row.machine_id), row);
    }
    if (row.worker_ip && !healthByIp.has(row.worker_ip)) healthByIp.set(row.worker_ip, row);
  }
  const metricByKey = new Map(
    (metricRows || []).map((row) => [`${row.worker_ip}:${row.platform}`, row])
  );
  const activityByKey = new Map(
    (activityRows || []).map((row) => [`${row.worker_ip}:${row.platform}`, row])
  );
  const queueByPlatform = new Map((queueRows || []).map((row) => [row.platform, row]));
  const repairByMachine = new Map((repairRows || []).map((row) => [Number(row.machine_id), row]));

  const consecutiveByKey = new Map();
  for (const row of recentRows || []) {
    const key = `${row.worker_ip}:${row.platform}`;
    if (!consecutiveByKey.has(key)) consecutiveByKey.set(key, []);
    const statuses = consecutiveByKey.get(key);
    if (statuses.length < 10) statuses.push(row.status);
  }

  const machines = registrations.map((registration) => {
    const healthRow = healthByMachine.get(registration.id) || healthByIp.get(registration.publicIp);
    const health = mapHealth(healthRow);
    const rawMetric = metricByKey.get(`${registration.publicIp}:${registration.platform}`) || emptyMetric();
    const activity = activityByKey.get(`${registration.publicIp}:${registration.platform}`) || {};
    const statuses = consecutiveByKey.get(`${registration.publicIp}:${registration.platform}`) || [];
    let consecutiveFailures = 0;
    for (const status of statuses) {
      if (status !== "failed") break;
      consecutiveFailures += 1;
    }
    const queueRaw = queueByPlatform.get(registration.platform);
    const oldestProcessingMs = rawMetric.oldest_processing_at
      ? new Date(rawMetric.oldest_processing_at).getTime()
      : 0;
    const staleProcessingCount =
      oldestProcessingMs &&
      new Date(now).getTime() - oldestProcessingMs >= registration.taskTimeoutMinutes * 60_000
        ? 1
        : 0;
    const roleDrift = Boolean(
      health?.reportedPlatforms?.length && !health.reportedPlatforms.includes(registration.platform)
    );
    const operational = evaluateCrawlerOperationalHealth({
      now,
      platform: registration.platform,
      health,
      roleDrift,
      taskTimeoutMinutes: registration.taskTimeoutMinutes,
      staleProcessingCount,
      lastClaimAt: activity.last_claim_at || health?.lastClaimAt,
      lastProgressAt: activity.last_progress_at || health?.lastProgressAt,
      queue: {
        pending: Number(queueRaw?.pending || 0),
        oldestPendingAt: toIso(queueRaw?.oldest_pending_at),
      },
      tenMinutes: {
        claimed: rawMetric.claimed10,
        processing: rawMetric.processing,
        succeeded: rawMetric.succeeded10,
        invalidSucceeded: rawMetric.invalid10,
        failed: rawMetric.failed10,
        consecutiveFailures,
      },
      oneHour: {
        claimed: rawMetric.claimed60,
        processing: rawMetric.processing,
        succeeded: rawMetric.succeeded60,
        invalidSucceeded: rawMetric.invalid60,
        failed: rawMetric.failed60,
      },
    });
    const repair = repairByMachine.get(registration.id);
    return {
      id: registration.id,
      machineKey: registration.machineKey,
      displayName: registration.displayName,
      ip: registration.publicIp,
      sshHost: registration.sshHost,
      mode: registration.mode,
      platform: registration.platform,
      isPrimary: registration.isPrimary,
      workerSlots: registration.workerSlots,
      taskTimeoutMinutes: registration.taskTimeoutMinutes,
      activeRelease: registration.activeRelease,
      health,
      operational: {
        ...operational,
        lastClaimAt: toIso(activity.last_claim_at || health?.lastClaimAt),
        lastProgressAt: toIso(activity.last_progress_at || health?.lastProgressAt),
        lastSuccessAt: toIso(activity.last_success_at),
        oldestProcessingAt: toIso(rawMetric.oldest_processing_at),
      },
      queue: {
        pending: Number(queueRaw?.pending || 0),
        oldestPendingAt: toIso(queueRaw?.oldest_pending_at),
      },
      lastRepair: repair
        ? {
            actionType: repair.action_type,
            result: repair.result,
            triggerReason: repair.trigger_reason || null,
            requestReason: repair.request_reason || null,
            startedAt: toIso(repair.started_at),
            finishedAt: toIso(repair.finished_at),
          }
        : null,
    };
  });

  const levels = { normal: 0, degraded: 0, fault: 0, idle: 0, unknown: 0 };
  for (const machine of machines) levels[machine.operational.level] += 1;
  return {
    snapshotAt: new Date(now).toISOString(),
    registryBacked: true,
    platforms,
    summary: { machineCount: machineIds.length, rowCount: machines.length, ...levels },
    queues: Object.fromEntries(
      platforms.map((platform) => {
        const row = queueByPlatform.get(platform);
        return [platform, { pending: Number(row?.pending || 0), oldestPendingAt: toIso(row?.oldest_pending_at) }];
      })
    ),
    machines,
  };
}
