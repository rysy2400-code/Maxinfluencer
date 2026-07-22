#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <youtube|tiktok|instagram>" >&2
  exit 2
fi
ROLE="$1"
case "$ROLE" in youtube|tiktok|instagram) ;; *) echo "Invalid role: $ROLE" >&2; exit 2 ;; esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGISTRY_OUTPUT="$(node "$SCRIPT_DIR/list-crawler-deploy-targets.mjs" "$ROLE")"
REGISTRY_RELEASE="$(printf '%s\n' "$REGISTRY_OUTPUT" | sed -n 's/^CRAWLER_RELEASE=//p' | head -1)"
if [[ ! "$REGISTRY_RELEASE" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "No active production release returned for $ROLE" >&2
  exit 1
fi
TARGETS=()
while IFS= read -r target; do
  [[ -n "$target" ]] && TARGETS+=("$target")
done < <(printf '%s\n' "$REGISTRY_OUTPUT" | sed -n 's/^CRAWLER_TARGET=//p')
if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "No enabled $ROLE crawler targets returned by registry" >&2
  exit 1
fi

export TARGET_SHA="${TARGET_SHA:-$REGISTRY_RELEASE}"
exec "$SCRIPT_DIR/deploy-crawler-role.sh" "$ROLE" "${TARGETS[@]}"
