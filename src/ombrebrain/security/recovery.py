"""Small, auditable recovery-code primitives for dashboard authentication.

Recovery codes are high-entropy bearer secrets.  They are deliberately hashed
with SHA-256 rather than a password KDF: a 128-bit random code is not feasibly
guessable, while a fast digest lets the server atomically compare a whole set
without turning a recovery attempt into an inexpensive CPU denial of service.
"""

from __future__ import annotations

import base64
import hashlib
import re
import secrets

RECOVERY_CODE_COUNT = 10
RECOVERY_CODE_BYTES = 16
_RECOVERY_CODE_PATTERN = re.compile(r"^[A-Z2-7]{26}$")


def normalize_recovery_code(value: str) -> str:
    """Normalize presentation only, then require exact RFC 4648 Base32."""
    if not isinstance(value, str):
        return ""
    normalized = "".join(char for char in value.upper() if char not in " -")
    return normalized if _RECOVERY_CODE_PATTERN.fullmatch(normalized) else ""


def recovery_code_hash(value: str) -> str:
    """Return a tagged, stable digest suitable for the private auth file."""
    normalized = normalize_recovery_code(value)
    if not normalized:
        return ""
    return "sha256:" + hashlib.sha256(normalized.encode("ascii")).hexdigest()


def _format_code(raw: str) -> str:
    return "-".join(raw[index : index + 4] for index in range(0, len(raw), 4))


def generate_recovery_codes(count: int = RECOVERY_CODE_COUNT) -> list[str]:
    """Generate display-ready Base32 codes with 128 bits of entropy each."""
    if count < 1:
        raise ValueError("count must be positive")
    return [
        _format_code(base64.b32encode(secrets.token_bytes(RECOVERY_CODE_BYTES)).decode("ascii").rstrip("="))
        for _ in range(count)
    ]
