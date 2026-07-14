#!/usr/bin/env bash
# Deploy all Instagram-only search crawler VMs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOSTS=(
  "152.32.252.45"
)

exec "$SCRIPT_DIR/deploy-crawler-role.sh" instagram "${HOSTS[@]}"
