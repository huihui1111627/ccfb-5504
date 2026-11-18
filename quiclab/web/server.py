"""零依赖的静态文件 + trace JSON HTTP 服务。

接口
----
GET /                 -> web/index.html
GET /app.js|styles.css-> web/ 下静态资源
GET /api/scenarios    -> traces 目录下所有场景清单(含 result 摘要)
GET /api/trace/<name> -> 指定场景的完整 trace JSON
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


def build_handler(traces_dir: Path):
    traces_dir = traces_dir.resolve()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # 安静一点
            pass

        def _send(self, code, body: bytes, content_type: str):
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, obj, code=200):
            self._send(
                code,
                json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                "application/json; charset=utf-8",
            )

        def do_GET(self):
            path = urlparse(self.path).path

            if path == "/api/scenarios":
                return self._list_scenarios()
            if path.startswith("/api/trace/"):
                name = unquote(path[len("/api/trace/"):])
                return self._get_trace(name)
            if path in ("/", "/index.html"):
                return self._static("index.html", "text/html; charset=utf-8")
            if path in ("/app.js", "/styles.css"):
                ctype = (
                    "application/javascript; charset=utf-8"
                    if path.endswith(".js")
                    else "text/css; charset=utf-8"
                )
                return self._static(path.lstrip("/"), ctype)
            self._send(404, b"not found", "text/plain")

        # --------------------------------------------------------------
        def _static(self, name: str, ctype: str):
            target = (WEB_DIR / name).resolve()
            if WEB_DIR not in target.parents and target != WEB_DIR:
                return self._send(403, b"forbidden", "text/plain")
            if not target.is_file():
                return self._send(404, b"not found", "text/plain")
            self._send(200, target.read_bytes(), ctype)

        def _list_scenarios(self):
            items = []
            # 递归扫描,兼容 violation/ 等子目录
            for p in sorted(traces_dir.rglob("*.json")):
                if p.name == "manifest.json":
                    continue
                try:
                    data = json.loads(p.read_text(encoding="utf-8"))
                except json.JSONDecodeError:
                    continue
                result = data.get("result", {})
                rel = p.relative_to(traces_dir).with_suffix("")
                items.append(
                    {
                        # 用相对路径(去掉 .json)作为 trace 拉取键
                        "name": data.get("scenario", {}).get("name", str(rel)),
                        "trace_key": str(rel),
                        "seed": data.get("scenario", {}).get("seed"),
                        "description": data.get("scenario", {}).get("description", ""),
                        "sim_time": result.get("sim_time"),
                        "exactly_once": result.get("exactly_once"),
                        "all_bytes_covered": result.get("all_bytes_covered"),
                        "app_expected": result.get("app_expected"),
                        "app_delivered_bytes": result.get("app_delivered_bytes"),
                        "client_reason": result.get("client_reason"),
                        "server_reason": result.get("server_reason"),
                        "event_count": len(data.get("events", [])),
                    }
                )
            self._json({"scenarios": items})

        def _get_trace(self, name: str):
            # name 可能含子目录(如 violation/xxx),防目录穿越后按相对路径解析
            candidate = (traces_dir / f"{name}.json").resolve()
            try:
                candidate.relative_to(traces_dir.resolve())
            except ValueError:
                return self._json({"error": "forbidden"}, 403)
            if not candidate.is_file():
                return self._json({"error": "not found"}, 404)
            self._send(
                200,
                candidate.read_bytes(),
                "application/json; charset=utf-8",
            )

    return Handler


def serve(port: int, traces_dir: str | Path) -> None:
    traces_path = Path(traces_dir)
    if not traces_path.exists():
        traces_path.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(
        ("127.0.0.1", port), build_handler(traces_path)
    )
    print(f"quiclab 可视化页面: http://127.0.0.1:{port}/")
    print(f"trace 目录: {traces_path.resolve()}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        server.server_close()
