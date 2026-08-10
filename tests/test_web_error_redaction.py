"""Authenticated web routes must not reflect provider, token or path errors."""

from __future__ import annotations

import ast
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

import web.plans as plans


_ROOT = Path(__file__).resolve().parents[1]
_ROUTE_MODULES = (
    "meta.py",
    "github.py",
    "search.py",
    "plans.py",
    "letters.py",
    "buckets.py",
    "import_api.py",
    "tunnel.py",
    "config_api.py",
)


class _FakeMCP:
    def __init__(self) -> None:
        self.routes: dict[tuple[str, str], Callable[..., Any]] = {}

    def custom_route(self, path: str, methods: list[str]) -> Callable[[Any], Any]:
        def decorator(handler: Any) -> Any:
            for method in methods:
                self.routes[(method, path)] = handler
            return handler

        return decorator


class _Request:
    query_params: dict[str, str] = {}
    path_params: dict[str, str] = {}


class _ExplodingManager:
    async def list_all(self, **_kwargs: Any) -> list[dict[str, Any]]:
        raise RuntimeError("Authorization: Bearer reflected-api-key /private/vault/secret.md")


def _contains_exception_value(node: ast.AST) -> bool:
    for child in ast.walk(node):
        if isinstance(child, ast.Call) and isinstance(child.func, ast.Name) and child.func.id in {"str", "repr"}:
            if child.args and isinstance(child.args[0], ast.Name) and child.args[0].id in {"e", "exc", "error"}:
                return True
        if isinstance(child, ast.FormattedValue) and isinstance(child.value, ast.Name):
            if child.value.id in {"e", "exc", "error"}:
                return True
    return False


def test_500_json_responses_do_not_reflect_exception_values() -> None:
    for module in _ROUTE_MODULES:
        tree = ast.parse((_ROOT / "src" / "web" / module).read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
                continue
            if node.func.id != "JSONResponse":
                continue
            status = next((item.value for item in node.keywords if item.arg == "status_code"), None)
            if not isinstance(status, ast.Constant) or status.value != 500 or not node.args:
                continue
            assert not _contains_exception_value(node.args[0]), module


@pytest.mark.asyncio
async def test_authenticated_route_redacts_reflected_token_and_absolute_path(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(plans.sh, "_require_auth", lambda _request: None)
    monkeypatch.setattr(plans.sh, "bucket_mgr", _ExplodingManager())
    mcp = _FakeMCP()
    plans.register(mcp)

    response = await mcp.routes[("GET", "/api/plans")](_Request())
    payload = json.loads(response.body)

    assert response.status_code == 500
    assert payload["error_code"] == "OB-WEB-INTERNAL"
    assert "reflected-api-key" not in response.body.decode("utf-8")
    assert "/private/vault" not in response.body.decode("utf-8")
    assert "reflected-api-key" not in caplog.text
    assert "exception_type=RuntimeError" in caplog.text
