#!/usr/bin/env python3
"""Translate Anthropic Messages and Gemini generateContent into OpenAI chat.

Claude Code and Gemini CLI only speak their vendor API, so pointing them at the
OpenAI-compatible endpoint under test needs a shim. This one is dependency-free
and intentionally small: text, tool calls and streaming, nothing else.
"""
from __future__ import annotations

import json
import os
import sys
import subprocess
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = os.environ.get("UPSTREAM_URL", "https://opencode.ai/inference/go/v1")
API_KEY = os.environ["OPENCODE_GO_API_KEY"]
# The endpoint routes by session; without it every call is rejected.
SESSION = str(uuid.uuid4())


def curl_headers() -> list[str]:
    return [
        "-H", "content-type: application/json",
        "-H", f"authorization: Bearer {API_KEY}",
        "-H", f"x-opencode-session: {SESSION}",
        "-H", "accept: application/json",
    ]


def call_openai(payload: dict) -> dict:
    # curl, not urllib: the endpoint sits behind Cloudflare and rejects the
    # HTTP/1.1 fingerprint urllib presents.
    result = subprocess.run(
        ["curl", "-sS", "--max-time", "600", *curl_headers(),
         "-d", json.dumps(payload), f"{UPSTREAM}/chat/completions"],
        capture_output=True, text=True, check=True,
    )
    return json.loads(result.stdout)


def stream_openai(payload: dict):
    process = subprocess.Popen(
        ["curl", "-sSN", "--max-time", "600", *curl_headers(),
         "-d", json.dumps(payload), f"{UPSTREAM}/chat/completions"],
        stdout=subprocess.PIPE, text=True, bufsize=1,
    )
    try:
        for line in process.stdout:
            line = line.strip()
            if not line.startswith("data:"):
                continue
            body = line[5:].strip()
            if body == "[DONE]":
                return
            yield json.loads(body)
    finally:
        process.kill()


def text_of(content) -> str:
    if isinstance(content, str):
        return content
    parts = []
    for block in content or []:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text", ""))
    return "".join(parts)


def anthropic_to_openai(body: dict) -> dict:
    messages = []
    system = text_of(body.get("system"))
    if system:
        messages.append({"role": "system", "content": system})
    for message in body.get("messages", []):
        role = message.get("role")
        content = message.get("content")
        if isinstance(content, str):
            messages.append({"role": role, "content": content})
            continue
        texts, tool_calls, tool_results = [], [], []
        for block in content or []:
            kind = block.get("type")
            if kind == "text":
                texts.append(block.get("text", ""))
            elif kind == "tool_use":
                tool_calls.append({
                    "id": block.get("id"),
                    "type": "function",
                    "function": {"name": block.get("name"),
                                 "arguments": json.dumps(block.get("input", {}))},
                })
            elif kind == "tool_result":
                tool_results.append({
                    "role": "tool",
                    "tool_call_id": block.get("tool_use_id"),
                    "content": text_of(block.get("content")),
                })
        if role == "assistant" and tool_calls:
            messages.append({"role": "assistant",
                             "content": "".join(texts) or None,
                             "tool_calls": tool_calls})
        elif role == "user" and tool_results:
            messages.extend(tool_results)
            if texts:
                messages.append({"role": "user", "content": "".join(texts)})
        else:
            messages.append({"role": role, "content": "".join(texts)})

    payload = {"model": body.get("model", "deepseek-v4.1-flash"),
               "messages": messages,
               "max_tokens": body.get("max_tokens", 4096)}
    if body.get("temperature") is not None:
        payload["temperature"] = body["temperature"]
    tools = []
    for tool in body.get("tools", []) or []:
        tools.append({"type": "function",
                      "function": {"name": tool["name"],
                                   "description": tool.get("description", ""),
                                   "parameters": tool.get("input_schema", {})}})
    if tools:
        payload["tools"] = tools
    return payload


def openai_stop_reason(reason: str | None) -> str:
    return {"length": "max_tokens", "tool_calls": "tool_use"}.get(reason or "", "end_turn")


