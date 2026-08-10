"""OB 媒体持久化存储。

本模块把 MCP 调用携带的服务器可读临时文件或 Base64 数据复制到持久媒体目录，
并返回可写入 Markdown frontmatter 的稳定元数据。它不理解记忆内容、不操作桶文件，
也不会因为记忆归档而删除媒体。对外暴露 ``MediaStore`` 和
``MediaPersistenceError``。
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import mimetypes
import os
import re
import stat
import tempfile
from pathlib import Path
from collections.abc import Callable
from typing import Any, Iterable

from .private_files import ensure_private_directory, ensure_private_file

_SAFE_SUFFIX = re.compile(r"^\.[a-zA-Z0-9]{1,10}$")
_DEFAULT_MAX_MEDIA_BYTES = 25 * 1024 * 1024


class MediaPersistenceError(ValueError):
    """媒体无法在 OB 服务器上永久保存。"""


class MediaStore:
    """把媒体复制到持久目录，并生成稳定引用。"""

    def __init__(
        self,
        vault_dir: str,
        media_dir: str,
        *,
        max_bytes: int = _DEFAULT_MAX_MEDIA_BYTES,
        allow_server_path: bool | Callable[[], bool] = False,
        allowed_path_roots: Iterable[str | os.PathLike[str]] | Callable[[], Iterable[str | os.PathLike[str]]] = (),
        allowed_roots: Iterable[str | os.PathLike[str]] | Callable[[], Iterable[str | os.PathLike[str]]] | None = None,
    ) -> None:
        self.vault_dir = Path(vault_dir).resolve()
        self.media_dir = Path(media_dir).resolve()
        expected_media_dir = self.vault_dir / "_media"
        if self.media_dir != expected_media_dir:
            raise MediaPersistenceError(
                "媒体目录必须是记忆目录内的 _media；外部媒体目录无法被安全备份。"
            )
        self.max_bytes = max(1, int(max_bytes))
        if allowed_roots is not None:
            if allowed_path_roots != ():
                raise MediaPersistenceError("媒体允许目录只能配置一次。")
            allowed_path_roots = allowed_roots
        self._allow_server_path_policy = allow_server_path
        self._allowed_path_roots_policy = allowed_path_roots
        ensure_private_directory(self.media_dir)

    @staticmethod
    def resolve_allowed_path_roots(
        roots: Iterable[str | os.PathLike[str]],
    ) -> tuple[Path, ...]:
        """Resolve existing, real directories used as server-path import roots.

        This is intentionally an explicit policy boundary.  Callers deciding
        whether they are stdio or remote MCP must pass both the boolean and
        roots; a constructed ``MediaStore`` is safe by default.
        """

        resolved: list[Path] = []
        for raw_root in roots:
            root = Path(raw_root).expanduser()
            try:
                real_root = root.resolve(strict=True)
            except OSError as exc:
                raise MediaPersistenceError(f"媒体允许目录不可用：{root}") from exc
            if root.is_symlink() or not real_root.is_dir():
                raise MediaPersistenceError(f"媒体允许目录必须是非链接目录：{root}")
            if real_root not in resolved:
                resolved.append(real_root)
        return tuple(resolved)

    @staticmethod
    def _suffix(name: str, mime_type: str) -> str:
        suffix = Path(name).suffix.lower()
        if _SAFE_SUFFIX.fullmatch(suffix):
            return suffix
        guessed = mimetypes.guess_extension(mime_type or "") or ".bin"
        return guessed if _SAFE_SUFFIX.fullmatch(guessed) else ".bin"

    def _stable_path(self, bucket_id: str, digest: str, suffix: str) -> Path:
        safe_bucket = re.sub(r"[^a-zA-Z0-9_.-]", "_", bucket_id)[:128]
        target_dir = (self.media_dir / safe_bucket).resolve()
        if self.media_dir not in target_dir.parents:
            raise MediaPersistenceError("媒体目录越界，已拒绝保存。")
        ensure_private_directory(target_dir)
        return target_dir / f"{digest}{suffix}"

    def _frontmatter_path(self, target: Path) -> str:
        try:
            return target.relative_to(self.vault_dir).as_posix()
        except ValueError:
            return str(target)

    @staticmethod
    def _atomic_write(target: Path, data: bytes) -> None:
        """在目标目录内写临时文件后原子替换，避免崩溃留下半张媒体。"""
        fd, temporary = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, target)
            ensure_private_file(target, required=True)
        except Exception:
            try:
                os.unlink(temporary)
            except OSError:
                pass
            raise

    def _read_path(self, raw_path: str) -> tuple[bytes, str]:
        allow_server_path = self._allow_server_path_policy
        if callable(allow_server_path):
            allow_server_path = allow_server_path()
        if not bool(allow_server_path):
            raise MediaPersistenceError(
                "当前连接不允许读取服务器路径；请改传 data_base64。"
            )
        roots = self._allowed_path_roots_policy
        if callable(roots):
            roots = roots()
        allowed_path_roots = self.resolve_allowed_path_roots(roots)
        if not allowed_path_roots:
            raise MediaPersistenceError(
                "服务器路径导入未配置允许目录；请改传 data_base64。"
            )
        source = Path(raw_path).expanduser()
        try:
            before_open = os.lstat(source)
        except OSError as exc:
            raise MediaPersistenceError(
                f"媒体临时路径在 OB 服务器上不可读：{raw_path}。"
                "请改传 data_base64，不能把客户端临时路径直接写进记忆。"
            ) from exc
        if stat.S_ISLNK(before_open.st_mode):
            raise MediaPersistenceError(
                f"媒体路径必须是普通文件，不能是符号链接：{raw_path}"
            )
        if not stat.S_ISREG(before_open.st_mode):
            raise MediaPersistenceError(
                f"媒体路径必须是普通文件：{raw_path}"
            )
        try:
            resolved_source = source.resolve(strict=True)
        except OSError as exc:
            raise MediaPersistenceError(f"媒体临时路径在 OB 服务器上不可读：{raw_path}") from exc
        if not any(
            resolved_source.is_relative_to(root) for root in allowed_path_roots
        ):
            raise MediaPersistenceError("媒体路径不在允许的服务器导入目录内。")

        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
        flags |= getattr(os, "O_NONBLOCK", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        fd: int | None = None
        try:
            fd = os.open(source, flags)
            opened = os.fstat(fd)
            if not stat.S_ISREG(opened.st_mode):
                raise MediaPersistenceError(
                    f"媒体路径必须是普通文件：{raw_path}"
                )

            # 以已打开的文件描述符为读取真源。打开后再比较路径身份，
            # 可在不二次按路径读取的前提下检出并发替换。
            after_open = os.lstat(source)
            if stat.S_ISLNK(after_open.st_mode) or (
                after_open.st_dev,
                after_open.st_ino,
            ) != (opened.st_dev, opened.st_ino):
                raise MediaPersistenceError(
                    f"媒体路径在打开期间发生变化：{raw_path}"
                )
            if opened.st_size > self.max_bytes:
                raise MediaPersistenceError(
                    f"媒体文件超过单项上限 {self.max_bytes} 字节：{raw_path}"
                )

            with os.fdopen(fd, "rb") as handle:
                fd = None
                data = handle.read(self.max_bytes + 1)
            if len(data) > self.max_bytes:
                raise MediaPersistenceError(
                    f"媒体文件超过单项上限 {self.max_bytes} 字节：{raw_path}"
                )
            return data, source.name
        except MediaPersistenceError:
            raise
        except OSError as exc:
            raise MediaPersistenceError(
                f"媒体临时路径在 OB 服务器上不可读：{raw_path}。"
                "请改传 data_base64，不能把客户端临时路径直接写进记忆。"
            ) from exc
        finally:
            if fd is not None:
                os.close(fd)

    def _decode_base64(self, value: str) -> bytes:
        payload = value.strip()
        if payload.startswith("data:"):
            _, separator, payload = payload.partition(",")
            if not separator:
                raise MediaPersistenceError("媒体 data URI 缺少数据部分。")
        # Reject before decoding: an attacker-controlled Base64 string should
        # not force an allocation much larger than the per-item media budget.
        # Four Base64 characters represent at most three decoded bytes; this
        # upper bound intentionally permits the normal final padding quartet.
        max_encoded_length = ((self.max_bytes + 2) // 3) * 4
        if len(payload) > max_encoded_length:
            raise MediaPersistenceError(
                f"媒体数据超过单项上限 {self.max_bytes} 字节。"
            )
        try:
            data = base64.b64decode(payload, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise MediaPersistenceError("媒体 data_base64 不是有效 Base64。") from exc
        if len(data) > self.max_bytes:
            raise MediaPersistenceError(
                f"媒体数据超过单项上限 {self.max_bytes} 字节。"
            )
        return data

    def _persist_one(self, bucket_id: str, item: Any) -> dict[str, Any]:
        entry = {"path": item} if isinstance(item, str) else dict(item or {})
        mime_type = str(entry.get("type") or entry.get("mime_type") or "")[:128]
        if entry.get("data_base64"):
            data = self._decode_base64(str(entry["data_base64"]))
            source_name = str(entry.get("filename") or entry.get("title") or "media")
        else:
            raw_path = str(entry.get("path") or "").strip()
            if not raw_path:
                raise MediaPersistenceError("media 每项必须提供 path 或 data_base64。")
            data, source_name = self._read_path(raw_path)
        digest = hashlib.sha256(data).hexdigest()
        suffix = self._suffix(source_name, mime_type)
        target = self._stable_path(bucket_id, digest, suffix)
        if not target.exists():
            self._atomic_write(target, data)
        else:
            ensure_private_file(target, required=True)
        result: dict[str, Any] = {
            "path": self._frontmatter_path(target),
            "sha256": digest,
            "size": len(data),
            "stored": True,
        }
        for key, limit in (("title", 200), ("type", 128), ("note", 500)):
            value = entry.get(key)
            if value:
                result[key] = str(value)[:limit]
        return result

    async def persist(self, bucket_id: str, media: Any) -> list[dict[str, Any]]:
        """永久保存一项或多项媒体；任何一项失败则明确报错。"""
        if not media:
            return []
        items = media if isinstance(media, list) else [media]
        return await asyncio.to_thread(
            lambda: [self._persist_one(bucket_id, item) for item in items]
        )
