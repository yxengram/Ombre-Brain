"""Provider failures must not reflect credentials or upstream response bodies."""

from __future__ import annotations

import json

import httpx
import pytest

from web import config_api


class _MCP:
    def __init__(self) -> None:
        self.routes = {}

    def custom_route(self, path, methods):
        def decorator(handler):
            for method in methods:
                self.routes[(method, path)] = handler
            return handler

        return decorator


class _Request:
    def __init__(self, body: dict | None = None) -> None:
        self._body = body or {}

    async def json(self):
        return self._body


@pytest.mark.asyncio
async def test_dehydration_probe_does_not_reflect_provider_echo(monkeypatch: pytest.MonkeyPatch) -> None:
    secret = "provider-reflected-secret"

    class Response:
        status_code = 401
        text = f"upstream echoed Authorization: Bearer {secret}"

    class Client:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        async def post(self, *_args, **_kwargs):
            return Response()

    monkeypatch.setattr(config_api.sh, "_require_auth", lambda _request: None)
    monkeypatch.setattr(config_api.sh, "config", {
        "dehydration": {
            "model": "safe-test-model",
            "base_url": "https://provider.example/v1",
            "api_key": "local-test-key",
        }
    })
    monkeypatch.setattr(httpx, "AsyncClient", Client)
    mcp = _MCP()
    config_api.register(mcp)

    response = await mcp.routes[("POST", "/api/test/dehydration")](_Request())
    body = json.loads(response.body)

    assert body["ok"] is False
    assert body["error_code"] == "OB-PROVIDER-REJECTED"
    assert secret not in response.body.decode()
    assert "Authorization" not in response.body.decode()


@pytest.mark.asyncio
async def test_model_catalog_does_not_reflect_connection_exception(monkeypatch: pytest.MonkeyPatch) -> None:
    secret = "exception-contained-provider-key"

    class Client:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        async def get(self, *_args, **_kwargs):
            raise RuntimeError(f"provider said bearer {secret}")

    monkeypatch.setattr(config_api.sh, "_require_auth", lambda _request: None)
    monkeypatch.setattr(httpx, "AsyncClient", Client)
    mcp = _MCP()
    config_api.register(mcp)

    response = await mcp.routes[("POST", "/api/models")](
        _Request({
            "api_key": "local-test-key",
            "api_format": "openai_compat",
            "base_url": "https://provider.example/v1",
        })
    )
    body = json.loads(response.body)

    assert body["ok"] is False
    assert body["error_code"] == "OB-MODEL-CATALOG-FAILED"
    assert secret not in response.body.decode()
