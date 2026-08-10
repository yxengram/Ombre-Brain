"""
========================================
web/auth.py — Dashboard 鉴权相关 HTTP 路由
========================================

承载 /auth/* 这一组 cookie 会话鉴权接口（状态/首启设密/登录/登出/改密/安全问题急救）。
真正的会话/密码逻辑在 web/_shared.py，本文件只做 HTTP 入口与参数校验。

对外暴露：register(mcp) —— server.py 启动装配时调用，把下列路由挂到主 mcp 实例。
========================================
"""

import asyncio
import ipaddress
import os
import threading

from starlette.requests import Request
from starlette.responses import Response

from . import _shared as sh
from ombrebrain.security.recovery import (
    RECOVERY_CODE_COUNT,
    generate_recovery_codes,
    recovery_code_hash,
)

_MAX_PASSWORD_CHARS = 1024
_PASSWORD_WORK_MAX_CONCURRENCY = 2


class _CrossLoopSemaphore:
    """Small async context manager backed by a process-wide thread semaphore.

    FastMCP can serve requests from more than one event loop.  An
    ``asyncio.Semaphore`` binds contended waiters to one loop and therefore is
    not a process-wide KDF ceiling.  Non-blocking polling keeps acquisition off
    the executor, so queued login attempts cannot occupy every worker thread
    while the PBKDF2 jobs holding the slots wait behind them.
    """

    def __init__(self, value: int):
        self._semaphore = threading.BoundedSemaphore(value)

    async def __aenter__(self):
        while not self._semaphore.acquire(blocking=False):
            await asyncio.sleep(0.01)
        return self

    async def __aexit__(self, _exc_type, _exc, _tb):
        self._semaphore.release()


_setup_lock = _CrossLoopSemaphore(1)
_password_work_semaphore = _CrossLoopSemaphore(_PASSWORD_WORK_MAX_CONCURRENCY)


async def _await_password_worker(func, *args, **kwargs):
    worker = asyncio.create_task(asyncio.to_thread(func, *args, **kwargs))
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        # A task may receive more than one cancellation while the executor
        # thread is still running. Keep shielding until it truly finishes;
        # otherwise each repeated disconnect could release another slot.
        while not worker.done():
            try:
                await asyncio.shield(worker)
            except asyncio.CancelledError:
                continue
        try:
            worker.result()
        except BaseException:
            pass
        raise


async def _run_password_work(func, *args, **kwargs):
    """Run a password KDF off-loop while enforcing one process-wide ceiling.

    ``asyncio.to_thread`` alone keeps the event loop responsive but its default
    executor can create many simultaneous PBKDF2 jobs. The semaphore bounds CPU
    pressure and remains held until a cancelled worker thread really stops.
    """
    async with _password_work_semaphore:
        return await _await_password_worker(func, *args, **kwargs)


async def _run_public_password_verification(request, verifier, secret):
    """Recheck per-source lockout after waiting for a global KDF slot."""
    async with _password_work_semaphore:
        retry = sh._login_retry_after(request)
        if retry:
            return False, retry
        verified = await _await_password_worker(verifier, secret)
        return verified, 0


def _json_object(body) -> dict | None:
    return body if isinstance(body, dict) else None


def _is_explicit_loopback_host(host: object) -> bool:
    """Accept only unambiguous loopback names and address literals."""
    value = str(host or "").strip().lower()
    if value in ("localhost", "localhost."):
        return True
    if not value or "%" in value:
        return False
    try:
        return ipaddress.ip_address(value).is_loopback
    except ValueError:
        # This deliberately rejects DNS aliases and legacy numeric IPv4 forms
        # such as 127.1, 2130706433, or 0177.0.0.1. Browsers can interpret
        # those differently from Python, which would reopen DNS rebinding.
        return False


