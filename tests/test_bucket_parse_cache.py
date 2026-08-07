"""list_all() 单文件解析缓存 + 软链接 vault 的回归测试。

背景：任何写入都会清掉 _active_cache（集合可能变了），此前下一次 list_all()
要把每个 .md 重新 frontmatter.load 一遍——800 桶实测 82ms，其中必需的 stat 扫描
只占 4ms。加了按 (mtime_ns, size) 指纹的单文件解析缓存后，重建只解析真正变过的
文件；这里锁住「省下的解析不能省出错误内容」这条线。
"""

import asyncio
import os
from pathlib import Path

import frontmatter
import pytest

from bucket_manager import BucketManager


@pytest.fixture
def mgr(tmp_path) -> BucketManager:
    return BucketManager({
        "buckets_dir": str(tmp_path / "vault"),
        "dehydration": {},
        "embedding": {"enabled": False},
    })


@pytest.mark.asyncio
async def test_unchanged_files_are_not_reparsed_after_a_write(mgr, monkeypatch):
    keep = await mgr.create(content="不动的记忆", name="keep", domain=["测试"])
    await mgr.list_all()

    parsed: list[str] = []
    original_load = mgr._load_bucket
    monkeypatch.setattr(
        mgr,
        "_load_bucket",
        lambda p: (parsed.append(os.path.basename(p)), original_load(p))[1],
    )

    new_id = await mgr.create(content="新记忆", name="fresh", domain=["测试"])
    parsed.clear()  # create() 自己也会读文件，这里只数 list_all 重建期间的解析
    buckets = await mgr.list_all()

    assert {b["id"] for b in buckets} == {keep, new_id}
    # 只有新建的那个文件需要解析，老桶走缓存
    assert len(parsed) == 1


@pytest.mark.asyncio
async def test_updated_bucket_is_reparsed(mgr):
    bucket_id = await mgr.create(content="原始正文", name="edit-me", domain=["测试"])
    await mgr.list_all()

    assert await mgr.update(bucket_id, content="改过的正文") is True
    [bucket] = await mgr.list_all()

    assert "改过的正文" in bucket["content"]


@pytest.mark.asyncio
async def test_external_edit_with_same_size_is_still_seen(mgr):
    """指纹靠 (mtime_ns, size)：同尺寸外部改写靠 mtime 变化被发现。"""
    mgr.external_change_poll_seconds = 0
    bucket_id = await mgr.create(content="AAAA 同尺寸正文", name="external", domain=["测试"])
    await mgr.list_all()

    path = Path(mgr._find_bucket_file(bucket_id))
    post = frontmatter.load(path)
    post.content = "BBBB 同尺寸正文"
    path.write_text(frontmatter.dumps(post), encoding="utf-8")

    [bucket] = await mgr.list_all()
    assert "BBBB 同尺寸正文" in bucket["content"]


@pytest.mark.asyncio
async def test_caller_mutation_does_not_poison_the_cache(mgr):
    """返回的桶被调用方改了，不能顺着缓存污染下一次读取。"""
    await mgr.create(content="原始正文", name="mutate", domain=["测试"])
    [first] = await mgr.list_all()
    first["metadata"]["tags"] = ["被调用方改过"]
    first["metadata"]["domain"].append("污染")

    mgr._invalidate_bm25()
    [second] = await mgr.list_all()

    assert second["metadata"].get("tags") != ["被调用方改过"]
    assert "污染" not in second["metadata"]["domain"]


@pytest.mark.asyncio
async def test_unscoped_invalidation_clears_whole_parse_cache(mgr):
    """不传路径 = 改动范围未知（GitHub 恢复等），必须整表清空。"""
    await mgr.create(content="正文", name="scope", domain=["测试"])
    await mgr.list_all()
    assert mgr._parse_cache

    mgr._invalidate_bm25()

    assert mgr._parse_cache == {}


@pytest.mark.asyncio
async def test_touch_activation_count_survives_a_full_rebuild(mgr):
    bucket_id = await mgr.create(content="正文", name="touched", domain=["测试"])
    await mgr.list_all()
    await mgr.touch(bucket_id, ripple=False)

    mgr._active_cache = None
    [bucket] = await mgr.list_all()

    assert bucket["metadata"]["activation_count"] == 1


def test_update_works_when_vault_path_goes_through_a_symlink(tmp_path):
    """软链接 vault：就地改写不能被误判成迁目录（曾导致 update 静默失败）。"""
    real = tmp_path / "real_vault"
    real.mkdir()
    link = tmp_path / "linked_vault"
    link.symlink_to(real, target_is_directory=True)

    mgr = BucketManager({
        "buckets_dir": str(link),
        "dehydration": {},
        "embedding": {"enabled": False},
    })

    async def scenario():
        bucket_id = await mgr.create(content="原始正文", name="symlink", domain=["测试"])
        assert await mgr.update(bucket_id, content="改过的正文") is True
        return await mgr.get(bucket_id)

    bucket = asyncio.run(scenario())
    assert bucket is not None
    assert "改过的正文" in bucket["content"]


def test_is_same_file_falls_back_when_filesystem_reports_no_inode(tmp_path, monkeypatch):
    """st_ino 恒为 0 的挂载（未开 serverino 的 CIFS/FUSE）上不能把两个文件判成同一个。

    samefile 在那种文件系统上对任意两个文件都返回 True；migrate_engine 的覆盖导入
    据此跳过「目标已存在」检查，会替换掉另一个桶的文件。
    """
    import os as _os

    from utils import is_same_file

    left = tmp_path / "a.md"
    right = tmp_path / "b.md"
    left.write_text("A", encoding="utf-8")
    right.write_text("B", encoding="utf-8")

    assert is_same_file(str(left), str(right)) is False
    assert is_same_file(str(left), str(left)) is True

    real_stat = _os.stat

    class _NoInodeStat:
        def __init__(self, base):
            self._base = base
            self.st_ino = 0

        def __getattr__(self, name):
            return getattr(self._base, name)

    monkeypatch.setattr(_os, "stat", lambda p, *a, **kw: _NoInodeStat(real_stat(p, *a, **kw)))

    assert is_same_file(str(left), str(right)) is False
    assert is_same_file(str(left), str(left)) is True
