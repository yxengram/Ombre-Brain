"""Regression coverage for the duplicate-candidate pair lifecycle."""

import asyncio
import json

import frontmatter
import pytest

import bucket_manager as bucket_module
from bucket_manager import BucketManager
from ombrebrain.storage.bucket_metadata import (
    normalize_metadata_value,
    sanitize_float_field,
)
from tools import _common as common
from tools import _runtime as rt
from web import _shared as shared_web
from web import search as search_web


class _Logger:
    def info(self, *_args, **_kwargs):
        pass

    def warning(self, *_args, **_kwargs):
        pass


class _Embedding:
    enabled = True

    def __init__(self, hits):
        self._hits = hits

    async def search_similar(self, _text: str, top_k: int = 10):
        assert top_k == 10
        return self._hits


class _MCP:
    def __init__(self):
        self.routes = {}

    def custom_route(self, path, methods):
        def register(handler):
            self.routes[(methods[0], path)] = handler
            return handler

        return register


class _Request:
    query_params = {}


@pytest.mark.asyncio
async def test_duplicate_candidate_metadata_persists_updates_and_clears(bucket_mgr):
    first = await bucket_mgr.create("第一条真实记忆", bucket_id_override="duplicate-first")
    second = await bucket_mgr.create("第二条真实记忆", bucket_id_override="duplicate-second")
    replacement = await bucket_mgr.create("第三条真实记忆", bucket_id_override="duplicate-third")

    assert await bucket_mgr.update(first, dup_candidate=second, dup_score=0.98213)
    stored = await bucket_mgr.get(first)
    assert stored["metadata"]["dup_candidate"] == second
    assert stored["metadata"]["dup_score"] == pytest.approx(0.98213)

    assert await bucket_mgr.update(first, dup_candidate=replacement, dup_score=2.0)
    updated = await bucket_mgr.get(first)
    assert updated["metadata"]["dup_candidate"] == replacement
    assert updated["metadata"]["dup_score"] == 1.0
    assert "dup_candidate" not in (await bucket_mgr.get(second))["metadata"]
    assert (await bucket_mgr.get(replacement))["metadata"]["dup_candidate"] == first

    assert await bucket_mgr.update(first, dup_candidate=None, dup_score=None)
    cleared = await bucket_mgr.get(first)
    assert "dup_candidate" not in cleared["metadata"]
    assert "dup_score" not in cleared["metadata"]
    assert "dup_candidate" not in (await bucket_mgr.get(replacement))["metadata"]


@pytest.mark.asyncio
async def test_replacement_preserves_old_partner_that_was_already_repaired(bucket_mgr):
    first = await bucket_mgr.create("A", bucket_id_override="duplicate-repair-a")
    old = await bucket_mgr.create("B", bucket_id_override="duplicate-repair-b")
    replacement = await bucket_mgr.create("C", bucket_id_override="duplicate-repair-c")
    fourth = await bucket_mgr.create("D", bucket_id_override="duplicate-repair-d")
    assert await bucket_mgr.update_duplicate_candidate(first, old, score=0.99)

    # 模拟旧版本/外部编辑留下 A→B，但 B 已重配 D。A 改配 C 时不能清掉 B→D。
    old_path = bucket_mgr._find_bucket_file(old)
    old_post = frontmatter.load(old_path)
    old_post["dup_candidate"] = fourth
    old_post["dup_score"] = 0.97
    bucket_module._atomic_write_text(old_path, frontmatter.dumps(old_post))
    fourth_path = bucket_mgr._find_bucket_file(fourth)
    fourth_post = frontmatter.load(fourth_path)
    fourth_post["dup_candidate"] = old
    fourth_post["dup_score"] = 0.97
    bucket_module._atomic_write_text(fourth_path, frontmatter.dumps(fourth_post))
    bucket_mgr._invalidate_bm25(old_path, fourth_path)

    assert await bucket_mgr.update_duplicate_candidate(first, replacement, score=0.98)
    assert (await bucket_mgr.get(old))["metadata"]["dup_candidate"] == fourth
    assert (await bucket_mgr.get(fourth))["metadata"]["dup_candidate"] == old
    assert (await bucket_mgr.get(first))["metadata"]["dup_candidate"] == replacement
    assert (await bucket_mgr.get(replacement))["metadata"]["dup_candidate"] == first


@pytest.mark.asyncio
async def test_duplicate_pair_partial_write_failure_rolls_back(bucket_mgr, monkeypatch):
    first = await bucket_mgr.create("A", bucket_id_override="duplicate-rollback-a")
    second = await bucket_mgr.create("B", bucket_id_override="duplicate-rollback-b")
    original_write = bucket_module._atomic_write_text
    calls = 0

    def fail_second_write(path, text):
        nonlocal calls
        calls += 1
        if calls == 2:
            # 模拟 replace 已发生、随后 fsync/关闭才报错；回滚必须包含抛错文件。
            original_write(path, text)
            raise OSError("synthetic second write failure")
        original_write(path, text)

    monkeypatch.setattr(bucket_module, "_atomic_write_text", fail_second_write)
    assert await bucket_mgr.update_duplicate_candidate(first, second, score=0.99) is False
    assert "dup_candidate" not in (await bucket_mgr.get(first))["metadata"]
    assert "dup_candidate" not in (await bucket_mgr.get(second))["metadata"]


