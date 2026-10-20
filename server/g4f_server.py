#!/usr/bin/env python3
"""
g4f OpenAI 兼容服务 —— 端口 8080。

【致敬 · 上游原项目】
本服务是对 GPT4Free / g4f（https://github.com/xtekky/gpt4free，PyPI 包 g4f，
作者 @xtekky，由 @hlohaus 维护，许可证 GPLv3）的再加工：本应按原任务跑官方
Docker 镜像 hlohaus789/g4f，但目标机为非 root Android，无法运行 dockerd，
故改为直接调用 g4f 库、并用标准库复刻其 OpenAI 兼容端点。
向原作者 @xtekky 与维护者 @hlohaus 致敬。

为什么不用 `g4f.api.run_api()`：那个入口依赖 fastapi + uvicorn + pydantic-core，
而后两者在 aarch64 Android/Termux 上要 Rust 编译（rustup 不支持
aarch64-unknown-linux-android triple）。容器内有 glibc wheel 可以装，但本机
网络对宿主做了 HTTPS 中间人（返回 *.certfallback.com 兜底证书 ⇒ 所有
provider 的 TLS 主机名校验失败），只有容器内的网络才是干净的。

因此本文件用**标准库 http.server** 复刻 g4f 的 OpenAI 兼容端点，后端直接调
`g4f.ChatCompletion.create()`。无 fastapi / uvicorn / pydantic 依赖。

契约（任务指定，不可改）：
  POST /v1/chat/completions
  GET  /v1/models
"""

import json
import logging
import os
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# g4f 的 provider 需要一个能走真实 TLS 的网络环境。容器内即如此。
from g4f import ChatCompletion
from g4f.Provider import __providers__ as ALL_PROVIDERS

LOG = logging.getLogger("g4f-service")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# 对外声明的模型清单（g4f 聚合公开 provider，模型名透传；这里给常用集合）。
MODEL_IDS = [
    "default", "gpt-4", "gpt-4o", "gpt-4o-mini", "gpt-4-turbo",
    "gpt-3.5-turbo", "gpt-4.1", "gpt-4.1-mini",
    "claude-3.5-sonnet", "claude-3-opus",
    "gemini-2.5-flash", "gemini-2.5-pro",
    "deepseek-v3", "deepseek-r1",
    "qwen-2.5-72b", "qwen-3-235b",
    "llama-3.3-70b", "llama-3.1-8b",
    "mixtral-8x7b", "mistral-7b",
    "grok-2", "phi-4", "command-r-plus",
]

# 优先尝试的免账号 provider（按经验排序；失败会继续尝试下一个）。
PREFERRED_PROVIDERS = [
    "Yqcloud", "LLM7", "Pollinations", "DeepInfra",
    "HuggingFace", "Cloudflare", "Cerebras", "Groq",
]


def provider_instances():
    """把 provider 名解析成类；解析不到的跳过（版本差异不致命）。

    ⚠️ `g4f.Provider.__providers__` 是**类的 list**，不是 dict——按名字查表
    会 AttributeError。这里先建 name→class 映射。
    """
    by_name = {}
    for item in ALL_PROVIDERS:
        name = getattr(item, "__name__", None)
        if name:
            by_name[name] = item
    out = []
    for name in PREFERRED_PROVIDERS:
        cls = by_name.get(name)
        if cls is not None:
            out.append((name, cls))
    return out


def extract_text(result):
    """g4f 可能返回 str、dict 或生成器，统一抽成纯文本。"""
    if isinstance(result, str):
        return result
    if isinstance(result, dict):
        try:
            return result["choices"][0]["message"]["content"]
        except Exception:
            return json.dumps(result, ensure_ascii=False)
    if hasattr(result, "__iter__"):
        chunks = []
        for piece in result:
            if isinstance(piece, str):
                chunks.append(piece)
        joined = "".join(chunks)
        if joined:
            return joined
    return str(result)


def split_for_stream(text, max_chars=12):
    """把整段文本切成适合流式推送的小块。

    切分规则偏「自然」：
      - 换行单独成块（保住段落结构）
      - 英文按空格边界切词（模型中文输出也常常混英文）
      - 中文按字切（中文没有空格边界，按 max_chars 聚合）

    目的只是让客户端看到打字节奏，不追求语义完美分块。
    """
    if not text:
        return []

    pieces = []
    buf = ''
    for ch in text:
        buf += ch
        if ch == '\n':
            pieces.append(buf)
            buf = ''
        elif len(buf) >= max_chars:
            # 优先在空格处断开，避免把英文单词劈成两半。
            space_at = buf.rfind(' ')
            if space_at > max_chars // 2:
                pieces.append(buf[:space_at + 1])
                buf = buf[space_at + 1:]
            else:
                pieces.append(buf)
                buf = ''
    if buf:
        pieces.append(buf)
    return pieces


