import pytest
from pydantic import BaseModel


class _Arguments(BaseModel):
    value: int = 1


class _Metadata:
    arg_model = _Arguments


class _Tool:
    fn_metadata = _Metadata()

    def __init__(self, text: str):
        self.text = text

    async def run(self, _arguments):
        return self.text



@pytest.mark.asyncio
async def test_all_public_tools_use_the_same_versioned_result_envelope(monkeypatch):
    import server

    public_tools = [tool.name for tool in await server.mcp.list_tools()]
    assert len(public_tools) == 15
    assert set(public_tools) == {
        "breath", "breath_search", "breath_advanced", "hold", "grow",
        "source_read", "trace", "dream", "anchor", "release", "pulse",
        "plan", "letter_write", "letter_read", "I",
    }
    discovered = await server.mcp.list_tools()
    for tool in discovered:
        schema = tool.outputSchema
        assert schema is not None
        assert set(schema["required"]) == {
            "result", "schema_version", "ok", "status", "error_code", "operation", "data",
        }

    calls = []

    def get_tool(name):
        calls.append(name)
        return _Tool(f"中文旧文本：{name}")

    monkeypatch.setattr(server.mcp._tool_manager, "get_tool", get_tool)
    for name in public_tools:
        result = await server._call_tool_with_envelope(name, {"value": 1})
        assert result.isError is False
        assert result.content[0].text == f"中文旧文本：{name}"
        assert result.structuredContent == {
            "result": f"中文旧文本：{name}",
            "schema_version": "ombrebrain.tool-result.v1",
            "ok": True,
            "status": "response_returned",
            "error_code": None,
            "operation": {"name": name, "business_outcome": "unknown"},
            "data": {"text": f"中文旧文本：{name}"},
        }
    assert calls == public_tools


@pytest.mark.asyncio
async def test_fastmcp_direct_call_converts_legacy_string_to_the_advertised_envelope(monkeypatch):
    import server

    async def fake_pulse(*, include_archive=False):
        assert include_archive is False
        return "直接调用文本"

    monkeypatch.setattr(server._t_anchor, "pulse", fake_pulse)
    content, structured = await server.mcp.call_tool("pulse", {})

    assert content[0].text == "直接调用文本"
    assert structured["result"] == "直接调用文本"
    assert structured["operation"]["name"] == "unknown"


@pytest.mark.asyncio
async def test_result_envelope_redacts_invalid_values_and_keeps_public_error_codes(monkeypatch):
    import server

    monkeypatch.setattr(server.mcp._tool_manager, "get_tool", lambda _name: _Tool("ignored"))
    invalid = await server._call_tool_with_envelope("hold", {"value": "secret://not-returned"})
    assert invalid.isError is True
    assert invalid.structuredContent["ok"] is False
    assert invalid.structuredContent["error_code"] == "OB-MCP-INVALID_ARGUMENTS"
    assert invalid.structuredContent["operation"]["business_outcome"] == "failed"
    assert "secret://not-returned" not in invalid.content[0].text

    monkeypatch.setattr(
        server.mcp._tool_manager,
        "get_tool",
        lambda _name: _Tool("❌ [OB-E004] 工具执行异常\n安全说明"),
    )
    existing = await server._call_tool_with_envelope("hold", {"value": 1})
    assert existing.isError is True
    assert existing.content[0].text == "❌ [OB-E004] 工具执行异常\n安全说明"
    assert existing.structuredContent["error_code"] == "OB-E004"

    monkeypatch.setattr(
        server.mcp._tool_manager,
        "get_tool",
        lambda _name: _Tool("成功\n⚠️ [OB-W005] 可恢复提示"),
    )
    warning = await server._call_tool_with_envelope("hold", {"value": 1})
    assert warning.isError is False
    assert warning.structuredContent["ok"] is True
    assert warning.structuredContent["error_code"] is None
    assert warning.structuredContent["operation"]["business_outcome"] == "unknown"
