"""Tests for the report generator supervisor.

A fake model server (a few lines of Python) stands in for llama-server, so these run
in about a second, with no model. They pin down what would cost memory or open a
hole if it broke: the model starts once however many requests race for it, it is
never unloaded under a running request, it is unloaded once idle, and a caller
without the API key cannot make it start.

Standard library only — `python3 -m unittest` in the image, or pytest in CI.
"""

import http.client
import json
import os
import socket
import sys
import tempfile
import textwrap
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import supervisor  # noqa: E402

FAKE_SERVER = textwrap.dedent('''
    import http.server, json, os, sys, time
    port = int(sys.argv[1])
    ready_at = time.monotonic() + float(os.environ.get("FAKE_READY_AFTER", "0"))
    never_ready = os.environ.get("FAKE_NEVER_READY") == "1"
    if os.environ.get("FAKE_EXIT_AT_ONCE") == "1":
        sys.exit(3)
    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        def log_message(self, *a): pass
        def _send(self, status, payload):
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("X-Fake", "yes")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        def do_GET(self):
            if self.path == "/health":
                ok = not never_ready and time.monotonic() >= ready_at
                return self._send(200 if ok else 503, {"status": "ok" if ok else "loading"})
            self._echo(b"")
        def do_POST(self):
            n = int(self.headers.get("Content-Length") or 0)
            self._echo(self.rfile.read(n))
        def _echo(self, body):
            if self.path.startswith("/slow"):
                time.sleep(float(self.path.split("=")[1]))
            self._send(200, {"method": self.command, "path": self.path, "body": body.decode(),
                             "auth": self.headers.get("Authorization")})
    class S(http.server.ThreadingHTTPServer):
        def handle_error(self, *a): pass   # health checks close their connections; not an error
    S(("127.0.0.1", port), H).serve_forever()
''')


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class CountingPopen:
    """subprocess.Popen, counting how many model servers were started."""

    def __init__(self):
        self.started = 0
        self.lock = threading.Lock()

    def __call__(self, command):
        with self.lock:
            self.started += 1
        return supervisor.subprocess.Popen(command)


class ModelTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.fake = os.path.join(cls.tmp.name, "fake_server.py")
        with open(cls.fake, "w", encoding="utf-8") as f:
            f.write(FAKE_SERVER)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def setUp(self):
        self.env_backup = dict(os.environ)
        self.models = []

    def tearDown(self):
        for m in self.models:
            m.shutdown()
        os.environ.clear()
        os.environ.update(self.env_backup)

    def make_model(self, clock=time.monotonic, ready_timeout=10, **env):
        os.environ.update(env)
        port = free_port()
        popen = CountingPopen()
        model = supervisor.Model([sys.executable, self.fake, str(port)], ready_timeout=ready_timeout,
                                 port=port, clock=clock, popen=popen)
        model.popen_counter = popen
        self.models.append(model)
        return model


