#!/usr/bin/env python3
"""Read-only deployment security diagnostics for Ombre Brain.

The command intentionally reports logical resource names instead of absolute
paths, and never serializes configured secret values.  It is a pre-flight
diagnostic, not a repair or a substitute for operating-system hardening.
"""

from __future__ import annotations

import argparse
import json
import os
import stat
import sys
from pathlib import Path
from typing import Any, Iterable

try:
    import yaml
except ImportError:  # pragma: no cover - production dependencies include PyYAML
    yaml = None


_REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
_SRC_ROOT = _REPOSITORY_ROOT / "src"
if str(_SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(_SRC_ROOT))

from ombrebrain.security.outbound_url import OutboundURLRejected, validate_outbound_url  # noqa: E402
from ombrebrain.security.release_signing import (  # noqa: E402
    OFFICIAL_RELEASE_KEY_ID,
    signing_available,
)


_SECRET_FIELDS = (
    ("mcp_token",),
    ("hooks", "token"),
    ("dehydration", "api_key"),
    ("embedding", "api_key"),
    ("github_sync", "token"),
)
_SECRET_ENVIRONMENT = (
    "OMBRE_MCP_TOKEN",
    "OMBRE_COMPRESS_API_KEY",
    "OMBRE_EMBED_API_KEY",
    "OMBRE_DASHBOARD_PASSWORD",
    "OMBRE_HOOK_TOKEN",
    "OMBRE_GITHUB_TOKEN",
    # Backward-compatible names accepted by the runtime.
    "OMBRE_API_KEY",
    "PASSWORD",
)
_VAULT_FILES = (
    ".dashboard_auth.json",
    ".dashboard_sessions.json",
    ".dashboard_mcp_tokens.json",
    ".oauth_clients.json",
    ".tunnel_config.json",
    "embeddings.db",
    "dehydration_cache.db",
)


def _nested(mapping: dict[str, Any], path: Iterable[str]) -> Any:
    value: Any = mapping
    for part in path:
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    return value


def _finding(
    findings: list[dict[str, str]], code: str, severity: str, message_zh: str, remediation_zh: str,
) -> None:
    findings.append(
        {
            "code": code,
            "severity": severity,
            "message_zh": message_zh,
            "remediation_zh": remediation_zh,
        }
    )


def _safe_config(path: Path, findings: list[dict[str, str]]) -> dict[str, Any]:
    if not path.is_file():
        _finding(findings, "OB-DIAG-CONFIG-MISSING", "high", "配置文件不存在或不是普通文件。", "通过 --config 指向部署配置文件。")
        return {}
    if path.is_symlink():
        _finding(findings, "OB-DIAG-CONFIG-SYMLINK", "medium", "配置文件是符号链接。", "部署配置应使用受控普通文件，并限制其父目录写权限。")
    if yaml is None:
        _finding(findings, "OB-DIAG-YAML-UNAVAILABLE", "high", "无法加载 YAML 解析器。", "安装锁定的生产依赖后重新运行诊断。")
        return {}
    try:
        loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, yaml.YAMLError):
        _finding(findings, "OB-DIAG-CONFIG-INVALID", "high", "配置文件无法作为 YAML 对象安全读取。", "修正 YAML 格式与读取权限。")
        return {}
    if loaded is None:
        return {}
    if not isinstance(loaded, dict):
        _finding(findings, "OB-DIAG-CONFIG-TYPE", "high", "配置顶层必须是对象。", "将配置顶层改为 YAML 映射。")
        return {}
    return loaded


def _resolve_config_path(config_path: str | os.PathLike[str]) -> Path:
    raw = Path(config_path).expanduser()
    return raw if raw.is_absolute() else Path.cwd() / raw


def _config_relative(config_path: Path, value: object, default: str) -> Path:
    candidate = Path(str(value or default)).expanduser()
    return candidate if candidate.is_absolute() else config_path.parent / candidate


def _inspect_file_policy(path: Path, logical_name: str, findings: list[dict[str, str]]) -> dict[str, Any]:
    result: dict[str, Any] = {"name": logical_name, "exists": False, "symlink": False, "mode": "unavailable"}
    try:
        info = path.lstat()
    except FileNotFoundError:
        return result
    except OSError:
        _finding(findings, "OB-DIAG-PATH-UNREADABLE", "medium", f"{logical_name} 无法检查。", "确认服务账户可读取受控数据目录。")
        return result
    result["exists"] = True
    result["symlink"] = stat.S_ISLNK(info.st_mode)
    result["mode"] = format(stat.S_IMODE(info.st_mode), "04o")
    if result["symlink"]:
        _finding(findings, "OB-DIAG-SYMLINK", "high", f"{logical_name} 是符号链接。", "不要让密钥、会话、数据库或 vault 指向不受控位置。")
    if os.name != "nt" and stat.S_IMODE(info.st_mode) & 0o077:
        _finding(findings, "OB-DIAG-PERMISSIVE-MODE", "medium", f"{logical_name} 对组或其他用户可访问。", "将私密文件设为 0600、目录设为 0700，并使用专用服务账户。")
    return result


def _is_loopback_bind(value: object) -> bool:
    host = str(value or "").strip().lower().strip("[]")
    return host in {"localhost", "127.0.0.1", "::1"}


def _parse_bool(value: object, *, default: bool) -> bool:
    """Match the deployment parser's strict handling of quoted YAML booleans."""

    if isinstance(value, bool):
        return value
    normalized = str(value or "").strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def _provider_values(config: dict[str, Any]) -> tuple[tuple[str, object], ...]:
    return (
        (
            "dehydration_endpoint",
            os.environ.get("OMBRE_COMPRESS_BASE_URL") or _nested(config, ("dehydration", "base_url")),
        ),
        (
            "embedding_endpoint",
            os.environ.get("OMBRE_EMBED_BASE_URL") or _nested(config, ("embedding", "base_url")),
        ),
        ("webhook_endpoint", os.environ.get("OMBRE_HOOK_URL")),
    )


