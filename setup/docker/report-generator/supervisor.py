#!/usr/bin/env python3
"""Report generator supervisor: keep the model in memory only while it is used.

The model server (llama-server) holds ~3 GB of memory it cannot give back for as
long as it runs, idle or not. This supervisor is the container's main process and
the only thing listening on the container port. It:

  * starts llama-server, on 127.0.0.1 only, when the first request that needs the
    model arrives, and waits until it reports healthy;
  * passes every request through unchanged — same paths, same bodies, same
    Authorization header — so the web app talks to it exactly as to llama-server;
  * stops llama-server once nothing has used it for REPORT_GENERATOR_IDLE_SECONDS
    (default 900), which returns its memory to the host. 0 keeps it loaded, and
    starts it at boot.

It needs no privileges: starting and stopping its own child process is all it
does. It never touches Docker, and it adds no endpoints of its own apart from
answering /health and the model list without waking the model.

Two requests that arrive while the model is unloaded start it once. The idle timer
never stops the model while a request is in flight, however long the request runs.
Only the Python standard library is used, so the image gains no dependency.
"""

import hmac
import http.client
import http.server
import json
import os
import signal
import subprocess
import sys
import threading
import time

LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = 8080
CHILD_HOST = "127.0.0.1"
CHILD_PORT = 8081
MAX_BODY_BYTES = 1_000_000
# Longer than the web app waits (15 minutes), so the web app gives up first; but
# finite, so a hung model server cannot stay "in flight" and block unloading forever.
FORWARD_TIMEOUT_SECONDS = 1800
REAP_INTERVAL_SECONDS = 15
# Hop-by-hop headers belong to one connection and must not be forwarded.
HOP_BY_HOP = {"connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade",
              "proxy-authorization", "proxy-authenticate", "host", "content-length"}


class Model:
    """The llama-server child process: started on demand, stopped when idle."""

    def __init__(self, command, ready_timeout=600, host=CHILD_HOST, port=CHILD_PORT,
                 clock=time.monotonic, popen=subprocess.Popen):
        self.command = command
        self.ready_timeout = ready_timeout
        self.host = host
        self.port = port
        self.clock = clock
        self.popen = popen
        self.proc = None
        self.in_flight = 0
        self.last_used = clock()
        self.state = "unloaded"
        self.lock = threading.Lock()

    def acquire(self):
        """Count a request in flight and make sure the model runs. Raises RuntimeError."""
        with self.lock:
            self.in_flight += 1
            self.last_used = self.clock()
            try:
                if not self.alive():
                    self._start()
            except Exception:
                self.in_flight -= 1
                raise

    def release(self):
        with self.lock:
            self.in_flight -= 1
            self.last_used = self.clock()

    def stop_if_idle(self, idle_seconds):
        """Stop the model when nothing is in flight and it has been unused long enough."""
        with self.lock:
            if idle_seconds <= 0 or self.in_flight > 0 or not self.alive():
                return False
            if self.clock() - self.last_used < idle_seconds:
                return False
            self._stop()
            return True

    def shutdown(self):
        with self.lock:
            self._stop()

    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    def current_state(self):
        """The state as it is now: a model server that died is unloaded, whatever was recorded."""
        if self.state == "ready" and not self.alive():
            return "unloaded"
        return self.state

    def _start(self):
        self.state = "starting"
        self.proc = self.popen(self.command)
        deadline = self.clock() + self.ready_timeout
        while not self._healthy():
            if self.proc.poll() is not None:
                self.proc = None
                self.state = "unloaded"
                raise RuntimeError("the model server exited while starting")
            if self.clock() > deadline:
                self._stop()
                raise RuntimeError("the model server did not become ready in time")
            time.sleep(0.25)
        self.state = "ready"

    def _healthy(self):
        conn = http.client.HTTPConnection(self.host, self.port, timeout=2)
        try:
            conn.request("GET", "/health")
            return conn.getresponse().status == 200
        except OSError:
            return False
        finally:
            conn.close()

    def _stop(self):
        if self.alive():
            self.proc.terminate()
            try:
                self.proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        self.proc = None
        self.state = "unloaded"


def authorised(header, api_key):
    """No key configured means no key required — the same rule llama-server applies."""
    if not api_key:
        return True
    return hmac.compare_digest(header or "", f"Bearer {api_key}")


