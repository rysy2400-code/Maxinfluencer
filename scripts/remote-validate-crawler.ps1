$ErrorActionPreference = "Stop"
$env:Path = "C:\Program Files\nodejs;" + $env:Path
Set-Location "C:\maxinfluencer"

$marker = "validation-" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

$insertJs = @'
import { queryTikTok } from "./lib/db/mysql-tiktok.js";
const marker = process.argv[2];
const rows = await queryTikTok("SELECT id FROM tiktok_campaign ORDER BY created_at DESC LIMIT 1");
if (!rows?.[0]?.id) {
  console.log("NO_CAMPAIGN");
  process.exit(2);
}
const campaignId = rows[0].id;
const payload = {
  trigger: "manual_validation",
  targetBatchSize: 1,
  validationMarker: marker,
  createdAt: new Date().toISOString()
};
const result = await queryTikTok(
  `INSERT INTO tiktok_influencer_search_task (campaign_id, priority, payload, status)
   VALUES (?, ?, ?, 'pending')`,
  [campaignId, 999, JSON.stringify(payload)]
);
console.log("INSERT_OK", campaignId, result.insertId, marker);
'@
Set-Content -Path ".\tmp-insert-task.mjs" -Value $insertJs -Encoding UTF8

Write-Host "[validate] inserting test task..."
$insertOut = node .\tmp-insert-task.mjs $marker
$insertOut | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) {
  throw "insert task failed"
}

Write-Host "[validate] run worker once (SEARCH_WORKER_LOOP=false)..."
$env:SEARCH_WORKER_LOOP = "false"
node .\scripts\worker-influencer-search.js
$workerExit = $LASTEXITCODE
Write-Host "[validate] worker exit code: $workerExit"

$checkJs = @'
import { queryTikTok } from "./lib/db/mysql-tiktok.js";
const marker = process.argv[2];
const like = `%${marker}%`;
const rows = await queryTikTok(
  `SELECT id, status, worker_id, started_at, finished_at, error_message
   FROM tiktok_influencer_search_task
   WHERE payload LIKE ?
   ORDER BY id DESC
   LIMIT 1`,
  [like]
);
if (!rows?.length) {
  console.log("TASK_NOT_FOUND", marker);
  process.exit(3);
}
const r = rows[0];
console.log("TASK_RESULT", JSON.stringify(r));
'@
Set-Content -Path ".\tmp-check-task.mjs" -Value $checkJs -Encoding UTF8

Write-Host "[validate] checking task result..."
node .\tmp-check-task.mjs $marker

Remove-Item ".\tmp-insert-task.mjs" -ErrorAction SilentlyContinue
Remove-Item ".\tmp-check-task.mjs" -ErrorAction SilentlyContinue