def _loopback_host_authority(authority: object) -> bool:
    """Validate a Host header as a loopback literal/name with optional port."""
    value = str(authority or "").strip()
    if not value or any(char.isspace() or char == "\\" for char in value):
        return False

    if value.startswith("["):
        close = value.find("]")
        if close <= 1:
            return False
        host = value[1:close]
        suffix = value[close + 1 :]
        if suffix and not suffix.startswith(":"):
            return False
        port_text = suffix[1:] if suffix else None
    else:
        if "[" in value or "]" in value or value.count(":") > 1:
            return False
        if ":" in value:
            host, port_text = value.rsplit(":", 1)
        else:
            host, port_text = value, None

    if port_text is not None:
        if (
            not port_text
            or not port_text.isascii()
            or not port_text.isdecimal()
        ):
            return False
        port = int(port_text)
        if not 1 <= port <= 65535:
            return False
    return _is_explicit_loopback_host(host)


def _request_has_one_loopback_host(request: Request) -> bool:
    headers = request.headers
    getlist = getattr(headers, "getlist", None)
    if callable(getlist):
        values = list(getlist("host"))
    else:
        value = headers.get("Host")
        if value is None:
            value = headers.get("host")
        values = [] if value is None else [value]
    return len(values) == 1 and _loopback_host_authority(values[0])


def _setup_request_allowed(request: Request) -> bool:
    """Allow password bootstrap locally, or remotely with an explicit secret."""
    configured_token = os.environ.get("OMBRE_SETUP_TOKEN", "").strip()
    supplied_token = request.headers.get("X-Ombre-Setup-Token", "").strip()
    if configured_token and supplied_token and sh._constant_time_text_equal(
        configured_token, supplied_token
    ):
        return True
    # Forwarding headers mean the browser is not the direct loopback peer.
    # Treat them conservatively even if the reverse proxy itself is local.
    if any(
        request.headers.get(name)
        for name in (
            "Forwarded",
            "X-Forwarded-For",
            "X-Forwarded-Host",
            "X-Forwarded-Proto",
        )
    ):
        return False
    client = getattr(request, "client", None)
    host = str(getattr(client, "host", "") or "").strip()
    return _is_explicit_loopback_host(host) and _request_has_one_loopback_host(
        request
    )


def _revoke_mcp_grants() -> None:
    # Delayed import avoids an auth<->oauth module initialization cycle.
    from .oauth import revoke_all_mcp_grants

    revoke_all_mcp_grants()


def _commit_password_rotation(
    proof: sh.CredentialProof,
    password_hash: str,
) -> str | None:
    """Commit one password rotation in a crash-safe, stale-proof-safe order.

    Persisted sessions are revoked first, then OAuth grants, and only then is
    the new password published.  Therefore an OAuth persistence failure can
    never leave a new password paired with old access/refresh grants.  The
    credential guard also prevents code/token issuance from entering between
    these file commits.
    """
    with sh._credential_state_guard():
        if not sh._credential_proof_matches_locked(proof):
            return None
        sh._revoke_all_sessions()
        _revoke_mcp_grants()
        committed = sh._save_prehashed_password(
            password_hash,
            keep_qa=True,
            advance_generation=False,
        )
        if not committed:  # pragma: no cover - guard makes this unreachable
            raise sh.CredentialChangedError("credential changed during rotation")
        return sh._create_session()


def _commit_recovery_code_rotation(code: str, password_hash: str) -> str | None:
    """Consume exactly one recovery code while rotating all auth state."""
    code_digest = recovery_code_hash(code)
    if not code_digest:
        return None
    with sh._credential_state_guard():
        data = sh._read_auth_data_locked(strict=True)
        configured = data.get("recovery_code_hashes", [])
        if not isinstance(configured, list):
            return None
        remaining: list[str] = []
        consumed = False
        for stored in configured:
            if not isinstance(stored, str):
                continue
            if not consumed and sh.hmac.compare_digest(code_digest, stored):
                consumed = True
            else:
                remaining.append(stored)
        if not consumed:
            return None
        sh._revoke_all_sessions()
        _revoke_mcp_grants()
        if not sh._save_prehashed_password(
            password_hash,
            recovery_code_hashes=remaining,
            advance_generation=False,
        ):
            return None
        return sh._create_session()


def _password_error(password: str) -> str | None:
    return sh._password_policy_error(password)


