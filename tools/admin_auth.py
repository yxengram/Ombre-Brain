#!/usr/bin/env python3
"""Offline Dashboard authentication recovery administration.

This command intentionally never accepts a password or recovery code through
argv.  Its only mutation resets a file-backed Dashboard password and prints a
fresh recovery-code set once to the invoking terminal.
"""

from __future__ import annotations

import argparse
import getpass
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from ombrebrain.security.recovery import (  # noqa: E402
    RECOVERY_CODE_COUNT,
    generate_recovery_codes,
    recovery_code_hash,
)
from utils import load_config  # noqa: E402
from web import _shared as sh  # noqa: E402


def _read_new_password() -> str:
    first = getpass.getpass("新 Dashboard 密码（15-1024 位）：")
    second = getpass.getpass("再次输入新 Dashboard 密码：")
    if first != second:
        raise ValueError("两次密码不一致")
    error = sh._password_policy_error(first)
    if error:
        raise ValueError(error)
    return first


def reset_password(config_path: str) -> int:
    if os.environ.get("OMBRE_DASHBOARD_PASSWORD", ""):
        print("拒绝重置：当前使用 OMBRE_DASHBOARD_PASSWORD，请在部署环境中修改该变量。", file=sys.stderr)
        return 2
    config = load_config(config_path)
    sh.init(config)
    password = _read_new_password()
    codes = generate_recovery_codes(RECOVERY_CODE_COUNT)
    try:
        with sh._credential_state_guard():
            sh._revoke_all_sessions()
            # Import only after config setup so OAuth persistence targets this vault.
            from web.oauth import revoke_all_mcp_grants

            revoke_all_mcp_grants()
            sh._save_prehashed_password(
                sh._hash_secret(password),
                recovery_code_hashes=[recovery_code_hash(code) for code in codes],
                advance_generation=False,
            )
    except Exception as exc:
        print(f"重置失败，未报告成功：{exc}", file=sys.stderr)
        return 1
    print("密码已重置。以下恢复码只显示这一次，请离线保存：")
    print("\n".join(codes))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Ombre Brain offline auth administration")
    subparsers = parser.add_subparsers(dest="command", required=True)
    reset = subparsers.add_parser("reset-password", help="reset file-backed Dashboard password")
    reset.add_argument("--config", required=True, help="path to config.yaml")
    args = parser.parse_args()
    if args.command == "reset-password":
        return reset_password(args.config)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
