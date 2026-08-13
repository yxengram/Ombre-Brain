"""Verification primitives for official Ombre Brain update releases.

The repository intentionally ships no private key.  Until the maintainer
installs a real public key matching the GitHub Actions secret, verification is
unavailable and the updater fails closed.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

OFFICIAL_RELEASE_REPOSITORY = "yxengram/Ombre-Brain"
OFFICIAL_RELEASE_KEY_ID = "ombre-release-2026-1"
# Set to the URL-safe/base64 encoded 32-byte public key by a repository
# maintainer in the same change that provisions OMBRE_UPDATE_SIGNING_KEY_B64.
# The explicit empty value is safer than a sample/test key: it disables update
# execution rather than accidentally trusting a publicly known private key.
OFFICIAL_RELEASE_PUBLIC_KEY_B64 = "JmIQJAOpGQ/PCPgs9atsmKqQpV/3hLNw5uc556DIIb0="
_VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
_COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def canonical_manifest_bytes(manifest: dict[str, Any]) -> bytes:
    """Produce the exact deterministic bytes signed by CI and verified at runtime."""
    return json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def signing_available() -> bool:
    try:
        return len(base64.b64decode(OFFICIAL_RELEASE_PUBLIC_KEY_B64, validate=True)) == 32
    except Exception:
        return False


def parse_and_verify_manifest(
    manifest_bytes: bytes, signature_bytes: bytes, *, expected_tag: str
) -> dict[str, Any]:
    """Verify a detached Ed25519 signature and strict Release metadata."""
    if not signing_available():
        raise ValueError("官方更新签名公钥尚未配置，已安全禁用热更新")
    try:
        manifest = json.loads(manifest_bytes.decode("utf-8"))
    except Exception as exc:
        raise ValueError("Release manifest 不是有效 JSON") from exc
    if not isinstance(manifest, dict):
        raise ValueError("Release manifest 必须是对象")
    if manifest.get("schema_version") != 1 or manifest.get("key_id") != OFFICIAL_RELEASE_KEY_ID:
        raise ValueError("Release manifest 的 schema 或 key_id 不受信任")
    version = str(manifest.get("version") or "")
    commit = str(manifest.get("commit") or "")
    asset = manifest.get("asset")
    if expected_tag != f"v{version}" or not _VERSION_RE.fullmatch(version):
        raise ValueError("Release tag 与 manifest 版本不一致")
    if not _COMMIT_RE.fullmatch(commit) or not isinstance(asset, dict):
        raise ValueError("Release manifest 缺少有效 commit 或 asset")
    name, sha256, size = asset.get("name"), asset.get("sha256"), asset.get("size")
    if not isinstance(name, str) or not name.endswith(".zip") or "/" in name:
        raise ValueError("Release payload 文件名无效")
    if not isinstance(sha256, str) or not _SHA256_RE.fullmatch(sha256):
        raise ValueError("Release payload SHA-256 无效")
    if not isinstance(size, int) or size < 1:
        raise ValueError("Release payload 大小无效")
    try:
        signature = base64.b64decode(signature_bytes, validate=True)
        public = Ed25519PublicKey.from_public_bytes(
            base64.b64decode(OFFICIAL_RELEASE_PUBLIC_KEY_B64, validate=True)
        )
        public.verify(signature, canonical_manifest_bytes(manifest))
    except (InvalidSignature, ValueError, TypeError) as exc:
        raise ValueError("Release manifest 签名无效") from exc
    return manifest


def verify_payload_file(path: str, asset: dict[str, Any]) -> None:
    expected_size = int(asset["size"])
    actual_size = 0
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while chunk := handle.read(1024 * 1024):
            actual_size += len(chunk)
            if actual_size > expected_size:
                raise ValueError("Release payload 大小不匹配")
            digest.update(chunk)
    if actual_size != expected_size or digest.hexdigest() != asset["sha256"]:
        raise ValueError("Release payload SHA-256 或大小不匹配")
