"""One strict URL policy for administrator-configured service egress.

Provider and webhook endpoints are operator configuration, not untrusted URLs.
This module therefore validates URL syntax, blocks unsafe direct-IP classes,
and all callers disable redirects.  It deliberately does *not* resolve DNS:
doing so without pinning the connection has a DNS-rebinding race.  Operators
must only configure trusted provider hostnames; a hostname resolving to a
private address is outside this process-local validation boundary.
"""

from __future__ import annotations

import ipaddress
import logging
import os
import re
from urllib.parse import SplitResult, urlsplit, urlunsplit


logger = logging.getLogger("ombre_brain.security.outbound_url")

MAX_OUTBOUND_URL_CHARS = 2048
_HTTP_LOCAL_HOSTS = frozenset({"localhost", "host.docker.internal", "ombre-ollama"})
_LEGACY_IPV4_COMPONENT = re.compile(r"(?:0x[0-9a-f]+|[0-9]+)\Z", re.IGNORECASE)


class OutboundURLRejected(ValueError):
    """Raised when a configured endpoint is unsafe for server-side egress."""


def _canonical_host(host: str) -> str:
    raw = str(host or "").rstrip(".")
    if not raw:
        return ""
    try:
        return ipaddress.ip_address(raw).compressed.lower()
    except ValueError:
        # Avoid legacy one-part/hex/short IPv4 spellings being resolved by a
        # lower-level URL stack after they evade the literal-IP policy here.
        parts = raw.split(".")
        if parts and all(_LEGACY_IPV4_COMPONENT.fullmatch(part) for part in parts):
            return ""
        try:
            return raw.encode("idna").decode("ascii").lower()
        except UnicodeError:
            return ""


def _allowed_insecure_hosts() -> frozenset[str]:
    raw = os.environ.get("OMBRE_INSECURE_LOCAL_HOSTS", "")
    return frozenset(
        host for item in raw.split(",") if (host := _canonical_host(item.strip()))
    )


def _literal_ip(host: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    """Return a parsed IP literal, never resolving a hostname."""

    try:
        return ipaddress.ip_address(host)
    except ValueError:
        return None


def _validate_literal_ip(host: str, *, scheme: str, purpose: str) -> None:
    """Apply the non-bypassable IP policy before any outbound connection."""

    address = _literal_ip(host)
    if address is None:
        return
    if (
        address.is_unspecified
        or address.is_link_local
        or address.is_multicast
        or address.is_reserved
    ):
        raise OutboundURLRejected("direct IP endpoint uses a forbidden address class")
    explicit = host in _allowed_insecure_hosts()
    built_in_local = address.is_loopback
    if scheme == "https" and address.is_private and not (built_in_local or explicit):
        raise OutboundURLRejected("private HTTPS IP requires an explicit local-host allowlist")
    if scheme == "http" and not (built_in_local or explicit):
        raise OutboundURLRejected("plain HTTP is restricted to local endpoints")
    if explicit and not built_in_local:
        logger.warning(
            "high-risk local outbound endpoint enabled purpose=%s host=%s scheme=%s",
            str(purpose)[:40], host, scheme,
        )


def validate_outbound_url(value: object, *, purpose: str = "provider") -> str:
    """Return a canonical safe HTTP(S) URL or raise ``OutboundURLRejected``.

    HTTPS is mandatory for remote endpoints.  Plain HTTP is intentionally
    limited to explicit local/container names, loopback IPs, or exact operator
    allowlist entries.  Direct private HTTPS IPs require the same exact
    ``OMBRE_INSECURE_LOCAL_HOSTS`` allowlist; unsafe literal IP classes are
    always rejected. Query strings remain valid because signed webhooks are
    common; userinfo credentials and fragments are never accepted.
    """

    raw = str(value or "").strip()
    if not raw or len(raw) > MAX_OUTBOUND_URL_CHARS:
        raise OutboundURLRejected("URL is empty or too long")
    if any(character.isspace() or ord(character) < 32 or character == "\\" for character in raw):
        raise OutboundURLRejected("URL contains unsafe characters")
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except (TypeError, ValueError):
        raise OutboundURLRejected("URL is malformed") from None
    scheme = parsed.scheme.lower()
    host = _canonical_host(parsed.hostname or "")
    if (
        scheme not in {"http", "https"}
        or not host
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or port == 0
    ):
        raise OutboundURLRejected("URL must be an HTTP(S) endpoint without credentials or fragment")
    _validate_literal_ip(host, scheme=scheme, purpose=purpose)
    if scheme == "http" and _literal_ip(host) is None:
        allowed = host in _HTTP_LOCAL_HOSTS
        explicit = host in _allowed_insecure_hosts()
        if not allowed and not explicit:
            raise OutboundURLRejected("plain HTTP is restricted to local endpoints")
        if explicit and not allowed:
            logger.warning(
                "high-risk plain HTTP outbound endpoint enabled purpose=%s host=%s",
                str(purpose)[:40], host,
            )
    netloc = host if ":" not in host else f"[{host}]"
    if port is not None and port != (443 if scheme == "https" else 80):
        netloc = f"{netloc}:{port}"
    normalized = SplitResult(scheme, netloc, parsed.path or "", parsed.query, "")
    return urlunsplit(normalized)
