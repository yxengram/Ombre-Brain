# MCP 工具输出协议

全部 15 个公开工具都会在 MCP `content` 保留既有中文文本；支持该字段的 MCP
版本还会得到稳定的 `structuredContent`：

```json
{
  "schema_version": "ombrebrain.tool-result.v1",
  "result": "原有中文工具输出",
  "ok": true,
  "status": "response_returned",
  "error_code": null,
  "operation": {"name": "pulse", "business_outcome": "unknown"},
  "data": {"text": "原有中文工具输出"}
}
```

客户端应使用 `result`、`ok`、`status`、`error_code`、`operation` 和 `data`。
`result` 保留 FastMCP 对旧 `-> str` 的结构化别名，值与 `data.text`/`content` 相同。
`ok` 只表示
协议 handler 返回了非 error 响应，不表示旧式纯文本工具一定改变了领域状态。工具尚未
提供显式领域 receipt 时，`operation.business_outcome` 保守地为 `unknown`；调用方
不得解析中文文本，或从 `ok` 推断写入、删除或命中成功。`data.text` 与 `content`
保留的旧文本完全一致，因此忽略 `structuredContent` 的旧连接器仍维持升级前行为。

协议边界失败使用稳定错误码：`OB-MCP-UNKNOWN_TOOL`、`OB-MCP-INVALID_ARGUMENTS`
和 `OB-MCP-EXECUTION_FAILED`。工具已经输出的公开 `OB-E*` 错误会原样保留。无效
参数值、异常正文、本机路径、配置和凭据绝不会复制进信封。

全部 15 个工具发现的 `outputSchema` 都是此信封，且要求 `result` 与其余字段。
真实低层 MCP handler 和官方 `ClientSession` 都会按发现 schema 校验成功响应；旧的
`structuredContent.result` 读取方以及仅读取 `content` 的连接器均保持兼容。后续可在不
改变此信封版本的前提下，逐工具把 `business_outcome=unknown` 收紧为经过校验的领域 receipt。

`GET /health` 保持常数时间，并返回 `deployment`：进程启动时固定的版本、git commit
（无 git 的镜像可由构建时 `OMBRE_BUILD_COMMIT` 注入，否则为 `unknown`）、运行时代码
指纹（不可用时为 `unavailable`）和 UTC `deployed_at`。其中不包含 vault 路径、配置或密钥。
