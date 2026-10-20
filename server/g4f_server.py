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


def provider_instances(prefer_stream=False):
    """把 provider 名解析成类；解析不到的跳过（版本差异不致命）。

    ⚠️ `g4f.Provider.__providers__` 是**类的 list**，不是 dict——按名字查表
    会 AttributeError。这里先建 name→class 映射。

    prefer_stream=True 时，把 `supports_stream` 的 provider 排到前面。
    原因：部分 provider（如 Yqcloud）会接受 stream=True 却只吐一整个块，
    导致「真流式」退化成一次性输出；先试真支持增量的，打字机才成立。
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

    if prefer_stream and len(out) > 1:
        def rank(entry):
            supports = bool(getattr(entry[1], "supports_stream", False))
            return (0 if supports else 1)

        out.sort(key=rank)
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

    ⚠️ 这是**降级路径**：只有当上游 provider 不支持真流式、只肯返回整段
    文本时才会用到。真流式请走 iter_providers_stream()——那才是边算边发。
    早期误把这里当成主路径（先拿完整结果再切块），结果是「等 5 秒、
    内容在最后几百毫秒一次性涌出」，用户看到的仍是一次性吐出。

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


def extract_stream_piece(piece):
    """从 g4f 的单个流式增量里抽出文本。

    各 provider 的增量形态不统一：纯字符串、`{"content": ...}`、
    `{"choices":[{"delta":{"content":...}}]}` 都见过。统一成字符串，
    抽不出来就返回空串（调用方跳过）。
    """
    if isinstance(piece, str):
        return piece
    if isinstance(piece, dict):
        # 标准 OpenAI delta
        try:
            delta = piece["choices"][0]["delta"]
            content = delta.get("content")
            if isinstance(content, str):
                return content
        except Exception:
            pass
        # g4f 简化形态
        content = piece.get("content")
        if isinstance(content, str):
            return content
        return ""
    return ""


def iter_providers_stream(model, messages, timeout_hint=55, tools=None):
    """逐个 provider 尝试真流式，边收增量边 yield (piece, provider_name)。

    与 call_providers 的区别：这里**不**等生成结束，yield 是实时的——
    这正是打字机效果的前提。

    若某 provider 不支持 stream（StreamNotSupportedError）或首块就失败，
    换下一个；一旦已产出内容就不再换（避免半截话拼接）。
    """
    errors = []
    # 假流式兜底：某个 provider 给了内容但只有单块时暂存于此，
    # 等所有 provider 都试完还没有真增量，再退回去用它。
    state = {"fake": None}
    want_emulation = os.environ.get("G4F_TOOL_EMULATION", "").strip().lower() in ("1", "true", "yes", "on")

    # 工具调用场景走非流式：tool_emulation 需要完整文本才能解析，
    # 而我们的插件层本来就等流结束后统一解析，这里不必真流。
    if tools:
        text, name = call_providers(model, messages, tools=tools)
        yield text, name
        return

    for name, cls in provider_instances(prefer_stream=True):
        started = False
        try:
            LOG.info("stream try provider %s model=%s", name, model)
            res = ChatCompletion.create(
                model=model,
                messages=messages,
                provider=cls,
                ignore_working=True,
                stream=True,
            )

            # 非生成器（provider 忽略了 stream）：直接吐出整段。
            if isinstance(res, (str, dict)):
                text = extract_text(res)
                if text and text.strip():
                    LOG.info("stream provider %s returned non-stream (%d chars)", name, len(text))
                    yield text, name
                    return
                errors.append(f"{name}: empty result")
                continue

            # ⚠️ 先探测再转发：有些 provider（实测 Yqcloud）会接受 stream=True
            # 却只吐出**一整块**正文。若能收到 ≥2 个块才算真增量，否则换下一个。
            # 必须先在本地缓冲两块，确认后才开始 yield——已经发出去的 chunk
            # 收不回来，会让用户看到「半段 + 重来」的拼接内容。
            buffer = []
            iterator = iter(res)
            for piece in iterator:
                piece_text = extract_stream_piece(piece)
                if not piece_text:
                    continue
                buffer.append(piece_text)
                if len(buffer) >= 2:
                    break

            if len(buffer) >= 2:
                # 真流式：先补发前两块，然后继续透传剩余增量。
                started = True
                LOG.info("stream provider %s first token (real stream)", name)
                for piece_text in buffer:
                    yield piece_text, name
                buffer = []
                for piece in iterator:
                    piece_text = extract_stream_piece(piece)
                    if piece_text:
                        yield piece_text, name
                LOG.info("stream provider %s ok (real stream)", name)
                return

            if len(buffer) == 1:
                # 单块 = 假流式。内容是对的，但拿不到打字节奏；
                # 记下来当**兜底**，继续试下一个 provider 看有没有真增量。
                fake = ("".join(buffer), name)
                errors.append(f"{name}: single chunk (no real streaming)")
                LOG.info("stream provider %s only produced 1 chunk, trying next", name)
                if state.get("fake") is None:
                    state["fake"] = fake
                continue

            errors.append(f"{name}: empty stream")
        except Exception as exc:  # noqa: BLE001
            # 已经开始吐字就不能再换 provider，否则用户会看到两段拼接的内容。
            if started:
                LOG.warning("stream provider %s broke mid-way: %s", name, str(exc)[:160])
                return
            msg = f"{type(exc).__name__}: {str(exc)[:160]}"
            errors.append(f"{name}: {msg}")
            LOG.warning("stream provider %s failed: %s", name, msg)

    # 所有 provider 都没给出真增量：退回单块结果（内容正确，只是没有打字节奏）。
    if state.get("fake") is not None:
        LOG.info("no provider gave real stream, falling back to single chunk text")
        yield state["fake"]
        return

    raise RuntimeError("all providers failed (stream) | " + " ; ".join(errors))


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

        # ⚠️ 流式必须走独立路径：不能先 call_providers() 拿到完整文本再切块，
        # 那样首字节要等整个生成结束（实测 5.5 秒），内容集中在最后
        # 268ms 涌出——用户看到的就是「一次性吐出」，和没做流式一样。
        if want_stream:
            self._stream_upstream(model, messages, tools)
            return

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

    def _stream_upstream(self, model, messages, tools):
        """真流式：边从上游取增量、边 flush 给客户端。

        两条路径：
          1. **真流式**（首选）—— `ChatCompletion.create(stream=True)` 返回
             生成器，逐个 delta 转发。首字节延迟 = provider 的首 token 时间。
          2. **降级**（provider 不支持 stream 时）—— 退回整段生成 + 切块推送。
             这条路上首字节会明显变慢，但至少结构仍是 SSE。

        早期只实现了路径 2，实测首块要等 5.5 秒、内容集中在最后 268ms，
        用户看到的就是「一次性吐出」。真正的打字机必须走路径 1。
        """
        self.send_response(200)
        self.send_header("content-type", "text/event-stream; charset=utf-8")
        self.send_header("cache-control", "no-cache")
        # ⚠️ 必须 close：发完 [DONE] 要真的断开，否则客户端 reader
        # 永远等不到 done（表现为「流打完了但一直转圈」）。不能发 keep-alive。
        self.send_header("connection", "close")
        self.send_header("x-accel-buffering", "no")
        self.end_headers()
        self.close_connection = True

        chunk_id = f"chatcmpl-g4f-{int(time.time()*1000)}"
        created = int(time.time())
        state = {"provider": None}

        def emit(delta, finish_reason=None):
            payload = {
                "id": chunk_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "provider": state["provider"] or "",
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

            produced = False
            for piece, provider in iter_providers_stream(model, messages, tools=tools):
                if state["provider"] is None:
                    state["provider"] = provider
                if not piece:
                    continue
                produced = True
                emit({"content": piece})

            if not produced:
                # 上游一个字都没吐：退化成整段路径，避免用户拿到空回复。
                LOG.warning("stream produced nothing, falling back to full generation")
                text, provider = call_providers(model, messages, tools=tools)
                state["provider"] = provider
                for piece in split_for_stream(text):
                    emit({"content": piece})

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
