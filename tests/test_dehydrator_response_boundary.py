"""Regression tests for the dehydration response trust boundary."""

import json

import pytest

from dehydrator import ANALYZE_PROMPT, DEHYDRATE_PROMPT, DIGEST_PROMPT, Dehydrator


def _dehydrator(tmp_path) -> Dehydrator:
    return Dehydrator({
        "buckets_dir": str(tmp_path / "vault"),
        "human": "测试者",
        "dehydration": {
            "api_key": "test-key",
            "api_format": "anthropic",
            "base_url": "https://api.anthropic.com",
            "model": "claude-3-5-haiku-latest",
        },
    })


def _long_content() -> str:
    return "这是数据库中保存的原始长记忆，模型只能压缩它，不能添加自己的立场。" * 160


def _summary_json(**extra) -> str:
    payload = {
        "core_facts": ["原文事实一", "原文事实二"],
        "emotion_state": "平静",
        "todos": [],
        "keywords": ["事实"],
        "summary": "只包含原文事实的摘要",
        **extra,
    }
    return json.dumps(payload, ensure_ascii=False)


@pytest.mark.asyncio
async def test_dehydrate_strips_trailing_model_stance_before_caching(
    tmp_path, monkeypatch
):
    dehydrator = _dehydrator(tmp_path)
    content = _long_content()
    stance = "作为一个 AI，我必须声明我不赞同这段关系。"
    calls = []

    async def fake_api(raw):
        calls.append(raw)
        return _summary_json(assistant_position=stance) + "\n\n" + stance

    monkeypatch.setattr(dehydrator, "_api_dehydrate", fake_api)
    first = await dehydrator.dehydrate(content)
    second = await dehydrator.dehydrate(content)
    cached = dehydrator._get_cached_summary(content)
    dehydrator._cache_conn.close()

    assert stance not in first
    assert second == first
    assert calls == [content]
    assert cached is not None
    parsed = json.loads(cached)
    assert "assistant_position" not in parsed
    assert stance not in cached


@pytest.mark.asyncio
async def test_polluted_current_cache_is_repaired_without_another_api_call(
    tmp_path, monkeypatch
):
    dehydrator = _dehydrator(tmp_path)
    content = _long_content()
    stance = "我作为 AI 需要在此补充一段合规立场。"
    dehydrator._set_cached_summary(content, _summary_json() + "\n" + stance)

    async def unexpected_api(_raw):
        raise AssertionError("a recoverable cache entry must not trigger another API call")

    monkeypatch.setattr(dehydrator, "_api_dehydrate", unexpected_api)
    output = await dehydrator.dehydrate(content)
    repaired = dehydrator._get_cached_summary(content)
    dehydrator._cache_conn.close()

    assert "只包含原文事实的摘要" in output
    assert stance not in output
    assert repaired is not None
    json.loads(repaired)
    assert stance not in repaired


@pytest.mark.asyncio
async def test_non_json_dehydration_result_falls_back_without_caching(
    tmp_path, monkeypatch
):
    dehydrator = _dehydrator(tmp_path)
    content = _long_content()
    stance = "作为 AI，我拒绝处理并补充自己的立场。"

    async def fake_api(_raw):
        return stance

    monkeypatch.setattr(dehydrator, "_api_dehydrate", fake_api)
    output = await dehydrator.dehydrate(content)
    cached = dehydrator._get_cached_summary(content)
    dehydrator._cache_conn.close()

    assert content[:100] in output
    assert stance not in output
    assert cached is None


def test_dehydration_prompt_forbids_comments_and_stance():
    assert "禁止附加自己的评论与立场" in DEHYDRATE_PROMPT
    assert "不得生成原文中不存在" in DEHYDRATE_PROMPT


def test_digest_prompt_forbids_padding_short_entries():
    """R5 报告 3：39 字输入被 digest 扩写成 65 字，加进了原文没有的整句。

    根因是旧规则 6「单个条目内容不少于 50 字」——低于 50 字的输入被逼着扩写凑数，
    而 grow 的短路径阈值是 30 字，30~50 字这段正好掉进「必须扩写」的区间。
    对记忆系统来说这是捏造记忆，比丢标签严重得多。

    模型是否真的照做要靠真实打标模型验证；这里只锁住 prompt 里不再有长度下限、
    且明确禁止补写原文没有的内容。
    """
    assert "不少于50字" not in DIGEST_PROMPT
    assert "条目长度不设下限" in DIGEST_PROMPT
    assert "严禁为了凑长度补充原文没有的信息" in DIGEST_PROMPT


def test_analysis_prompt_and_parser_include_importance(tmp_path):
    assert "importance（重要度）：1~10 的整数" in ANALYZE_PROMPT
    assert '"importance": 5' in ANALYZE_PROMPT

    dehydrator = _dehydrator(tmp_path)
    parsed = dehydrator._parse_analysis(json.dumps({
        "domain": ["工作"],
        "valence": 0.6,
        "arousal": 0.4,
        "tags": ["承诺"],
        "suggested_name": "项目承诺",
        "importance": 8,
    }, ensure_ascii=False))
    dehydrator._cache_conn.close()

    assert parsed["importance"] == 8
