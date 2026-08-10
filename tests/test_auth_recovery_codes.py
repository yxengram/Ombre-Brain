import asyncio
import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from ombrebrain.security.recovery import generate_recovery_codes, recovery_code_hash
from web import _shared as sh
from web import auth as auth_web


class FakeMCP:
    def __init__(self):
        self.routes = {}

    def custom_route(self, path, methods):
        def decorator(handler):
            for method in methods:
                self.routes[(method, path)] = handler
            return handler

        return decorator


class JsonRequest:
    def __init__(self, body=None, *, cookies=None):
        self._body = {} if body is None else body
        self.headers = {"host": "localhost"}
        self.cookies = cookies or {}
        self.client = type("Client", (), {"host": "127.0.0.1"})()

    async def json(self):
        return self._body


def _payload(response):
    return json.loads(response.body)


@pytest.fixture
def auth_routes(tmp_path, monkeypatch):
    monkeypatch.delenv("OMBRE_DASHBOARD_PASSWORD", raising=False)
    monkeypatch.setitem(sh.config, "buckets_dir", str(tmp_path))
    sh._sessions.clear()
    mcp = FakeMCP()
    auth_web.register(mcp)
    yield mcp.routes
    sh._sessions.clear()


def test_recovery_codes_are_128_bit_base32_and_normalize_only_presentation():
    codes = generate_recovery_codes()

    assert len(codes) == 10
    assert len(set(codes)) == 10
    assert all(len(code.replace("-", "")) == 26 for code in codes)
    assert recovery_code_hash(codes[0]) == recovery_code_hash(codes[0].lower().replace("-", " "))
    assert recovery_code_hash(codes[0]) != recovery_code_hash(codes[0] + "!")
    assert recovery_code_hash("中文恢复码") == ""
    assert recovery_code_hash("😀" * 26) == ""
    assert recovery_code_hash("A" * 25) == ""
    assert recovery_code_hash("A" * 27) == ""
    assert recovery_code_hash("A" * 25 + "!") == ""


@pytest.mark.asyncio
async def test_setup_returns_codes_once_and_persists_only_digests(auth_routes):
    response = await auth_routes[("POST", "/auth/setup")](
        JsonRequest({"password": "unique dashboard password"})
    )

    assert response.status_code == 200
    payload = _payload(response)
    assert len(payload["recovery_codes"]) == 10
    stored = sh._load_auth_data()
    assert "security_question" not in stored
    assert "security_answer_hash" not in stored
    assert all(value.startswith("sha256:") for value in stored["recovery_code_hashes"])
    assert not any(code in json.dumps(stored) for code in payload["recovery_codes"])
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.asyncio
async def test_recovery_code_is_single_use_and_invalid_attempt_does_not_consume(auth_routes):
    setup = await auth_routes[("POST", "/auth/setup")](
        JsonRequest({"password": "unique dashboard password"})
    )
    code = _payload(setup)["recovery_codes"][0]

    invalid = await auth_routes[("POST", "/auth/recover")](
        JsonRequest({"recovery_code": generate_recovery_codes(1)[0], "new_password": "another unique password"})
    )
    assert invalid.status_code == 401
    assert sh._recovery_code_is_configured(code)

    recovered = await auth_routes[("POST", "/auth/recover")](
        JsonRequest({"recovery_code": code, "new_password": "another unique password"})
    )
    assert recovered.status_code == 200
    assert not sh._recovery_code_is_configured(code)
    replay = await auth_routes[("POST", "/auth/recover")](
        JsonRequest({"recovery_code": code, "new_password": "third unique password"})
    )
    assert replay.status_code in (401, 429)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "invalid_code",
    ["中文恢复码", "😀" * 26, "A" * 25, "A" * 27, "A" * 25 + "!", "A" * 257],
)
async def test_invalid_recovery_code_is_a_bounded_400_not_an_exception(
    auth_routes, invalid_code, monkeypatch
):
    monkeypatch.setattr(auth_web.sh, "_login_retry_after", lambda _request: 0)
    monkeypatch.setattr(auth_web.sh, "_record_login_failure", lambda _request: None)
    response = await auth_routes[("POST", "/auth/recover")](
        JsonRequest(
            {
                "recovery_code": invalid_code,
                "new_password": "another unique password",
            }
        )
    )

    assert response.status_code == 400


