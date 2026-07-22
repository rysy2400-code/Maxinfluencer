import { queryTikTok } from "./mysql-tiktok.js";

function parseReasons(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

export async function listCrawlerAlertStates() {
  const rows = await queryTikTok("SELECT * FROM tiktok_crawler_alert_state", []);
  return new Map(
    (rows || []).map((row) => [
      `${row.machine_id}:${row.platform}`,
      {
        machineId: Number(row.machine_id),
        platform: row.platform,
        currentLevel: row.current_level,
        notifiedLevel: row.notified_level || null,
        reasonCodes: parseReasons(row.reason_codes),
        stateStartedAt: row.state_started_at,
        lastAlertAt: row.last_alert_at,
        lastRecoveryAt: row.last_recovery_at,
        alertFingerprint: row.alert_fingerprint || null,
      },
    ])
  );
}

export async function recordCrawlerObservedState({ machineId, platform, level, reasonCodes }) {
  await queryTikTok(
    `INSERT INTO tiktok_crawler_alert_state
      (machine_id, platform, current_level, reason_codes, state_started_at)
     VALUES (?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       state_started_at=IF(current_level<>VALUES(current_level), NOW(), state_started_at),
       current_level=VALUES(current_level), reason_codes=VALUES(reason_codes), updated_at=NOW()`,
    [machineId, platform, level, JSON.stringify(reasonCodes || [])]
  );
}

export async function markCrawlerAlertSent({
  machineId,
  platform,
  notifiedLevel,
  fingerprint,
  recovery = false,
}) {
  await queryTikTok(
    `UPDATE tiktok_crawler_alert_state
     SET notified_level=?, alert_fingerprint=?,
         last_alert_at=IF(?=0,NOW(),last_alert_at),
         last_recovery_at=IF(?=1,NOW(),last_recovery_at), updated_at=NOW()
     WHERE machine_id=? AND platform=?`,
    [notifiedLevel, fingerprint, recovery ? 1 : 0, recovery ? 1 : 0, machineId, platform]
  );
}

export async function listPlatformAlertStates() {
  const rows = await queryTikTok("SELECT * FROM tiktok_crawler_platform_alert_state", []);
  return new Map((rows || []).map((row) => [row.platform, row]));
}

export async function recordPlatformObservedState(platform, level) {
  await queryTikTok(
    `INSERT INTO tiktok_crawler_platform_alert_state (platform,current_level,state_started_at)
     VALUES (?,?,NOW())
     ON DUPLICATE KEY UPDATE
       state_started_at=IF(current_level<>VALUES(current_level),NOW(),state_started_at),
       current_level=VALUES(current_level),updated_at=NOW()`,
    [platform, level]
  );
}

export async function markPlatformAlertSent(platform, { recovery, fingerprint }) {
  await queryTikTok(
    `UPDATE tiktok_crawler_platform_alert_state
     SET alert_fingerprint=?, last_alert_at=IF(?=0,NOW(),last_alert_at),
         last_recovery_at=IF(?=1,NOW(),last_recovery_at), updated_at=NOW()
     WHERE platform=?`,
    [fingerprint, recovery ? 1 : 0, recovery ? 1 : 0, platform]
  );
}
