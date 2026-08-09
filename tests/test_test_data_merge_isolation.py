"""测试桶不能成为普通写入的合并目标（R6 回归报告三）。

`_merge_or_create_inner` 的合并分支只有 `not test_data` 这一道闸门，它判断的是
**这次写入**是不是测试数据，判断不了**合并目标**是不是测试桶。于是：

    hold("……", test_data=True)   → 新建 test 桶
    hold("……")                    → 逐字相同 → find_exact_content 命中 → 合并进 test 桶
    trace(id, hard_delete=True)   → 「已永久删除测试桶」→ 真实记忆一起没了

这是 `rule.md` §1「记忆永不被物理抹除」上的静默绕过路径：用户看到的只是一次
正常的「合并→」。隔离必须双向——测试桶只接受测试写入。

两条进入合并的路径都要覆盖：
- 逐字相同：`find_exact_content` → `score=inf` → 跳过同事件判定，门槛为零（R6 实证的就是这条）；
- 语义相近：检索分 > 75 且 `judge_same_event` 置信度 ≥ 0.85（R6 未实测）。
两条都收敛到同一个 `get(candidate_id)` 之后的守卫，所以一处修好两条都堵上。
"""

import pytest

from tools import _common as common
from tools import _runtime as rt


class _Logger:
    def info(self, *_args, **_kwargs):
        pass

    def warning(self, *_args, **_kwargs):
        pass


class _Dehydrator:
    """合并路径需要的两个能力：同事件判定与压缩合并。"""

    def __init__(self, same_event: bool = True, confidence: float = 0.95):
        self._same_event = same_event
        self._confidence = confidence

    async def judge_same_event(self, _old: str, _new: str) -> dict:
        return {
            "same_event": self._same_event,
            "confidence": self._confidence,
            "reason": "test stub",
        }

    async def merge(self, old: str, new: str) -> str:
        return f"{old}\n{new}"

    def invalidate_cache(self, _content: str) -> None:
        pass


@pytest.fixture
def merge_rt(monkeypatch, bucket_mgr, test_config):
    monkeypatch.setattr(rt, "config", test_config, raising=False)
    monkeypatch.setattr(rt, "bucket_mgr", bucket_mgr, raising=False)
    monkeypatch.setattr(rt, "dehydrator", _Dehydrator(), raising=False)
    monkeypatch.setattr(rt, "logger", _Logger(), raising=False)
    monkeypatch.setattr(rt, "embedding_engine", None, raising=False)
    return bucket_mgr


async def _hold_like(content: str, *, test_data: bool = False) -> tuple[str, bool]:
    bucket_id, merged, _warn = await common.merge_or_create(
        content=content,
        tags=["报税"],
        importance=5,
        domain=["事务"],
        valence=0.5,
        arousal=0.3,
        raw_merge=True,
        source_tool="hold",
        test_data=test_data,
    )
    return bucket_id, merged


EVENT = "今天下午把报税材料交给了会计，这条是回归测试用的重复文本。"


@pytest.mark.asyncio
async def test_identical_content_does_not_merge_into_a_test_bucket(merge_rt):
    """R6 实证的那条路径：逐字相同，门槛为零。"""
    test_id, _ = await _hold_like(EVENT, test_data=True)
    real_id, merged = await _hold_like(EVENT)

    assert real_id != test_id
    assert merged is False

    test_bucket = await merge_rt.get(test_id)
    assert test_bucket["content"].strip() == EVENT
    assert test_bucket["metadata"]["provenance"]["kind"] == "test"

    real_bucket = await merge_rt.get(real_id)
    assert "provenance" not in real_bucket["metadata"]


@pytest.mark.asyncio
async def test_semantic_match_does_not_merge_into_a_test_bucket(merge_rt, monkeypatch):
    """语义路径：检索分与同事件判定都放行，也必须被目标桶的 test 标记挡住。

    这条 R6 没实测过，单靠上一个用例只能证明 find_exact_content 那一支被堵住。
    """
    test_id, _ = await _hold_like(EVENT, test_data=True)
    target = await merge_rt.get(test_id)

    async def fake_search(*_args, **_kwargs):
        return [dict(target, score=99.0)]

    monkeypatch.setattr(merge_rt, "search", fake_search)

    real_id, merged = await _hold_like("下午去了会计事务所，材料递交完毕。")

    assert real_id != test_id
    assert merged is False
    assert (await merge_rt.get(test_id))["content"].strip() == EVENT


