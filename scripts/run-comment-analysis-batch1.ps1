# One-shot task on 103: comment analysis for Wondershare campaigns (ASCII-only file,
# PowerShell 5.1 chokes on non-ASCII comments when the file has no BOM).
# Params:
#   -All      run all pending influencers (no --limit)
#   -Force    recompute influencers that already have data
#   -Limit N  only run N items (default 5)
#   -Platform <p>  restrict to one platform (tiktok|instagram)
param(
  [switch]$All,
  [switch]$Force,
  [int]$Limit = 5,
  [string]$Platform = ""
)
$ErrorActionPreference = "Continue"
$Root = "C:\maxinfluencer"
$node = "C:\Program Files\nodejs\node.exe"
if (-not (Test-Path $node)) { $node = "node" }

$env:COMMENT_ANALYSIS_LLM_CONCURRENCY = "4"
$env:COMMENT_ANALYSIS_VIDEOS = "10"
# throttle + soft-block cooldown
$env:COMMENT_ANALYSIS_TT_GAP_MS = "900"
$env:COMMENT_ANALYSIS_IG_GAP_MS = "600"
$env:COMMENT_ANALYSIS_TT_COOLDOWN_MS = "120000"
$env:COMMENT_ANALYSIS_IG_COOLDOWN_MS = "600000"
$env:CDP_ENDPOINT_TIKTOK = "http://127.0.0.1:9222"
$env:CDP_ENDPOINT_INSTAGRAM = "http://127.0.0.1:9223"

$log = Join-Path $Root "logs\comment-analysis-batch1.log"
$ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
"[$ts] ===== run start (All=$All Force=$Force Limit=$Limit) =====" | Out-File -FilePath $log -Append -Encoding UTF8

$extra = @()
if ($Force) { $extra += "--force" }
# -All => --limit=0 (worker treats <=0 as "no limit")
if ($All) { $extra += "--limit=0" } else { $extra += "--limit=$Limit" }
if ($Platform) { $extra += "--platform=$Platform" }

# NOTE: use "2>&1 | Out-File -Encoding UTF8" instead of "*>>".
# PS 5.1 appends native-command output as UTF-16, which produced a mixed-encoding log.
& $node --experimental-default-type=module (Join-Path $Root "scripts\run-comment-analysis.mjs") --wondershare @extra 2>&1 |
  Out-File -FilePath $log -Append -Encoding UTF8

$ts2 = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
"[$ts2] ===== run exit=$LASTEXITCODE =====" | Out-File -FilePath $log -Append -Encoding UTF8
