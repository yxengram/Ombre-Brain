"""The strict-CSP JavaScript assets must ship in the web and Docker surfaces."""

import asyncio
from pathlib import Path
from types import SimpleNamespace

from web import dashboard as dashboard_web


ROOT = Path(__file__).resolve().parents[1]


class _MCP:
    def __init__(self) -> None:
        self.routes = {}

    def custom_route(self, path, methods):
        def decorator(handler):
            for method in methods:
                self.routes[(method, path)] = handler
            return handler

        return decorator


def test_docker_context_includes_all_external_frontend_scripts() -> None:
    dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
    ignored = {
        line.strip()
        for line in (ROOT / ".dockerignore").read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }

    assert "COPY frontend/ ./frontend/" in dockerfile
    assert "frontend/" not in ignored
    assert "frontend/dashboard.js" not in ignored
    assert "frontend/onboarding.js" not in ignored
    assert (ROOT / "frontend" / "dashboard.js").is_file()
    assert (ROOT / "frontend" / "onboarding.js").is_file()


def test_external_scripts_are_available_from_the_static_whitelist(monkeypatch) -> None:
    monkeypatch.setattr(dashboard_web.sh, "repo_root", str(ROOT), raising=False)
    mcp = _MCP()
    dashboard_web.register(mcp)
    handler = mcp.routes[("GET", "/static/{name}")]

    for name in ("dashboard.js", "onboarding.js"):
        response = asyncio.run(handler(SimpleNamespace(path_params={"name": name})))
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/javascript")
        assert response.headers["cache-control"] == "no-cache"