@pytest.mark.asyncio
async def test_security_question_routes_are_gone(auth_routes):
    assert (await auth_routes[("GET", "/auth/recovery-question")](JsonRequest())).status_code == 410
    assert (await auth_routes[("POST", "/auth/security-question")](JsonRequest({}))).status_code == 410


@pytest.mark.asyncio
async def test_short_legacy_password_requires_upgrade_then_creates_session(auth_routes):
    sh._save_password_hash("oldshort")
    login = await auth_routes[("POST", "/auth/login")](JsonRequest({"password": "oldshort"}))
    assert login.status_code == 428
    assert _payload(login)["error_code"] == "password_upgrade_required"
    assert sh._sessions == {}

    upgraded = await auth_routes[("POST", "/auth/upgrade-password")](
        JsonRequest({"current_password": "oldshort", "new_password": "new unique dashboard password"})
    )
    assert upgraded.status_code == 200
    assert sh._sessions


@pytest.mark.asyncio
async def test_concurrent_regeneration_only_returns_one_usable_code_set(auth_routes, monkeypatch):
    password = "unique dashboard password"
    await auth_routes[("POST", "/auth/setup")](JsonRequest({"password": password}))
    generation = sh._credential_generation_snapshot()
    monkeypatch.setattr(auth_web.sh, "_require_auth", lambda _request: None)
    monkeypatch.setattr(
        auth_web.sh, "_authenticated_credential_generation", lambda _request: generation
    )
    monkeypatch.setattr(
        auth_web.sh,
        "_verify_password_for_rotation",
        lambda _password: sh.CredentialProof("password_hash", "proof", generation),
    )
    regenerate = auth_routes[("POST", "/auth/recovery-codes/regenerate")]
    responses = await asyncio.gather(
        regenerate(JsonRequest({"current_password": password})),
        regenerate(JsonRequest({"current_password": password})),
    )

    successful = [response for response in responses if response.status_code == 200]
    assert len(successful) == 1
    assert sorted(response.status_code for response in responses) == [200, 409]
    shown = _payload(successful[0])["recovery_codes"]
    assert all(sh._recovery_code_is_configured(code) for code in shown)


def test_short_environment_password_fails_before_routes_are_exposed(tmp_path, monkeypatch):
    monkeypatch.setenv("OMBRE_DASHBOARD_PASSWORD", "short")
    monkeypatch.setitem(sh.config, "buckets_dir", str(tmp_path))
    with pytest.raises(RuntimeError, match="OMBRE_DASHBOARD_PASSWORD"):
        auth_web.register(FakeMCP())


def test_new_password_write_removes_legacy_security_question(tmp_path, monkeypatch):
    monkeypatch.setitem(sh.config, "buckets_dir", str(tmp_path))
    (tmp_path / ".dashboard_auth.json").write_text(
        json.dumps({"password_hash": sh._hash_secret("legacy password value"), "security_question": "old", "security_answer_hash": "old"}),
        encoding="utf-8",
    )
    sh._save_password_hash("new unique password")

    stored = sh._load_auth_data()
    assert "security_question" not in stored
    assert "security_answer_hash" not in stored


def test_concurrent_recovery_consumption_has_exactly_one_winner(tmp_path, monkeypatch):
    monkeypatch.setitem(sh.config, "buckets_dir", str(tmp_path))
    code = generate_recovery_codes(1)[0]
    sh._save_prehashed_password(
        "hash:old-password", recovery_code_hashes=[recovery_code_hash(code)]
    )
    monkeypatch.setattr(auth_web, "_revoke_mcp_grants", lambda: None)
    with ThreadPoolExecutor(max_workers=12) as executor:
        results = list(
            executor.map(
                lambda _index: auth_web._commit_recovery_code_rotation(code, "hash:new-password"),
                range(12),
            )
        )

    assert sum(result is not None for result in results) == 1
    assert not sh._recovery_code_is_configured(code)
