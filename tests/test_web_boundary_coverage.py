"""Focused safety and state-boundary regressions for dashboard routes."""

from __future__ import annotations

import asyncio
import json
import time
from types import SimpleNamespace

import pytest

from server_app import MCPAuthMiddleware
from web import letters, ollama_local, oauth, plans, search


class FakeMCP:
    def __init__(self):
        self.routes = {}

    def custom_route(self, path, methods):
        def decorator(handler):
            for method in methods:
                self.routes[(method, path)] = handler
            return handler

        return decorator


class FakeRequest:
    def __init__(self, body=None, *, query=None, path_params=None):
        self._body = {} if body is None else body
        self.query_params = query or {}
        self.path_params = path_params or {}
        self.headers = {"content-type": "application/json"}

    async def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


class OAuthRequest(FakeRequest):
    def __init__(self, body=None, *, method="POST", **kwargs):
        super().__init__(body, **kwargs)
        self.method = method
        self.headers = {"content-type": "application/json", "host": "ombre.example"}
        self.url = SimpleNamespace(scheme="https", netloc="ombre.example")
        self.client = SimpleNamespace(host="127.0.0.1")

    async def form(self):
        return self._body


def payload(response):
    return json.loads(response.body)


class RecordingBuckets:
    def __init__(self, buckets=()):
        self.buckets = {bucket["id"]: bucket for bucket in buckets}
        self.created = []
        self.updated = []
        self.deleted = []
        self.embedding_outbox = SimpleNamespace(discard=lambda bucket_id: self.deleted.append(("outbox", bucket_id)))
        self.w_topic = self.w_emotion = self.w_time = self.w_importance = 1.0
        self.fuzzy_threshold = 40

    async def list_all(self, **_kwargs):
        return list(self.buckets.values())

    async def get(self, bucket_id):
        return self.buckets.get(bucket_id)

    async def create(self, **kwargs):
        self.created.append(kwargs)
        return "letter-1"

    async def update(self, bucket_id, **updates):
        self.updated.append((bucket_id, updates))
        return True

    async def delete(self, bucket_id):
        self.deleted.append(bucket_id)
        return True

    def _invalidate_bm25(self):
        self.deleted.append("bm25")

    async def search(self, _query, **_kwargs):
        return list(self.buckets.values())

    def _calc_topic_score(self, _query, _bucket):
        return 0.5

    def _calc_emotion_score(self, _valence, _arousal, _metadata):
        return 0.5

    def _calc_time_score(self, _metadata):
        return 0.5


def register_routes(module):
    mcp = FakeMCP()
    module.register(mcp)
    return mcp.routes


@pytest.mark.asyncio
async def test_letter_create_normalizes_ai_and_persists_optional_metadata(monkeypatch):
    buckets = RecordingBuckets()
    monkeypatch.setattr(letters.sh, "_require_auth", lambda _request: None)
    monkeypatch.setattr(letters.sh, "bucket_mgr", buckets)
    monkeypatch.setattr(letters, "get_ai_name", lambda: "Ombre")
    routes = register_routes(letters)

    response = await routes[("POST", "/api/letter")](
        FakeRequest(
            {
                "author": "claude", "content": "[[safe]] content", "title": "A title",
                "date": "2026-08-09", "user_name": "Thomas",
            }
        )
    )

    assert response.status_code == 200
    assert buckets.created[0]["bucket_type"] == "letter"
    assert buckets.created[0]["name"] == "A title"
    assert buckets.updated == [("letter-1", {"author": "Ombre", "user_name": "Thomas", "title": "A title", "letter_date": "2026-08-09"})]