def call_providers(model, messages, timeout_hint=55, tools=None):
    """依次尝试可用 provider，任一成功即返回 (text, provider_name)。

    全部失败时抛 RuntimeError，附上每个 provider 的错误摘要——这样上游调用方
    能拿到可读的失败原因，而不是空字符串。

    tools：透传 OpenAI tools 声明。页面反代 provider 对 tools 的支持不稳定，
    故交由插件层做「文本 → tool_calls」兜底解析（见插件 lib/parse_tool_calls.js）；
    G4F_TOOL_EMULATION=1 时同时开启 g4f 内置仿真作为第一道。
    """
    errors = []
    want_emulation = os.environ.get("G4F_TOOL_EMULATION", "").strip().lower() in ("1", "true", "yes", "on")
    for name, cls in provider_instances():
        try:
            LOG.info("try provider %s model=%s", name, model)
            kwargs = dict(model=model, messages=messages, provider=cls, ignore_working=True)
            if tools:
                kwargs["tools"] = tools
                if want_emulation:
                    kwargs["tool_emulation"] = True
            res = ChatCompletion.create(**kwargs)
            text = extract_text(res)
            if text and text.strip():
                LOG.info("provider %s ok (%d chars)", name, len(text))
                return text, name
            errors.append(f"{name}: empty result")
        except Exception as exc:  # noqa: BLE001 - 每个 provider 的失败都要吞掉继续试
            msg = f"{type(exc).__name__}: {str(exc)[:160]}"
            errors.append(f"{name}: {msg}")
            LOG.warning("provider %s failed: %s", name, msg)
    raise RuntimeError("all providers failed | " + " ; ".join(errors))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        LOG.info("%s %s", self.address_string(), fmt % args)

    def do_GET(self):
        if self.path.split("?")[0] in ("/v1/models", "/models"):
            self._send(200, {
                "object": "list",
                "data": [
                    {"id": m, "object": "model", "created": 0, "owned_by": "g4f"}
                    for m in MODEL_IDS
                ],
            })
            return
        if self.path in ("/", "/health"):
            self._send(200, {"ok": True, "service": "g4f"})
            return
        self._send(404, {"error": {"message": "not found", "type": "invalid_request"}})

    def do_POST(self):
        if self.path.split("?")[0] != "/v1/chat/completions":
            self._send(404, {"error": {"message": "not found", "type": "invalid_request"}})
            return

        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length > 0 else b""
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except ValueError:
            self._send(400, {"error": {"message": "invalid JSON", "type": "invalid_request"}})
            return

        messages = body.get("messages") or []
        if not messages:
            self._send(400, {"error": {"message": "messages is required", "type": "invalid_request"}})
            return

        model = body.get("model") or "default"
        tools = body.get("tools")
        want_stream = bool(body.get("stream"))
        try:
            text, provider = call_providers(model, messages, tools=tools)
        except Exception as exc:  # noqa: BLE001 - 转成 HTTP 502，不崩服务
            LOG.error("completion failed: %s", exc)
            self._send(502, {
                "error": {
                    "message": str(exc)[:900],
                    "type": "upstream_unavailable",
                    "hint": "g4f 的可用性取决于当日活跃 Provider；稍后重试或切换 service。",
                }
            })
            return

        if want_stream:
            self._stream_text(model, provider, text)
            return

        self._send(200, {
            "id": f"chatcmpl-g4f-{int(time.time()*1000)}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": model,
            "provider": provider,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        })

    def _stream_text(self, model, provider, text):
        """把已拿到的整段文本按块切成 SSE 流。

        ⚠️ 这里必须真的发 `text/event-stream`：g4f 的 provider 调用本身是
        阻塞的、拿不到增量（`ChatCompletion.create` 返回最终文本或生成器，
        但网页反代 provider 多数只给最终结果）。所以本服务不做「边算边发」，
        而是把结果按词切开、带上真实间隔逐条推出去——效果上就是打字机。

        为什么不直接透传上游生成器：各 provider 的增量语义不统一（有的
        给整段、有的给 token、有的返回 dict），透传会让调用方拿到混合格式。
        在这里统一成标准 SSE，插件侧只需按标准解析。
        """
        self.send_response(200)
        self.send_header("content-type", "text/event-stream; charset=utf-8")
        self.send_header("cache-control", "no-cache")
        # ⚠️ 必须声明 close：发完 [DONE] 要真的断开，否则客户端 reader
        # 永远等不到 done（表现为「流打完了但一直转圈」）。不能发 keep-alive。
        self.send_header("connection", "close")
        self.send_header("x-accel-buffering", "no")
        self.end_headers()
        self.close_connection = True

        chunk_id = f"chatcmpl-g4f-{int(time.time()*1000)}"
        created = int(time.time())

        def emit(delta, finish_reason=None):
            payload = {
                "id": chunk_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "provider": provider,
                "choices": [{
                    "index": 0,
                    "delta": delta,
                    "finish_reason": finish_reason,
                }],
            }
            line = "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"
            self.wfile.write(line.encode("utf-8"))
            self.wfile.flush()

        try:
            # 首个 chunk 只带 role，符合 OpenAI 流式约定。
            emit({"role": "assistant", "content": ""})

            for piece in split_for_stream(text):
                emit({"content": piece})
                # 小块之间留一点间隔，客户端才能看出打字节奏。
                time.sleep(0.02)

            emit({}, "stop")
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except BrokenPipeError:
            # 客户端中途断开（用户点了停止），不算错误。
            LOG.info("stream client disconnected")
        except Exception as exc:  # noqa: BLE001
            LOG.warning("stream failed: %s", exc)


if __name__ == "__main__":
    port = int(os.environ.get("G4F_PORT", "8080"))
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    LOG.info("g4f OpenAI-compatible service on :%d", port)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
