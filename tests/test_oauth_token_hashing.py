import json
import time

from web import _shared as sh
from web import oauth


def _clear_grants():
    oauth._mcp_tokens.clear()
    oauth._mcp_token_resources.clear()
    oauth._mcp_refresh_tokens.clear()


def test_oauth_uses_short_security_ttls():
    assert oauth._MCP_TOKEN_TTL == 3600
    assert oauth._MCP_REFRESH_TOKEN_TTL == 30 * 86400


def test_issued_tokens_are_not_kept_as_registry_keys(tmp_path, monkeypatch):
    monkeypatch.setitem(sh.config, "buckets_dir", str(tmp_path))
    _clear_grants()
    access = oauth._issue_mcp_access_token("https://ombre.example/mcp")
    refresh = oauth._issue_mcp_refresh_token("client", "https://ombre.example/mcp")

    assert access not in oauth._mcp_tokens
    assert refresh not in oauth._mcp_refresh_tokens
    assert oauth._token_digest(access) in oauth._mcp_tokens
    assert oauth._token_digest(refresh) in oauth._mcp_refresh_tokens
    assert oauth._is_valid_mcp_token(access, "https://ombre.example/mcp")


def test_persisted_token_state_is_schema_v2_and_has_no_bearer_values(tmp_path, monkeypatch):
    monkeypatch.setitem(sh.config, "buckets_dir", str(tmp_path))
    _clear_grants()
    access = oauth._issue_mcp_access_token()
    refresh = oauth._issue_mcp_refresh_token("client")
    oauth._save_mcp_tokens()

    raw = (tmp_path / ".dashboard_mcp_tokens.json").read_text(encoding="utf-8")
    data = json.loads(raw)
    assert data["schema_version"] == 2
    assert access not in raw and refresh not in raw
    assert all(key.startswith("sha256:") for key in data["access_tokens"])
    assert all(key.startswith("sha256:") for key in data["refresh_tokens"])


def test_v1_token_file_is_migrated_before_grants_are_published(tmp_path, monkeypatch):
    monkeypatch.setitem(sh.config, "buckets_dir", str(tmp_path))
    raw_access, raw_refresh = "legacy-access-token", "legacy-refresh-token"
    (tmp_path / ".dashboard_mcp_tokens.json").write_text(
        json.dumps(
            {
                "access_tokens": {raw_access: {"expires": time.time() + 86400, "resource": "https://ombre.example/mcp"}},
                "refresh_tokens": {raw_refresh: {"expires": time.time() + 86400, "client_id": "c", "resource": "https://ombre.example/mcp"}},
            }
        ),
        encoding="utf-8",
    )
    _clear_grants()
    oauth._load_mcp_tokens()

    assert oauth._is_valid_mcp_token(raw_access, "https://ombre.example/mcp")
    assert raw_access not in oauth._mcp_tokens
    data = json.loads((tmp_path / ".dashboard_mcp_tokens.json").read_text(encoding="utf-8"))
    assert data["schema_version"] == 2
    assert raw_access not in json.dumps(data)
    assert oauth._mcp_tokens[oauth._token_digest(raw_access)] <= time.time() + 3601


def test_malformed_v2_raw_or_non_hex_token_keys_are_dropped_and_rewritten(
    tmp_path, monkeypatch
):
    monkeypatch.setitem(sh.config, "buckets_dir", str(tmp_path))
    valid_raw = "issued-access-token"
    valid_digest = oauth._token_digest(valid_raw)
    bad_raw, bad_non_hex = "raw-bearer-value", "sha256:" + "g" * 64
    (tmp_path / ".dashboard_mcp_tokens.json").write_text(
        json.dumps(
            {
                "schema_version": 2,
                "access_tokens": {
                    valid_digest: {"expires": time.time() + 60},
                    bad_raw: {"expires": time.time() + 60},
                    bad_non_hex: {"expires": time.time() + 60},
                },
                "refresh_tokens": {bad_raw: {"expires": time.time() + 60}},
            }
        ),
        encoding="utf-8",
    )
    _clear_grants()
    oauth._load_mcp_tokens()

    assert oauth._is_valid_mcp_token(valid_raw)
    assert not oauth._is_valid_mcp_token(bad_raw)
    assert set(oauth._mcp_tokens) == {valid_digest}
    persisted = json.loads(
        (tmp_path / ".dashboard_mcp_tokens.json").read_text(encoding="utf-8")
    )
    assert set(persisted["access_tokens"]) == {valid_digest}
    assert persisted["refresh_tokens"] == {}
    assert bad_raw not in json.dumps(persisted)