def openai_to_anthropic(response: dict, model: str) -> dict:
    choice = response["choices"][0]
    message = choice.get("message", {})
    blocks = []
    if message.get("content"):
        blocks.append({"type": "text", "text": message["content"]})
    for call in message.get("tool_calls") or []:
        try:
            arguments = json.loads(call["function"]["arguments"] or "{}")
        except json.JSONDecodeError:
            arguments = {}
        blocks.append({"type": "tool_use", "id": call["id"],
                       "name": call["function"]["name"], "input": arguments})
    usage = response.get("usage", {})
    return {"id": response.get("id", "msg_local"), "type": "message",
            "role": "assistant", "model": model, "content": blocks,
            "stop_reason": openai_stop_reason(choice.get("finish_reason")),
            "stop_sequence": None,
            "usage": {"input_tokens": usage.get("prompt_tokens", 0),
                      "output_tokens": usage.get("completion_tokens", 0)}}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def send_json(self, payload: dict, status: int = 200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            self.send_json({"data": [{"id": "deepseek-v4.1-flash",
                                      "display_name": "deepseek-v4.1-flash"}]})
            return
        self.send_json({"error": "not found"}, 404)

    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        path = self.path.split("?")[0]
        if path.endswith("/messages/count_tokens"):
            self.send_json({"input_tokens": 1})
            return
        if path.endswith("/messages"):
            self.handle_anthropic(body)
            return
        if ":generateContent" in path or ":streamGenerateContent" in path:
            self.handle_gemini(body, stream=":streamGenerateContent" in path)
            return
        self.send_json({"error": f"unsupported path {path}"}, 404)

    # ---------------------------------------------------------------- Anthropic
    def handle_anthropic(self, body: dict):
        payload = anthropic_to_openai(body)
        model = payload["model"]
        if not body.get("stream"):
            self.send_json(openai_to_anthropic(call_openai(payload), model))
            return

        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "close")
        self.end_headers()

        def emit(event: str, data: dict):
            self.wfile.write(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode())
            self.wfile.flush()

        emit("message_start", {"type": "message_start", "message": {
            "id": "msg_local", "type": "message", "role": "assistant",
            "model": model, "content": [], "stop_reason": None,
            "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 0}}})
        emit("content_block_start", {"type": "content_block_start", "index": 0,
                                     "content_block": {"type": "text", "text": ""}})
        text_started = True
        block_index = 0
        tool_blocks = {}
        payload["stream"] = True
        for chunk in stream_openai(payload):
            choice = (chunk.get("choices") or [{}])[0]
            delta = choice.get("delta") or {}
            if delta.get("content"):
                emit("content_block_delta", {"type": "content_block_delta",
                                             "index": 0,
                                             "delta": {"type": "text_delta",
                                                       "text": delta["content"]}})
            for call in delta.get("tool_calls") or []:
                slot = call.get("index", 0)
                if slot not in tool_blocks:
                    if text_started:
                        emit("content_block_stop", {"type": "content_block_stop", "index": 0})
                        text_started = False
                    block_index += 1
                    tool_blocks[slot] = block_index
                    emit("content_block_start", {
                        "type": "content_block_start", "index": block_index,
                        "content_block": {"type": "tool_use",
                                          "id": call.get("id") or f"toolu_{slot}",
                                          "name": call["function"]["name"],
                                          "input": {}}})
                arguments = call.get("function", {}).get("arguments")
                if arguments:
                    emit("content_block_delta", {
                        "type": "content_block_delta", "index": tool_blocks[slot],
                        "delta": {"type": "input_json_delta", "partial_json": arguments}})
            if choice.get("finish_reason"):
                if text_started:
                    emit("content_block_stop", {"type": "content_block_stop", "index": 0})
                for index in tool_blocks.values():
                    emit("content_block_stop", {"type": "content_block_stop", "index": index})
                emit("message_delta", {"type": "message_delta",
                                       "delta": {"stop_reason": openai_stop_reason(choice["finish_reason"]),
                                                 "stop_sequence": None},
                                       "usage": {"output_tokens": 0}})
                emit("message_stop", {"type": "message_stop"})
                return

    # ------------------------------------------------------------------- Gemini
    def handle_gemini(self, body: dict, stream: bool):
        contents = body.get("contents", [])
        messages = []
        system = body.get("systemInstruction")
        if system:
            messages.append({"role": "system", "content": text_of(system.get("parts"))})
        for content in contents:
            role = "assistant" if content.get("role") == "model" else "user"
            parts = content.get("parts", [])
            texts, calls, results = [], [], []
            for part in parts:
                if "text" in part:
                    texts.append(part["text"])
                elif "functionCall" in part:
                    calls.append({"id": f"call_{len(calls)}", "type": "function",
                                  "function": {"name": part["functionCall"]["name"],
                                               "arguments": json.dumps(part["functionCall"].get("args", {}))}})
                elif "functionResponse" in part:
                    results.append({"role": "tool",
                                    "tool_call_id": f"call_0",
                                    "content": json.dumps(part["functionResponse"].get("response", {}))})
            if role == "assistant" and calls:
                messages.append({"role": "assistant", "content": "".join(texts) or None,
                                 "tool_calls": calls})
            elif results:
                messages.extend(results)
                if texts:
                    messages.append({"role": "user", "content": "".join(texts)})
            else:
                messages.append({"role": role, "content": "".join(texts)})

        payload = {"model": "deepseek-v4.1-flash", "messages": messages}
        declarations = (body.get("tools") or [{}])[0].get("functionDeclarations") if body.get("tools") else None
        if declarations:
            payload["tools"] = [{"type": "function",
                                 "function": {"name": item["name"],
                                              "description": item.get("description", ""),
                                              "parameters": item.get("parameters", {})}}
                                for item in declarations]
        if stream:
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("cache-control", "no-cache")
            self.send_header("connection", "close")
            self.end_headers()
            payload["stream"] = True
            pending_calls = {}
            for chunk in stream_openai(payload):
                choice = (chunk.get("choices") or [{}])[0]
                delta = choice.get("delta") or {}
                parts = []
                if delta.get("content"):
                    parts.append({"text": delta["content"]})
                for call in delta.get("tool_calls") or []:
                    slot = call.get("index", 0)
                    entry = pending_calls.setdefault(slot, {"name": "", "arguments": ""})
                    if call.get("function", {}).get("name"):
                        entry["name"] = call["function"]["name"]
                    entry["arguments"] += call.get("function", {}).get("arguments") or ""
                if parts:
                    self.wfile.write(("data: " + json.dumps({"candidates": [
                        {"content": {"role": "model", "parts": parts}, "index": 0}]}) + "\n\n").encode())
                    self.wfile.flush()
                if choice.get("finish_reason"):
                    final_parts = []
                    for entry in pending_calls.values():
                        try:
                            arguments = json.loads(entry["arguments"] or "{}")
                        except json.JSONDecodeError:
                            arguments = {}
                        final_parts.append({"functionCall": {"name": entry["name"], "args": arguments}})
                    self.wfile.write(("data: " + json.dumps({"candidates": [
                        {"content": {"role": "model", "parts": final_parts},
                         "finishReason": "STOP", "index": 0}]}) + "\n\n").encode())
                    self.wfile.flush()
                    return
            return

        response = call_openai(payload)
        choice = response["choices"][0]
        message = choice.get("message", {})
        parts = []
        if message.get("content"):
            parts.append({"text": message["content"]})
        for call in message.get("tool_calls") or []:
            parts.append({"functionCall": {"name": call["function"]["name"],
                                           "args": json.loads(call["function"]["arguments"] or "{}")}})
        self.send_json({"candidates": [{"content": {"role": "model", "parts": parts},
                                        "finishReason": "STOP"}],
                        "usageMetadata": {"promptTokenCount": response.get("usage", {}).get("prompt_tokens", 0),
                                          "candidatesTokenCount": response.get("usage", {}).get("completion_tokens", 0)}})


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8901
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"translating proxy on 127.0.0.1:{port} -> {UPSTREAM}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
