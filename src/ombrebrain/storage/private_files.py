"""Small, explicit helpers for files that may contain private vault data.

The helpers deliberately operate on paths supplied by the caller.  They never
walk arbitrary trees or follow symbolic links, which makes them safe to use in
startup diagnostics and migrations as well as write paths.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path
from typing import Any

PRIVATE_DIR_MODE = 0o700
PRIVATE_FILE_MODE = 0o600


def _posix_result(path: Path, expected: int, kind: str) -> dict[str, Any]:
    try:
        mode = stat.S_IMODE(path.stat(follow_symlinks=False).st_mode)
    except OSError as exc:
        return {"path": str(path), "kind": kind, "ok": False, "error": str(exc)}
    return {
        "path": str(path),
        "kind": kind,
        "ok": mode == expected,
        "mode": oct(mode),
        "expected_mode": oct(expected),
    }


def ensure_private_directory(path: str | Path, *, create: bool = True) -> dict[str, Any]:
    """Create or tighten one non-symlink private directory.

    On Windows ``chmod`` does not express POSIX ACL semantics.  We perform the
    best available operation but return an explicit diagnostic rather than
    claiming an unverified ``0700`` guarantee.
    """

    target = Path(path)
    if target.is_symlink():
        raise ValueError(f"refuse to secure symbolic-link directory: {target}")
    if create:
        target.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIR_MODE)
    if not target.is_dir():
        raise ValueError(f"private directory is not a directory: {target}")
    if os.name == "nt":
        try:
            os.chmod(target, PRIVATE_DIR_MODE)
        except OSError as exc:
            return {"path": str(target), "kind": "directory", "ok": False, "platform": "windows", "warning": str(exc)}
        return {"path": str(target), "kind": "directory", "ok": False, "platform": "windows", "warning": "POSIX mode cannot verify Windows ACL"}
    os.chmod(target, PRIVATE_DIR_MODE, follow_symlinks=False)
    return _posix_result(target, PRIVATE_DIR_MODE, "directory")


def ensure_private_file(path: str | Path, *, required: bool = False) -> dict[str, Any]:
    """Tighten one existing regular file without following symbolic links."""

    target = Path(path)
    try:
        info = target.lstat()
    except FileNotFoundError:
        if required:
            raise
        return {"path": str(target), "kind": "file", "ok": True, "missing": True}
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise ValueError(f"refuse to secure non-regular file: {target}")
    if os.name == "nt":
        try:
            os.chmod(target, PRIVATE_FILE_MODE)
        except OSError as exc:
            return {"path": str(target), "kind": "file", "ok": False, "platform": "windows", "warning": str(exc)}
        return {"path": str(target), "kind": "file", "ok": False, "platform": "windows", "warning": "POSIX mode cannot verify Windows ACL"}
    os.chmod(target, PRIVATE_FILE_MODE, follow_symlinks=False)
    return _posix_result(target, PRIVATE_FILE_MODE, "file")


def audit_private_paths(paths: list[str | Path]) -> list[dict[str, Any]]:
    """Non-mutating permission diagnostics for explicitly selected paths."""

    results: list[dict[str, Any]] = []
    for raw_path in paths:
        path = Path(raw_path)
        if path.is_symlink():
            results.append({"path": str(path), "ok": False, "error": "symbolic link"})
        elif path.is_dir():
            results.append(_posix_result(path, PRIVATE_DIR_MODE, "directory") if os.name != "nt" else {"path": str(path), "ok": False, "platform": "windows", "warning": "POSIX mode cannot verify Windows ACL"})
        else:
            results.append(_posix_result(path, PRIVATE_FILE_MODE, "file") if os.name != "nt" else {"path": str(path), "ok": False, "platform": "windows", "warning": "POSIX mode cannot verify Windows ACL"})
    return results


def ensure_private_sqlite_files(path: str | Path) -> list[dict[str, Any]]:
    """Repair an SQLite database and its optional sidecars without walking."""

    database = Path(path)
    results = [ensure_private_file(database, required=True)]
    for suffix in ("-wal", "-shm"):
        sidecar = Path(f"{database}{suffix}")
        if sidecar.exists() or sidecar.is_symlink():
            results.append(ensure_private_file(sidecar, required=True))
    return results
