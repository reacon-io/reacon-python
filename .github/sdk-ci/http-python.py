from pathlib import Path
import sys
_fixture_root = next(p for p in [Path(__file__).resolve().parent, Path(__file__).resolve().parent.parent, Path('/sdk/conformance'), Path('/')] if (p/'fixed-origin'/'httpx_fixture.py').exists())
sys.path.insert(0, str(_fixture_root/'fixed-origin'))
from httpx_fixture import route_api, route_http
"""Fault tests of installed generated methods, using real loopback HTTP sockets."""
import asyncio
import ast
import importlib.metadata
import json
import os
import re
import socket
import select
import subprocess
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
from reacon_sdk import ApiClient, Configuration
from reacon_sdk.api.domains_api import DomainsApi
from reacon_sdk.api.emails_api import EmailsApi
from reacon_sdk.exceptions import ApiException
from reacon_sdk.sync_helper import run_sync
import reacon_sdk

assert Path(reacon_sdk.__file__).resolve().is_relative_to(Path(sys.prefix).resolve()), "SDK must be installed in the isolated consumer environment"

MODE = os.environ.get("REACON_HTTP_PYTHON_MODE", "async")
assert MODE in ("async", "sync")
observations = []
closed_requests = []
stop = threading.Event()
wire = {"generic_emails": 1, "personal_emails": 2, "total": 3}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (ConnectionError, OSError):
            self.close_connection = True

    def reply(self, status=200, body=None, media="application/json", headers=None):
        data = (json.dumps(wire) if body is None else body).encode()
        self.send_response(status)
        self.send_header("content-type", media)
        self.send_header("content-length", str(len(data)))
        self.send_header("x-request-id", "synthetic-request")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/control/closed/"):
            return self.reply(body=json.dumps(closed_requests.count(self.path.split("/")[-1])))
        scenario = self.headers.get("x-test-scenario", "success")
        observations.append({"scenario": scenario, "method": self.command, "path": self.path, "key": self.headers.get("X-API-Key")})
        if self.path == "/redirect-target":
            return self.reply()
        if scenario.startswith("redirect-"):
            return self.reply(int(scenario.split("-")[1]), "{}", headers={"location": "/redirect-target"})
        if scenario == "lost-response":
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            self.close_connection = True
            return
        if scenario in ("hang-headers", "hang-body", "broken-body", "trickle-body"):
            self.close_connection = True
            if scenario != "hang-headers":
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", "4096")
                self.end_headers()
                self.wfile.write(b"{")
                self.wfile.flush()
            if scenario == "broken-body":
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
            elif scenario == "trickle-body":
                for _ in range(30):
                    if stop.wait(0.025):
                        break
                    self.wfile.write(b" ")
                    self.wfile.flush()
            else:
                deadline = time.monotonic() + 2
                while not stop.is_set() and time.monotonic() < deadline:
                    readable, _, _ = select.select([self.connection], [], [], 0.025)
                    if readable and not self.connection.recv(1, socket.MSG_PEEK):
                        closed_requests.append(scenario)
                        break
            return
        if scenario == "error-json":
            return self.reply(402, json.dumps({"code": "insufficient_credits", "credits": {"remaining": 0}}), headers={"x-credits-remaining": "0"})
        if scenario == "error-nested":
            return self.reply(404, json.dumps({"error": {"code": "not_found", "message": "Synthetic missing email"}}))
        if scenario == "error-text":
            return self.reply(503, "Synthetic unavailable", "text/plain", {"retry-after": "1"})
        if scenario == "error-malformed":
            return self.reply(429, "{broken", headers={"retry-after": "1"})
        if scenario == "malformed":
            return self.reply(200, "{broken")
        if scenario == "wrong-mime":
            return self.reply(200, json.dumps(wire), "text/html")
        if scenario == "wrong-schema":
            return self.reply(200, '{"total":"not-a-number"}')
        if scenario == "slow-success":
            stop.wait(0.15)
        return self.reply()

    do_DELETE = do_GET


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
server.daemon_threads = True
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
base = f"http://127.0.0.1:{server.server_port}"


class HttpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.clients = []

    async def asyncTearDown(self):
        for client in self.clients:
            if MODE == "sync":
                await asyncio.to_thread(client.close_sync)
            else:
                await client.close()

    def client(self, scenario="success", timeout=1.0, http_client=None, safe_retries=None):
        result = route_api(ApiClient(Configuration(api_key={"ApiKey": "synthetic-key"}, request_timeout=timeout, safe_retries=safe_retries), http_client=http_client), base)
        result.set_default_header("x-test-scenario", scenario)
        self.clients.append(result)
        return result

    async def invoke(self, api, method="get_domain_counts", **kwargs):
        function = getattr(api, method + ("_sync" if MODE == "sync" else ""))
        return await asyncio.to_thread(function, **kwargs) if MODE == "sync" else await function(**kwargs)

    async def counts(self, client=None, **kwargs):
        return await self.invoke(DomainsApi(client or self.client()), domain="example.invalid", **kwargs)

    async def test_json_auth_and_model(self):
        self.assertEqual((await self.counts()).to_dict(), wire)
        self.assertEqual(observations[-1], {"scenario": "success", "method": "GET", "path": "/v1/domains/example.invalid/counts", "key": "synthetic-key"})

    async def test_default_and_override_deadlines(self):
        with self.assertRaises(reacon_sdk.ReaconRequestTimeoutError):
            await self.counts(self.client("hang-headers", 0.08))
        with self.assertRaises(reacon_sdk.ReaconRequestTimeoutError) as caught:
            await self.counts(self.client("hang-body"), _request_timeout=0.08)
        self.assertEqual(caught.exception.timeout_seconds, 0.08)
        self.assertEqual((await self.counts(self.client("slow-success", 0.05), _request_timeout=0.8)).total, 3)

    async def test_trickle_is_bounded_by_total_not_read_inactivity(self):
        started = time.monotonic()
        with self.assertRaises(reacon_sdk.ReaconRequestTimeoutError) as caught:
            await self.counts(self.client("trickle-body", 0.12))
        self.assertEqual(caught.exception.phase, "total")
        self.assertLess(time.monotonic() - started, 0.8)

    async def test_tuple_keeps_phase_limits_and_configured_total(self):
        with self.assertRaises(reacon_sdk.ReaconRequestTimeoutError) as caught:
            await self.counts(self.client("trickle-body", 0.12), _request_timeout=(0.2, 0.2))
        self.assertEqual(caught.exception.phase, "total")
        with self.assertRaises(reacon_sdk.ReaconRequestTimeoutError) as caught:
            await self.counts(self.client("hang-body", 1.0), _request_timeout=(0.2, 0.05))
        self.assertEqual(caught.exception.phase, "read")
        self.assertEqual(caught.exception.timeout_seconds, 0.05)

    async def test_raw_method_also_finishes_body_under_deadline(self):
        api = DomainsApi(self.client("hang-body", 0.08))
        method = api.get_domain_counts_sync_without_preload_content if MODE == "sync" else api.get_domain_counts_without_preload_content
        with self.assertRaises(reacon_sdk.ReaconRequestTimeoutError):
            if MODE == "sync":
                await asyncio.to_thread(method, domain="example.invalid")
            else:
                await method(domain="example.invalid")

    async def test_http_error_keeps_body_response_and_credit_details(self):
        with self.assertRaises(ApiException) as caught:
            await self.counts(self.client("error-json"))
        error = caught.exception
        self.assertEqual(error.status, 402)
        self.assertEqual(error.code, "insufficient_credits")
        self.assertEqual(error.request_id, "synthetic-request")
        self.assertEqual(error.headers["x-credits-remaining"], "0")
        self.assertEqual(error.parsed_body["credits"]["remaining"], 0)
        self.assertEqual(json.loads(error.body), error.parsed_body)
        self.assertEqual(error.response.json(), error.parsed_body)

    async def test_nested_error(self):
        with self.assertRaises(ApiException) as caught:
            await self.invoke(EmailsApi(self.client("error-nested")), "reveal_email", email="synthetic@example.invalid")
        self.assertEqual(caught.exception.status, 404)
        self.assertEqual(caught.exception.code, "not_found")
        self.assertEqual(caught.exception.parsed_body["error"]["message"], "Synthetic missing email")

    async def test_body_transport_failure(self):
        with self.assertRaises(reacon_sdk.ReaconTransportError):
            await self.counts(self.client("broken-body"))

    async def test_client_reusable_after_deadline(self):
        client = self.client("hang-body", 0.08)
        with self.assertRaises(reacon_sdk.ReaconRequestTimeoutError):
            await self.counts(client)
        client.set_default_header("x-test-scenario", "success")
        self.assertEqual((await self.counts(client)).total, 3)

    async def test_cancellation_closes_pending_requests(self):
        for scenario in ("hang-headers", "hang-body"):
            closed_before = closed_requests.count(scenario)
            if MODE == "async":
                client = self.client(scenario)
                task = asyncio.create_task(self.counts(client))
                await asyncio.sleep(0.07)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                for _ in range(40):
                    if closed_requests.count(scenario) > closed_before:
                        break
                    await asyncio.sleep(0.01)
                self.assertGreater(closed_requests.count(scenario), closed_before)
                client.set_default_header("x-test-scenario", "success")
                self.assertEqual((await self.counts(client)).total, 3)
            else:
                # Real SIGINT in an isolated sync consumer. Never signals the test runner.
                code = '''import os,signal,threading,json,time,urllib.request
from reacon_sdk import ApiClient,Configuration
from reacon_sdk.api.domains_api import DomainsApi
from httpx_fixture import route_api
client=route_api(ApiClient(Configuration(request_timeout=3.0)), os.environ['TEST_URL'])
client.set_default_header('x-test-scenario',os.environ['TEST_SCENARIO'])
timer=threading.Timer(0.15,lambda:os.kill(os.getpid(),signal.SIGINT));timer.start()
try:
 try: DomainsApi(client).get_domain_counts_sync('example.invalid')
 except KeyboardInterrupt: pass
 else: raise AssertionError('Request was not interrupted')
 for _ in range(50):
  with urllib.request.urlopen(os.environ['TEST_URL']+'/control/closed/'+os.environ['TEST_SCENARIO']) as response:
   closed=json.load(response)
  if closed>int(os.environ['TEST_CLOSED_BEFORE']): break
  time.sleep(0.01)
 else: raise AssertionError('Interrupted request connection remained open')
 client.set_default_header('x-test-scenario','success')
 assert DomainsApi(client).get_domain_counts_sync('example.invalid').total==3
finally:
 timer.cancel();client.close_sync()
'''
                result = await asyncio.to_thread(subprocess.run, [sys.executable, "-c", code], env={**os.environ, "PYTHONPATH": str(_fixture_root/'fixed-origin'), "TEST_URL": base, "TEST_SCENARIO": scenario, "TEST_CLOSED_BEFORE": str(closed_before)}, capture_output=True, text=True, timeout=8)
                self.assertEqual(result.returncode, 0, result.stderr)

    async def test_cancel_before_dispatch_or_sync_loop_guard(self):
        if MODE == "async":
            before = len(observations)
            task = asyncio.create_task(self.counts())
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertEqual(len(observations), before)
        else:
            with self.assertRaisesRegex(RuntimeError, "async SDK methods"):
                DomainsApi(self.client()).get_domain_counts_sync("example.invalid")

    async def test_borrowed_pool_is_not_closed_and_cannot_enable_redirects(self):
        borrowed = httpx.AsyncClient(follow_redirects=True)
        try:
            client = self.client("redirect-302", http_client=borrowed)
            with self.assertRaises(ApiException) as caught:
                await self.counts(client)
            self.assertEqual(caught.exception.status, 302)
            if MODE == "sync":
                await asyncio.to_thread(client.close_sync)
            else:
                await client.close()
            self.assertFalse(borrowed.is_closed)
        finally:
            if MODE == "sync":
                await asyncio.to_thread(run_sync, borrowed.aclose())
            else:
                await borrowed.aclose()

    async def test_service_origin_is_readonly_and_has_no_constructor_override(self):
        with self.assertRaises(TypeError):
            Configuration(host="https://other.invalid")
        config = Configuration()
        self.assertEqual(config.host, "https://api.reacon.io")
        with self.assertRaises(AttributeError):
            config.host = "https://other.invalid"
        with self.assertRaises(TypeError):
            reacon_sdk.AsyncReacon("synthetic", base_url="https://other.invalid")

    async def test_configuration_rejects_invalid_deadlines_and_unsafe_retry_setting(self):
        for value in (0, -1, float("inf"), float("nan"), True):
            with self.assertRaises(ValueError):
                ApiClient(Configuration(request_timeout=value))
        with self.assertRaisesRegex(ValueError, "retries"):
            ApiClient(Configuration(retries=1))

    async def test_packaged_readme_examples(self):
        description = importlib.metadata.metadata("reacon-sdk").get_payload()
        examples = re.findall(r"```python\n([\s\S]*?)\n```", description)
        self.assertTrue(examples)
        for example in examples:
            ast.parse(example)

    async def test_async_facade_shares_the_json_deadline(self):
        # This async-only facade is tested in both package installation variants.
        async with route_http(httpx.AsyncClient(), base) as http, reacon_sdk.AsyncReacon("synthetic-key", http_client=http, request_timeout=0.08) as facade:
            with self.assertRaises(reacon_sdk.ReaconRequestTimeoutError):
                await facade.domains.get_domain_counts("example.invalid", _headers={"x-test-scenario": "trickle-body"})
            self.assertEqual((await facade.domains.get_domain_counts("example.invalid")).total, 3)

    async def test_owned_pool_closes(self):
        client = self.client()
        await self.counts(client)
        pool = client.rest_client.pool_manager
        if MODE == "sync":
            await asyncio.to_thread(client.close_sync)
        else:
            await client.close()
        self.assertTrue(pool.is_closed)

    async def test_deadline_includes_waiting_for_pool_slot(self):
        configuration = Configuration(connection_pool_maxsize=1, request_timeout=1.0)
        client = route_api(ApiClient(configuration), base)
        self.clients.append(client)
        client.set_default_header("x-test-scenario", "hang-headers")
        before = len(observations)
        first = asyncio.create_task(self.counts(client, _request_timeout=0.4))
        try:
            for _ in range(30):
                if len(observations) > before:
                    break
                await asyncio.sleep(0.01)
            self.assertEqual(len(observations), before + 1)
            with self.assertRaises(reacon_sdk.ReaconRequestTimeoutError):
                await self.counts(client, _request_timeout=0.05)
            self.assertEqual(len(observations), before + 1)
        finally:
            with self.assertRaises(reacon_sdk.ReaconRequestTimeoutError):
                await first


    async def test_opt_in_retry_bounds_and_override(self):
        for status in (429, 502, 503, 504):
            calls = []
            def respond(request):
                calls.append(request)
                return httpx.Response(status if len(calls) < 3 else 200, json=wire)
            async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as transport:
                client = self.client(http_client=transport, safe_retries={"max_retries": 2, "base_delay": 0.001})
                self.assertEqual((await self.counts(client)).total, 3)
                self.assertEqual(len(calls), 3)
                calls.clear()
                with self.assertRaises(ApiException):
                    await self.counts(client, _retry=False)
                self.assertEqual(len(calls), 1)

    async def test_no_retries_for_unaudited_routes_or_lost_response(self):
        calls = []
        def respond(request):
            calls.append(request)
            if request.url.path.endswith('/counts'):
                raise httpx.ReadError('response lost', request=request)
            return httpx.Response(503, json={"code": "unavailable"})
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as transport:
            client = self.client(http_client=transport, safe_retries={"max_retries": 3})
            for method in ('reveal_email', 'delete_email'):
                before = len(calls)
                with self.assertRaises(ApiException):
                    await self.invoke(EmailsApi(client), method, email='fixture@example.invalid')
                self.assertEqual(len(calls), before + 1)
                with self.assertRaises(reacon_sdk.ReaconRetryPolicyError):
                    await self.invoke(EmailsApi(client), method, email='fixture@example.invalid', _retry={"max_retries": 1})
                self.assertEqual(len(calls), before + 1)
            before = len(calls)
            with self.assertRaises(reacon_sdk.ReaconTransportError):
                await self.counts(client)
            self.assertEqual(len(calls), before + 1)

    async def test_retry_after_respects_delay_cap_and_total_deadline(self):
        from email.utils import formatdate
        for value in ('20', formatdate(time.time() + 20, usegmt=True)):
            calls = []
            def respond(request):
                calls.append(request)
                return httpx.Response(429, json={"code": "rate_limited"}, headers={'retry-after': value})
            async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as transport:
                client = self.client(http_client=transport)
                with self.assertRaises(ApiException) as caught:
                    await self.counts(client, _retry={"max_retries": 2}, _request_timeout=0.1)
                self.assertEqual(caught.exception.status, 429)
                self.assertEqual(len(calls), 1)

    async def test_retry_cancellation_during_backoff(self):
        calls = []
        def respond(request):
            calls.append(request)
            return httpx.Response(503, json={}, headers={'retry-after': '1'})
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as transport:
            client = self.client(http_client=transport, timeout=3.0)
            if MODE == 'sync':
                # Run cancellation on the very loop that owns sync requests.
                async def scenario():
                    task = asyncio.create_task(DomainsApi(client).get_domain_counts('example.invalid', _retry={"max_retries": 2}))
                    await asyncio.sleep(0.05); task.cancel()
                    with self.assertRaises(asyncio.CancelledError): await task
                await asyncio.to_thread(run_sync, scenario())
            else:
                task = asyncio.create_task(self.counts(client, _retry={"max_retries": 2}))
                await asyncio.sleep(0.05); task.cancel()
                with self.assertRaises(asyncio.CancelledError): await task
            self.assertEqual(len(calls), 1)

    async def test_invalid_retry_settings_make_no_request(self):
        before = len(observations)
        for settings in (True, {"max_retries": 4}, {"max_retries": -1}, {"max_retries": True}, {"base_delay": 3, "max_delay": 1}, {"max_delay": 61}):
            with self.assertRaises(ValueError):
                await self.counts(_retry=settings)
        self.assertEqual(len(observations), before)

    def page_fixture(self, pages, *, headers=None, safe_retries=None):
        calls = []
        def respond(request):
            calls.append(request)
            self.assertEqual(request.headers['x-api-key'], 'synthetic-key')
            response = pages[len(calls) - 1]
            return response if isinstance(response, httpx.Response) else httpx.Response(200, json=response)
        transport = httpx.AsyncClient(transport=httpx.MockTransport(respond), headers=headers)
        client = self.client(http_client=transport, safe_retries=safe_retries)
        return client, transport, calls

    @staticmethod
    def page(ids=(), cursor=None):
        return {"results": [{"id": item, "email": item+'@example.invalid', "team_id": "team", "created_at": "2026-01-01", "updated_at": "2026-01-01", "created_by": None} for item in ids], "nextCursor": cursor, "totalCount": len(ids), "groupTotals": None}

    async def take(self, resource, kind, options, limit=None):
        if MODE == 'sync':
            def consume():
                iterator = getattr(resource, kind+'_sync')(**options)
                result = []
                try:
                    for item in iterator:
                        result.append(item)
                        if limit is not None and len(result) >= limit: break
                finally: iterator.close()
                return result
            return await asyncio.to_thread(consume)
        iterator = getattr(resource, kind)(**options)
        result = []
        try:
            async for item in iterator:
                result.append(item)
                if limit is not None and len(result) >= limit: break
        finally: await iterator.aclose()
        return result

    async def test_pagination_lazy_stop_preserves_filters(self):
        client, transport, calls = self.page_fixture([self.page(['one', 'two'], 'next')])
        async with transport:
            resource = reacon_sdk.LeadsClient(client)
            iterator = resource.pages(team_id='team')
            self.assertEqual(calls, [])
            await iterator.aclose()
            result = await self.take(resource, 'items', {'team_id':'team', 'limit':2, 'search':'fixture', 'sort':'name', 'order':'desc', 'filters':'{}'}, limit=1)
            self.assertEqual([x.id for x in result], ['one'])
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0].url.params['search'], 'fixture')
            self.assertEqual(calls[0].url.params['filters'], '{}')

    async def test_pagination_caps_each_request_and_continues_empty_pages(self):
        client, transport, calls = self.page_fixture([self.page([], 'a'), self.page(['one','two'], 'b'), self.page(['three'], 'unused')])
        async with transport:
            result = await self.take(reacon_sdk.LeadsClient(client), 'items', {'team_id':'team', 'limit':2, 'max_items':3})
            self.assertEqual([x.id for x in result], ['one','two','three'])
            self.assertEqual([r.url.params['limit'] for r in calls], ['2','2','1'])
            self.assertEqual(calls[-1].url.params['cursor'], 'b')

    async def test_pagination_bounds_cycles_and_invalid_parameters(self):
        client, transport, calls = self.page_fixture([self.page([], 'a'), self.page([], 'a')])
        async with transport:
            resource = reacon_sdk.LeadsClient(client)
            for options in ({'max_items':0}, {'max_pages':0}):
                self.assertEqual(await self.take(resource,'pages',{'team_id':'team',**options}), [])
            for options in ({'offset':0}, {'max_pages':-1}, {'max_items':True}, {'limit':0}):
                with self.assertRaises(ValueError): await self.take(resource,'pages',{'team_id':'team',**options})
            self.assertEqual(len(calls), 0)
            with self.assertRaises(reacon_sdk.ReaconPaginationError): await self.take(resource,'pages',{'team_id':'team'})
            self.assertEqual(len(calls), 2)

    async def test_pagination_rejects_oversized_response_and_never_retries(self):
        client, transport, calls = self.page_fixture([self.page(['one','two'])])
        async with transport:
            with self.assertRaises(reacon_sdk.ReaconPaginationError):
                await self.take(reacon_sdk.LeadsClient(client),'pages',{'team_id':'team','max_items':1})
        client, transport, calls = self.page_fixture([httpx.Response(503,json={})], safe_retries={'max_retries':3})
        async with transport:
            with self.assertRaises(ApiException): await self.take(reacon_sdk.LeadsClient(client),'pages',{'team_id':'team'})
            self.assertEqual(len(calls), 1)

    async def test_email_pagination_requires_consent_and_updates_header_cursor(self):
        client, transport, calls = self.page_fixture([{'results':[], 'nextCursor':'new'}, {'results':[], 'nextCursor':None}], headers={'x-lr-cursor':'start','x-lr-limit':'4'})
        client.set_default_header('X-LR-Cursor', 'client-start')
        async with transport:
            resource = reacon_sdk.EmailsClient(client)
            with self.assertRaises(ValueError): await self.take(resource,'pages',{'domain':'example.invalid'})
            self.assertEqual(len(calls), 0)
            await self.take(resource,'pages',{'domain':'example.invalid','only_if_free':'true', 'limit':2})
            self.assertEqual([r.headers['x-lr-cursor'] for r in calls], ['client-start','new'])
            self.assertEqual([r.headers['x-lr-limit'] for r in calls], ['2','2'])
            self.assertTrue(all(r.url.params['onlyIfFree']=='true' for r in calls))



