"""GPT-5.x / o 系列的 Chat Completions 参数方言回归测试。

背景：OpenAI 从 GPT-5 起不再接受 max_tokens，只接受 max_completion_tokens
（发 max_tokens 直接 400: "Unsupported parameter: 'max_tokens' is not supported
with this model. Use 'max_completion_tokens' instead."）。GPT-4o 及各家 OpenAI
兼容代理仍然只认 max_tokens，所以不能全局改名——两个方向都要锁住。
"""

import httpx
import pytest

import web.config_api as config_api
from dehydrator import Dehydrator
from ombrebrain.integrations.provider_detect import requires_max_completion_tokens


class _FakeMessage:
    def __init__(self, content: str):
        self.content = content


class _FakeChoice:
    def __init__(self, content: str):
        self.message = _FakeMessage(content)


class _FakeResponse:
    def __init__(self, content: str):
        self.choices = [_FakeChoice(content)]


class _UnsupportedParamError(Exception):
    """模拟 openai.BadRequestError：status_code 挂在异常上，文案点名参数。"""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message
        self.status_code = 400


class _FakeCompletions:
    def __init__(self, fail_times: int = 0, error: Exception | None = None):
        self.calls: list[dict] = []
        self._fail_times = fail_times
        self._error = error

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        if len(self.calls) <= self._fail_times and self._error is not None:
            raise self._error
        return _FakeResponse("ok")


class _FakeClient:
    def __init__(self, completions: _FakeCompletions):
        self.chat = type("_Chat", (), {"completions": completions})()


def _dehydrator(tmp_path, model: str) -> Dehydrator:
    return Dehydrator({
        "buckets_dir": str(tmp_path / "vault"),
        "human": "测试者",
        "dehydration": {
            "api_key": "test-key",
            "api_format": "openai_compat",
            "base_url": "https://api.openai.com/v1",
            "model": model,
        },
    })


@pytest.mark.parametrize(
    ("model", "expected"),
    [
        ("gpt-5", True),
        ("gpt-5.1", True),
        ("gpt-5-mini", True),
        ("gpt-5-chat-latest", True),
        ("openai/gpt-5", True),
        ("GPT-5", True),
        ("o1-mini", True),
        ("o3", True),
        ("gpt-4o-mini", False),
        ("gpt-4o", False),
        ("gpt-4.1", False),
        ("gpt-51-custom", False),
        ("deepseek-chat", False),
        ("gemini-2.0-flash", False),
        ("qwen2.5:7b", False),
    ],
)
def test_model_family_detection(model: str, expected: bool):
    assert requires_max_completion_tokens(model) is expected


@pytest.mark.asyncio
async def test_gpt5_sends_max_completion_tokens(tmp_path):
    dehydrator = _dehydrator(tmp_path, "gpt-5")
    completions = _FakeCompletions()
    dehydrator.client = _FakeClient(completions)

    result = await dehydrator._chat_once("system", "user", max_tokens=256)
    dehydrator.close()

    assert result == "ok"
    assert completions.calls[0]["max_completion_tokens"] == 256
    assert "max_tokens" not in completions.calls[0]


@pytest.mark.asyncio
async def test_legacy_model_keeps_max_tokens(tmp_path):
    dehydrator = _dehydrator(tmp_path, "gpt-4o-mini")
    completions = _FakeCompletions()
    dehydrator.client = _FakeClient(completions)

    await dehydrator._chat_once("system", "user", max_tokens=256)
    dehydrator.close()

    assert completions.calls[0]["max_tokens"] == 256
    assert "max_completion_tokens" not in completions.calls[0]


@pytest.mark.asyncio
async def test_unsupported_param_error_is_corrected_and_remembered(tmp_path):
    """未知代理上的 GPT-5 类模型：按端点报错改参重发，之后不再白跑一次。"""
    dehydrator = _dehydrator(tmp_path, "custom-proxy-model")
    completions = _FakeCompletions(
        fail_times=1,
        error=_UnsupportedParamError(
            "Unsupported parameter: 'max_tokens' is not supported with this "
            "model. Use 'max_completion_tokens' instead."
        ),
    )
    dehydrator.client = _FakeClient(completions)

    first = await dehydrator._chat_once("system", "user", max_tokens=256)
    second = await dehydrator._chat_once("system", "user", max_tokens=256)
    dehydrator.close()

    assert first == "ok" and second == "ok"
    assert len(completions.calls) == 3  # 首次失败 + 改参重发 + 第二次直接命中
    assert "max_tokens" in completions.calls[0]
    assert completions.calls[1]["max_completion_tokens"] == 256
    assert "max_tokens" not in completions.calls[1]
    # 第二次调用不再重复探测
    assert completions.calls[2]["max_completion_tokens"] == 256
    assert "max_tokens" not in completions.calls[2]


