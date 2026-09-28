"""Lazy bounded cursor iteration. Copyright Reacon, Apache-2.0."""
from copy import deepcopy
from .api.leads_api import LeadsApi
from .api.emails_api import EmailsApi
from .sync_helper import run_sync


class ReaconPaginationError(ValueError):
    pass


def bound(value, name):
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 1_000_000:
        raise ValueError(f"{name} must be an integer from 0 to 1000000")
    return value


def cursor_pages(fetch, query, *, max_pages=100, max_items=10000, paid=False, allow_paid_requests=False):
    query = deepcopy(query)

    async def iterate():
        bound(max_pages, "max_pages"); bound(max_items, "max_items")
        if query.get("offset") is not None:
            raise ValueError("Use the one-page method for offset pagination")
        if paid and query.get("only_if_free") != "true" and allow_paid_requests is not True:
            raise ValueError("Set only_if_free='true' or acknowledge allow_paid_requests=True")
        for name in ("limit", "x_lr_limit"):
            value = query.get(name)
            if value is not None and (isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 500):
                raise ValueError("Page size must be an integer from 1 to 500")
        size = min(query.get("limit") or 100, query.get("x_lr_limit") or 500)
        if isinstance(size, bool) or not isinstance(size, int) or not 1 <= size <= 500:
            raise ValueError("Page size must be an integer from 1 to 500")
        cursor = query.get("x_lr_cursor") if query.get("x_lr_cursor") is not None else query.get("cursor")
        seen = set() if cursor is None else {cursor}
        count = 0
        for index in range(max_pages):
            if count >= max_items:
                return
            limit = min(size, max_items - count)
            request = {**query, "limit": limit, "_retry": False}
            if query.get("x_lr_limit") is not None:
                request["x_lr_limit"] = limit
            page = await fetch(**request)
            if not isinstance(page.results, list) or len(page.results) > limit:
                raise ReaconPaginationError("Pagination response exceeds requested item bound")
            next_cursor = page.next_cursor
            if next_cursor is not None and (not isinstance(next_cursor, str) or not next_cursor):
                raise ReaconPaginationError("Invalid pagination cursor")
            count += len(page.results)
            yield page
            if next_cursor is None or count >= max_items or index + 1 >= max_pages:
                return
            if next_cursor in seen:
                raise ReaconPaginationError("Repeated pagination cursor")
            seen.add(next_cursor)
            query["cursor"] = next_cursor
            if query.get("x_lr_cursor") is not None:
                query["x_lr_cursor"] = next_cursor
    return iterate()


async def items(pages):
    try:
        async for page in pages:
            for item in page.results:
                yield item
    finally:
        await pages.aclose()


def sync_iter(iterator):
    # No background producer: each next() requests at most one page. Responses
    # are buffered/closed by HTTPX, so early exit holds no network response open.
    try:
        while True:
            try:
                yield run_sync(iterator.__anext__())
            except StopAsyncIteration:
                return
    finally:
        run_sync(iterator.aclose())


class LeadsClient(LeadsApi):
    def pages(self, *, max_pages=100, max_items=10000, **query):
        return cursor_pages(self.list_leads, query, max_pages=max_pages, max_items=max_items)

    def items(self, **options):
        return items(self.pages(**options))

    def pages_sync(self, **options):
        return sync_iter(self.pages(**options))

    def items_sync(self, **options):
        return sync_iter(self.items(**options))


class EmailsClient(EmailsApi):
    def _cursor_query(self, query, *, mentions=False):
        query = deepcopy(query)
        pool = self.api_client.rest_client.pool_manager
        headers = {k.lower(): v for source in [getattr(pool, "headers", {}), self.api_client.default_headers, query.get("_headers") or {}]
                   for k, v in source.items()}
        for field, name in [("x_lr_cursor", "x-lr-cursor"), ("x_lr_limit", "x-lr-limit")]:
            if query.get(field) is None and name in headers:
                query[field] = int(headers[name]) if field == "x_lr_limit" else headers[name]
        query["_headers"] = {k: v for k, v in (query.get("_headers") or {}).items() if k.lower() not in ("x-lr-cursor", "x-lr-limit")}
        if mentions and query.get("x_lr_limit") is not None:
            query["limit"] = query["x_lr_limit"]
        return query

    def pages(self, *, max_pages=100, max_items=10000, allow_paid_requests=False, **query):
        return cursor_pages(self.list_emails, self._cursor_query(query), max_pages=max_pages,
                            max_items=max_items, paid=True, allow_paid_requests=allow_paid_requests)

    def items(self, **options):
        return items(self.pages(**options))

    def pages_sync(self, **options):
        return sync_iter(self.pages(**options))

    def items_sync(self, **options):
        return sync_iter(self.items(**options))

    def mention_pages(self, *, max_pages=100, max_items=10000, **query):
        return cursor_pages(self.list_email_mentions, self._cursor_query(query, mentions=True),
                            max_pages=max_pages, max_items=max_items)

    def mention_items(self, **options):
        return items(self.mention_pages(**options))

    def mention_pages_sync(self, **options):
        return sync_iter(self.mention_pages(**options))

    def mention_items_sync(self, **options):
        return sync_iter(self.mention_items(**options))
