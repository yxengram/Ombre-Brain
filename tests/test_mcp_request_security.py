"""Protocol-boundary regressions for MCP identity, quotas, and annotations."""

from __future__ import annotations

import asyncio

import pytest

from ombrebrain.security.rate_limit import MCPRateLimiter, Quota
from ombrebrain.security.request_context import (
    MCPRequestContext,
    allow_stdio_media_server_path,
    get_request_context,
    reset_request_context,
    set_request_context,
    stdio_media_import_roots,
)
from ombrebrain.storage.media_store import MediaPersistenceError, MediaStore
from server_app import MCPAuthMiddleware


async def _empty_receive():
    return {"type": "http.request", "body": b"", "more_body": False}


async def _discard_send(_message):
    return None


class _ContextApp:
    def __init__(self):
        self.contexts = []

    async def __call__(self, _scope, _receive, _send):
        self.contexts.append(get_request_context())


def _scope(headers=(), *, client=("2001:db8::1", 4567)):
    return {
        "type": "http",
        "scheme": "https",
        "path": "/mcp",
        "client": client,
        "headers": [(b"host", b"ombre.example"), *headers],
    }


@pytest.mark.asyncio
async def test_authenticated_mcp_context_uses_only_a_token_digest():
    downstream = _ContextApp()
    middleware = MCPAuthMiddleware(
        downstream,
        auth_required=True,
        auth_mode="token",
        token_validator=lambda value, **_kwargs: value == "very-secret-token",
    )

    await middleware(
        _scope([(b"authorization", b"Bearer very-secret-token")]),
        _empty_receive,
        _discard_send,
    )

    [context] = downstream.contexts
    assert context.remote is True
    assert context.transport == "http-authenticated"
    assert context.principal.startswith("token:sha256:")
    assert "very-secret-token" not in context.principal
    assert get_request_context().principal == "local:stdio"


@pytest.mark.asyncio
async def test_open_mcp_context_uses_canonical_peer_address():
    downstream = _ContextApp()
    middleware = MCPAuthMiddleware(
        downstream,
        auth_required=False,
        token_validator=lambda *_args, **_kwargs: False,
    )

    await middleware(_scope(client=("2001:0db8::1", 1)), _empty_receive, _discard_send)

    [context] = downstream.contexts
    assert context.remote is True
    assert context.transport == "http-open"
    assert context.principal == "peer:2001:db8::1"


def test_rate_limiter_is_atomic_and_fail_fast_for_concurrency_and_window():
    now = [10.0]
    limiter = MCPRateLimiter(
        quotas={
            "all": Quota(calls_per_window=2, max_concurrent=1),
            "write": Quota(calls_per_window=1, max_concurrent=1),
            "provider": Quota(calls_per_window=1, max_concurrent=1),
        },
        clock=lambda: now[0],
    )
    assert limiter.try_acquire("token:one", ("write",)) is None
    assert limiter.try_acquire("token:one", ("write",)).error_code == "OB-MCP-BUSY"
    assert limiter.try_acquire("token:two", ("write",)) is None
    limiter.release("token:one", ("write",))
    assert limiter.try_acquire("token:one", ("write",)).error_code == "OB-MCP-RATE-LIMITED"
    # Principal two has independent quota; no cross-tenant serialisation.
    limiter.release("token:two", ("write",))
    now[0] += 61.0
    assert limiter.try_acquire("token:one", ("write",)) is None


def test_rate_limiter_evicts_idle_lru_but_never_exceeds_principal_cap():
    limiter = MCPRateLimiter(max_principals=2)
    assert limiter.try_acquire("token:a", ()) is None
    limiter.release("token:a", ())
    assert limiter.try_acquire("token:b", ()) is None
    # a is inactive and may be evicted to accept c.
    assert limiter.try_acquire("token:c", ()) is None

    saturated = MCPRateLimiter(max_principals=2)
    assert saturated.try_acquire("token:a", ()) is None
    assert saturated.try_acquire("token:b", ()) is None
    rejected = saturated.try_acquire("token:c", ())
    assert rejected is not None and rejected.error_code == "OB-MCP-BUSY"


