import os from "os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  getRegisteredCrawlerMachine,
} from "../db/crawler-ops-registry-dao.js";
import {
  findRecentCrawlerAction,
  finishCrawlerAction,
  startCrawlerAction,
} from "../db/crawler-ops-action-dao.js";

const execFileAsync = promisify(execFile);

const ACTIONS = {
  "restart-worker": { logType: "restart_worker", cooldownMinutes: 2 },
  "restart-chrome": { logType: "restart_cdp", cooldownMinutes: 5 },
  redeploy: { logType: "redeploy_crawler", cooldownMinutes: 15 },
};

function psQuote(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function encodePowerShellCommand(command) {
  return Buffer.from(String(command || ""), "utf16le").toString("base64");
}

function resolveDeploymentPlatform(machine, requestedPlatform) {
  const available = machine.platforms.filter((item) => item.activeRelease?.sha);
  const selected = requestedPlatform
    ? available.find((item) => item.platform === requestedPlatform)
    : available.find((item) => item.isPrimary) || available[0];
  if (!selected) {
    const error = new Error("该平台尚未配置 active production release");
    error.code = "ACTIVE_RELEASE_MISSING";
    throw error;
  }
  if (machine.mode === "mixed") {
    const releases = new Set(machine.platforms.map((item) => item.activeRelease?.sha).filter(Boolean));
    if (releases.size > 1) {
      const error = new Error("混合机器的平台 release SHA 不一致，禁止整机重新部署");
      error.code = "MIXED_RELEASE_CONFLICT";
      throw error;
    }
  }
  return selected;
}

function buildRemotePowerShell(action, machine, deployment) {
  const root = "C:\\maxinfluencer";
  const common = [
    "$ErrorActionPreference='Stop'",
    `$root=${psQuote(root)}`,
    "Set-Location $root",
  ];
  if (action === "restart-worker") {
    return [
      ...common,
      "$p=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'worker-influencer-search\\.js' })",
      "foreach($x in $p){ Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue }",
      "schtasks.exe /Run /TN 'maxin-guard-crawler-search' | Out-Null",
      "$deadline=(Get-Date).AddSeconds(18)",
      "$ok=$false",
      "do { Start-Sleep -Seconds 2; $ok=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'worker-influencer-search\\.js' }).Count -ge 1 } while((-not $ok) -and ((Get-Date) -lt $deadline))",
      "if(-not $ok){ throw 'worker_not_recovered' }",
      "Write-Output '[crawler-action] worker_ok=true'",
    ].join("; ");
  }
  if (action === "restart-chrome") {
    return [
      ...common,
      "$p=@(Get-CimInstance Win32_Process | Where-Object { ($_.Name -match 'chrome|msedge') -and $_.CommandLine -match '\\.chrome-cdp-9222' })",
      "foreach($x in $p){ Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue }",
      "schtasks.exe /Run /TN 'maxin-guard-chrome-9222' | Out-Null",
      "$deadline=(Get-Date).AddSeconds(28)",
      "$ok=$false",
      "$lastError='not_started'",
      "do { Start-Sleep -Seconds 2; try { $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 5; $ok=($r.StatusCode -ge 200 -and $r.StatusCode -lt 400 -and $r.Content -match 'webSocketDebuggerUrl'); if(-not $ok){ $lastError='cdp_version_response_invalid' } } catch { $lastError=$_.Exception.Message } } while((-not $ok) -and ((Get-Date) -lt $deadline))",
      "if(-not $ok){ throw ('cdp_9222_not_recovered:' + $lastError) }",
      "Write-Output '[crawler-action] cdp_9222_ok=true'",
    ].join("; ");
  }
  return [
    ...common,
    "$git='C:\\Program Files\\Git\\cmd\\git.exe'",
    "if(-not (Test-Path $git)){ $git='git' }",
    `& $git -C $root fetch origin --prune`,
    "if($LASTEXITCODE -ne 0){ throw 'git_fetch_failed' }",
    `& $git -C $root cat-file -e ${psQuote(`${deployment.activeRelease.sha}^{commit}`)}`,
    "if($LASTEXITCODE -ne 0){ throw 'release_commit_missing' }",
    `& $git -C $root checkout --detach --force ${psQuote(deployment.activeRelease.sha)}`,
    "if($LASTEXITCODE -ne 0){ throw 'release_checkout_failed' }",
    "$deployScript=Join-Path $root 'deploy-crawler.ps1'",
    "if(-not (Select-String -LiteralPath $deployScript -SimpleMatch 'CRAWLER_DEPLOY_SHA' -Quiet)){ throw 'release_does_not_support_pinned_deploy' }",
    `$env:CRAWLER_PLATFORM_ROLE=${psQuote(deployment.platform)}`,
    `$env:CRAWLER_DEPLOY_SHA=${psQuote(deployment.activeRelease.sha)}`,
    `$env:CRAWLER_MACHINE_KEY=${psQuote(machine.machineKey)}`,
    "& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $deployScript",
    "if($LASTEXITCODE -ne 0){ throw ('deploy_exit=' + $LASTEXITCODE) }",
    "$sha=(& git -C $root rev-parse HEAD).Trim()",
    `if($sha -ne ${psQuote(deployment.activeRelease.sha)}){ throw ('release_sha_mismatch:' + $sha) }`,
    "Write-Output ('[crawler-action] release_sha=' + $sha)",
  ].join("; ");
}

async function runSsh(machine, remotePowerShell) {
  const user = String(process.env.CRAWLER_SSH_USER || "Administrator").trim();
  const port = String(process.env.CRAWLER_SSH_PORT || "22").trim();
  const defaultKey = os.platform() === "win32" ? "C:/ProgramData/ssh/maxin_crawler_key" : "";
  const keyPath = String(process.env.CRAWLER_SSH_KEY_PATH || defaultKey).trim();
  if (!keyPath) throw new Error("CRAWLER_SSH_KEY_PATH 未配置");
  if (!/^[a-zA-Z0-9.-]+$/.test(String(machine.sshHost || ""))) {
    throw new Error("机器 SSH host 格式无效");
  }
  const sshBinary = os.platform() === "win32" ? "ssh.exe" : "ssh";
  const nullHosts = os.platform() === "win32" ? "NUL" : "/dev/null";
  const timeoutMs = Math.max(
    30_000,
    Number(process.env.CRAWLER_SSH_TIMEOUT_MS || 600_000) || 600_000
  );
  const encodedPowerShell = encodePowerShellCommand(remotePowerShell);
  const args = [
    "-i",
    keyPath,
    "-p",
    port,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    `UserKnownHostsFile=${nullHosts}`,
    "-o",
    "ConnectTimeout=15",
    "-o",
    "BatchMode=yes",
    `${user}@${machine.sshHost}`,
    "powershell.exe",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodedPowerShell,
  ];
  return execFileAsync(sshBinary, args, {
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
}

export async function executeCrawlerAction({
  machineId,
  action,
  platform = null,
  reason,
  requestedByUserId,
}) {
  const actionConfig = ACTIONS[action];
  if (!actionConfig) {
    const error = new Error("不支持的运维操作");
    error.code = "INVALID_ACTION";
    throw error;
  }
  const normalizedReason = String(reason || "").trim().slice(0, 500);
  if (normalizedReason.length < 5) {
    const error = new Error("操作原因至少需要 5 个字符");
    error.code = "REASON_REQUIRED";
    throw error;
  }
  const machine = await getRegisteredCrawlerMachine(Number(machineId));
  if (!machine) {
    const error = new Error("机器不存在或已停用");
    error.code = "MACHINE_NOT_FOUND";
    throw error;
  }
  const selectedPlatform =
    machine.platforms.find((item) => item.platform === platform) ||
    machine.platforms.find((item) => item.isPrimary) ||
    machine.platforms[0];
  const deployment = action === "redeploy"
    ? resolveDeploymentPlatform(machine, platform)
    : selectedPlatform;
  const recent = await findRecentCrawlerAction(
    machine.id,
    actionConfig.logType,
    actionConfig.cooldownMinutes
  );
  if (recent) {
    const error = new Error(`操作冷却中，请稍后再试（${actionConfig.cooldownMinutes} 分钟）`);
    error.code = "ACTION_COOLDOWN";
    throw error;
  }

  const actionId = await startCrawlerAction({
    machine,
    platform: deployment?.platform || null,
    actionType: actionConfig.logType,
    reason: normalizedReason,
    requestedByUserId,
    targetReleaseSha: action === "redeploy" ? deployment.activeRelease.sha : null,
  });
  try {
    const remotePowerShell = buildRemotePowerShell(action, machine, deployment);
    const result = await runSsh(machine, remotePowerShell);
    const detail = `stdout:\n${result.stdout || ""}\n\nstderr:\n${result.stderr || ""}`;
    await finishCrawlerAction(actionId, { ok: true, detail });
    return {
      actionId,
      machineId: machine.id,
      action,
      platform: deployment?.platform || null,
      targetReleaseSha: action === "redeploy" ? deployment.activeRelease.sha : null,
      status: "succeeded",
    };
  } catch (error) {
    const detail = [
      String(error?.message || error),
      error?.stdout ? `stdout:\n${error.stdout}` : "",
      error?.stderr ? `stderr:\n${error.stderr}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    await finishCrawlerAction(actionId, { ok: false, detail });
    throw error;
  }
}
