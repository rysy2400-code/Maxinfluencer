#!/usr/bin/env bash
# Deploy all X-only search crawler VMs (香港 IP 直连，不走代理).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/deploy-platform-crawlers.sh" x
