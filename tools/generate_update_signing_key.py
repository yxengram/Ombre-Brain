#!/usr/bin/env python3
"""Generate an Ed25519 update-signing key without exposing its private half.

Example:
  python tools/generate_update_signing_key.py --private-key /secure/ombre-update.key
The private key is written owner-only. Its Base64 value is never printed. The
file content is already Base64: redirect it directly into the GitHub Actions
secret with
`gh secret set OMBRE_UPDATE_SIGNING_KEY_B64 < /secure/ombre-update.key`.
"""

from __future__ import annotations

import argparse
import base64
import os
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate Ombre Brain update signing material")
    parser.add_argument("--private-key", required=True, type=Path)
    parser.add_argument("--public-key", type=Path)
    args = parser.parse_args()
    private_path = args.private_key.expanduser().resolve()
    if private_path.exists():
        raise SystemExit(f"refusing to overwrite existing private key: {private_path}")
    private_path.parent.mkdir(parents=True, exist_ok=True)
    private = Ed25519PrivateKey.generate()
    private_bytes = private.private_bytes(
        serialization.Encoding.Raw,
        serialization.PrivateFormat.Raw,
        serialization.NoEncryption(),
    )
    descriptor = os.open(private_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(base64.b64encode(private_bytes) + b"\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(private_path, 0o600)
    public_b64 = base64.b64encode(
        private.public_key().public_bytes(
            serialization.Encoding.Raw,
            serialization.PublicFormat.Raw,
        )
    ).decode("ascii")
    if args.public_key:
        args.public_key.write_text(public_b64 + "\n", encoding="ascii")
    print(public_b64)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