@pytest.mark.asyncio
async def test_letter_edit_rejects_non_string_before_mutating_and_delete_is_idempotent(monkeypatch):
    letter = {"id": "letter-1", "content": "old", "metadata": {"type": "letter"}}
    buckets = RecordingBuckets([letter])
    invalidated = []
    deleted_embeddings = []
    monkeypatch.setattr(letters.sh, "_require_auth", lambda _request: None)
    monkeypatch.setattr(letters.sh, "bucket_mgr", buckets)
    monkeypatch.setattr(letters.sh, "dehydrator", SimpleNamespace(invalidate_cache=invalidated.append))
    monkeypatch.setattr(letters.sh, "embedding_engine", SimpleNamespace(delete_embedding=deleted_embeddings.append))
    routes = register_routes(letters)

    invalid = await routes[("PATCH", "/api/letter/{letter_id}")](
        FakeRequest({"content": ["not text"]}, path_params={"letter_id": "letter-1"})
    )
    assert invalid.status_code == 400
    assert buckets.updated == []

    edited = await routes[("PATCH", "/api/letter/{letter_id}")](
        FakeRequest({"content": " revised "}, path_params={"letter_id": "letter-1"})
    )
    assert payload(edited)["updated"] == ["content"]
    assert invalidated == ["old"]

    buckets.buckets.clear()
    deleted = await routes[("DELETE", "/api/letter/{letter_id}")](
        FakeRequest(query={"confirm": "yes"}, path_params={"letter_id": "letter-1"})
    )
    assert payload(deleted) == {"ok": True, "deleted": False, "cleaned": True, "already_missing": True}
    assert deleted_embeddings == ["letter-1"]
    assert "bm25" in buckets.deleted


@pytest.mark.asyncio
async def test_plans_groups_legacy_status_and_resolve_cascades_only_after_persist(monkeypatch):
    plan_a = {"id": "a", "content": "a", "metadata": {"type": "plan", "status": "ACTIVE", "weight": "0.9", "updated_at": "2026-01-01"}}
    plan_b = {"id": "b", "content": "b", "metadata": {"type": "plan", "status": "unexpected", "weight": 0.2, "updated_at": "2026-02-01"}}
    buckets = RecordingBuckets([plan_a, plan_b])
    monkeypatch.setattr(plans.sh, "_require_auth", lambda _request: None)
    monkeypatch.setattr(plans.sh, "bucket_mgr", buckets)
    routes = register_routes(plans)

    listed = await routes[("GET", "/api/plans")](FakeRequest())
    assert [plan["id"] for plan in payload(listed)["active"]] == ["a", "b"]

    cascaded = []
    import tools._common as common
    monkeypatch.setattr(common, "cascade_plan_resolved_to_buckets", lambda _meta, bucket_id: cascaded.append(bucket_id) or asyncio.sleep(0, result=["related-1"]))
    action = await routes[("POST", "/api/plans/{bucket_id}/action")](
        FakeRequest({"action": "resolve"}, path_params={"bucket_id": "a"})
    )
    assert payload(action)["cascaded_resolved"] == ["related-1"]
    assert cascaded == ["a"]
    assert buckets.updated[0][1]["status"] == "resolved"


@pytest.mark.asyncio
async def test_search_degrades_semantic_channel_without_leaking_filtered_buckets(monkeypatch):
    visible = {"id": "visible", "content": "[[Topic]]", "metadata": {"name": "Visible", "type": "dynamic"}}
    hidden = {"id": "hidden", "content": "private", "metadata": {"name": "Hidden", "type": "tombstone"}}
    buckets = RecordingBuckets([visible, hidden])

    class FailingEngine:
        enabled = True

        async def search_similar_strict(self, *_args, **_kwargs):
            raise RuntimeError("embedding unavailable")

    monkeypatch.setattr(search.sh, "_require_auth", lambda _request: None)
    monkeypatch.setattr(search.sh, "bucket_mgr", buckets)
    monkeypatch.setattr(search.sh, "embedding_engine", FailingEngine())
    routes = register_routes(search)

    response = await routes[("GET", "/api/search")](FakeRequest(query={"q": "topic"}))
    assert response.headers["x-semantic-search"] == "degraded"
    assert [entry["id"] for entry in payload(response)] == ["visible"]


@pytest.mark.asyncio
async def test_search_network_normalizes_concepts_and_breath_debug_rejects_nonfinite(monkeypatch):
    buckets = RecordingBuckets([
        {"id": "one", "content": "[[Memory]] [[Shared]]", "metadata": {"tags": ["#memory", "shared"], "anchor": True}},
        {"id": "two", "content": "[[shared]]", "metadata": {"tags": "other, memory"}},
    ])
    monkeypatch.setattr(search.sh, "_require_auth", lambda _request: None)
    monkeypatch.setattr(search.sh, "bucket_mgr", buckets)
    monkeypatch.setattr(search.sh, "embedding_engine", None)
    routes = register_routes(search)

    network = await routes[("GET", "/api/network")](FakeRequest())
    nodes = {node["id"]: node for node in payload(network)["nodes"]}
    assert nodes["memory"]["kind"] == "mixed"
    assert nodes["memory"]["anchor"] is True
    assert nodes["shared"]["freq"] == 2

    invalid = await routes[("GET", "/api/breath-debug")](FakeRequest(query={"valence": "nan"}))
    assert invalid.status_code == 400
    assert "有限" in payload(invalid)["error"]


