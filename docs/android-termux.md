# Android Termux 部署实录

在非 root Android（Termux + DSH）上的部署要点与踩坑记录，供同款设备参考。

## 为什么服务要跑在 proot 容器里

1. **宿主装不了 g4f**：`fastapi → pydantic-core` 需 Rust 编译，而
   `rustup` 不支持 `aarch64-unknown-linux-android` triple。
2. **宿主 HTTPS 被中间人**：所有域名返回 `*.certfallback.com` 兜底证书，
   Python 报 `CERTIFICATE_VERIFY_FAILED: Hostname mismatch`，g4f 的所有
   公开 provider 都会失败。容器内 TLS 是干净的。
3. 容器与宿主**共享网络命名空间**，所以宿主 `localhost:8080/8081` 直接
   可达容器端口。

## Docker 不可行

- 无 `docker` 二进制（exit 127）；Termux 源只有 `docker-cli`，没有 `dockerd`
- 无 root/su（"No su program found on this device"）
- `--user=0` 只是容器启动后的运行参数，引擎没跑就轮不到它

## 进程生命周期：必须用 tmux

直接 spawn 的进程绑在引擎进程树上：App 重启 → 引擎退出 → 服务全灭。
tmux server 会被 init 收养（`ppid=1`），脱离引擎进程树。

⚠️ **TMPDIR 必须统一**：Termux 的 tmux 用 `$TMPDIR/tmux-<uid>/default` 作
socket 路径，而引擎进程的 TMPDIR 是 `/data/user/0/com.dsh.android/cache`。
两边不一致会连到不同的 tmux server，互相看不到会话 → 重复启动 → 抢端口。

本机的解法：插件（`lib/index.js`）与脚本（`scripts/start.sh`）都读
`scripts/local-env.sh`，把 TMPDIR 固定为
`/data/user/0/com.dsh.android/files/termux/usr/var/run`。

## 本机 local-env.sh 示例

```bash
export FREE_CHAT_CONTAINER=napcat
export FREE_CHAT_PYTHON=/root/g4f-venv/bin/python
export FREE_CHAT_SERVER_DIR=/root/services
export FREE_CHAT_TERMUX_PREFIX=/data/user/0/com.dsh.android/files/termux/usr
export FREE_CHAT_TMUX_TMPDIR=/data/user/0/com.dsh.android/files/termux/usr/var/run
```

## 文件传输到容器

容器看不到宿主私有目录，也无法读 `/sdcard`、`/tmp`（noexec）。
可靠方式是 base64 stdin 管道：

```bash
proot-distro login napcat -- bash -c 'base64 -d > /root/x.py' < <(base64 -w0 x.py)
```

## DSH 插件的三个静默坑

1. 工具 schema **不支持 type 数组**（`type:['string','null']` 会让
   `ctx.tools.register` 抛错 → cordis 静默不激活插件）。排查：
   `$DSH_HOME/logs/startup-*.log` 里搜插件名。
2. 工具返回值必须是 **lossless JSON**：任何 `undefined` 字段都会报
   `value is not lossless JSON`。失败分支也要把字段落成 `''/0/false`。
3. 工具插件**不写进** profile 的 `cordis.patch.yml`（那是用户配置层），
   靠插件包自带的 `cordis.patch.yml` + `package.json` 的 `dsh.bundle.patch`
   声明 entry。
