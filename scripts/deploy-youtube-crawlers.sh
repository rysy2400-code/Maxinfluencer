#!/usr/bin/env bash
# Deploy all YouTube-only search crawler VMs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOSTS=(
  "36.255.223.141"
  "36.255.223.151"
  "103.218.240.130"
  "107.150.119.142"
  "128.1.132.49"
  "128.1.132.174"
  "152.32.174.193"
  "152.32.174.208"
  "152.32.187.186"
  "152.32.187.244"
  "152.32.188.48"
  "152.32.211.203"
)

exec "$SCRIPT_DIR/deploy-crawler-role.sh" youtube "${HOSTS[@]}"
