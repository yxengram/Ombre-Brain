"""媒体持久化回归：临时来源必须复制进 OB 持久目录。"""

import base64
import os
from pathlib import Path

import pytest

from ombrebrain.storage.media_store import MediaPersistenceError, MediaStore
from ombrebrain.storage import media_store as media_store_mod


def _path_store(vault: Path, root: Path, **kwargs) -> MediaStore:
    return MediaStore(
        str(vault),
        str(vault / "_media"),
        allow_server_path=True,
        allowed_path_roots=[str(root)],
        **kwargs,
    )


@pytest.mark.asyncio
async def test_server_readable_temporary_file_is_copied(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    source = tmp_path / "client-temp.png"
    source.write_bytes(b"image-bytes")
    store = _path_store(vault, tmp_path)

    result = await store.persist("bucket-1", str(source))

    stored = vault / result[0]["path"]
    assert stored.read_bytes() == b"image-bytes"
    assert result[0]["stored"] is True
    assert result[0]["path"].startswith("_media/bucket-1/")
    source.unlink()
    assert stored.read_bytes() == b"image-bytes"


@pytest.mark.asyncio
async def test_base64_media_is_persisted_with_original_suffix(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    store = MediaStore(str(vault), str(vault / "_media"))
    payload = base64.b64encode(b"sound-bytes").decode("ascii")

    result = await store.persist(
        "bucket-2",
        [{"data_base64": payload, "filename": "voice.ogg", "type": "audio/ogg"}],
    )

    stored = vault / result[0]["path"]
    assert stored.suffix == ".ogg"
    assert stored.read_bytes() == b"sound-bytes"


@pytest.mark.asyncio
async def test_server_path_is_denied_by_default_but_base64_still_works(tmp_path: Path) -> None:
    source = tmp_path / "client-temp.png"
    source.write_bytes(b"image-bytes")
    vault = tmp_path / "vault"
    store = MediaStore(str(vault), str(vault / "_media"))

    with pytest.raises(MediaPersistenceError, match="不允许读取服务器路径"):
        await store.persist("bucket-1", str(source))

    result = await store.persist(
        "bucket-1", {"data_base64": base64.b64encode(b"ok").decode()}
    )
    assert (vault / result[0]["path"]).read_bytes() == b"ok"


@pytest.mark.asyncio
async def test_server_path_must_stay_inside_explicit_root(tmp_path: Path) -> None:
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    outside = tmp_path / "outside.bin"
    outside.write_bytes(b"private")
    store = _path_store(tmp_path / "vault", allowed)

    with pytest.raises(MediaPersistenceError, match="允许"):
        await store.persist("bucket-1", str(outside))


@pytest.mark.asyncio
async def test_policy_callables_are_resolved_for_each_request(tmp_path: Path) -> None:
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    source = allowed / "ok.bin"
    source.write_bytes(b"ok")
    enabled = False
    store = MediaStore(
        str(tmp_path / "vault"),
        str(tmp_path / "vault" / "_media"),
        allow_server_path=lambda: enabled,
        allowed_path_roots=lambda: [allowed],
    )
    with pytest.raises(MediaPersistenceError, match="不允许"):
        await store.persist("bucket-1", str(source))
    enabled = True
    assert (await store.persist("bucket-1", str(source)))[0]["stored"] is True


@pytest.mark.asyncio
async def test_unreadable_client_temporary_path_is_rejected(tmp_path: Path) -> None:
    store = _path_store(tmp_path / "vault", tmp_path)

    with pytest.raises(MediaPersistenceError, match="data_base64"):
        await store.persist("bucket-3", "/client-only/temporary/photo.png")


@pytest.mark.asyncio
async def test_server_path_symlink_is_rejected(tmp_path: Path) -> None:
    target = tmp_path / "target.png"
    target.write_bytes(b"image-bytes")
    link = tmp_path / "linked.png"
    try:
        link.symlink_to(target)
    except OSError as exc:
        pytest.skip(f"symlink creation is unavailable: {exc}")
    store = _path_store(tmp_path / "vault", tmp_path)

    with pytest.raises(MediaPersistenceError, match="符号链接"):
        await store.persist("bucket-symlink", str(link))


@pytest.mark.asyncio
async def test_server_path_special_file_is_rejected(tmp_path: Path) -> None:
    store = _path_store(tmp_path / "vault", tmp_path)

    with pytest.raises(MediaPersistenceError, match="普通文件|data_base64"):
        await store.persist("bucket-directory", str(tmp_path))


@pytest.mark.asyncio
async def test_server_path_over_limit_is_rejected(tmp_path: Path) -> None:
    source = tmp_path / "oversized.bin"
    source.write_bytes(b"12345")
    store = _path_store(tmp_path / "vault", tmp_path, max_bytes=4)

    with pytest.raises(MediaPersistenceError, match="上限 4 字节"):
        await store.persist("bucket-oversized", str(source))


def test_server_path_read_is_bounded_to_max_plus_one(
    tmp_path: Path, monkeypatch
) -> None:
    source = tmp_path / "bounded.bin"
    source.write_bytes(b"data")
    store = _path_store(tmp_path / "vault", tmp_path, max_bytes=8)
    requested_sizes: list[int] = []
    real_fdopen = os.fdopen

    class TrackingReader:
        def __init__(self, fd: int, mode: str) -> None:
            self._handle = real_fdopen(fd, mode)

        def __enter__(self):
            self._handle.__enter__()
            return self

        def __exit__(self, *args):
            return self._handle.__exit__(*args)

        def read(self, size: int) -> bytes:
            requested_sizes.append(size)
            return self._handle.read(size)

    monkeypatch.setattr(
        media_store_mod.os,
        "fdopen",
        lambda fd, mode: TrackingReader(fd, mode),
    )

    data, name = store._read_path(str(source))

    assert data == b"data"
    assert name == source.name
    assert requested_sizes == [store.max_bytes + 1]


def test_server_path_replacement_after_open_is_rejected(
    tmp_path: Path, monkeypatch
) -> None:
    source = tmp_path / "raced.bin"
    source.write_bytes(b"data")
    store = _path_store(tmp_path / "vault", tmp_path)
    real_lstat = os.lstat
    calls = 0

    def changed_lstat(path):
        nonlocal calls
        calls += 1
        result = real_lstat(path)
        if calls == 1:
            return result
        values = list(result)
        values[1] = result.st_ino + 1
        return os.stat_result(values)

    monkeypatch.setattr(media_store_mod.os, "lstat", changed_lstat)

    with pytest.raises(MediaPersistenceError, match="发生变化"):
        store._read_path(str(source))


def test_base64_over_limit_is_rejected_before_decode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = MediaStore(str(tmp_path / "vault"), str(tmp_path / "vault" / "_media"), max_bytes=3)
    decoded = False

    def must_not_decode(*_args, **_kwargs):
        nonlocal decoded
        decoded = True
        raise AssertionError("oversized input must be rejected before b64decode")

    monkeypatch.setattr(media_store_mod.base64, "b64decode", must_not_decode)

    with pytest.raises(MediaPersistenceError, match="上限 3 字节"):
        store._decode_base64("A" * 5)
    assert decoded is False


def test_external_media_directory_is_rejected_to_preserve_backup_closure(tmp_path: Path) -> None:
    with pytest.raises(MediaPersistenceError, match="无法被安全备份"):
        MediaStore(str(tmp_path / "vault"), str(tmp_path / "external-media"))
