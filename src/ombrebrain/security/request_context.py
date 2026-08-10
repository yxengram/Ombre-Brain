"""Per-request MCP security context.

The context deliberately contains an opaque principal, never a bearer token or
request body.  ``ContextVar`` keeps concurrent ASGI requests and stdio calls
from accidentally sharing the identity used by the MCP quota and media policy.
"""

from __future__ import annotations

import contextvars
import hashlib
import ipaddress
import os
import tempfile
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class MCPRequestContext:
    """Minimal, non-secret identity needed at the tool boundary."""

    principal: str = "local:stdio"
    remote: bool = False
    transport: str = "stdio"


_DEFAULT_CONTEXT = MCPRequestContext()
_REQUEST_CONTEXT: contextvars.ContextVar[MCPRequestContext] = contextvars.ContextVar(
    "ombre_mcp_request_context", default=_DEFAULT_CONTEXT
)


def get_request_context() -> MCPRequestContext:
    """Return the current request context, or the safe stdio default."""

    return _REQUEST_CONTEXT.get()


def set_request_context(context: MCPRequestContext) -> contextvars.Token[MCPRequestContext]:
    """Install a context and return the token that must be reset in ``finally``."""

    return _REQUEST_CONTEXT.set(context)


def reset_request_context(token: contextvars.Token[MCPRequestContext]) -> None:
    """Restore the previous context after a middleware or request finishes."""

    _REQUEST_CONTEXT.reset(token)


def token_principal(token: str) -> str:
    """Return an opaque bearer-token principal without retaining the token."""

    digest = hashlib.sha256(str(token).encode("utf-8")).hexdigest()
    return f"token:sha256:{digest}"


def normalize_client_address(value: Any) -> str:
    """Return a stable non-ambiguous peer identity for unauthenticated HTTP.

    The value is not logged by this module.  An invalid/missing peer is folded
    into one bounded bucket rather than reflecting attacker-controlled text.
    """

    raw = str(value or "").strip()
    if not raw or len(raw) > 253:
        return "peer:unknown"
    try:
        return f"peer:{ipaddress.ip_address(raw).compressed.lower()}"
    except ValueError:
        # ASGI servers normally supply IP literals.  Retain a safe hostname
        # fallback for test transports and Unix-socket adapters without storing
        # raw control characters or whitespace in quota state.
        if any(character.isspace() or ord(character) < 32 for character in raw):
            return "peer:unknown"
        return "peer:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def http_context(*, principal: str, authenticated: bool) -> MCPRequestContext:
    """Create the normalized HTTP context used by MCPAuthMiddleware."""

    return MCPRequestContext(
        principal=principal,
        remote=True,
        transport="http-authenticated" if authenticated else "http-open",
    )


def allow_stdio_media_server_path() -> bool:
    """Whether the active request may import a server-side media path.

    Remote HTTP requests are always denied, including unauthenticated loopback
    HTTP.  Only the direct stdio transport receives this compatibility ability.
    """

    context = get_request_context()
    return not context.remote and context.transport == "stdio"


def stdio_media_import_roots() -> tuple[str, ...]:
    """Return operator-configured stdio import roots or the system temp root."""

    configured = os.environ.get("OMBRE_MEDIA_IMPORT_ROOTS", "").strip()
    if configured:
        return tuple(item for item in configured.split(os.pathsep) if item.strip())
    return (tempfile.gettempdir(),)
