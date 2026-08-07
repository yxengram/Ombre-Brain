"""plan 自动闭环的收紧：分级门槛 + 证据校验 + 审计留痕。

背景（docs/AUDIT_2026-08-07_v2.13.1.md 二）：候选列表是
`keyword + vector + active_plans`，最后那个兜底把所有 active plan 无条件送进 LLM
判定，预筛只影响排序、不影响成员；阈值又只有 0.7（比「合并同一事件」的 0.85 还低）。
于是「话题相近就被标 resolved」。承诺被误关会直接从 dream 的 active 段消失，
漏判只是它继续浮现——两个方向的代价完全不对称。

收紧后的契约：
1. 召回命中（keyword/vector）的候选门槛 0.85，仅靠兜底进来的 0.95；
2. 两档都必须给出**能在新事件里逐字找到**的原话作为证据，引不出来一律不闭环；
3. 自动闭环写 resolution_source / resolution_evidence / resolved_at 三个审计字段，
   dream 据此把最近的自动闭环连同证据摆给她/他看，可 trace 撤回。
"""

import pytest

import tools._common as common
import tools._runtime as rt


class _Logger:
    def info(self, *_a, **_k):
        pass

    def warning(self, *_a, **_k):
        pass


class _Manager:
    """只提供 check_plan_resolution 用到的三个方法。"""

    def __init__(self, plans, recalled=()):
        self._plans = plans
        self._recalled = list(recalled)
        self.updated = []

    async def list_all(self, include_archive=False):
        return list(self._plans)

    async def search(self, query, limit=None, vector_scores=None):
        return list(self._recalled)

    async def update(self, bucket_id, **changes):
        self.updated.append((bucket_id, changes))
        return True


class _Judge:
    def __init__(self, **judgement):
        self.judgement = judgement
        self.calls = 0

    async def judge_plan_resolution(self, _plan_text, _new_event_text):
        self.calls += 1
        return dict(self.judgement)


def _plan(bucket_id: str, content: str) -> dict:
    return {
        "id": bucket_id,
        "content": content,
        "metadata": {"type": "plan", "status": "active", "name": content[:8]},
    }


@pytest.fixture
def wire(monkeypatch):
    def _wire(manager, judge):
        monkeypatch.setattr(rt, "bucket_mgr", manager, raising=False)
        monkeypatch.setattr(rt, "embedding_engine", None, raising=False)
        monkeypatch.setattr(rt, "dehydrator", judge, raising=False)
        monkeypatch.setattr(rt, "logger", _Logger(), raising=False)
    return _wire


EVENT = "今天下午把报税材料交给会计了，她说没问题。"


@pytest.mark.asyncio
async def test_recalled_candidate_resolves_with_evidence(wire):
    plan = _plan("plan-tax", "月底前把报税材料交给会计。")
    manager = _Manager([plan], recalled=[plan])
    judge = _Judge(
        resolved=True,
        confidence=0.88,                       # ≥0.85，召回档通过
        evidence="把报税材料交给会计了",        # 是 EVENT 的原话
        reason="材料已送达会计",
    )
    wire(manager, judge)

    await common.check_plan_resolution(EVENT, source_bucket_id="event-1")

    assert len(manager.updated) == 1
    bucket_id, changes = manager.updated[0]
    assert bucket_id == "plan-tax"
    assert changes["status"] == "resolved"
    assert changes["resolved_by"] == "event-1"          # 仍指向来源桶，未被改成标记串
    assert changes["resolution_source"] == "llm_judge:keyword"
    assert changes["resolution_evidence"] == "把报税材料交给会计了"
    assert changes["resolved_at"]


@pytest.mark.asyncio
async def test_recalled_candidate_below_new_threshold_is_rejected(wire):
    """旧阈值 0.7 会放行，新阈值 0.85 不放行。"""
    plan = _plan("plan-tax", "月底前把报税材料交给会计。")
    manager = _Manager([plan], recalled=[plan])
    judge = _Judge(
        resolved=True,
        confidence=0.75,
        evidence="把报税材料交给会计了",
        reason="看起来是这件事",
    )
    wire(manager, judge)

    await common.check_plan_resolution(EVENT, source_bucket_id="event-1")

    assert manager.updated == []


@pytest.mark.asyncio
async def test_fallback_only_candidate_needs_higher_confidence(wire):
    """没被任何通道召回的 plan：0.88 在召回档够、在兜底档不够。"""
    unrelated = _plan("plan-sea", "答应她这周末带她去看海。")
    manager = _Manager([unrelated], recalled=[])       # 关键词召回为空 → 只能靠兜底
    judge = _Judge(
        resolved=True,
        confidence=0.88,
        evidence="把报税材料交给会计了",
        reason="话题相近",
    )
    wire(manager, judge)

    await common.check_plan_resolution(EVENT, source_bucket_id="event-1")

    assert manager.updated == []
    assert judge.calls == 1  # 仍然判定了，只是没通过门槛


