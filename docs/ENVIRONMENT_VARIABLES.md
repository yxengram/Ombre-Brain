# Ombre Brain 全环境变量清单

本文是环境变量名称的唯一文档真源。代码、Docker 与 README 只能引用这里已经登记的名称；禁止静默改名。确需更名时，旧名必须保留兼容映射、弃用提示和迁移说明。

## 模型与向量

- `OMBRE_COMPRESS_API_KEY`：打标、脱水和合并模型密钥。
- `OMBRE_COMPRESS_BASE_URL`：OpenAI 兼容模型地址。
- `OMBRE_COMPRESS_MODEL`：打标模型名。
- `OMBRE_COMPRESS_FORMAT`：打标 API 格式。
- `OMBRE_COMPRESS_API_FORMAT`：`OMBRE_COMPRESS_FORMAT` 的旧兼容名。
- `OMBRE_COMPRESS_TIMEOUT_SECONDS`：打标请求超时秒数。
- `OMBRE_EMBED_API_KEY`：向量模型密钥。
- `OMBRE_EMBED_BASE_URL`：向量 API 地址。
- `OMBRE_EMBED_MODEL`：向量模型名。
- `OMBRE_EMBED_FORMAT`：向量 API 格式。
- `OMBRE_EMBED_TIMEOUT_SECONDS`：向量请求超时秒数。
- `OMBRE_EMBED_BACKEND`：向量后端，例如 `api` 或 `local`。
- `OMBRE_OLLAMA_URL`：本地 Ollama 地址。

## 存储、媒体与日志

- `OMBRE_VAULT_DIR`：推荐的数据根目录。
- `OMBRE_BUCKETS_DIR`：`OMBRE_VAULT_DIR` 的旧兼容名。
- `OMBRE_MEDIA_DIR`：仅可显式重申 `<数据根目录>/_media`；外部目录会被拒绝，避免媒体引用无法进入备份与恢复。
- `OMBRE_MEDIA_MAX_BYTES`：单个媒体文件最大字节数，默认 25 MiB。
- `OMBRE_CONFIG_PATH`：持久配置文件路径。
- `OMBRE_CODE_DIR`：容器中持久运行代码目录。
- `OMBRE_LOG_DIR`：日志目录。
- `OMBRE_LOG_FILE`：日志文件路径。
- `OMBRE_EXTERNAL_CHANGE_POLL_SECONDS`：外部 Markdown 变动轮询间隔。
- `OMBRE_BUILD_COMMIT`：镜像构建时注入的完整 40 位 git commit SHA；仅在运行目录没有可读 git commit 时用于 `/health` 部署身份，非法值安全降级为 `unknown`。

## HTTP、MCP 与鉴权

- `OMBRE_TRANSPORT`：`stdio`、`sse` 或 `streamable-http`。
- `OMBRE_PORT`：容器或裸机监听端口。
- `OMBRE_BIND_HOST`：进程实际监听地址；容器/PaaS 通常需要 `0.0.0.0`，裸机仅限本机访问时应设为 `127.0.0.1`。
- `OMBRE_MCP_REQUIRE_AUTH`：是否要求 MCP 鉴权。网络传输在非确认回环边界
  设置为 `false` 会拒绝启动；只有 `stdio`、确认回环，或操作员明确设置
  `OMBRE_ALLOW_INSECURE_MCP=true` 才可免鉴权。
