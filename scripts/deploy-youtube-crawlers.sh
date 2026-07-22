#!/usr/bin/env bash
# Deploy all YouTube-only search crawler VMs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/deploy-platform-crawlers.sh" youtube