class ModelLifecycleTest(ModelTestCase):
    def test_starts_on_first_use_and_is_ready_afterwards(self):
        model = self.make_model(FAKE_READY_AFTER="0.5")
        self.assertEqual(model.current_state(), "unloaded")
        self.assertFalse(model.alive())

        model.acquire()
        self.assertTrue(model.alive())
        self.assertEqual(model.current_state(), "ready")
        model.release()

    def test_requests_racing_for_an_unloaded_model_start_it_once(self):
        model = self.make_model(FAKE_READY_AFTER="0.5")
        threads = [threading.Thread(target=lambda: (model.acquire(), model.release())) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(model.popen_counter.started, 1)
        self.assertEqual(model.in_flight, 0)

    def test_unloads_only_after_the_idle_time_and_never_under_a_running_request(self):
        clock = FakeClock()
        model = self.make_model(clock=clock)
        model.acquire()                         # a request is in flight
        clock.now += 10_000
        self.assertFalse(model.stop_if_idle(900), "stopped while a request was running")
        self.assertTrue(model.alive())

        model.release()                         # done: the idle time starts now
        clock.now += 899
        self.assertFalse(model.stop_if_idle(900), "stopped before the idle time was up")
        clock.now += 2
        self.assertTrue(model.stop_if_idle(900))
        self.assertFalse(model.alive())
        self.assertEqual(model.current_state(), "unloaded")

    def test_zero_idle_time_keeps_the_model_loaded(self):
        clock = FakeClock()
        model = self.make_model(clock=clock)
        model.acquire()
        model.release()
        clock.now += 10 ** 9
        self.assertFalse(model.stop_if_idle(0))
        self.assertTrue(model.alive())

    def test_loads_again_after_an_unload(self):
        clock = FakeClock()
        model = self.make_model(clock=clock)
        model.acquire()
        model.release()
        clock.now += 1000
        self.assertTrue(model.stop_if_idle(900))
        model.acquire()
        self.assertTrue(model.alive())
        self.assertEqual(model.popen_counter.started, 2)
        model.release()

    def test_a_model_server_that_exits_while_starting_is_reported_and_not_counted(self):
        model = self.make_model(FAKE_EXIT_AT_ONCE="1")
        with self.assertRaisesRegex(RuntimeError, "exited while starting"):
            model.acquire()
        self.assertEqual(model.in_flight, 0)
        self.assertEqual(model.current_state(), "unloaded")

    def test_a_model_server_that_never_becomes_ready_is_stopped(self):
        model = self.make_model(ready_timeout=1, FAKE_NEVER_READY="1")
        with self.assertRaisesRegex(RuntimeError, "did not become ready"):
            model.acquire()
        self.assertFalse(model.alive())
        self.assertEqual(model.in_flight, 0)

    def test_a_crashed_model_server_reads_as_unloaded_and_is_started_again(self):
        model = self.make_model()
        model.acquire()
        model.release()
        model.proc.kill()
        model.proc.wait()
        self.assertEqual(model.current_state(), "unloaded")
        model.acquire()
        self.assertTrue(model.alive())
        self.assertEqual(model.popen_counter.started, 2)
        model.release()


class ProxyTest(ModelTestCase):
    KEY = "s3cret-key"

    def start_proxy(self, api_key=KEY):
        model = self.make_model()
        port = free_port()
        server = supervisor.http.server.ThreadingHTTPServer(
            ("127.0.0.1", port), supervisor.make_handler(model, api_key, "qwen-test"))
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return model, port

    def call(self, port, method, path, body=None, auth=KEY, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
        try:
            h = dict(headers or {})
            if auth:
                h["Authorization"] = f"Bearer {auth}"
            conn.request(method, path, body=body, headers=h)
            resp = conn.getresponse()
            return resp.status, dict(resp.getheaders()), json.loads(resp.read() or b"{}")
        finally:
            conn.close()

    def test_health_answers_without_a_key_and_without_loading_the_model(self):
        model, port = self.start_proxy()
        status, _, body = self.call(port, "GET", "/health", auth=None)
        self.assertEqual((status, body), (200, {"status": "ok", "model": "unloaded"}))
        self.assertEqual(model.popen_counter.started, 0)

    def test_the_model_list_does_not_load_the_model(self):
        model, port = self.start_proxy()
        status, _, body = self.call(port, "GET", "/v1/models")
        self.assertEqual(status, 200)
        self.assertEqual(body["data"][0]["id"], "qwen-test")
        self.assertFalse(body["data"][0]["loaded"])
        self.assertEqual(model.popen_counter.started, 0)

    def test_a_caller_without_the_key_is_refused_and_does_not_start_the_model(self):
        model, port = self.start_proxy()
        for auth in (None, "wrong-key"):
            status, _, _ = self.call(port, "POST", "/v1/chat/completions", body=b"{}", auth=auth)
            self.assertEqual(status, 401)
        status, _, _ = self.call(port, "GET", "/v1/models", auth="wrong-key")
        self.assertEqual(status, 401)
        self.assertEqual(model.popen_counter.started, 0)

    def test_passes_method_path_query_body_and_key_through_unchanged(self):
        model, port = self.start_proxy()
        status, headers, body = self.call(port, "POST", "/slots/0?action=restore",
                                          body=b'{"filename":"prompt.bin"}',
                                          headers={"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        self.assertEqual(body, {"method": "POST", "path": "/slots/0?action=restore",
                                "body": '{"filename":"prompt.bin"}', "auth": f"Bearer {self.KEY}"})
        self.assertEqual(headers.get("X-Fake"), "yes")   # upstream headers are relayed
        self.assertEqual(model.popen_counter.started, 1)
        self.assertEqual(model.in_flight, 0)
        self.assertEqual(self.call(port, "GET", "/v1/models")[2]["data"][0]["loaded"], True)

    def test_a_request_counts_as_in_flight_for_as_long_as_it_runs(self):
        model, port = self.start_proxy()
        self.call(port, "GET", "/props")                 # load it first
        seen = []
        worker = threading.Thread(target=lambda: seen.append(self.call(port, "GET", "/slow?s=1.5")))
        worker.start()
        time.sleep(0.5)
        self.assertEqual(model.in_flight, 1)
        self.assertFalse(model.stop_if_idle(0.001))      # idle time long past, but a request runs
        worker.join()
        self.assertEqual(seen[0][0], 200)
        self.assertEqual(model.in_flight, 0)

    def test_no_key_configured_means_no_key_required(self):
        model, port = self.start_proxy(api_key="")
        status, _, _ = self.call(port, "GET", "/props", auth=None)
        self.assertEqual(status, 200)

    def test_refuses_an_oversized_body_before_loading_the_model(self):
        model, port = self.start_proxy()
        status, _, _ = self.call(port, "POST", "/v1/chat/completions", body=b"x" * (supervisor.MAX_BODY_BYTES + 1))
        self.assertEqual(status, 413)
        self.assertEqual(model.popen_counter.started, 0)


class HelpersTest(unittest.TestCase):
    def test_the_model_server_listens_on_loopback_only(self):
        cmd = supervisor.child_command(["/app/llama-server", "--alias", "m"])
        self.assertEqual(cmd[-4:], ["--host", "127.0.0.1", "--port", "8081"])

    def test_alias_is_read_from_the_command(self):
        self.assertEqual(supervisor.alias_of(["/app/llama-server", "--alias", "qwen3:4b"]), "qwen3:4b")
        self.assertEqual(supervisor.alias_of(["/app/llama-server"]), "model")

    def test_key_check(self):
        self.assertTrue(supervisor.authorised(None, ""))
        self.assertTrue(supervisor.authorised("Bearer k", "k"))
        self.assertFalse(supervisor.authorised("Bearer K", "k"))
        self.assertFalse(supervisor.authorised("k", "k"))
        self.assertFalse(supervisor.authorised(None, "k"))


if __name__ == "__main__":
    unittest.main()