def _persistence_failure_response(action: str, error: Exception) -> Response:
    """Return an explicit fail-closed result without leaking private details."""
    from starlette.responses import JSONResponse

    sh.logger.error("[auth] %s could not be committed: %s", action, error)
    return JSONResponse(
        {"error": "安全状态无法持久化，请检查存储后重试"},
        status_code=503,
        headers={"Retry-After": "5", "Cache-Control": "no-store"},
    )


def register(mcp) -> None:
    """把 /auth/* 路由注册到传入的 FastMCP 实例。"""
    # Environment passwords are the only credential path not created through
    # /auth/setup, so validate them before exposing any authentication route.
    sh._validate_environment_password()

    @mcp.custom_route("/auth/status", methods=["GET"])
    async def auth_status(request: Request) -> Response:
        """Return auth state (authenticated, setup_needed)."""
        from starlette.responses import JSONResponse
        return JSONResponse(
            {
                "authenticated": sh._is_authenticated(request),
                "setup_needed": sh._is_setup_needed(),
            },
            headers={"Cache-Control": "no-store"},
        )

    @mcp.custom_route("/auth/setup", methods=["POST"])
    async def auth_setup_endpoint(request: Request) -> Response:
        """Initial password setup (only when no password is configured)."""
        from starlette.responses import JSONResponse
        if not sh._is_setup_needed():
            return JSONResponse({"error": "Already configured"}, status_code=400)
        if not _setup_request_allowed(request):
            return JSONResponse(
                {
                    "error": (
                        "Initial password setup is local-only. Set "
                        "OMBRE_DASHBOARD_PASSWORD before public deployment, or "
                        "supply X-Ombre-Setup-Token matching OMBRE_SETUP_TOKEN."
                    )
                },
                status_code=403,
            )
        retry = sh._login_retry_after(request)
        if retry:
            return JSONResponse(
                {"error": f"尝试过于频繁，请 {retry} 秒后再试"},
                status_code=429,
                headers={"Retry-After": str(retry)},
            )
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "Invalid JSON"}, status_code=400)
        body = _json_object(body)
        if body is None:
            return JSONResponse({"error": "JSON body must be an object"}, status_code=400)
        password = body.get("password", "")
        if not isinstance(password, str):
            return JSONResponse({"error": "password must be a string"}, status_code=400)
        password = password.strip()
        if error := _password_error(password):
            return JSONResponse({"error": error}, status_code=400, headers={"Cache-Control": "no-store"})
        # Two public first-run requests can both pass the optimistic check
        # above while either one is awaiting/parsing its body.  Recheck and
        # initialize under one process-wide lock so exactly one password and
        # one administrator session can win the bootstrap race.
        async with _setup_lock:
            if not sh._is_setup_needed():
                return JSONResponse({"error": "Already configured"}, status_code=400)
            try:
                sh._revoke_all_sessions()
                _revoke_mcp_grants()
                password_hash = await _run_password_work(sh._hash_secret, password)
                recovery_codes = generate_recovery_codes(RECOVERY_CODE_COUNT)
                sh._save_prehashed_password(
                    password_hash,
                    recovery_code_hashes=[recovery_code_hash(code) for code in recovery_codes],
                )
                token = sh._create_session()
            except Exception as e:
                return _persistence_failure_response("initial setup", e)
        resp = JSONResponse({"ok": True, "recovery_codes": recovery_codes}, headers={"Cache-Control": "no-store", "Pragma": "no-cache"})
        sh._set_session_cookie(resp, token, request)
        return resp

    @mcp.custom_route("/auth/login", methods=["POST"])
    async def auth_login(request: Request) -> Response:
        """Login with password."""
        from starlette.responses import JSONResponse
        retry = sh._login_retry_after(request)
        if retry:
            return JSONResponse(
                {"error": f"尝试过于频繁，请 {retry} 秒后再试"},
                status_code=429,
                headers={"Retry-After": str(retry)},
            )
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "Invalid JSON"}, status_code=400)
        body = _json_object(body)
        if body is None:
            sh._record_login_failure(request)
            return JSONResponse({"error": "JSON body must be an object"}, status_code=400)
        password = body.get("password", "")
        if not isinstance(password, str) or len(password) > _MAX_PASSWORD_CHARS:
            sh._record_login_failure(request)
            return JSONResponse({"error": "密码格式无效"}, status_code=400)
        global_retry = sh._reserve_global_login_attempt()
        if global_retry:
            return JSONResponse(
                {"error": f"登录服务繁忙，请 {global_retry} 秒后重试"},
                status_code=429,
                headers={"Retry-After": str(global_retry)},
            )
        verified, queued_retry = await _run_public_password_verification(
            request, sh._verify_password_for_rotation, password
        )
        if queued_retry:
            return JSONResponse(
                {"error": f"尝试过于频繁，请 {queued_retry} 秒后再试"},
                status_code=429,
                headers={"Retry-After": str(queued_retry)},
            )
        if verified:
            # Short file-backed credentials from <=2.15 can be verified once
            # only to force an upgrade; never turn that verification into a
            # normal Dashboard session.
            if len(password) < sh._MIN_PASSWORD_CHARS:
                try:
                    if not sh._mark_password_upgrade_required(verified):
                        return JSONResponse({"error": "密码已变更，请重新登录"}, status_code=409, headers={"Cache-Control": "no-store"})
                except Exception as e:
                    return _persistence_failure_response("password upgrade requirement", e)
                return JSONResponse(
                    {"error": "当前密码需要升级", "error_code": "password_upgrade_required"},
                    status_code=428,
                    headers={"Cache-Control": "no-store"},
                )
            sh._record_login_success(request)
            try:
                token = sh._create_session_for_credential(verified)
            except Exception as e:
                return _persistence_failure_response("login session", e)
            if token is None:
                return JSONResponse(
                    {"error": "密码已变更，请重新登录"},
                    status_code=409,
                    headers={"Cache-Control": "no-store"},
                )
            resp = JSONResponse({"ok": True}, headers={"Cache-Control": "no-store"})
            sh._set_session_cookie(resp, token, request)
            return resp
        sh._record_login_failure(request)
        return JSONResponse({"error": "密码错误"}, status_code=401)

    @mcp.custom_route("/auth/logout", methods=["POST"])
    async def auth_logout(request: Request) -> Response:
        """Invalidate session."""
        from starlette.responses import JSONResponse
        token = request.cookies.get("ombre_session")
        if token:
            try:
                sh._revoke_session(token)
            except Exception as e:
                return _persistence_failure_response("logout", e)
        resp = JSONResponse({"ok": True})
        resp.delete_cookie("ombre_session")
        return resp

    @mcp.custom_route("/auth/change-password", methods=["POST"])
    async def auth_change_password(request: Request) -> Response:
        """Change dashboard password (requires current password)."""
        from starlette.responses import JSONResponse
        err = sh._require_auth(request)
        if err:
            return err
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "Invalid JSON"}, status_code=400)
        body = _json_object(body)
        if body is None:
            return JSONResponse({"error": "JSON body must be an object"}, status_code=400)
        if os.environ.get("OMBRE_DASHBOARD_PASSWORD", ""):
            return JSONResponse({"error": "当前使用环境变量密码，请直接修改 OMBRE_DASHBOARD_PASSWORD"}, status_code=400, headers={"Cache-Control": "no-store"})
        current = body.get("current", "")
        new_pwd = body.get("new", "")
        if not isinstance(current, str) or not isinstance(new_pwd, str):
            return JSONResponse({"error": "密码格式无效"}, status_code=400)
        new_pwd = new_pwd.strip()
        if len(current) > _MAX_PASSWORD_CHARS:
            return JSONResponse({"error": "当前密码格式无效"}, status_code=400)
        proof = await _run_password_work(
            sh._verify_password_for_rotation, current
        )
        if proof is None:
            return JSONResponse({"error": "当前密码错误"}, status_code=401)
        if error := _password_error(new_pwd):
            return JSONResponse({"error": error}, status_code=400, headers={"Cache-Control": "no-store"})
        try:
            password_hash = await _run_password_work(sh._hash_secret, new_pwd)
            token = _commit_password_rotation(proof, password_hash)
        except Exception as e:
            return _persistence_failure_response("password change", e)
        if token is None:
            return JSONResponse(
                {"error": "凭据已变更，请重试"},
                status_code=409,
                headers={"Cache-Control": "no-store"},
            )
        resp = JSONResponse({"ok": True}, headers={"Cache-Control": "no-store"})
        sh._set_session_cookie(resp, token, request)
        return resp

    @mcp.custom_route("/auth/recovery-question", methods=["GET"])
    async def auth_recovery_question(request: Request) -> Response:
        """Retired in 2.16: knowledge-based recovery is unsafe."""
        return Response(status_code=410, headers={"Cache-Control": "no-store"})

    @mcp.custom_route("/auth/recover", methods=["POST"])
    async def auth_recover(request: Request) -> Response:
        """Reset a file-backed password by atomically consuming a recovery code."""
        from starlette.responses import JSONResponse
        retry = sh._login_retry_after(request)
        if retry:
            return JSONResponse(
                {"error": f"尝试过于频繁，请 {retry} 秒后再试"},
                status_code=429,
                headers={"Retry-After": str(retry)},
            )
        try:
            body = await request.json()
        except Exception:
            sh._record_login_failure(request)
            return JSONResponse({"error": "Invalid JSON"}, status_code=400, headers={"Cache-Control": "no-store"})
        body = _json_object(body)
        if body is None:
            sh._record_login_failure(request)
            return JSONResponse({"error": "JSON body must be an object"}, status_code=400)
        if os.environ.get("OMBRE_DASHBOARD_PASSWORD", ""):
            return JSONResponse({"error": "当前使用环境变量密码，无法使用恢复码重置"}, status_code=400, headers={"Cache-Control": "no-store"})
        recovery_code = body.get("recovery_code", "")
        new_pwd = body.get("new_password", "")
        if not isinstance(recovery_code, str) or not isinstance(new_pwd, str):
            sh._record_login_failure(request)
            return JSONResponse({"error": "恢复参数格式无效"}, status_code=400)
        new_pwd = new_pwd.strip()
        if len(recovery_code) > 256 or not recovery_code_hash(recovery_code):
            sh._record_login_failure(request)
            return JSONResponse({"error": "恢复码格式无效"}, status_code=400)
        if error := _password_error(new_pwd):
            sh._record_login_failure(request)
            return JSONResponse({"error": error}, status_code=400, headers={"Cache-Control": "no-store"})
        global_retry = sh._reserve_global_login_attempt()
        if global_retry:
            return JSONResponse(
                {"error": f"登录服务繁忙，请 {global_retry} 秒后重试"},
                status_code=429,
                headers={"Retry-After": str(global_retry)},
            )
        if not sh._recovery_code_is_configured(recovery_code):
            sh._record_login_failure(request)
            return JSONResponse({"error": "恢复码不正确或已失效"}, status_code=401, headers={"Cache-Control": "no-store"})
        try:
            password_hash = await _run_password_work(sh._hash_secret, new_pwd)
            token = _commit_recovery_code_rotation(recovery_code, password_hash)
        except Exception as e:
            return _persistence_failure_response("password recovery", e)
        if token is None:
            return JSONResponse(
                {"error": "恢复凭据已变更，请重试"},
                status_code=409,
                headers={"Cache-Control": "no-store"},
            )
        sh._record_login_success(request)
        resp = JSONResponse({"ok": True}, headers={"Cache-Control": "no-store"})
        sh._set_session_cookie(resp, token, request)
        return resp

    @mcp.custom_route("/auth/security-question", methods=["POST"])
    async def auth_set_security_question(request: Request) -> Response:
        """Retired in 2.16: knowledge-based recovery is unsafe."""
        return Response(status_code=410, headers={"Cache-Control": "no-store"})

    @mcp.custom_route("/auth/recovery-codes/regenerate", methods=["POST"])
    async def auth_recovery_codes_regenerate(request: Request) -> Response:
        """Replace all recovery codes after an authenticated password proof."""
        from starlette.responses import JSONResponse
        err = sh._require_auth(request)
        if err:
            return err
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "Invalid JSON"}, status_code=400)
        body = _json_object(body)
        if body is None:
            return JSONResponse({"error": "JSON body must be an object"}, status_code=400)
        if os.environ.get("OMBRE_DASHBOARD_PASSWORD", ""):
            return JSONResponse({"error": "当前使用环境变量密码，无法管理恢复码"}, status_code=400, headers={"Cache-Control": "no-store"})
        current = body.get("current_password", "")
        if not isinstance(current, str) or len(current) > _MAX_PASSWORD_CHARS:
            return JSONResponse({"error": "当前密码格式无效"}, status_code=400, headers={"Cache-Control": "no-store"})
        generation = sh._authenticated_credential_generation(request)
        if generation is None:
            return JSONResponse({"error": "Unauthorized"}, status_code=401)
        try:
            proof = await _run_password_work(sh._verify_password_for_rotation, current)
            if proof is None or proof.generation != generation:
                return JSONResponse({"error": "当前密码错误"}, status_code=401, headers={"Cache-Control": "no-store"})
            codes = generate_recovery_codes(RECOVERY_CODE_COUNT)
            saved = sh._replace_recovery_code_hashes(
                [recovery_code_hash(code) for code in codes], expected_generation=generation
            )
        except Exception as e:
            return _persistence_failure_response("recovery code update", e)
        if not saved:
            return JSONResponse(
                {"error": "凭据已变更，请重试"},
                status_code=409,
                headers={"Cache-Control": "no-store"},
            )
        return JSONResponse({"ok": True, "recovery_codes": codes}, headers={"Cache-Control": "no-store", "Pragma": "no-cache"})

    @mcp.custom_route("/auth/upgrade-password", methods=["POST"])
    async def auth_upgrade_password(request: Request) -> Response:
        """Upgrade a legacy short file password without issuing an old session."""
        from starlette.responses import JSONResponse
        retry = sh._login_retry_after(request)
        if retry:
            return JSONResponse({"error": f"尝试过于频繁，请 {retry} 秒后再试"}, status_code=429, headers={"Retry-After": str(retry), "Cache-Control": "no-store"})
        try:
            body = _json_object(await request.json())
        except Exception:
            body = None
        if body is None:
            sh._record_login_failure(request)
            return JSONResponse({"error": "JSON body must be an object"}, status_code=400, headers={"Cache-Control": "no-store"})
        if os.environ.get("OMBRE_DASHBOARD_PASSWORD", ""):
            return JSONResponse({"error": "当前使用环境变量密码，请直接修改 OMBRE_DASHBOARD_PASSWORD"}, status_code=400, headers={"Cache-Control": "no-store"})
        current, new_password = body.get("current_password", ""), body.get("new_password", "")
        if not isinstance(current, str) or not isinstance(new_password, str):
            sh._record_login_failure(request)
            return JSONResponse({"error": "密码格式无效"}, status_code=400, headers={"Cache-Control": "no-store"})
        new_password = new_password.strip()
        if error := _password_error(new_password):
            sh._record_login_failure(request)
            return JSONResponse({"error": error}, status_code=400, headers={"Cache-Control": "no-store"})
        global_retry = sh._reserve_global_login_attempt()
        if global_retry:
            return JSONResponse({"error": f"登录服务繁忙，请 {global_retry} 秒后重试"}, status_code=429, headers={"Retry-After": str(global_retry), "Cache-Control": "no-store"})
        verified, queued_retry = await _run_public_password_verification(request, sh._verify_password_for_rotation, current)
        if queued_retry:
            return JSONResponse({"error": f"尝试过于频繁，请 {queued_retry} 秒后再试"}, status_code=429, headers={"Retry-After": str(queued_retry), "Cache-Control": "no-store"})
        if verified is None or not sh._is_password_upgrade_required(verified):
            sh._record_login_failure(request)
            return JSONResponse({"error": "当前密码不需要升级或不正确"}, status_code=401, headers={"Cache-Control": "no-store"})
        try:
            token = _commit_password_rotation(verified, await _run_password_work(sh._hash_secret, new_password))
        except Exception as e:
            return _persistence_failure_response("password upgrade", e)
        if token is None:
            return JSONResponse({"error": "凭据已变更，请重试"}, status_code=409, headers={"Cache-Control": "no-store"})
        sh._record_login_success(request)
        response = JSONResponse({"ok": True}, headers={"Cache-Control": "no-store"})
        sh._set_session_cookie(response, token, request)
        return response
