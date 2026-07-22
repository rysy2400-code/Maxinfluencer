import { getRegisteredCrawlerFleetSnapshot } from "../db/crawler-ops-registry-dao.js";
import {
  listCrawlerAlertStates,
  listPlatformAlertStates,
  markCrawlerAlertSent,
  markPlatformAlertSent,
  recordCrawlerObservedState,
  recordPlatformObservedState,
} from "../db/crawler-alert-state-dao.js";
import { crawlerAlertFingerprint, sendCrawlerFeishuAlert } from "./feishu-crawler-alert.js";

const DEGRADED_HOLD_MS = 10 * 60_000;
const RECOVERY_HOLD_MS = 10 * 60_000;
const DEDUPE_MS = 30 * 60_000;

function ms(value) {
  const n = value ? new Date(value).getTime() : 0;
  return Number.isFinite(n) ? n : 0;
}

function dueAfter(value, durationMs, nowMs) {
  const started = ms(value);
  return started > 0 && nowMs - started >= durationMs;
}

function reasonText(machine) {
  const codes = machine.operational.reasonCodes || [];
  return `**原因**：${codes.length ? codes.join("、") : "状态恢复"}`;
}

async function reconcileMachineAlert(machine, previous, nowMs) {
  const level = machine.operational.level;
  const fingerprint = crawlerAlertFingerprint([
    String(machine.id),
    machine.platform,
    level,
    ...(machine.operational.reasonCodes || []),
  ]);
  const stateChanged = !previous || previous.currentLevel !== level;
  await recordCrawlerObservedState({
    machineId: machine.id,
    platform: machine.platform,
    level,
    reasonCodes: machine.operational.reasonCodes,
  });
  const stateStartedAt = stateChanged ? new Date(nowMs) : previous.stateStartedAt;
  const deduped = previous?.alertFingerprint === fingerprint && nowMs - ms(previous.lastAlertAt) < DEDUPE_MS;

  if (level === "fault" && !deduped) {
    const result = await sendCrawlerFeishuAlert({
      title: `Crawler 故障：${machine.displayName} / ${machine.platform}`,
      level,
      machine,
      message: reasonText(machine),
    });
    if (result.sent) {
      await markCrawlerAlertSent({ machineId: machine.id, platform: machine.platform, notifiedLevel: level, fingerprint });
    }
    return;
  }
  if (
    level === "degraded" &&
    dueAfter(stateStartedAt, DEGRADED_HOLD_MS, nowMs) &&
    !deduped
  ) {
    const result = await sendCrawlerFeishuAlert({
      title: `Crawler 降级：${machine.displayName} / ${machine.platform}`,
      level,
      machine,
      message: reasonText(machine),
    });
    if (result.sent) {
      await markCrawlerAlertSent({ machineId: machine.id, platform: machine.platform, notifiedLevel: level, fingerprint });
    }
    return;
  }
  if (
    ["normal", "idle"].includes(level) &&
    ["fault", "degraded"].includes(previous?.notifiedLevel) &&
    dueAfter(stateStartedAt, RECOVERY_HOLD_MS, nowMs)
  ) {
    const recoveryFingerprint = crawlerAlertFingerprint([String(machine.id), machine.platform, "recovered"]);
    const result = await sendCrawlerFeishuAlert({
      title: `Crawler 恢复：${machine.displayName} / ${machine.platform}`,
      level: "normal",
      machine,
      recovery: true,
      message: "已连续健康 10 分钟。",
    });
    if (result.sent) {
      await markCrawlerAlertSent({
        machineId: machine.id,
        platform: machine.platform,
        notifiedLevel: "normal",
        fingerprint: recoveryFingerprint,
        recovery: true,
      });
    }
  }
}

async function reconcilePlatformAlerts(snapshot, previousStates, nowMs) {
  for (const platform of snapshot.platforms || []) {
    const rows = snapshot.machines.filter((machine) => machine.platform === platform);
    const faultCount = rows.filter((machine) => machine.operational.level === "fault").length;
    const faultRatio = rows.length ? faultCount / rows.length : 0;
    const level = rows.length > 0 && faultRatio >= 0.3 ? "fault" : "normal";
    const previous = previousStates.get(platform);
    const changed = !previous || previous.current_level !== level;
    await recordPlatformObservedState(platform, level);
    const stateStartedAt = changed ? new Date(nowMs) : previous.state_started_at;
    const fingerprint = crawlerAlertFingerprint([platform, level, String(faultCount), String(rows.length)]);
    const alertInCooldown = previous?.last_alert_at && nowMs - ms(previous.last_alert_at) < DEDUPE_MS;
    if (level === "fault" && !alertInCooldown) {
      const result = await sendCrawlerFeishuAlert({
        title: `${platform} Crawler 平台级事故`,
        level: "fault",
        message: `**故障机器**：${faultCount}/${rows.length}（${Math.round(faultRatio * 100)}%）`,
      });
      if (result.sent) await markPlatformAlertSent(platform, { recovery: false, fingerprint });
    } else if (
      level === "normal" &&
      previous?.last_alert_at &&
      ms(previous.last_alert_at) > ms(previous.last_recovery_at) &&
      dueAfter(stateStartedAt, RECOVERY_HOLD_MS, nowMs)
    ) {
      const result = await sendCrawlerFeishuAlert({
        title: `${platform} Crawler 平台恢复`,
        level: "normal",
        recovery: true,
        message: `**当前故障机器**：${faultCount}/${rows.length}，已连续恢复 10 分钟。`,
      });
      if (result.sent) {
        await markPlatformAlertSent(platform, {
          recovery: true,
          fingerprint: crawlerAlertFingerprint([platform, "recovered"]),
        });
      }
    }
  }
}

export async function reconcileCrawlerAlerts() {
  const [snapshot, states, platformStates] = await Promise.all([
    getRegisteredCrawlerFleetSnapshot(),
    listCrawlerAlertStates(),
    listPlatformAlertStates(),
  ]);
  const nowMs = new Date(snapshot.snapshotAt).getTime();
  for (const machine of snapshot.machines) {
    await reconcileMachineAlert(machine, states.get(`${machine.id}:${machine.platform}`), nowMs);
  }
  await reconcilePlatformAlerts(snapshot, platformStates, nowMs);
  return { machineRows: snapshot.machines.length, snapshotAt: snapshot.snapshotAt };
}
