"""R5 回归报告二（打标 prompt）与四（历史遗留五项）的修复。

打标类改动只能在这里锁 **prompt 文本**——模型是否真的照做，要靠带真实打标模型的
下一轮回归验证。报告已经证明连换五个模型都解决不了，根因在 prompt 而非模型，所以
这里锁住「prompt 里确实写了新规则」这条底线，避免以后被无声改回去。

其余四项（显示精度、合并截断、extra_tags、_parse_analysis 类型校验）是纯代码行为，
可以直接断言。
"""

import pytest

from dehydrator import ANALYZE_PROMPT, DIGEST_PROMPT, Dehydrator


def _dehydrator(tmp_path) -> Dehydrator:
    return Dehydrator({
        "buckets_dir": str(tmp_path / "vault"),
        "dehydration": {"api_key": "test-key"},
    })


# ---------------------------------------------------------------
# 二、打标 prompt 三处（ANALYZE 与 DIGEST 同步改，否则 grow 路径仍是旧行为）
# ---------------------------------------------------------------

@pytest.mark.parametrize("prompt", [ANALYZE_PROMPT, DIGEST_PROMPT], ids=["analyze", "digest"])
def test_prompt_no_longer_anchors_valence_to_a_positive_example(prompt):
    """中性事实五轮都被判成 0.6~0.8，从未到 0.5——输出示例里的 0.7 是锚点。"""
    assert '"valence": 0.7' not in prompt
    assert '"valence": 0.5' in prompt
    assert "0.5" in prompt and "占位" in prompt


@pytest.mark.parametrize("prompt", [ANALYZE_PROMPT, DIGEST_PROMPT], ids=["analyze", "digest"])
def test_prompt_widens_domain_quota_and_guarantees_emotion(prompt):
    """五领域混合只留 2 个、正面情绪拿不到「情绪」域——名额太窄 + 无保底。

    「情绪」是在 1~3 个具体领域**之外**额外占一位（最多 4 个），不是挤掉一个具体
    领域：名额内竞争正是 R4 §3.4 判定的不对称根因。
    """
    assert "1~2 个" not in prompt
    assert "1~3 个" in prompt
    assert "额外" in prompt
    assert "情绪" in prompt and "正面负面一视同仁" in prompt


def test_source_read_explains_scope_instead_of_sounding_like_an_error(tmp_path):
    """R4 §5.8：hold 桶没有 source_refs 是设计如此，不该回一句像报错的话。"""
    from pathlib import Path

    text = (Path(__file__).resolve().parents[1] / "src" / "tools" / "source_read" / "core.py").read_text(
        encoding="utf-8"
    )
    assert "该桶没有原文证据引用。" not in text
    assert "正文本身就是原文" in text
    assert "source_ranges" in text


@pytest.mark.parametrize("prompt", [ANALYZE_PROMPT, DIGEST_PROMPT], ids=["analyze", "digest"])
def test_prompt_scales_tag_count_with_content_length(prompt):
    """「测试」两个字拿到 10 个标签、8 个是脑补——固定配额是根因。"""
    assert "总计 10~15 个" not in prompt
    assert "数量随" in prompt
    assert "20 字" in prompt


# ---------------------------------------------------------------
# 四·e：_parse_analysis 的类型校验
# ---------------------------------------------------------------

@pytest.mark.parametrize(
    ("raw_domain", "expected"),
    [
        (["工作", "学习"], ["工作", "学习"]),
        ("工作", ["工作"]),          # 裸字符串：旧代码切片后仍是 str
        (None, ["未分类"]),
        ([], ["未分类"]),
        (123, ["未分类"]),
    ],
)
def test_parse_analysis_normalizes_domain_shape(tmp_path, raw_domain, expected):
    import json

    dehydrator = _dehydrator(tmp_path)
    parsed = dehydrator._parse_analysis(json.dumps({
        "domain": raw_domain,
        "valence": 0.5,
        "arousal": 0.3,
        "tags": ["标签"],
        "suggested_name": "标题",
        "importance": 5,
    }, ensure_ascii=False))
    dehydrator._cache_conn.close()

    assert parsed["domain"] == expected
    assert isinstance(parsed["domain"], list)


def test_parse_analysis_normalizes_tags_shape(tmp_path):
    import json

    dehydrator = _dehydrator(tmp_path)
    parsed = dehydrator._parse_analysis(json.dumps({
        "domain": ["工作"],
        "valence": 0.5,
        "arousal": 0.3,
        "tags": "单个标签",
        "suggested_name": "标题",
        "importance": 5,
    }, ensure_ascii=False))
    null_tags = dehydrator._parse_analysis(json.dumps({
        "domain": ["工作"],
        "valence": 0.5,
        "arousal": 0.3,
        "tags": None,
        "suggested_name": "标题",
        "importance": 5,
    }, ensure_ascii=False))
    dehydrator._cache_conn.close()

    assert parsed["tags"] == ["单个标签"]
    assert null_tags["tags"] == []


# ---------------------------------------------------------------
# 四·a：情感坐标显示精度（0~1 两位小数，.1f 会把 0.15 显示成 0.1）
# ---------------------------------------------------------------

