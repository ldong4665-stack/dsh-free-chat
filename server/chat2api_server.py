#!/usr/bin/env python3
"""
chat2api 协议等价服务（免登录模式）—— 端口 8081。

【致敬 · 上游原项目】
本服务是对 lanqian528/chat2api（https://github.com/lanqian528/chat2api）
「免登录模式」协议语义的复刻与再加工。原任务指定的 Docker 镜像
yilee01/chat2api 的源仓库已 404，无法获取其真实实现，故按原项目的
公开协议行为重新实现。向原作者 lanqian528 致敬。

  * 无需任何 Token / Authorization:不设置 AUTHORIZATION 环境变量即运行在
    免登录模式,请求不带 key 也能访问。
  * 模型名不含 "gpt-4" 时自动落到免登录 GPT-3.5 档(gpt-3.5-turbo);
    含 gpt-4 的模型名原样透传。
  * 暴露 OpenAI 兼容契约:/v1/chat/completions 与 /v1/models。

后端接入 g4f 的多个公开 provider 做冗余——与原服务"聚合公开 provider、
无需账号"的设计意图一致。全程无任何账号凭证。

端口 8081 与 /v1 路径是硬契约(任务指定),不要改。
"""

import json
import logging
import os
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# g4f 与宿主同机部署(localhost:8080 由另一个进程提供)。容器内访问宿主
# 端口走网关 IP;若直接同进程调用可改 import g4f。这里用 HTTP 调本机 g4f,
# 保持两个服务进程职责分离、各自可独立重启。
import urllib.request

G4F_BASE = os.environ.get("G4F_BASE", "http://localhost:8080")
LISTEN_PORT = int(os.environ.get("CHAT2API_PORT", "8081"))
LOGIN_FREE_MODEL = "gpt-3.5-turbo"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("chat2api")


def resolve_model(model):
    """免登录语义:模型名不含 gpt-4 → 落到免登录 GPT-3.5 档。"""
    if not model or "gpt-4" not in model:
        return LOGIN_FREE_MODEL
    return model


def call_upstream(payload, timeout=60):
    """调用本机 g4f的 OpenAI 兼容端点,带超时,失败抛带状态码的异常。"""
    url = f"{G4F_BASE}/v1/chat/completions"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json", "accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        log.info("%s %s", self.address_string(), fmt % args)

    def do_GET(self):
        if self.path == "/v1/models":
            # 免登录模式对外声明 GPT-3.5 档可用(gpt-3.5-turbo),
            # 与原服务「免登录仅保证 GPT-3.5」的语义一致。
            self._json(200, {
                "object": "list",
                "data": [
                    {"id": LOGIN_FREE_MODEL, "object": "model", "created": 0, "owned_by": "chat2api"},
                ],
            })
            return
        if self.path == "/health" or self.path == "/":
            self._json(200, {"ok": True, "mode": "login-free"})
            return
        self._json(404, {"error": {"message": "not found", "type": "invalid_request"}})

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self._json(404, {"error": {"message": "not found", "type": "invalid_request"}})
            return

        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length > 0 else b""
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except ValueError:
            self._json(400, {"error": {"message": "invalid JSON body", "type": "invalid_request"}})
            return

        messages = body.get("messages") or []
        if not messages:
            self._json(400, {"error": {"message": "messages is required", "type": "invalid_request"}})
            return

        model = resolve_model(body.get("model"))
        upstream_payload = dict(body)
        upstream_payload["model"] = model
        want_stream = bool(body.get("stream"))

        if want_stream:
            self._proxy_stream(upstream_payload, model)
            return

        try:
            data = call_upstream(upstream_payload)
        except urllib.error.HTTPError as exc:
            text = ""
            try:
                text = exc.read().decode("utf-8", "replace")[:300]
            except Exception:
                pass
            log.warning("upstream HTTP %s: %s", exc.code, text)
            self._json(502, {"error": {"message": f"upstream error {exc.code}: {text}", "type": "upstream"}})
            return
        except Exception as exc:  # 超时 / 连接失败
            log.warning("upstream unreachable: %s", exc)
            self._json(502, {"error": {"message": f"upstream unreachable: {exc}", "type": "upstream"}})
            return

        # 保持上游响应原样透传(已是 OpenAI 兼容格式),只标注实际落档模型。
        try:
            data.setdefault("model", model)
        except Exception:
            pass
        self._json(200, data)

    def _proxy_stream(self, payload, model):
        """把上游 SSE 原样转发给客户端（打字机效果）。

        逐行读取上游流并立即 flush，不做缓冲、不做聚合——缓冲会让
        「流式」退化成一次性输出，客户端看到的仍是整段蹦出来。
        """
        url = f"{G4F_BASE}/v1/chat/completions"
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"content-type": "application/json", "accept": "text/event-stream"},
            method="POST",
        )

        self.send_response(200)
        self.send_header("content-type", "text/event-stream; charset=utf-8")
        self.send_header("cache-control", "no-cache")
        # 必须 close：发完就断开，否则客户端 reader 等不到流结束。
        self.send_header("connection", "close")
        self.end_headers()
        self.close_connection = True

        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                for raw in resp:
                    if not raw:
                        continue
                    line = raw.decode("utf-8", "replace")
                    # 把上游声明的模型名替换成免登录档实际落档的模型名。
                    if '"model"' in line and model:
                        line = re.sub(r'"model"\s*:\s*"[^"]*"', f'"model": "{model}"', line, count=1)
                    self.wfile.write(line.encode("utf-8"))
                    self.wfile.flush()
        except BrokenPipeError:
            log.info("stream client disconnected")
        except Exception as exc:  # noqa: BLE001
            log.warning("stream proxy failed: %s", exc)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", LISTEN_PORT), Handler)
    log.info("chat2api login-free server on :%d (no token required)", LISTEN_PORT)
    server.serve_forever()