def redirect_case(status):
    async def check(self):
        before = len(observations)
        with self.assertRaises(ApiException) as caught:
            await self.counts(self.client(f"redirect-{status}"))
        self.assertEqual(caught.exception.status, status)
        self.assertEqual(caught.exception.headers["location"], "/redirect-target")
        self.assertEqual(len(observations) - before, 1)
        self.assertFalse(any(item["path"] == "/redirect-target" for item in observations))
    return check


def error_case(scenario, body):
    async def check(self):
        before = len(observations)
        with self.assertRaises(ApiException) as caught:
            await self.counts(self.client(scenario))
        self.assertEqual(caught.exception.body, body)
        self.assertEqual(caught.exception.parsed_body, body)
        self.assertEqual(caught.exception.response.text, body)
        self.assertEqual(caught.exception.headers["retry-after"], "1")
        self.assertEqual(len(observations) - before, 1)
    return check


def decode_case(scenario):
    async def check(self):
        with self.assertRaises(reacon_sdk.ReaconResponseDecodeError) as caught:
            await self.counts(self.client(scenario))
        self.assertEqual(caught.exception.status, 200)
        self.assertEqual(caught.exception.request_id, "synthetic-request")
        self.assertIsInstance(caught.exception.body, str)
    return check


def lost_case(method):
    async def check(self):
        client = self.client()
        await self.counts(client)  # Warm the same pool before an interrupted request.
        client.set_default_header("x-test-scenario", "lost-response")
        before = len(observations)
        with self.assertRaises(reacon_sdk.ReaconTransportError):
            await self.invoke(EmailsApi(client), method, email="synthetic@example.invalid")
        await asyncio.sleep(0.05)
        self.assertEqual(len(observations) - before, 1)
        self.assertEqual(observations[-1]["method"], "GET" if method == "reveal_email" else "DELETE")
    return check