- `OMBRE_MCP_AUTH_MODE`：`oauth`、`token` 或 `hybrid`。`hybrid` 保留 OAuth 动态注册，同时让 `Authorization: Bearer` 也接受预置静态 Token；关闭鉴权仍由 `OMBRE_MCP_REQUIRE_AUTH=false` 控制。
- `OMBRE_MCP_TOKEN`：静态 Token / OAuth + 静态 Token 共存模式的预置密钥。
- `OMBRE_ALLOW_INSECURE_MCP`：非回环网络 MCP 免鉴权的唯一高风险逃生阀，只接受精确值 `true`。未设置时，危险组合会在启动期明确失败，而不是静默改写配置或继续裸奔。
- `OMBRE_MCP_RATE_LIMIT_PROFILE=integration-test`：仅供仓库 Docker 集成测试。还必须同时设置 `OMBRE_INTEGRATION_TEST=true` 且 `OMBRE_BIND_ADDRESS` 为明确回环地址，否则服务拒绝启动；生产环境不要设置。
- `OMBRE_INTEGRATION_TEST`：配合上述测试限流档的第二个显式信号；单独设置不改变任何配额。
- `OMBRE_DASHBOARD_PASSWORD`：Dashboard 密码。
- `OMBRE_DASHBOARD_SESSION_DAYS`：Dashboard 登录会话天数。
- `OMBRE_TRUSTED_PROXY_CIDRS`：直接连接 OB 的最后一跳可信反向代理 CIDR；不是公网客户端 IP 或域名，禁止使用 `0.0.0.0/0`。官方 Compose 模板会从 `.env` 透传该值，修改后需要重新创建容器。

## Tunnel、Hook 与 GitHub

- `OMBRE_GITHUB_TOKEN`：GitHub 备份或更新访问令牌。
- `OMBRE_HOOK_URL`：外部 Hook 地址。
- `OMBRE_HOOK_TOKEN`：Hook 鉴权令牌。
- `OMBRE_HOOK_SKIP`：跳过 Hook。
- `OMBRE_HOOK_ALLOW_PUBLIC`：允许公网 Hook 地址。
- `TUNNEL_EDGE`：cloudflared 边缘节点覆盖值。
- `TUNNEL_TRANSPORT_PROTOCOL`：cloudflared 传输协议。

## 更新与容器维护

- `OMBRE_ALLOW_CUSTOM_UPDATE_REPO`、`OMBRE_ALLOW_UNTRUSTED_MIRROR`、`OMBRE_UPDATE_ALLOW_PIP`：已退役且不再放宽更新链。热更新仅接受官方签名 Release；依赖升级必须使用由同一受控版本 tag 构建的 Docker 镜像。
- `OMBRE_FORCE_CODE_RESEED`：下次启动强制从镜像重播代码；使用后应移除。
- `OMBRE_IMAGE_ROOT`：镜像内置代码根目录。
- `OMBRE_BOOTSTRAP_ONLY`：仅执行启动引导和诊断。
- `OMBRE_DOCKER_INTEGRATION_URL`：Docker 集成服务地址。
- `OMBRE_DOCKER_WEB_BASE_URL`：Docker Web 基地址。

## 部署编排与多所有者

- `OMBRE_BIND_ADDRESS`：Compose 宿主机对外绑定地址，默认 `127.0.0.1`；官方模板同时把该值传入容器，供 MCP 安全门禁判断真实宿主边界。
- `OMBRE_HOST_PORT`：Compose 宿主机端口。
- `OMBRE_HOST_VAULT_DIR`：Compose 宿主机数据目录。
- `OMBRE_CONTAINER_NAME`：目标容器名。
- `OMBRE_OWNER_NAME`：当前所有者名。
- `OMBRE_OWNER_COUNT`：多所有者实例数。
- `OMBRE_MING_VAULT_DIR`、`OMBRE_HONG_VAULT_DIR`：示例多所有者数据目录。
- `OMBRE_MING_PASSWORD`、`OMBRE_HONG_PASSWORD`：示例多所有者密码。
- `OMBRE_MING_MCP_TOKEN`、`OMBRE_HONG_MCP_TOKEN`：多所有者 Compose 中每个实例各自的静态 MCP Token；不要让多个 owner 共用同一密钥。
- `AI_NAME`：AI 显示名称。

## v1.x 兼容变量

这些旧名仍然生效，但新部署应使用右侧正式名称：

- `OMBRE_API_KEY` → `OMBRE_COMPRESS_API_KEY`
- `OMBRE_BASE_URL` → `OMBRE_COMPRESS_BASE_URL`
- `PASSWORD` → `OMBRE_DASHBOARD_PASSWORD`

正式名称和旧名同时存在时，以正式名称为准。删除兼容名必须经过一次明确的主版本迁移，并在发布说明中写出截止版本，禁止在普通重构中删除。
