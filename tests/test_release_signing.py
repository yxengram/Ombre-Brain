import base64
import os
import subprocess
import sys

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from ombrebrain.security import release_signing


def _manifest():
    return {
        "schema_version": 1,
        "key_id": release_signing.OFFICIAL_RELEASE_KEY_ID,
        "version": "2.16.0",
        "commit": "a" * 40,
        "asset": {"name": "ombre-brain-update-v2.16.0.zip", "sha256": "b" * 64, "size": 17},
    }


def test_production_public_key_is_configured():
    public = base64.b64decode(release_signing.OFFICIAL_RELEASE_PUBLIC_KEY_B64, validate=True)
    assert len(public) == 32
    assert release_signing.signing_available() is True


def test_missing_production_public_key_fails_closed(monkeypatch):
    monkeypatch.setattr(release_signing, "OFFICIAL_RELEASE_PUBLIC_KEY_B64", "")
    with pytest.raises(ValueError, match="公钥尚未配置"):
        release_signing.parse_and_verify_manifest(b"{}", b"", expected_tag="v2.16.0")


def test_valid_fixture_signature_verifies_and_forged_signature_is_rejected(monkeypatch):
    private = Ed25519PrivateKey.generate()
    public = private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    monkeypatch.setattr(release_signing, "OFFICIAL_RELEASE_PUBLIC_KEY_B64", base64.b64encode(public).decode())
    manifest = _manifest()
    body = release_signing.canonical_manifest_bytes(manifest)
    signature = base64.b64encode(private.sign(body))

    assert release_signing.parse_and_verify_manifest(body, signature, expected_tag="v2.16.0") == manifest
    with pytest.raises(ValueError, match="签名无效"):
        release_signing.parse_and_verify_manifest(body, base64.b64encode(b"x" * 64), expected_tag="v2.16.0")


def test_offline_key_tool_writes_private_material_owner_only_and_refuses_overwrite(tmp_path):
    private = tmp_path / "update.key"
    public = tmp_path / "update.pub"
    command = [sys.executable, "tools/generate_update_signing_key.py", "--private-key", str(private), "--public-key", str(public)]
    result = subprocess.run(command, check=True, capture_output=True, text=True)

    assert public.read_text(encoding="ascii").strip() == result.stdout.strip()
    assert len(base64.b64decode(private.read_bytes().strip(), validate=True)) == 32
    if os.name != "nt":
        assert private.stat().st_mode & 0o777 == 0o600
    second = subprocess.run(command, capture_output=True, text=True)
    assert second.returncode != 0
    assert "refusing to overwrite" in second.stderr
