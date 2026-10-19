#!/usr/bin/env bash
# 一键部署：建 venv、装依赖、启动两个服务。
# 用法：bash scripts/install.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PY="${FREE_CHAT_PYTHON:-}"
if [ -z "$PY" ]; then
  if [ ! -x venv/bin/python ]; then
    echo "→ 创建 venv"
    python3 -m venv venv
  fi
  PY="$PWD/venv/bin/python"
fi

echo "→ 安装依赖（$PY）"
"$PY" -m pip install -U -r server/requirements.txt

echo "→ 启动服务"
FREE_CHAT_PYTHON="$PY" bash scripts/start.sh
