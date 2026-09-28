"""Maintained JSON/CSV transport policy. Copyright Reacon, Apache-2.0."""
import asyncio
import json
import math
import re
import random
import time
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit
from .retry_policy import AUDITED_READS, RETRYABLE_STATUSES, MAXIMUM_RETRIES
from typing import Any

import httpx


class ReaconRequestTimeoutError(TimeoutError):
    def __init__(self, timeout_seconds: float, phase: str = "total"):
        super().__init__("Reacon request deadline exceeded")
        self.timeout_seconds = timeout_seconds
        self.phase = phase


class ReaconTransportError(Exception):
    def __init__(self, cause: Exception):
        super().__init__("Reacon request transport failed")
        self.cause = cause


class ReaconResponseDecodeError(Exception):
    def __init__(self, response, message: str):
        super().__init__(message)
        self.status = response.status
        self.headers = httpx.Headers(response.headers)
        self.request_id = self.headers.get("x-request-id")
        self.raw_body = response.data
        self.body = response.data.decode("utf-8", errors="replace")
        self.response = response.response


def is_json(content_type: str | None) -> bool:
    return bool(re.match(r"^application/(?:json|[\w!#$&.+\-^_]+\+json)\s*(?:;|$)", content_type or "", re.IGNORECASE))


def parse_error_body(body: str | None, headers) -> Any:
    if body is not None and is_json((headers or {}).get("content-type")):
        try:
            return json.loads(body)
        except (ValueError, TypeError):
            pass
    return body


def error_code(body: Any) -> str | None:
    if not isinstance(body, dict):
        return None
    if isinstance(body.get("code"), str):
        return body["code"]
    nested = body.get("error")
    return nested.get("code") if isinstance(nested, dict) and isinstance(nested.get("code"), str) else None


def positive_seconds(value) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ValueError("Request timeout must be a finite positive number of seconds")
    return float(value)


class ReaconRetryPolicyError(ValueError):
    pass


def retry_options(value):
    if value is None or value is False:
        return {"max_retries": 0, "base_delay": 0.1, "max_delay": 2.0}
    if not isinstance(value, dict) or set(value) - {"max_retries", "base_delay", "max_delay"}:
        raise ReaconRetryPolicyError("Expected retry options or False")
    count = value.get("max_retries", 0)
    if isinstance(count, bool) or not isinstance(count, int) or not 0 <= count <= MAXIMUM_RETRIES:
        raise ReaconRetryPolicyError("max_retries must be an integer from 0 to 3")
    base = positive_seconds(value.get("base_delay", 0.1))
    cap = positive_seconds(value.get("max_delay", 2.0))
    if base > cap or cap > 60:
        raise ReaconRetryPolicyError("Retry delays require base_delay <= max_delay <= 60 seconds")
    return {"max_retries": count, "base_delay": base, "max_delay": cap}


def retry_after_seconds(value):
    if value is None:
        return 0.0
    try:
        if re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", value.strip()):
            return float(value)
        date = parsedate_to_datetime(value)
        if date.tzinfo is None:
            return 0.0
        return max(0.0, date.timestamp() - time.time())
    except (ValueError, TypeError, OverflowError):
        return 0.0


async def request_with_policy(client: httpx.AsyncClient, args: dict, override, default_timeout: float,
                              retry=None, default_retry=None) -> httpx.Response:
    total = positive_seconds(default_timeout)
    if isinstance(override, tuple):
        if len(override) != 2:
            raise ValueError("Timeout tuple must contain connect and read seconds")
        connect, read = map(positive_seconds, override)
        network = httpx.Timeout(total, connect=connect, read=read)
    else:
        total = positive_seconds(override) if override is not None else total
        network = httpx.Timeout(total)
    options = retry_options(default_retry if retry is None else retry)
    audited = args["method"].upper() == "GET" and any(
        re.fullmatch(pattern, urlsplit(str(args["url"])).path) for pattern in AUDITED_READS)
    if not audited:
        if retry is not None and options["max_retries"]:
            raise ReaconRetryPolicyError("This operation is not audited for retries")
        options["max_retries"] = 0
    deadline = time.monotonic() + total

    async def attempts():
        for index in range(options["max_retries"] + 1):
            # Buffered requests include body reads. Lost connections and decode
            # failures never cause another transmission.
            response = await client.request(**{**args, "timeout": network, "follow_redirects": False})
            if response.status_code not in RETRYABLE_STATUSES or index == options["max_retries"]:
                return response
            pause = max(min(options["max_delay"], options["base_delay"] * 2 ** index) * random.uniform(0.5, 1.0),
                        retry_after_seconds(response.headers.get("retry-after")))
            if pause > options["max_delay"] or pause >= deadline - time.monotonic():
                return response
            await response.aclose()
            await asyncio.sleep(pause)
    try:
        return await asyncio.wait_for(attempts(), total)
    except asyncio.CancelledError:
        raise
    except asyncio.TimeoutError as cause:
        raise ReaconRequestTimeoutError(total) from cause
    except httpx.TimeoutException as cause:
        phase = {httpx.ConnectTimeout: "connect", httpx.ReadTimeout: "read", httpx.WriteTimeout: "write", httpx.PoolTimeout: "pool"}.get(type(cause), "total")
        raise ReaconRequestTimeoutError(getattr(network, phase, total), phase) from cause
    except httpx.TransportError as cause:
        raise ReaconTransportError(cause) from cause
