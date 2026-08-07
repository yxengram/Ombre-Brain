"""valence/arousal = 0.0 不能被 `x or 默认值` 吞掉。

0.0 是情感坐标上最有意义的那一端（极度消极 / 完全平静），不是「没填」。
历史写法 `item.get("valence") or 0.5` 把它当假值，于是：

- grow 拆条：打标模型给出的 0.0 落盘变成 0.5（静默改数据）
- 合并进老桶：老桶存的 0.0 被当缺省，平均后把坐标抬高
- anchor / dream 展示：把 0.0 显示成 0.5

对应 docs/AUDIT_2026-08-07_v2.13.1.md 一、1。
"""

from unittest.mock import MagicMock

import pytest

import tools._runtime as rt
from ombrebrain.storage.source_store import SourceStore
from tools.grow.core import grow_core
from utils import unit_float


class _ZeroEmotionDehydrator:
    """digest 拆出一条「极度消极 + 完全平静」的条目。"""

    async def digest(self, content):
        return [{
            "content": "今天什么都不想说，只是坐着。",
            "name": "低谷",
            "domain": ["内心"],
            "tags": ["情绪"],
            "importance": 6,
            "valence": 0.0,
            "arousal": 0.0,
        }]

    async def analyze(self, content):
        return {
            "domain": ["内心"], "valence": 0.0, "arousal": 0.0,
            "tags": ["情绪"], "suggested_name": "低谷", "importance": 6,
        }

    async def merge(self, old_content, new_content):
        return f"{old_content}\n\n---\n{new_content}"

    async def judge_same_event(self, *_args, **_kwargs):
        # 合并路径要求「同一事件判定器」明确点头，否则保守新建
        return {"same_event": True, "confidence": 0.95, "reason": "测试固定判定"}


class _NoopDecay:
    is_running = True

    async def ensure_started(self):
        return None

    def calculate_score(self, meta):
        return 1.0


@pytest.fixture
def grow_rt(bucket_mgr, monkeypatch):
    monkeypatch.setattr(rt, "config", {"limits": {}, "merge_threshold": 75}, raising=False)
    monkeypatch.setattr(rt, "bucket_mgr", bucket_mgr, raising=False)
    monkeypatch.setattr(rt, "dehydrator", _ZeroEmotionDehydrator(), raising=False)
    monkeypatch.setattr(rt, "decay_engine", _NoopDecay(), raising=False)
    monkeypatch.setattr(rt, "logger", MagicMock(), raising=False)
    monkeypatch.setattr(rt, "fire_webhook", None, raising=False)
    monkeypatch.setattr(rt, "source_store", SourceStore(bucket_mgr.base_dir), raising=False)
    return bucket_mgr


@pytest.mark.parametrize(
    ("value", "default", "expected"),
    [
        (0.0, 0.5, 0.0),          # 关键用例：0.0 必须原样保留
        (0, 0.3, 0.0),
        ("0.0", 0.5, 0.0),
        (0.7, 0.5, 0.7),
        (1.0, 0.5, 1.0),
        (None, 0.5, 0.5),         # 真的没填 → 默认值
        ("", 0.5, 0.5),
        ("abc", 0.3, 0.3),
        (float("nan"), 0.5, 0.5),
        (float("inf"), 0.5, 0.5),
        (1.7, 0.5, 1.0),          # 越界夹回边界
        (-0.4, 0.5, 0.0),
    ],
)
def test_unit_float_keeps_zero_and_falls_back_only_on_missing(value, default, expected):
    assert unit_float(value, default) == expected


@pytest.mark.asyncio
async def test_grow_writes_zero_emotion_to_disk(grow_rt):
    """打标模型给 0.0，.md 里就得是 0.0，不能变成中性 0.5 / 0.3。"""
    bucket_mgr = grow_rt

    await grow_core("今天什么都不想说，只是坐着。" * 6)

    [bucket] = await bucket_mgr.list_all(include_archive=False)
    assert bucket["metadata"]["valence"] == 0.0
    assert bucket["metadata"]["arousal"] == 0.0


@pytest.mark.asyncio
async def test_merge_averages_against_stored_zero(grow_rt, monkeypatch):
    """老桶存 0.0，新内容 0.6 → 合并后 0.3；旧写法把 0.0 吞成 0.5，会算成 0.55。

    检索命中与否不是本用例的主题（另有专门测试），这里直接把候选喂给合并分支，
    断言真正落盘的坐标。"""
    from tools._common import merge_or_create

    bucket_mgr = grow_rt
    await merge_or_create(
        content="她说她今天不想说话。",
        tags=["情绪"],
        importance=6,
        domain=["内心"],
        valence=0.0,
        arousal=0.0,
        name="低谷",
    )
    [before] = await bucket_mgr.list_all(include_archive=False)
    assert before["metadata"]["valence"] == 0.0

    async def fake_search(*_args, **_kwargs):
        return [dict(before, score=999.0)]

    monkeypatch.setattr(bucket_mgr, "search", fake_search)

    _name, is_merged, _warn = await merge_or_create(
        content="后来她说想出去走走。",
        tags=["情绪"],
        importance=6,
        domain=["内心"],
        valence=0.6,
        arousal=0.6,
        name="低谷",
    )

    assert is_merged, "前置条件：第二次写入应命中合并路径"
    [after] = await bucket_mgr.list_all(include_archive=False)
    assert after["metadata"]["valence"] == 0.3
    assert after["metadata"]["arousal"] == 0.3