@pytest.mark.asyncio
async def test_mcp_discovery_advertises_strict_schema_and_safety_hints():
    import server

    tools = {tool.name: tool for tool in await server.mcp.list_tools()}
    assert len(tools) == 15
    assert tools["breath"].inputSchema["additionalProperties"] is False
    assert all(tool.inputSchema.get("additionalProperties") is False for tool in tools.values())
    assert tools["source_read"].annotations.readOnlyHint is True
    assert tools["hold"].annotations.readOnlyHint is False
    assert tools["hold"].annotations.openWorldHint is True
    assert tools["trace"].annotations.destructiveHint is True


@pytest.mark.asyncio
async def test_mcp_rate_rejection_uses_the_existing_versioned_error_envelope(monkeypatch):
    import server

    class Arguments:
        @classmethod
        def model_validate(cls, _arguments):
            return None

    class Metadata:
        arg_model = Arguments

    class Tool:
        fn_metadata = Metadata()

        async def run(self, _arguments):
            return "中文旧文本"

    limiter = MCPRateLimiter(
        quotas={
            "all": Quota(calls_per_window=1, max_concurrent=1),
            "write": Quota(calls_per_window=1, max_concurrent=1),
            "provider": Quota(calls_per_window=1, max_concurrent=1),
        }
    )
    monkeypatch.setattr(server, "DEFAULT_MCP_RATE_LIMITER", limiter)
    monkeypatch.setattr(server.mcp._tool_manager, "get_tool", lambda _name: Tool())
    first = await server._call_tool_with_envelope("pulse", {})
    second = await server._call_tool_with_envelope("pulse", {})
    assert first.structuredContent["ok"] is True
    assert second.isError is True
    assert second.structuredContent["schema_version"] == "ombrebrain.tool-result.v1"
    assert second.structuredContent["error_code"] == "OB-MCP-RATE-LIMITED"


@pytest.mark.asyncio
async def test_rate_limiter_keeps_unrelated_principals_concurrent():
    # This is intentionally a tiny async race regression: rate limiter locking
    # covers bookkeeping only and must never await or serialize tool execution.
    now = [0.0]
    limiter = MCPRateLimiter(
        quotas={
            "all": Quota(calls_per_window=10, max_concurrent=1),
            "write": Quota(calls_per_window=10, max_concurrent=1),
            "provider": Quota(calls_per_window=10, max_concurrent=1),
        },
        clock=lambda: now[0],
    )
    started = asyncio.Event()

    async def run(principal):
        assert limiter.try_acquire(principal, ()) is None
        started.set()
        await asyncio.sleep(0)
        limiter.release(principal, ())

    await asyncio.gather(run("token:a"), run("token:b"))
    assert started.is_set()


@pytest.mark.asyncio
async def test_media_path_policy_tracks_request_context_without_shared_mutation(tmp_path):
    source = tmp_path / "stdio.bin"
    source.write_bytes(b"data")
    store = MediaStore(
        str(tmp_path / "vault"),
        str(tmp_path / "vault" / "_media"),
        allow_server_path=allow_stdio_media_server_path,
        allowed_path_roots=stdio_media_import_roots,
    )
    # The test vault lives under the system temp root, so stdio retains the
    # documented compatibility path while an HTTP request cannot inherit it.
    assert (await store.persist("stdio", str(source)))[0]["stored"] is True
    token = set_request_context(
        MCPRequestContext(principal="token:sha256:test", remote=True, transport="http-authenticated")
    )
    try:
        with pytest.raises(MediaPersistenceError, match="不允许"):
            await store.persist("http", str(source))
    finally:
        reset_request_context(token)