def inspect_security(config_path: str | os.PathLike[str] = "config.yaml") -> dict[str, Any]:
    """Return a JSON-safe, read-only deployment-security assessment."""

    findings: list[dict[str, str]] = []
    config_file = _resolve_config_path(config_path)
    config = _safe_config(config_file, findings)
    vault_override = os.environ.get("OMBRE_BUCKETS_DIR") or os.environ.get("OMBRE_VAULT_DIR")
    vault_path = _config_relative(config_file, vault_override or config.get("buckets_dir"), "buckets")
    media_override = os.environ.get("OMBRE_MEDIA_DIR", "").strip()
    media_path = _config_relative(config_file, media_override, str(vault_path / "_media")) if media_override else vault_path / "_media"
    db_path = vault_path / "embeddings.db"
    cache_path = vault_path / "dehydration_cache.db"

    # Docker has a distinct external bind boundary; report it when supplied,
    # otherwise use the actual server listener's OMBRE_BIND_HOST contract.
    bind_host = (
        os.environ.get("OMBRE_BIND_ADDRESS")
        or os.environ.get("OMBRE_BIND_HOST")
        # Diagnostic fallback only: this value is classified as remote below;
        # the tool never opens a listener.
        or config.get("bind_host", "0.0.0.0")  # nosec B104
    )
    auth_required = _parse_bool(
        os.environ.get("OMBRE_MCP_REQUIRE_AUTH", config.get("mcp_require_auth", True)),
        default=True,
    )
    if not auth_required and not _is_loopback_bind(bind_host):
        _finding(
            findings,
            "OB-DIAG-OPEN-REMOTE-MCP",
            "critical",
            "MCP 已免鉴权且监听地址不是回环地址。",
            "启用 mcp_require_auth，或仅监听 localhost/回环网络。",
        )

    secret_status = {
        ".".join(parts): bool(_nested(config, parts)) for parts in _SECRET_FIELDS
    }
    secret_status["environment"] = {
        name: bool(os.environ.get(name)) for name in _SECRET_ENVIRONMENT
    }
    resources = [
        _inspect_file_policy(vault_path, "vault", findings),
        _inspect_file_policy(media_path, "media", findings),
        _inspect_file_policy(db_path, "embeddings_db", findings),
        _inspect_file_policy(cache_path, "dehydration_cache_db", findings),
    ]
    resources.extend(
        _inspect_file_policy(vault_path / filename, f"vault/{filename}", findings)
        for filename in _VAULT_FILES
    )

    providers: list[dict[str, Any]] = []
    for logical_name, value in _provider_values(config):
        if not value:
            providers.append({"name": logical_name, "configured": False, "accepted": None})
            continue
        try:
            normalized = validate_outbound_url(value, purpose="security-diagnostics")
        except OutboundURLRejected:
            providers.append({"name": logical_name, "configured": True, "accepted": False})
            _finding(findings, "OB-DIAG-OUTBOUND-URL", "high", f"{logical_name} 不符合出站 URL 策略。", "使用可信 HTTPS 端点；本地 HTTP 仅使用受控的明确允许地址。")
        else:
            providers.append({"name": logical_name, "configured": True, "accepted": True, "scheme": normalized.split(":", 1)[0]})

    versions: dict[str, str] = {}
    for logical_name, version_path in (("VERSION", _REPOSITORY_ROOT / "VERSION"), ("src/VERSION", _SRC_ROOT / "VERSION")):
        try:
            versions[logical_name] = version_path.read_text(encoding="utf-8").strip()[:80]
        except OSError:
            versions[logical_name] = "unavailable"
    if versions["VERSION"] != versions["src/VERSION"]:
        _finding(findings, "OB-DIAG-VERSION-MISMATCH", "medium", "VERSION 与 src/VERSION 不一致。", "发布前同步两个版本文件并重新生成更新清单。")
    update_signing = {
        "signing_available": signing_available(),
        "key_id": OFFICIAL_RELEASE_KEY_ID if signing_available() else None,
    }
    if not update_signing["signing_available"]:
        _finding(
            findings,
            "OB-DIAG-UPDATE-SIGNING-UNAVAILABLE",
            "medium",
            "热更新签名公钥尚未配置；热更新应保持禁用。",
            "在正式发布前配置受控的 Ed25519 公钥，并验证签名更新流程。",
        )

    severity_rank = {"critical": 4, "high": 3, "medium": 2, "low": 1}
    max_severity = max((severity_rank[item["severity"]] for item in findings), default=0)
    return {
        "schema_version": "ombrebrain.security-diagnostics.v1",
        "ok": max_severity < severity_rank["high"],
        "summary_zh": "未发现高风险配置问题。" if max_severity < severity_rank["high"] else "发现需要处理的安全配置问题。",
        "auth": {"mcp_require_auth": auth_required, "bind_scope": "loopback" if _is_loopback_bind(bind_host) else "non_loopback"},
        "secrets": secret_status,
        "resources": resources,
        "providers": providers,
        "versions": versions,
        "update_signing": update_signing,
        "findings": findings,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only Ombre Brain security diagnostics")
    parser.add_argument("--config", default="config.yaml", help="YAML deployment config path (default: config.yaml)")
    parser.add_argument("--pretty", action="store_true", help="pretty-print JSON")
    args = parser.parse_args(argv)
    report = inspect_security(args.config)
    print(json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2 if args.pretty else None))
    return 0 if report["ok"] else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