@pytest.mark.asyncio
async def test_fallback_candidate_resolves_at_very_high_confidence(wire):
    unrelated = _plan("plan-sea", "答应她这周末带她去看海。")
    manager = _Manager([unrelated], recalled=[])
    judge = _Judge(
        resolved=True,
        confidence=0.97,
        evidence="把报税材料交给会计了",
        reason="确认完成",
    )
    wire(manager, judge)

    await common.check_plan_resolution(EVENT, source_bucket_id="event-1")

    assert len(manager.updated) == 1
    assert manager.updated[0][1]["resolution_source"] == "llm_judge:fallback"


@pytest.mark.asyncio
async def test_fabricated_evidence_blocks_resolution(wire):
    """证据不是新事件里的原话 → 无论信心多高都不闭环。"""
    plan = _plan("plan-tax", "月底前把报税材料交给会计。")
    manager = _Manager([plan], recalled=[plan])
    judge = _Judge(
        resolved=True,
        confidence=0.99,
        evidence="他明确说这件事已经彻底办完了",   # EVENT 里没有这句
        reason="模型自述已完成",
    )
    wire(manager, judge)

    await common.check_plan_resolution(EVENT, source_bucket_id="event-1")

    assert manager.updated == []


@pytest.mark.asyncio
async def test_missing_or_too_short_evidence_blocks_resolution(wire):
    plan = _plan("plan-tax", "月底前把报税材料交给会计。")
    for evidence in ("", "了", None):
        manager = _Manager([plan], recalled=[plan])
        judge = _Judge(resolved=True, confidence=0.99, evidence=evidence, reason="无证据")
        wire(manager, judge)

        await common.check_plan_resolution(EVENT, source_bucket_id="event-1")

        assert manager.updated == [], f"evidence={evidence!r} 不该放行"


@pytest.mark.asyncio
async def test_whitespace_differences_in_evidence_are_tolerated(wire):
    """模型复制原话时多/少一个空格或换行不该被判成捏造。"""
    plan = _plan("plan-tax", "月底前把报税材料交给会计。")
    manager = _Manager([plan], recalled=[plan])
    judge = _Judge(
        resolved=True,
        confidence=0.9,
        evidence="把报税材料\n交给会计了 ",
        reason="材料已送达",
    )
    wire(manager, judge)

    await common.check_plan_resolution(EVENT, source_bucket_id="event-1")

    assert len(manager.updated) == 1


@pytest.mark.asyncio
async def test_unresolved_judgement_never_writes(wire):
    plan = _plan("plan-tax", "月底前把报税材料交给会计。")
    manager = _Manager([plan], recalled=[plan])
    judge = _Judge(resolved=False, confidence=0.99, evidence="把报税材料交给会计了", reason="还没做完")
    wire(manager, judge)

    await common.check_plan_resolution(EVENT, source_bucket_id="event-1")

    assert manager.updated == []


# ---------------------------------------------------------------
# ④ 让误判可见：dream 列出最近的自动闭环 + 证据
# ---------------------------------------------------------------

def _resolved_plan(bucket_id: str, name: str, resolved_at: str, source: str) -> dict:
    return {
        "id": bucket_id,
        "content": "承诺正文",
        "metadata": {
            "type": "plan",
            "status": "resolved",
            "name": name,
            "resolved_at": resolved_at,
            "resolution_source": source,
            "resolution_evidence": "把报税材料交给会计了",
        },
    }


def test_dream_lists_recent_auto_resolved_plans_only():
    from datetime import datetime, timedelta

    from tools.dream.output import _recent_auto_resolved_plans

    now = datetime.now()
    recent = _resolved_plan(
        "p-recent", "报税", (now - timedelta(days=1)).isoformat(), "llm_judge:keyword"
    )
    stale = _resolved_plan(
        "p-stale", "旧的", (now - timedelta(days=30)).isoformat(), "llm_judge:fallback"
    )
    manual = _resolved_plan("p-manual", "手动关的", now.isoformat(), "")
    manual["metadata"].pop("resolution_source")

    picked = _recent_auto_resolved_plans([recent, stale, manual])

    assert [b["id"] for b in picked] == ["p-recent"]


def test_dream_auto_resolved_helper_survives_bad_timestamp():
    from tools.dream.output import _recent_auto_resolved_plans

    broken = _resolved_plan("p-broken", "坏时间戳", "not-a-date", "llm_judge:keyword")
    missing = _resolved_plan("p-missing", "没时间戳", "", "llm_judge:keyword")

    assert _recent_auto_resolved_plans([broken, missing]) == []