def model_list(alias, state):
    """What /v1/models answers, without loading the model to find out."""
    return {"object": "list", "data": [{"id": alias, "object": "model", "owned_by": "llamacpp",
                                        "loaded": state == "ready", "state": state}]}


def alias_of(command):
    return command[command.index("--alias") + 1] if "--alias" in command else "model"


def make_handler(model, api_key, alias):
    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            self._handle()

        def do_POST(self):
            self._handle()

        def log_message(self, *args):
            # Request lines are not logged: the model server logs what it needs.
            pass

        def _handle(self):
            path = self.path.split("?", 1)[0]
            if path == "/health":
                return self._json(200, {"status": "ok", "model": model.current_state()})
            if not authorised(self.headers.get("Authorization"), api_key):
                return self._json(401, {"error": {"message": "Invalid API Key", "type": "authentication_error"}})
            if path in ("/v1/models", "/models"):
                return self._json(200, model_list(alias, model.current_state()))
            body = self._read_body()
            if body is not None:
                self._proxy(body)

        def _read_body(self):
            if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
                # The body was not read, so this connection cannot carry another request.
                self.close_connection = True
                self._json(411, {"error": {"message": "Content-Length is required"}})
                return None
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY_BYTES:
                self.close_connection = True
                self._json(413, {"error": {"message": "Request body too large"}})
                return None
            return self.rfile.read(length) if length else b""

        def _proxy(self, body):
            try:
                model.acquire()
            except RuntimeError as err:
                return self._json(503, {"error": {"message": str(err)}})
            try:
                status, headers, data = forward(model, self.command, self.path, self.headers, body)
                self._send(status, headers, data)
            except OSError:
                self._json(502, {"error": {"message": "the model server did not answer"}})
            finally:
                model.release()

        def _send(self, status, headers, data):
            self.send_response(status)
            for name, value in headers:
                if name.lower() not in HOP_BY_HOP:
                    self.send_header(name, value)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _json(self, status, payload):
            data = json.dumps(payload).encode()
            self._send(status, [("Content-Type", "application/json")], data)

    return Handler


def forward(model, method, path, request_headers, body):
    """One request to the model server; the whole response is read (no streaming)."""
    conn = http.client.HTTPConnection(model.host, model.port, timeout=FORWARD_TIMEOUT_SECONDS)
    try:
        headers = {k: v for k, v in request_headers.items() if k.lower() not in HOP_BY_HOP}
        conn.request(method, path, body=body or None, headers=headers)
        resp = conn.getresponse()
        return resp.status, resp.getheaders(), resp.read()
    finally:
        conn.close()


def preload(model):
    """Keep-loaded mode: load the model at boot instead of on the first request."""
    try:
        model.acquire()
        model.release()
    except RuntimeError as err:
        print(f"report generator: could not preload the model: {err}", flush=True)


def reap_forever(model, idle_seconds, interval=REAP_INTERVAL_SECONDS):
    while True:
        time.sleep(interval)
        if model.stop_if_idle(idle_seconds):
            print(f"report generator: model unloaded after {idle_seconds}s unused", flush=True)


def child_command(argv):
    """llama-server as given, bound to loopback so only this supervisor can reach it."""
    return [*argv, "--host", CHILD_HOST, "--port", str(CHILD_PORT)]


def main(argv):
    if not argv:
        print("usage: supervisor.py /app/llama-server <llama-server arguments>", file=sys.stderr)
        return 2
    idle_seconds = int(os.environ.get("REPORT_GENERATOR_IDLE_SECONDS", "900"))
    model = Model(child_command(argv), ready_timeout=int(os.environ.get("REPORT_GENERATOR_READY_TIMEOUT", "600")))
    server = http.server.ThreadingHTTPServer(
        (LISTEN_HOST, LISTEN_PORT), make_handler(model, os.environ.get("LLAMA_API_KEY", ""), alias_of(argv)))
    server.daemon_threads = True

    def stop(*_):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    if idle_seconds <= 0:
        threading.Thread(target=preload, args=(model,), daemon=True).start()
    else:
        threading.Thread(target=reap_forever, args=(model, idle_seconds), daemon=True).start()
    print(f"report generator: listening on {LISTEN_PORT}; model loads on demand"
          + (f", unloads after {idle_seconds}s unused" if idle_seconds > 0 else ", kept loaded"), flush=True)
    try:
        server.serve_forever()
    finally:
        model.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
