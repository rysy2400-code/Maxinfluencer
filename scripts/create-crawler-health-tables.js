/**
 * 创建 / 迁移 crawler health 相关表：
 * - tiktok_crawler_worker_health（旧名 crawler_worker_health 会 RENAME）
 * - tiktok_crawler_repair_action_log（旧名 crawler_repair_action_log 会 RENAME）
 * - 移除 tiktok_influencer_outreach_thread_binding（若存在）
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const T_WORKER = "tiktok_crawler_worker_health";
const T_LOG = "tiktok_crawler_repair_action_log";
const OLD_WORKER = "crawler_worker_health";
const OLD_LOG = "crawler_repair_action_log";

const INITIAL_MACHINES = [
  ["36.255.223.141", "youtube"],
  ["36.255.223.151", "youtube"],
  ["103.218.240.130", "youtube"],
  ["107.150.119.142", "youtube"],
  ["128.1.132.49", "youtube"],
  ["128.1.132.174", "youtube"],
  ["152.32.174.193", "youtube"],
  ["152.32.174.208", "youtube"],
  ["152.32.187.186", "youtube"],
  ["152.32.187.244", "youtube"],
  ["152.32.188.48", "youtube"],
  ["152.32.211.203", "youtube"],
  ["152.32.192.65", "tiktok"],
  ["152.32.252.45", "instagram"],
];

async function tableExists(table) {
  const rows = await queryTikTok(
    `
    SELECT COUNT(*) AS n
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
  `,
    [table]
  );
  return Number(rows?.[0]?.n || 0) > 0;
}

async function columnExists(table, column) {
  const rows = await queryTikTok(
    `
    SELECT COUNT(*) AS n
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
      AND COLUMN_NAME = ?
  `,
    [table, column]
  );
  return (rows?.[0]?.n || 0) > 0;
}

async function ensureColumn(table, column, ddl) {
  const exists = await columnExists(table, column);
  if (exists) return false;
  await queryTikTok(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`);
  return true;
}

async function ensureIndex(table, index, ddl) {
  const rows = await queryTikTok(
    `SELECT COUNT(*) AS n FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, index]
  );
  if (Number(rows?.[0]?.n || 0) > 0) return false;
  await queryTikTok(`ALTER TABLE \`${table}\` ADD ${ddl}`);
  return true;
}

async function dropIndexIfExists(table, index) {
  const rows = await queryTikTok(
    `SELECT COUNT(*) AS n FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, index]
  );
  if (Number(rows?.[0]?.n || 0) === 0) return false;
  await queryTikTok(`ALTER TABLE \`${table}\` DROP INDEX \`${index}\``);
  return true;
}

function machineKey(ip) {
  return `crawler-${String(ip).replace(/[^a-zA-Z0-9]+/g, "-")}`;
}

async function seedMachines() {
  for (const [ip, platform] of INITIAL_MACHINES) {
    await queryTikTok(
      `INSERT INTO tiktok_crawler_machine
        (machine_key, display_name, public_ip, ssh_host, mode, enabled)
       VALUES (?, ?, ?, ?, 'dedicated', 1)
       ON DUPLICATE KEY UPDATE ssh_host = VALUES(ssh_host), updated_at = NOW()`,
      [machineKey(ip), ip, ip, ip]
    );
    await queryTikTok(
      `INSERT INTO tiktok_crawler_machine_platform
        (machine_id, platform, enabled, is_primary, worker_slots, task_timeout_minutes)
       SELECT id, ?, 1, 1, 1, 30
       FROM tiktok_crawler_machine WHERE machine_key = ?
       ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), updated_at = NOW()`,
      [platform, machineKey(ip)]
    );
  }
}

async function normalizeWorkerHealthIdentity() {
  if (!(await tableExists(T_WORKER))) return [];
  const changed = [];
  await queryTikTok(
    `UPDATE ${T_WORKER} h
     JOIN tiktok_crawler_machine m ON m.public_ip = h.worker_ip
     SET h.machine_id = m.id
     WHERE h.machine_id IS NULL`
  );

  await queryTikTok(
    `DELETE h FROM ${T_WORKER} h
     JOIN ${T_WORKER} newer
       ON h.machine_id IS NOT NULL
      AND newer.machine_id = h.machine_id
      AND newer.id > h.id`
  );
  await queryTikTok(
    `DELETE h FROM ${T_WORKER} h
     JOIN ${T_WORKER} newer
       ON h.worker_ip IS NOT NULL
      AND newer.worker_ip = h.worker_ip
      AND newer.id > h.id`
  );

  if (await dropIndexIfExists(T_WORKER, "uk_worker_host")) {
    changed.push(`${T_WORKER}.drop_uk_worker_host`);
  }
  if (await ensureIndex(T_WORKER, "uk_worker_machine", "UNIQUE KEY uk_worker_machine (machine_id)")) {
    changed.push(`${T_WORKER}.uk_worker_machine`);
  }
  if (await ensureIndex(T_WORKER, "uk_worker_ip", "UNIQUE KEY uk_worker_ip (worker_ip)")) {
    changed.push(`${T_WORKER}.uk_worker_ip`);
  }
  return changed;
}

function splitSqlStatements(sqlText) {
  return String(sqlText || "")
    .split("\n")
    .map((line) => line.replace(/--.*$/, "").trimEnd())
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function migrateOldNamesIfNeeded() {
  const hasOldW = await tableExists(OLD_WORKER);
  const hasNewW = await tableExists(T_WORKER);
  const hasOldL = await tableExists(OLD_LOG);
  const hasNewL = await tableExists(T_LOG);

  if (hasOldW && hasNewW) {
    console.warn(
      `⚠️ 同时存在 ${OLD_WORKER} 与 ${T_WORKER}，跳过 RENAME，请人工合并后删除旧表。`
    );
  } else if (hasOldL && hasNewL) {
    console.warn(`⚠️ 同时存在 ${OLD_LOG} 与 ${T_LOG}，跳过 RENAME，请人工合并后删除旧表。`);
  } else if (hasOldW && !hasNewW && hasOldL && !hasNewL) {
    await queryTikTok(
      `RENAME TABLE \`${OLD_WORKER}\` TO \`${T_WORKER}\`, \`${OLD_LOG}\` TO \`${T_LOG}\``
    );
    console.log(`✅ RENAME: ${OLD_WORKER}→${T_WORKER}, ${OLD_LOG}→${T_LOG}`);
  } else {
    if (hasOldW && !hasNewW) {
      await queryTikTok(`RENAME TABLE \`${OLD_WORKER}\` TO \`${T_WORKER}\``);
      console.log(`✅ RENAME: ${OLD_WORKER}→${T_WORKER}`);
    }
    if (hasOldL && !hasNewL) {
      await queryTikTok(`RENAME TABLE \`${OLD_LOG}\` TO \`${T_LOG}\``);
      console.log(`✅ RENAME: ${OLD_LOG}→${T_LOG}`);
    }
  }
}

async function main() {
  await migrateOldNamesIfNeeded();

  const schemaPath = path.join(__dirname, "../lib/db/crawler-health-schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  const statements = splitSqlStatements(sql);

  for (const statement of statements) {
    await queryTikTok(statement);
  }

  const changed = [];
  if (
    await ensureColumn(
      T_WORKER,
      "cdp_9222_fail_streak",
      "cdp_9222_fail_streak INT NOT NULL DEFAULT 0"
    )
  ) {
    changed.push(`${T_WORKER}.cdp_9222_fail_streak`);
  }
  if (
    await ensureColumn(
      T_WORKER,
      "cdp_9223_fail_streak",
      "cdp_9223_fail_streak INT NOT NULL DEFAULT 0"
    )
  ) {
    changed.push(`${T_WORKER}.cdp_9223_fail_streak`);
  }

  const workerColumns = [
    ["machine_id", "machine_id BIGINT NULL AFTER id"],
    ["cdp_9222_rpc_ok", "cdp_9222_rpc_ok TINYINT(1) NULL AFTER cdp_9222_ok"],
    ["worker_loop_ok", "worker_loop_ok TINYINT(1) NULL AFTER worker_alive"],
    ["reported_platforms", "reported_platforms VARCHAR(255) NULL AFTER worker_id"],
    ["reported_release_sha", "reported_release_sha CHAR(40) NULL AFTER reported_platforms"],
    ["tiktok_endpoint_health", "tiktok_endpoint_health JSON NULL AFTER cdp_9223_fail_streak"],
    ["last_claim_at", "last_claim_at DATETIME NULL AFTER last_seen_at"],
    ["last_progress_at", "last_progress_at DATETIME NULL AFTER last_claim_at"],
  ];
  for (const [column, ddl] of workerColumns) {
    if (await ensureColumn(T_WORKER, column, ddl)) changed.push(`${T_WORKER}.${column}`);
  }
  if (await ensureIndex(T_WORKER, "idx_machine_seen", "INDEX idx_machine_seen (machine_id, last_seen_at DESC)")) {
    changed.push(`${T_WORKER}.idx_machine_seen`);
  }
  changed.push(...(await normalizeWorkerHealthIdentity()));

  const logColumns = [
    ["machine_id", "machine_id BIGINT NULL AFTER id"],
    ["platform", "platform VARCHAR(32) NULL AFTER worker_ip"],
    ["requested_by_user_id", "requested_by_user_id BIGINT NULL AFTER operator"],
    ["request_reason", "request_reason VARCHAR(500) NULL AFTER trigger_reason"],
    ["target_release_sha", "target_release_sha CHAR(40) NULL AFTER request_reason"],
  ];
  for (const [column, ddl] of logColumns) {
    if (await ensureColumn(T_LOG, column, ddl)) changed.push(`${T_LOG}.${column}`);
  }

  if (
    await ensureColumn(
      "tiktok_crawler_alert_state",
      "notified_level",
      "notified_level ENUM('normal','degraded','fault','idle','unknown') NULL AFTER current_level"
    )
  ) {
    changed.push("tiktok_crawler_alert_state.notified_level");
  }

  await seedMachines();

  console.log(`✅ ${T_WORKER} / ${T_LOG} 表已确保存在。`);
  console.log(`✅ 已确保 ${INITIAL_MACHINES.length} 台 crawler 注册配置。`);
  if (changed.length) {
    console.log("✅ crawler health 已补齐字段:", changed.join(", "));
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ 创建 crawler health 表失败:", err?.message || err);
    process.exit(1);
  });
