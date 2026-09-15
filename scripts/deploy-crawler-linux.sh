#!/usr/bin/env bash
# 部署 HK Linux 爬虫机（YouTube / Instagram）：git checkout 到指定 SHA + 重启 systemd 服务。
#
# 背景：HK Linux 机器不在 crawler SSH key 的授信范围内（ssh 免密不可用），
# 只能用「ubuntu + 密码」经跳板机登录；deploy-crawler-role.sh 只覆盖 Windows 机器。
#
# 用法:
#   export CRAWLER_LINUX_PASSWORD='...'          # 必填，机器 administrator/ubuntu 密码
#   scripts/deploy-crawler-linux.sh youtube                 # 从注册表取该平台机器
#   scripts/deploy-crawler-linux.sh youtube 10.61.1.2 10.61.1.3
#
# 可选环境变量:
#   TARGET_SHA                 默认取注册表 active release
#   CRAWLER_LINUX_USER         默认 ubuntu
#   CRAWLER_LINUX_JUMP_HOST    经跳板机登录（如 maxin-web）
#   CRAWLER_LINUX_CONCURRENCY  默认 4（跳板机 sshd 默认 MaxStartups 10:30:100，别开太大）
#   CRAWLER_LINUX_RETRIES      默认 2
#   CRAWLER_LINUX_SOCKS_PROXY  走 socks5（如 127.0.0.1:1081）。
#                              比 -J 逐条建隧道稳：只用一条到跳板机的 SSH 会话，不会撞 MaxStartups。
set -uo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <youtube|tiktok|instagram|x> [host...]" >&2
  exit 2
fi
ROLE="$1"; shift
case "$ROLE" in youtube|tiktok|instagram|x) ;; *) echo "Invalid role: $ROLE" >&2; exit 2;; esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_NAME="${CRAWLER_LINUX_USER:-ubuntu}"
JUMP="${CRAWLER_LINUX_JUMP_HOST:-}"
CONCURRENCY="${CRAWLER_LINUX_CONCURRENCY:-4}"
RETRIES="${CRAWLER_LINUX_RETRIES:-3}"
LOG_DIR="${CRAWLER_LINUX_LOG_DIR:-/tmp/deploy-linux-$ROLE}"

if [[ -z "${CRAWLER_LINUX_PASSWORD:-}" ]]; then
  echo "缺少 CRAWLER_LINUX_PASSWORD" >&2
  exit 2
fi

# 显式给了 host 时仍默认用注册表里的 active release 作为目标 SHA
REGISTRY_OUTPUT="$(node "$SCRIPT_DIR/list-crawler-deploy-targets.mjs" "$ROLE" 2>/dev/null || true)"
if [[ $# -gt 0 ]]; then
  HOSTS=("$@")
else
  HOSTS=()
  while IFS= read -r h; do [[ -n "$h" ]] && HOSTS+=("$h"); done \
    < <(printf '%s\n' "$REGISTRY_OUTPUT" | sed -n 's/^CRAWLER_TARGET=.*=//p')
fi
TARGET_SHA="${TARGET_SHA:-$(printf '%s\n' "$REGISTRY_OUTPUT" | sed -n 's/^CRAWLER_RELEASE=//p' | head -1)}"
if [[ ! "$TARGET_SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "无效 TARGET_SHA: ${TARGET_SHA:-<empty>}" >&2
  exit 2
fi
if [[ ${#HOSTS[@]} -eq 0 ]]; then
  echo "没有可部署的 $ROLE 机器" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"
echo "[deploy-linux-$ROLE] ${#HOSTS[@]} hosts -> $TARGET_SHA (并发 $CONCURRENCY)"

REMOTE_SCRIPT="$(mktemp)"
cat > "$REMOTE_SCRIPT" <<REMOTE
set -e
cd /opt/maxinfluencer || { echo "RESULT=FAIL no_repo"; exit 1; }
git fetch origin --prune >/dev/null 2>&1 || true   # .git 属主异常时 ref 更新会失败，对象仍会拉到
git checkout --detach --force $TARGET_SHA >/dev/null 2>&1 || { echo "RESULT=FAIL checkout"; exit 2; }
sudo -n systemctl restart maxin-worker >/dev/null 2>&1 || { echo "RESULT=FAIL restart_worker"; exit 3; }
sudo -n systemctl restart maxin-heartbeat >/dev/null 2>&1 || { echo "RESULT=FAIL restart_heartbeat"; exit 4; }
sleep 8
echo "RESULT=OK head=\$(git rev-parse --short HEAD) worker=\$(systemctl is-active maxin-worker) heartbeat=\$(systemctl is-active maxin-heartbeat)"
REMOTE

deploy_one() {
  local host="$1" log="$LOG_DIR/$1.log" attempt out
  for ((attempt = 1; attempt <= RETRIES; attempt++)); do
    local proxy_opt=()
    if [[ -n "${CRAWLER_LINUX_SOCKS_PROXY:-}" ]]; then
      proxy_opt=(-o "ProxyCommand=nc -x ${CRAWLER_LINUX_SOCKS_PROXY} %h %p")
    elif [[ -n "$JUMP" ]]; then
      proxy_opt=(-o "ProxyJump=$JUMP")
    fi
    sshpass -p "$CRAWLER_LINUX_PASSWORD" ssh \
      "${proxy_opt[@]}" \
      -o PreferredAuthentications=password -o PubkeyAuthentication=no \
      -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o ConnectTimeout=60 -o ServerAliveInterval=15 -o TCPKeepAlive=yes \
      "$USER_NAME@$host" bash -s < "$REMOTE_SCRIPT" > "$log" 2>&1
    if grep -q "RESULT=OK" "$log"; then
      echo "[$ROLE] OK $host $(grep -o 'head=[^ ]*' "$log" | tail -1)"
      return 0
    fi
    sleep 4
  done
  echo "[$ROLE] FAIL $host - $(tail -2 "$log" | tr '\n' ' ')" >&2
  return 1
}

running=0
for host in "${HOSTS[@]}"; do
  deploy_one "$host" &
  running=$((running + 1))
  if (( running % CONCURRENCY == 0 )); then wait; fi
done
wait
rm -f "$REMOTE_SCRIPT"

ok=$(grep -l "RESULT=OK" "$LOG_DIR"/*.log 2>/dev/null | wc -l | tr -d ' ')
bad=$(grep -L "RESULT=OK" "$LOG_DIR"/*.log 2>/dev/null | wc -l | tr -d ' ')
echo "[deploy-linux-$ROLE] 完成: OK=$ok FAIL=$bad (日志 $LOG_DIR)"
[[ "$bad" == "0" ]] || exit 1