def test_emotion_display_keeps_two_decimals():
    """按「这一类」断言，而不是按这次改到的那几个字面量。

    第一版只断言 V{val:.1f}/A{aro:.1f}/valence:.1f/arousal:.1f 四个串，
    结果 dream/output.py 里 feel 历史段的 V{fv:.1f} 两处一个都没被查出来——
    测试是照着 diff 写的，不是照着缺陷写的。
    """
    import re as _re
    from pathlib import Path

    root = Path(__file__).resolve().parents[1] / "src"
    sources = {
        "dehydrator.py": root / "dehydrator.py",
        "grow/shortpath.py": root / "tools" / "grow" / "shortpath.py",
        "anchor/core.py": root / "tools" / "anchor" / "core.py",
        "dream/output.py": root / "tools" / "dream" / "output.py",
    }
    # 形如 V{任意表达式:.1f} / A{...:.1f}，以及 valence/arousal 直接格式化的写法
    one_decimal = _re.compile(r"[VA]\{[^}]+:\.1f\}|(?:valence|arousal)[^\n]{0,20}:\.1f")
    for name, path in sources.items():
        hits = one_decimal.findall(path.read_text(encoding="utf-8"))
        assert not hits, f"{name} 仍有单位小数的情感展示: {hits}"


# ---------------------------------------------------------------
# 四·c：extra_tags 的「覆盖」是既有设计，不是 bug —— 锁住现状
# ---------------------------------------------------------------

@pytest.mark.asyncio
async def test_explicit_tags_replace_model_tags_by_design(tmp_path, monkeypatch):
    """R5 报告四·c 说 extra_tags「覆盖而非追加」是问题，但这是既有产品口径。

    与 title「传入时即最终标题，优先于打标模型建议」同一条规则，并已有专门用例
    tests/test_source_layer.py::test_hold_explicit_tags_replace_model_suggestions。
    改口径要产品拍板，代码这轮不动；这条用例把现状钉在这里，避免两份测试互相打架。
    """
    from unittest.mock import MagicMock

    import tools._runtime as rt
    from tools.hold import core as hold_core

    captured = {}

    async def fake_merge_or_create(**kwargs):
        captured.update(kwargs)
        return "bucket", False, ""

    class _Dehy:
        async def analyze(self, _content):
            return {
                "domain": ["工作"], "valence": 0.5, "arousal": 0.3,
                "tags": ["模型标签一", "模型标签二"],
                "suggested_name": "标题", "importance": 5,
            }

    monkeypatch.setattr(hold_core, "merge_or_create", fake_merge_or_create)
    monkeypatch.setattr(rt, "config", {"limits": {}}, raising=False)
    monkeypatch.setattr(rt, "dehydrator", _Dehy(), raising=False)
    monkeypatch.setattr(rt, "logger", MagicMock(), raising=False)

    await hold_core.store_core(
        "一条足够长的正文内容，用来触发正常打标路径。",
        extra_tags=["显式标签"],
        importance=5,
        valence=-1,
        arousal=-1,
        why_remembered="",
    )

    assert captured["tags"] == ["显式标签"]


# ---------------------------------------------------------------
# 四·b：合并时 tags/domain 有上限
# ---------------------------------------------------------------

def test_merge_metadata_caps_match_the_tagging_side():
    """合并侧与打标侧必须同口径，否则合并会把刚打好的 domain 截掉一个。"""
    from dehydrator import _DOMAIN_MAX, _TAGS_MAX
    from tools import _common

    assert _common._MERGED_TAGS_MAX == _TAGS_MAX == 15
    # domain 上限 4 = 具体领域 1~3 + 带情绪时额外的「情绪」
    assert _common._MERGED_DOMAIN_MAX == _DOMAIN_MAX == 4


def test_short_content_tag_cap_is_enforced_in_code(tmp_path, monkeypatch):
    """prompt 的「数量随信息量走」是软约束，弱模型照样能给「测试」编 10 个标签。

    代码侧按原文长度再兜一层，模型绕不过（R4 §3.5 的建议）。
    """
    import asyncio
    import json

    dehydrator = _dehydrator(tmp_path)

    async def fake_chat(*_args, **_kwargs):
        return json.dumps({
            "domain": ["事务"],
            "valence": 0.5,
            "arousal": 0.3,
            "tags": [f"脑补标签{i}" for i in range(12)],
            "suggested_name": "测试",
            "importance": 3,
        }, ensure_ascii=False)

    monkeypatch.setattr(dehydrator, "_chat", fake_chat)

    short = asyncio.run(dehydrator.analyze("测试"))
    medium = asyncio.run(dehydrator.analyze("回归测试一条中等长度的内容。" * 3))
    long_text = asyncio.run(dehydrator.analyze("回归测试一条足够长的内容。" * 12))
    dehydrator._cache_conn.close()

    assert len(short["tags"]) == 3       # <20 字
    assert len(medium["tags"]) == 9      # <100 字
    assert len(long_text["tags"]) == 12  # 放开到 _TAGS_MAX=15，模型只给了 12