@pytest.mark.asyncio
async def test_normal_buckets_are_still_valid_merge_targets(merge_rt, monkeypatch):
    """对照组：守卫不能宽到把正常合并一起关掉。"""
    first_id, _ = await _hold_like(EVENT)
    target = await merge_rt.get(first_id)

    async def fake_search(*_args, **_kwargs):
        return [dict(target, score=99.0)]

    monkeypatch.setattr(merge_rt, "search", fake_search)

    second_id, merged = await _hold_like("下午去了会计事务所，材料递交完毕。")

    assert second_id == first_id
    assert merged is True


@pytest.mark.asyncio
async def test_test_writes_still_never_merge(merge_rt):
    """另一半方向本来就成立（`not test_data`），一并钉住，避免修这半边碰坏那半边。"""
    first_id, _ = await _hold_like(EVENT, test_data=True)
    second_id, merged = await _hold_like(EVENT, test_data=True)

    assert second_id != first_id
    assert merged is False


@pytest.mark.asyncio
async def test_hard_delete_after_isolation_only_erases_test_content(merge_rt):
    """闭环验证：隔离之后 hard_delete 的前提（桶里只有测试数据）才真正成立。"""
    test_id, _ = await _hold_like(EVENT, test_data=True)
    real_id, _ = await _hold_like(EVENT)

    result = await merge_rt.hard_delete_test_bucket(test_id, reason="回归测试清理")

    assert result["ok"] is True
    assert await merge_rt.get(test_id) is None
    survivor = await merge_rt.get(real_id)
    assert survivor is not None
    assert EVENT in survivor["content"]


def test_looks_like_test_bucket_is_deliberately_broader_than_hard_delete():
    """合并守卫只看 kind=test，不要求 erasable——两个方向的保守正好相反。

    物理删除侧宁可漏删（kind=test 且 erasable=true 才准删）；合并侧宁可多建一个
    桶。共用一个谓词就会有一边被迫放宽。
    """
    assert common.looks_like_test_bucket({"provenance": {"kind": "test"}}) is True
    assert common.looks_like_test_bucket(
        {"provenance": {"kind": "test", "erasable": False}}
    ) is True
    assert common.looks_like_test_bucket({"provenance": {"kind": "import"}}) is False
    assert common.looks_like_test_bucket({"provenance": "test"}) is False
    assert common.looks_like_test_bucket({}) is False
    assert common.looks_like_test_bucket(None) is False


@pytest.mark.asyncio
async def test_duplicate_marking_skips_test_buckets(monkeypatch):
    """疑似重复也是双向写的：真实桶那边会留下一个指向即将被抹掉的桶的悬空提示。

    本用例验证候选选择的隔离规则；持久化、读取与 API 聚合见
    ``test_duplicate_candidates.py``，避免这个轻量替身伪造 Markdown 行为。
    """
    buckets = {
        "real": {"id": "real", "content": "真实记忆", "metadata": {"id": "real"}},
        "test": {
            "id": "test",
            "content": "测试记忆",
            "metadata": {"id": "test", "provenance": {"kind": "test", "erasable": True}},
        },
        "other": {"id": "other", "content": "另一条真实记忆", "metadata": {"id": "other"}},
    }
    updated: list[str] = []

    class _Manager:
        async def get(self, bucket_id):
            return buckets.get(bucket_id)

        async def update_duplicate_candidate(self, bucket_id, candidate_id, **_changes):
            updated.extend((bucket_id, candidate_id))
            return True

    class _Embedding:
        enabled = True

        def __init__(self, hits):
            self._hits = hits

        async def search_similar(self, _text: str, top_k: int = 10):
            return self._hits

    monkeypatch.setattr(rt, "bucket_mgr", _Manager(), raising=False)
    monkeypatch.setattr(rt, "logger", _Logger(), raising=False)

    monkeypatch.setattr(rt, "embedding_engine", _Embedding([("test", 0.99)]), raising=False)
    await common.check_duplicate_for("real", "真实记忆")
    assert updated == []

    # 对照：跳过测试桶之后，仍然会与下一个真实候选配对，不是把整条路径关掉
    monkeypatch.setattr(
        rt, "embedding_engine", _Embedding([("test", 0.99), ("other", 0.98)]), raising=False
    )
    await common.check_duplicate_for("real", "真实记忆")
    assert updated == ["real", "other"]