for status in (301, 302, 303, 307, 308):
    setattr(HttpTests, f"test_redirect_{status}", redirect_case(status))
for scenario, body in (("error-text", "Synthetic unavailable"), ("error-malformed", "{broken")):
    setattr(HttpTests, f"test_{scenario.replace('-', '_')}", error_case(scenario, body))
for scenario in ("malformed", "wrong-mime", "wrong-schema"):
    setattr(HttpTests, f"test_decode_{scenario.replace('-', '_')}", decode_case(scenario))
for method in ("reveal_email", "delete_email"):
    setattr(HttpTests, f"test_lost_response_{method}", lost_case(method))

try:
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(HttpTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    report = {"mode": MODE, "tests": result.testsRun, "failures": len(result.failures), "errors": len(result.errors), "skipped": len(result.skipped), "passed": result.wasSuccessful(), "requests": len(observations), "python": sys.version.split()[0], "dependencies": {name: importlib.metadata.version(name) for name in ("reacon-sdk", "httpx", "httpcore", "anyio", "pydantic")}}
    if os.environ.get("REACON_HTTP_RESULTS"):
        with open(os.environ["REACON_HTTP_RESULTS"], "w") as file:
            json.dump(report, file, indent=2)
    print(json.dumps(report))
finally:
    stop.set()
    server.shutdown()
    server.server_close()
sys.exit(0 if result.wasSuccessful() else 1)