def test_ollama_rejects_untrusted_download_and_archive_escape(monkeypatch, tmp_path):
    monkeypatch.delenv("OMBRE_ALLOW_UNTRUSTED_MIRROR", raising=False)
    with pytest.raises(ValueError, match="可信白名单"):
        ollama_local._validate_download_url("https://github.com.attacker.example/tool")
    with pytest.raises(ValueError, match="escapes"):
        ollama_local._safe_archive_target(str(tmp_path), "../../outside")
    assert ollama_local._recommend(False, False, False) == "install"
    assert ollama_local._recommend(True, True, True) == "docker"


@pytest.mark.asyncio
async def test_ollama_install_route_rejects_bad_request_without_spawning_thread(monkeypatch):
    monkeypatch.setattr(ollama_local.sh, "_require_auth", lambda _request: None)
    monkeypatch.setattr(ollama_local.sh, "in_docker", lambda: False)
    monkeypatch.setattr(ollama_local, "find_ollama_bin", lambda: None)
    monkeypatch.setattr(ollama_local, "_install_state", {"running": False})
    routes = register_routes(ollama_local)

    response = await routes[("POST", "/api/embedding/local/install")](FakeRequest(["not an object"]))
    assert response.status_code == 400
    assert payload(response)["error"] == "JSON body must be an object"


def _fresh_oauth_routes(monkeypatch, tmp_path):
    oauth._oauth_clients.clear()
    oauth._oauth_codes.clear()
    oauth._mcp_tokens.clear()
    oauth._mcp_token_resources.clear()
    oauth._mcp_refresh_tokens.clear()
    oauth.sh._login_failures.clear()
    oauth.sh._login_locked_until.clear()
    monkeypatch.setattr(
        oauth.sh,
        "config",
        {"buckets_dir": str(tmp_path / "oauth"), "mcp_require_auth": True},
    )
    return register_routes(oauth)


@pytest.mark.asyncio
async def test_oauth_foreign_token_audience_does_not_consume_authorization_code(
    monkeypatch, tmp_path
):
    """A hostile audience request must not burn a legitimate one-time code."""
    routes = _fresh_oauth_routes(monkeypatch, tmp_path)
    code_data = {
        "client_id": "client-1",
        "redirect_uri": "https://client.example/callback",
        "code_challenge": "",
        "resource": "https://ombre.example/mcp",
        "scope": "mcp",
        "expires": time.time() + 60,
    }
    oauth._oauth_codes["code-for-real-origin"] = dict(code_data)

    response = await routes[("POST", "/oauth/token")](
        OAuthRequest(
            {
                "grant_type": "authorization_code",
                "code": "code-for-real-origin",
                "client_id": "client-1",
                "redirect_uri": "https://client.example/callback",
                "resource": "https://attacker.example/mcp",
            }
        )
    )

    assert response.status_code == 400
    assert payload(response)["error"] == "invalid_target"
    assert oauth._oauth_codes["code-for-real-origin"] == code_data
    assert oauth._mcp_tokens == {}


@pytest.mark.asyncio
async def test_oauth_resource_bound_access_token_is_rejected_by_mcp_middleware(
    monkeypatch, tmp_path
):
    """A token for a prior public origin cannot cross the middleware boundary."""
    _fresh_oauth_routes(monkeypatch, tmp_path)
    access = oauth._issue_mcp_access_token("https://other.example/mcp")
    sent = []
    reached = []

    async def downstream(scope, _receive, send):
        reached.append(scope)
        await send({"type": "http.response.start", "status": 204, "headers": []})

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)

    middleware = MCPAuthMiddleware(
        downstream,
        auth_required=True,
        token_validator=oauth._is_valid_mcp_token,
        public_origin="https://ombre.example",
    )
    await middleware(
        {
            "type": "http",
            "method": "POST",
            "scheme": "https",
            "path": "/mcp",
            "client": ("127.0.0.1", 1000),
            "headers": [(b"host", b"ombre.example"), (b"authorization", f"Bearer {access}".encode())],
        },
        receive,
        send,
    )

    assert reached == []
    assert sent[0]["status"] == 401
