"""Regression coverage for the read-only deployment security diagnostic."""

from __future__ import annotations

import importlib.util
import io
import json
from contextlib import redirect_stdout
from pathlib import Path

import pytest


_MODULE_PATH = Path(__file__).resolve().parents[1] / "tools" / "security_diagnostics.py"
_SPEC = importlib.util.spec_from_file_location("security_diagnostics", _MODULE_PATH)
assert _SPEC is not None and _SPEC.loader is not None
security_diagnostics = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(security_diagnostics)


def _write_config(path: Path, *, auth: str | bool = True, endpoint: str = "https://provider.example/v1") -> None:
    auth_value = str(auth).lower() if isinstance(auth, bool) else auth
    path.write_text(
        "\n".join(
            [
                f"mcp_require_auth: {auth_value}",
                "bind_host: 0.0.0.0",
                "mcp_token: super-secret-value",
                "buckets_dir: vault-data",
                "dehydration:",
                f"  base_url: {endpoint}",
                "embedding:",
                "  db_path: vault-data/embedding-private.db",
            ]
        ),
        encoding="utf-8",
    )


def _clear_runtime_path_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("OMBRE_BUCKETS_DIR", "OMBRE_VAULT_DIR", "OMBRE_MEDIA_DIR"):
        monkeypatch.delenv(name, raising=False)


def test_diagnostic_never_serializes_secret_or_absolute_paths(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _clear_runtime_path_overrides(monkeypatch)
    config = tmp_path / "deployment.yaml"
    _write_config(config, auth=False)
    vault = tmp_path / "vault-data"
    vault.mkdir(mode=0o700)
    token_file = vault / ".dashboard_mcp_tokens.json"
    token_file.write_text('{"token":"do-not-print"}', encoding="utf-8")
    token_file.chmod(0o600)

    report = security_diagnostics.inspect_security(config)
    rendered = json.dumps(report, ensure_ascii=False)

    assert report["ok"] is False
    assert any(item["code"] == "OB-DIAG-OPEN-REMOTE-MCP" for item in report["findings"])
    assert "super-secret-value" not in rendered
    assert "do-not-print" not in rendered
    assert str(tmp_path) not in rendered
    assert any(item["name"] == "vault/.dashboard_mcp_tokens.json" for item in report["resources"])
    assert set(report["update_signing"]) == {"signing_available", "key_id"}


def test_diagnostic_rejects_remote_http_and_detects_symlink(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _clear_runtime_path_overrides(monkeypatch)
    config = tmp_path / "deployment.yaml"
    _write_config(config, endpoint="http://provider.example/v1")
    vault = tmp_path / "vault-data"
    vault.mkdir()
    target = tmp_path / "target"
    target.mkdir()
    media = vault / "_media"
    try:
        media.symlink_to(target, target_is_directory=True)
    except (NotImplementedError, OSError):
        pytest.skip("symlinks are unavailable in this test environment")

    report = security_diagnostics.inspect_security(config)
    codes = {item["code"] for item in report["findings"]}

    assert "OB-DIAG-OUTBOUND-URL" in codes
    assert "OB-DIAG-SYMLINK" in codes
    assert {item["name"] for item in report["providers"]} >= {"dehydration_endpoint", "embedding_endpoint"}


def test_diagnostic_uses_runtime_bind_and_default_media_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _clear_runtime_path_overrides(monkeypatch)
    config = tmp_path / "deployment.yaml"
    _write_config(config, auth='"false"')
    (tmp_path / "vault-data" / "_media").mkdir(parents=True)
    monkeypatch.setenv("OMBRE_BIND_ADDRESS", "0.0.0.0")

    report = security_diagnostics.inspect_security(config)

    assert report["auth"] == {"mcp_require_auth": False, "bind_scope": "non_loopback"}
    assert any(item["code"] == "OB-DIAG-OPEN-REMOTE-MCP" for item in report["findings"])
    assert next(item for item in report["resources"] if item["name"] == "media")["exists"] is True
    assert str(tmp_path) not in json.dumps(report, ensure_ascii=False)


def test_diagnostic_cli_is_json_only_and_read_only(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _clear_runtime_path_overrides(monkeypatch)
    config = tmp_path / "deployment.yaml"
    _write_config(config)
    before = sorted(item.name for item in tmp_path.iterdir())
    stream = io.StringIO()
    with redirect_stdout(stream):
        status = security_diagnostics.main(["--config", str(config)])

    payload = json.loads(stream.getvalue())
    assert status == 0
    assert payload["schema_version"] == "ombrebrain.security-diagnostics.v1"
    assert sorted(item.name for item in tmp_path.iterdir()) == before
    assert "super-secret-value" not in stream.getvalue()
