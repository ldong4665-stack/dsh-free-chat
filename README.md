# dsh-free-chat

**Self-hosted, account-free OpenAI-compatible chat services with a DSH plugin.**
Two independent channels, no API key, no account, no token — ever.

> 无账号、无密钥、无 token 的 OpenAI 兼容聊天服务，自带 DSH 插件。两条
> 独立通道，clone 后一条命令即可跑起来。

| Channel | Default endpoint | Description |
|---|---|---|
| `g4f` | `http://localhost:8080/v1` | gpt4free aggregating public providers |
| `chat2api` | `http://localhost:8081/v1` | Login-free tier; model names without `gpt-4` fall back to GPT-3.5 |

---

## 这是什么

一套**再加工**的开源方案，把两个无账号 LLM 通道变成本地常驻服务，
并注册成 DSH（DeepSeek Harness）的原生模型供应商与工具：

- **server/**：两个 OpenAI 兼容 HTTP 服务（Python 标准库实现，仅依赖 `g4f`）
- **lib/**：DSH 插件——注册 `free_chat` 工具 + `free-g4f` / `free-chat2api`
  两个模型供应商，可在模型选择器里直接选中对话
- **scripts/**：一键部署与启动

## 快速开始

```bash
git clone <repo-url> dsh-free-chat
cd dsh-free-chat
bash scripts/install.sh
```

`install.sh` 会创建 venv、装依赖、启动两个服务。启动后验证：

```bash
curl http://localhost:8080/v1/models   # g4f
curl http://localhost:8081/v1/models   # chat2api
```

对话测试：

```bash
curl http://localhost:8081/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"claude-3-sonnet","messages":[{"role":"user","content":"hi"}]}'
# 免登录语义：claude-3-sonnet 不含 gpt-4 → 自动落到 gpt-3.5-turbo
```

## 安装 DSH 插件

```bash
node <engine>/node_modules/@deepseek-ai/dsh/lib/bin.js \
  plugin --profile web add /path/to/dsh-free-chat
```

重启 DSH 后：

- 模型选择器出现 `Free (g4f 公开聚合)` 与 `Free (chat2api 免登录)` 两个供应商
- 会话中可用 `free_chat` 工具

## 配置

所有配置都是可选的。优先级：**进程环境变量 > `scripts/local-env.sh` > 默认值**。

`scripts/local-env.example.sh` 是模板；复制为 `local-env.sh` 后修改
（该文件已被 gitignore，不会进仓库）。

| 变量 | 默认 | 说明 |
|---|---|---|
| `FREE_CHAT_AUTOSTART` | `1` | 引擎启动时是否自动拉起服务；`0` 关闭 |
| `FREE_CHAT_CONTAINER` | 无 | proot 容器名（Android Termux 用）；不设 = 同机直接跑 |
| `FREE_CHAT_PYTHON` | 自动探测 | Python 解释器路径 |
| `FREE_CHAT_SERVER_DIR` | 仓库 `server/` | server 脚本目录 |
| `FREE_CHAT_TERMUX_PREFIX` | 无 | Termux 前缀（影响 PATH 与 tmux 路径） |
| `FREE_CHAT_TMUX_TMPDIR` | 系统默认 | tmux socket 目录（Termux 上必须固定，见下方） |
| `FREE_G4F_URL` | `http://localhost:8080/v1` | g4f 通道地址 |
| `FREE_CHAT2API_URL` | `http://localhost:8081/v1` | chat2api 通道地址 |

server 端口也可改：`G4F_PORT`（默认 8080）、`CHAT2API_PORT`（默认 8081）、
`G4F_BASE`（chat2api 的上游，默认 `http://localhost:8080`）。

## 工作原理

- 服务跑在 **tmux** 里：tmux server 被 init 收养（`ppid=1`），不随
  DSH 引擎退出而死。插件在引擎每次启动时后台探测端口，没起就拉起。
- HTTP 层用 Python 标准库（`ThreadingHTTPServer`），不依赖
  fastapi/uvicorn/pydantic——后者在 aarch64 Android 上需 Rust 编译。
- HTTP 请求 60 秒超时；失败返回结构化错误，不抛异常。

## Android Termux 部署

非 root Android 上需要 proot 容器（宿主装不了 g4f、且宿主 HTTPS 被中间人）。
完整踩坑记录见 [docs/android-termux.md](docs/android-termux.md)。

## 已知限制

- g4f 可用性取决于当日活跃 provider；失败时错误里会列出各 provider 的
  失败原因，并提示切换通道或重试
- chat2api 通道是**协议等价实现**：原任务指定的 `yilee01/chat2api` 源仓库
  已 404，故按上游 `lanqian528/chat2api` 的公开协议行为重新实现
- 全程无任何账号凭证

## 致谢 · Acknowledgements

本项目是**再加工**，站在以下项目的肩膀上，向原作者致谢：

| 上游项目 | 地址 | 本项目用到的部分 | 许可证 |
|---|---|---|---|
| GPT4Free / g4f | https://github.com/xtekky/gpt4free | g4f 通道的 provider 聚合后端（PyPI 包 `g4f`，作者 @xtekky，维护 @hlohaus） | GPLv3 |
| chat2api | https://github.com/lanqian528/chat2api | chat2api 通道复刻其**免登录模式**协议语义 | 见上游 |
| dsh-gateway-ui | DSH 生态插件 | `LlmAdapter` 结构与 StreamChunk 组装参考 | MIT |
| dsh-qqbot-manager | DSH 生态插件 | tmux 承载与引擎启动时后台自举的模式参考 | MIT |

本项目自身代码以 **MIT** 发布；上游 g4f 为 **GPLv3**，二次分发时请留意
其许可条款并保留上游署名。

---

## 署名 · Author

该项目由 **易尘** 开源 🤓
