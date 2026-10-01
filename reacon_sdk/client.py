"""Reacon's maintained async client and explicit, non-reconnecting verification stream."""
from __future__ import annotations
import asyncio
import json
import math
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, AsyncIterator, Literal
import httpx
from httpx_sse import aconnect_sse
from pydantic import ValidationError
from .api_client import ApiClient
from .configuration import Configuration
from .api.domains_api import DomainsApi
from .api.emails_api import EmailsApi
from .api.leads_api import LeadsApi
from .pagination import LeadsClient, EmailsClient
from .api.verification_api import VerificationApi
from .models.verification_stage import VerificationStage
from .models.verification_progress import VerificationProgress
from .models.verification_final import VerificationFinal
from .models.verification_stream_error import VerificationStreamError


class ReaconProtocolError(Exception):
    """A successful response did not follow the verification stream contract."""


class ReaconTimeoutError(TimeoutError):
    def __init__(self, phase: Literal['idle', 'total']):
        self.phase = phase
        super().__init__(f'Reacon {phase} timeout')


class ReaconStreamApiError(Exception):
    def __init__(self, status: int, headers: httpx.Headers, body: Any, event: VerificationStreamError | None = None):
        self.status, self.headers, self.body, self.event = status, headers, body, event
        self.request_id = headers.get('x-request-id')
        super().__init__(f'Reacon stream failed: {event.code}' if event else f'Reacon returned HTTP {status}')


@dataclass(frozen=True)
class VerificationEvent:
    type: Literal['stage', 'progress', 'final', 'unknown']
    data: VerificationStage | VerificationProgress | VerificationFinal | dict[str, Any]
    raw: dict[str, Any]


def _positive(value: float, name: str) -> float:
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f'{name} must be positive and finite')
    return value


class AsyncReacon:
    """Each instance owns credentials. An injected HTTPX client stays caller-owned.

    JSON methods use generated resource clients. Streaming uses the same HTTPX
    pool, TLS configuration and connection limits without response buffering.
    """
    def __init__(self, api_key: str, *, http_client: httpx.AsyncClient | None = None, request_timeout: float = 30.0, safe_retries=None):
        if not api_key:
            raise ValueError('api_key is required')
        from .http_policy import positive_seconds
        request_timeout = positive_seconds(request_timeout)
        self._key = api_key
        self._base_url = 'https://api.reacon.io'
        self._owned = http_client is None
        self._http = http_client or httpx.AsyncClient(follow_redirects=False)
        self._generated = ApiClient(Configuration(api_key={'ApiKey': api_key}, request_timeout=request_timeout, safe_retries=safe_retries), http_client=self._http)
        self.domains = DomainsApi(self._generated)
        self.emails = EmailsClient(self._generated)
        self.leads = LeadsClient(self._generated)
        self.verification = VerificationApi(self._generated)

    async def __aenter__(self) -> AsyncReacon:
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owned:
            await self._http.aclose()

    @asynccontextmanager
    async def stream_verification(self, email: str, *, cache_max_age: str | None = None, only_if_free: str | None = None,
                                  total_timeout: float = 300.0, idle_timeout: float = 30.0) -> AsyncIterator[AsyncIterator[VerificationEvent]]:
        """Use ``async with`` for deterministic early close, then ``async for``.

        Timeouts are seconds. The total deadline starts on context entry and is
        checked on each read (including time spent by the consumer). HTTPX's
        idle timeout bounds network reads. Task cancellation closes the stream.
        No automatic retry or reconnection is performed.
        """
        _positive(total_timeout, 'total_timeout'); _positive(idle_timeout, 'idle_timeout')
        if not email:
            raise ValueError('email is required')
        if cache_max_age not in (None, 'live', '1d', '1w', '1m') or only_if_free not in (None, 'true', 'false'):
            raise ValueError('Invalid verification option')
        deadline = time.monotonic() + total_timeout
        async def bounded(awaitable):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                if hasattr(awaitable, 'close'): awaitable.close()
                raise ReaconTimeoutError('total')
            try:
                return await asyncio.wait_for(awaitable, remaining)
            except asyncio.TimeoutError as error:
                raise ReaconTimeoutError('total') from error
            except httpx.ReadTimeout as error:
                raise ReaconTimeoutError('idle') from error

        params = {'email': email}
        if cache_max_age is not None: params['cacheMaxAge'] = cache_max_age
        if only_if_free is not None: params['onlyIfFree'] = only_if_free
        manager = aconnect_sse(self._http, 'GET', self._base_url + '/v1/verify', params=params,
                              headers={'X-API-Key': self._key}, follow_redirects=False,
                              timeout=httpx.Timeout(idle_timeout, connect=min(idle_timeout, total_timeout)))
        source = await bounded(manager.__aenter__())
        response = source.response
        async def events() -> AsyncIterator[VerificationEvent]:
            if not response.is_success:
                body = bytearray()
                chunks = response.aiter_bytes()
                while len(body) < 65536:
                    try: chunk = await bounded(chunks.__anext__())
                    except StopAsyncIteration: break
                    body.extend(chunk[:65536 - len(body)])
                text = body.decode('utf-8', errors='replace')
                try: parsed = json.loads(text)
                except ValueError: parsed = text
                raise ReaconStreamApiError(response.status_code, response.headers, parsed)
            if response.headers.get('content-type', '').split(';')[0].strip().lower() != 'text/event-stream':
                raise ReaconProtocolError('Expected a text/event-stream response body')
            iterator = source.aiter_sse()
            while True:
                try: event = await bounded(iterator.__anext__())
                except StopAsyncIteration:
                    raise ReaconProtocolError('Verification stream ended before a terminal event') from None
                try: raw = json.loads(event.data)
                except ValueError: raise ReaconProtocolError('Malformed SSE JSON payload') from None
                if not isinstance(raw, dict): raise ReaconProtocolError('Expected an SSE JSON object')
                try:
                    if 'error' in raw:
                        error = VerificationStreamError.from_dict(raw)
                        raise ReaconStreamApiError(response.status_code, response.headers, raw, error)
                    if 'result' in raw:
                        value = VerificationFinal.from_dict(raw)
                        # Close before yielding final, even if the consumer never reads again.
                        await response.aclose()
                        yield VerificationEvent('final', value, raw)
                        return
                    if 'stage' in raw:
                        yield VerificationEvent('stage', VerificationStage.from_dict(raw), raw)
                    elif 'state' in raw:
                        yield VerificationEvent('progress', VerificationProgress.from_dict(raw), raw)
                    else:
                        yield VerificationEvent('unknown', raw, raw)
                except ValidationError:
                    raise ReaconProtocolError('Malformed verification event') from None
        iterator = events()
        try:
            yield iterator
        finally:
            try:
                await iterator.aclose()
            finally:
                await manager.__aexit__(None, None, None)
