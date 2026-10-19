#!/usr/bin/env bash
# 启动两个服务（幂等）。用法：bash scripts/start.sh
#
# 优先读 scripts/local-env.sh；也可以用环境变量覆盖。
set -uo pipefail
cd "$(dirname "$0")/.."

[ -f scripts/local-env.sh ] && source scripts/local-env.sh

SERVER_DIR="${FREE_CHAT_SERVER_DIR:-$PWD/server}"
PYTHON="${FREE_CHAT_PYTHON:-$PWD/venv/bin/python}"
[ -x "$PYTHON" ] || PYTHON=python3

port_open() {
  (exec 3<>/dev/tcp/127.0.0.1/"$1") 2>/dev/null && { exec 3<&- 3>&-; return 0; }
  return 1
}

start_one() {
  local sess="$1" file="$2" port="$3"
  if port_open "$port"; then echo "$sess: already listening (:$port)"; return 0; fi

  local inner="$PYTHON $SERVER_DIR/$file"
  if [ -n "${FREE_CHAT_CONTAINER:-}" ]; then
    inner="proot-distro login $FREE_CHAT_CONTAINER -- $inner"
  fi

  tmux new-session -d -s "$sess" "$inner > logs/$sess.log 2>&1" \
    || { echo "$sess: tmux 启动失败"; return 1; }
  echo "$sess: started"
}

mkdir -p logs
start_one freechat-g4f g4f_server.py 8080
start_one freechat-c2a chat2api_server.py 8081

for spec in "8080:g4f" "8081:chat2api"; do
  port="${spec%%:*}"; name="${spec##*:}"
  ready=no
  for _ in $(seq 1 30); do port_open "$port" && { ready=yes; break; } || sleep 1; done
  echo "$name (:$port) => $ready"
done