@pytest.mark.asyncio
async def test_reverse_correction_when_proxy_only_takes_max_tokens(tmp_path):
    """先验判断在兼容代理上过头时，按报错换回 max_tokens。"""
    dehydrator = _dehydrator(tmp_path, "gpt-5")
    completions = _FakeCompletions(
        fail_times=1,
        error=_UnsupportedParamError(
            "Unsupported parameter: 'max_completion_tokens'. Use 'max_tokens'."
        ),
    )
    dehydrator.client = _FakeClient(completions)

    await dehydrator._chat_once("system", "user", max_tokens=256)
    dehydrator.close()

    assert completions.calls[1]["max_tokens"] == 256
    assert "max_completion_tokens" not in completions.calls[1]
    assert dehydrator._token_param_name() == "max_tokens"


@pytest.mark.asyncio
async def test_fixed_temperature_model_drops_temperature(tmp_path):
    dehydrator = _dehydrator(tmp_path, "gpt-5")
    completions = _FakeCompletions(
        fail_times=1,
        error=_UnsupportedParamError(
            "Unsupported value: 'temperature' does not support 0.0 with this "
            "model. Only the default (1) value is supported."
        ),
    )
    dehydrator.client = _FakeClient(completions)

    await dehydrator._chat_once("system", "user", temperature=0.0)
    second_call_before = len(completions.calls)
    await dehydrator._chat_once("system", "user", temperature=0.0)
    dehydrator.close()

    assert "temperature" in completions.calls[0]
    assert "temperature" not in completions.calls[1]
    # 记住结论后，后续调用一次成功且不再发 temperature
    assert len(completions.calls) == second_call_before + 1
    assert "temperature" not in completions.calls[-1]


@pytest.mark.asyncio
async def test_analyze_end_to_end_uses_corrected_param(tmp_path):
    """公开路径（analyze → _chat → _chat_once）整条链路都不再发 max_tokens。"""
    dehydrator = _dehydrator(tmp_path, "gpt-5")
    completions = _FakeCompletions()
    completions.create = _analysis_create(completions)  # type: ignore[method-assign]
    dehydrator.client = _FakeClient(completions)

    result = await dehydrator.analyze("今天把 GPT-5 打标跑通了")
    dehydrator.close()

    assert result["suggested_name"] == "打标跑通"
    assert "max_completion_tokens" in completions.calls[0]
    assert "max_tokens" not in completions.calls[0]


def _analysis_create(completions: _FakeCompletions):
    import json

    async def create(**kwargs):
        completions.calls.append(kwargs)
        return _FakeResponse(json.dumps({
            "domain": ["数字"],
            "valence": 0.7,
            "arousal": 0.4,
            "tags": ["打标"],
            "suggested_name": "打标跑通",
            "importance": 5,
        }, ensure_ascii=False))

    return create


@pytest.mark.asyncio
async def test_unrelated_error_is_not_swallowed(tmp_path):
    dehydrator = _dehydrator(tmp_path, "gpt-5")
    completions = _FakeCompletions(
        fail_times=99,
        error=_UnsupportedParamError("Incorrect API key provided"),
    )
    dehydrator.client = _FakeClient(completions)

    with pytest.raises(_UnsupportedParamError, match="Incorrect API key"):
        await dehydrator._chat_once("system", "user")
    dehydrator.close()

    assert len(completions.calls) == 1  # 不做无意义的改参重试


# ---------------------------------------------------------------
# Dashboard「测试脱水 API」连通性探测也要按模型家族选参数名，
# 否则 GPT-5.x 会被 400 拒掉，误报成「Key 无效」。
# ---------------------------------------------------------------

class _FakeMCP:
    def __init__(self) -> None:
        self.routes: dict = {}

    def custom_route(self, path, methods):
        def decorator(handler):
            for method in methods:
                self.routes[(method, path)] = handler
            return handler

        return decorator


class _CapturingHTTPClient:
    """记录 POST 出去的 payload，并固定返回 200。"""

    sent: list[dict] = []

    def __init__(self, *_args, **_kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def post(self, _url, json=None, headers=None):
        type(self).sent.append(json or {})
        return type("_Resp", (), {"status_code": 200, "text": "", "json": lambda self: {}})()


async def _probe_payload(monkeypatch, model: str) -> dict:
    _CapturingHTTPClient.sent = []
    monkeypatch.setattr(config_api.sh, "_require_auth", lambda _request: None)
    monkeypatch.setattr(config_api.sh, "config", {
        "dehydration": {
            "model": model,
            "base_url": "https://api.openai.com/v1",
            "api_key": "test-key",
        },
    })
    monkeypatch.setattr(httpx, "AsyncClient", _CapturingHTTPClient)
    mcp = _FakeMCP()
    config_api.register(mcp)
    await mcp.routes[("POST", "/api/test/dehydration")](object())
    return _CapturingHTTPClient.sent[0]


@pytest.mark.asyncio
async def test_dehydration_probe_uses_max_completion_tokens_for_gpt5(monkeypatch):
    payload = await _probe_payload(monkeypatch, "gpt-5")
    assert "max_completion_tokens" in payload
    assert "max_tokens" not in payload


@pytest.mark.asyncio
async def test_dehydration_probe_keeps_max_tokens_for_legacy_model(monkeypatch):
    payload = await _probe_payload(monkeypatch, "gpt-4o-mini")
    assert "max_tokens" in payload
    assert "max_completion_tokens" not in payload
