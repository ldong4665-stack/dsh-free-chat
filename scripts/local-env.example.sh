# 本机专用部署配置示例。
#
# 复制为 local-env.sh 后按本机情况修改；local-env.sh 已被 .gitignore 忽略。
# 不需要任何配置也能跑（走通用默认：同机直接跑 python3 + 仓库内 server/）。
#
# 环境变量 / local-env.sh 可设项（进程环境变量优先级更高）：

# 引擎启动时是否自动拉起服务：'0' 关闭（已有 systemd/launchd 托管时用）
#export FREE_CHAT_AUTOSTART=1

# proot 容器名；设置后服务在容器里跑（适合 Android Termux）
#export FREE_CHAT_CONTAINER=napcat

# Python 解释器路径；不设 = 自动探测（仓库 venv → 系统 python3）
#export FREE_CHAT_PYTHON=/root/g4f-venv/bin/python

# server 脚本目录；不设 = 仓库内 server/
#export FREE_CHAT_SERVER_DIR=/root/services

# Termux 前缀；设置后注入 Termux 的 PATH 与 tmux 路径
#export FREE_CHAT_TERMUX_PREFIX=/data/user/0/com.dsh.android/files/termux/usr

# tmux socket 目录；Termux 上必须是共享 TMPDIR（否则不同来源的 tmux
# 命令连到不同 server，互相看不到会话 → 重复启动抢端口）
#export FREE_CHAT_TMUX_TMPDIR=/data/user/0/com.dsh.android/files/termux/usr/var/run

# 两个通道的地址（插件与 adapter 读同一组变量）
#export FREE_G4F_URL=http://localhost:8080/v1
#export FREE_CHAT2API_URL=http://localhost:8081/v1
