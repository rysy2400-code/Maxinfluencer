#!/usr/bin/env bash
# Deploy all TikTok-only search crawler VMs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOSTS=(
  "152.32.192.65"
)

exec "$SCRIPT_DIR/deploy-crawler-role.sh" tiktok "${HOSTS[@]}"
