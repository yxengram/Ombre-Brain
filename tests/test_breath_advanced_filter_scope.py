"""breath_advanced 的 domain / valence / arousal 在无 query 时不再静默失效。

R5 回归报告 4：
- `breath_advanced(domain="情绪", max_results=5)` 返回 5 条，**没有一条 domain 含「情绪」**；
- `breath_advanced(domain="情绪", importance_min=1, max_results=5)` 返回 19 条全部记忆。

根因是 domain/valence/arousal 只传给了检索分支（有 query），浮现与重要度两个分支的
函数签名里压根没有这几个参数。而工具描述没写任何限定——按文档传参会拿到一份看起来
正常、其实没过滤的结果，是最坏的失败方式。

现在的契约：
- `domain` 四种模式都生效（目录/重要度/浮现/检索）；
- `valence`/`arousal` 只在检索模式生效（它们是打分维度，无 query 时无从比对），
  无 query 却传了会在结果末尾明确说明本次未参与筛选；
- 重要度模式的硬上限 20 条不可调高，但 `max_results` 可以在其之下再收紧。
"""

from unittest.mock import MagicMock

import pytest

import tools._runtime as rt
from tools.breath import dispatch


def _bucket(bucket_id: str, domain: list[str], importance: int = 5) -> dict:
    return {
        "id": bucket_id,
        "content": f"{bucket_id} 的正文内容，足够长以便渲染。",
        "path": f"/tmp/{bucket_id}.md",
        "metadata": {
            "id": bucket_id,
            "name": bucket_id,
            "type": "dynamic",
            "domain": domain,
            "tags": [],
            "importance": importance,
            "valence": 0.5,
            "arousal": 0.3,
            "created": "2026-08-01T10:00:00",
            "last_active": "2026-08-01T10:00:00",
            "activation_count": 1,
        },
    }


BUCKETS = [
    _bucket("emotion-1", ["情绪"], importance=6),
    _bucket("work-1", ["工作"], importance=7),
    _bucket("work-2", ["工作"], importance=8),
    _bucket("food-1", ["饮食"], importance=9),
]


class _Manager:
    async def list_all(self, include_archive=False):
        return [dict(b, metadata=dict(b["metadata"])) for b in BUCKETS]

    def footprint_snapshot(self):
        return None

    async def search(self, *_a, **_k):
        return []


class _Decay:
    is_running = True

    async def ensure_started(self):
        return None

    def calculate_score(self, _meta):
        return 1.0


@pytest.fixture
def breath_rt(monkeypatch):
    monkeypatch.setattr(rt, "config", {"surfacing": {}}, raising=False)
    monkeypatch.setattr(rt, "bucket_mgr", _Manager(), raising=False)
    monkeypatch.setattr(rt, "decay_engine", _Decay(), raising=False)
    monkeypatch.setattr(rt, "embedding_engine", None, raising=False)
    monkeypatch.setattr(rt, "logger", MagicMock(), raising=False)


@pytest.mark.asyncio
async def test_surfacing_mode_honors_domain_filter(breath_rt):
    out = await dispatch(domain="情绪", max_results=5)

    assert "emotion-1" in out
    for other in ("work-1", "work-2", "food-1"):
        assert other not in out


@pytest.mark.asyncio
async def test_importance_mode_honors_domain_filter(breath_rt):
    out = await dispatch(domain="情绪", importance_min=1, max_results=5)

    assert "emotion-1" in out
    for other in ("work-1", "work-2", "food-1"):
        assert other not in out


@pytest.mark.asyncio
async def test_importance_mode_honors_max_results(breath_rt):
    out = await dispatch(importance_min=1, max_results=2)

    returned = [b for b in ("emotion-1", "work-1", "work-2", "food-1") if b in out]
    assert len(returned) == 2
    # 按 importance 降序取前二
    assert set(returned) == {"food-1", "work-2"}


@pytest.mark.asyncio
async def test_emotion_params_without_query_say_they_were_ignored(breath_rt):
    surfacing = await dispatch(valence=0.9, max_results=5)
    importance = await dispatch(valence=0.9, importance_min=1)

    assert "valence/arousal 只在检索模式" in surfacing
    assert "valence/arousal 只在检索模式" in importance


@pytest.mark.asyncio
async def test_catalog_and_feel_modes_also_report_ignored_emotion(breath_rt, monkeypatch):
    """四种模式都要说明，不能只覆盖两种——文档写了「四种模式」就得四种都算数。"""
    import tools.breath as breath_pkg

    async def fake_catalog(**_kwargs):
        return "目录内容"

    async def fake_feels(**_kwargs):
        return "feel 内容"

    monkeypatch.setattr(breath_pkg, "surface_catalog", fake_catalog)
    monkeypatch.setattr(breath_pkg, "surface_feels", fake_feels)

    catalog_out = await dispatch(catalog=True, valence=0.9)
    feel_out = await dispatch(domain="feel", arousal=0.9)

    assert "valence/arousal 只在检索模式" in catalog_out
    assert "valence/arousal 只在检索模式" in feel_out


@pytest.mark.asyncio
async def test_no_notice_when_emotion_not_requested(breath_rt):
    out = await dispatch(max_results=5)

    assert "valence/arousal 只在检索模式" not in out


@pytest.mark.asyncio
async def test_search_mode_still_forwards_emotion_to_bucket_manager(breath_rt, monkeypatch):
    """检索模式的语义不变：valence/arousal 仍作为查询坐标进 search()。"""
    captured = {}

    class _SearchManager(_Manager):
        async def search(self, query, **kwargs):
            captured.update(kwargs)
            captured["query"] = query
            return []

    monkeypatch.setattr(rt, "bucket_mgr", _SearchManager(), raising=False)

    await dispatch(query="工作", valence=0.9, arousal=0.2)

    assert captured["query_valence"] == 0.9
    assert captured["query_arousal"] == 0.2
    assert captured["domain_filter"] is None