@pytest.mark.asyncio
async def test_concurrent_duplicate_replacement_leaves_exactly_one_pair(bucket_mgr):
    first = await bucket_mgr.create("A", bucket_id_override="duplicate-race-a")
    second = await bucket_mgr.create("B", bucket_id_override="duplicate-race-b")
    third = await bucket_mgr.create("C", bucket_id_override="duplicate-race-c")

    results = await asyncio.gather(
        bucket_mgr.update_duplicate_candidate(first, second, score=0.99),
        bucket_mgr.update_duplicate_candidate(first, third, score=0.98),
    )
    assert results == [True, True]
    first_partner = (await bucket_mgr.get(first))["metadata"]["dup_candidate"]
    winner = second if first_partner == second else third
    loser = third if winner == second else second
    assert (await bucket_mgr.get(winner))["metadata"]["dup_candidate"] == first
    assert "dup_candidate" not in (await bucket_mgr.get(loser))["metadata"]


@pytest.mark.asyncio
async def test_duplicate_marking_persists_only_real_bucket_pairs(
    bucket_mgr, test_config, monkeypatch
):
    real = await bucket_mgr.create("真实新记忆", bucket_id_override="duplicate-real")
    test = await bucket_mgr.create(
        "测试记忆", bucket_id_override="duplicate-test", test_data=True
    )
    other = await bucket_mgr.create("另一条真实记忆", bucket_id_override="duplicate-other")
    monkeypatch.setattr(rt, "bucket_mgr", bucket_mgr, raising=False)
    monkeypatch.setattr(rt, "config", test_config, raising=False)
    monkeypatch.setattr(rt, "logger", _Logger(), raising=False)

    monkeypatch.setattr(
        rt, "embedding_engine", _Embedding([(test, 0.99)]), raising=False
    )
    await common.check_duplicate_for(real, "真实新记忆")
    assert "dup_candidate" not in (await bucket_mgr.get(real))["metadata"]

    monkeypatch.setattr(
        rt,
        "embedding_engine",
        _Embedding([(test, 0.99), (other, 0.98)]),
        raising=False,
    )
    await common.check_duplicate_for(real, "真实新记忆")
    real_metadata = (await bucket_mgr.get(real))["metadata"]
    other_metadata = (await bucket_mgr.get(other))["metadata"]
    assert real_metadata["dup_candidate"] == other
    assert other_metadata["dup_candidate"] == real
    assert real_metadata["dup_score"] == other_metadata["dup_score"] == 0.98


@pytest.mark.asyncio
async def test_duplicates_api_reads_persisted_candidate_pair(bucket_mgr, monkeypatch):
    first = await bucket_mgr.create("第一条", bucket_id_override="duplicates-api-first")
    second = await bucket_mgr.create("第二条", bucket_id_override="duplicates-api-second")
    assert await bucket_mgr.update(first, dup_candidate=second, dup_score=0.975)
    assert await bucket_mgr.update(second, dup_candidate=first, dup_score=0.975)

    mcp = _MCP()
    search_web.register(mcp)
    monkeypatch.setattr(shared_web, "bucket_mgr", bucket_mgr, raising=False)
    monkeypatch.setattr(shared_web, "_require_auth", lambda _request: None)
    response = await mcp.routes[("GET", "/api/duplicates")](_Request())

    payload = json.loads(response.body)
    first_name = (await bucket_mgr.get(first))["metadata"]["name"]
    second_name = (await bucket_mgr.get(second))["metadata"]["name"]
    assert payload["total"] == 1
    pair = payload["pairs"][0]
    assert pair["score"] == 0.975
    assert {pair["a"]["id"], pair["b"]["id"]} == {first, second}
    names_by_id = {
        pair["a"]["id"]: pair["a"]["name"],
        pair["b"]["id"]: pair["b"]["name"],
    }
    assert names_by_id == {first: first_name, second: second_name}


@pytest.mark.asyncio
async def test_duplicates_api_filters_stale_one_way_pair(bucket_mgr, monkeypatch):
    first = await bucket_mgr.create("第一条", bucket_id_override="duplicates-stale-first")
    second = await bucket_mgr.create("第二条", bucket_id_override="duplicates-stale-second")
    third = await bucket_mgr.create("第三条", bucket_id_override="duplicates-stale-third")
    assert await bucket_mgr.update_duplicate_candidate(first, second, score=0.975)

    # 模拟旧版本部分写入：A→B 仍在，但 B 已单边指向 C。
    second_path = bucket_mgr._find_bucket_file(second)
    second_post = frontmatter.load(second_path)
    second_post["dup_candidate"] = third
    bucket_module._atomic_write_text(second_path, frontmatter.dumps(second_post))
    bucket_mgr._invalidate_bm25(second_path)

    mcp = _MCP()
    search_web.register(mcp)
    monkeypatch.setattr(shared_web, "bucket_mgr", bucket_mgr, raising=False)
    monkeypatch.setattr(shared_web, "_require_auth", lambda _request: None)
    response = await mcp.routes[("GET", "/api/duplicates")](_Request())
    assert json.loads(response.body) == {"pairs": [], "total": 0}


@pytest.mark.asyncio
async def test_bucket_metadata_helpers_keep_legacy_identity_and_monkeypatch_contract(
    bucket_mgr, monkeypatch
):
    assert BucketManager._sanitize_float_field is sanitize_float_field
    assert BucketManager._normalize_metadata_value is normalize_metadata_value

    bucket_id = await bucket_mgr.create("兼容入口", bucket_id_override="metadata-compat")
    monkeypatch.setattr(
        BucketManager, "_sanitize_float_field", staticmethod(lambda _value, _default: 0.123)
    )
    assert (await bucket_mgr.get(bucket_id))["metadata"]["valence"] == 0.123
