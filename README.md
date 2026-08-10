# Ombre Brain

一个给 Claude（或其它 MCP 客户端）用的长期情绪记忆系统。基于 Russell 效价/唤醒度坐标打标，Obsidian 做存储层，MCP 接入，带遗忘曲线和向量语义检索——不是冷冰冰的键值存储，而是会自然衰减、像人类一样会遗忘和浮现的记忆。

A long-term emotional memory system for Claude (and any MCP client): Russell valence/arousal tagging, Obsidian-compatible Markdown storage, MCP access, forgetting curve + vector semantic search.

> **本仓库是 [P0luz/Ombre-Brain](https://github.com/P0luz/Ombre-Brain) 的个人 fork**（`yxengram/Ombre-Brain`），跟自己用。下文的 `curl` / `git clone` 都指向本 fork，预构建镜像发布在 `thomas1997/ombre-brain`。
>
> 设计哲学与完整技术规格见 [rule.md](rule.md) / [docs/INTERNALS.md](docs/INTERNALS.md)；给 Claude 用的工具约定见 [docs/CLAUDE_PROMPT.md](docs/CLAUDE_PROMPT.md)；每个版本改了什么见 [CHANGELOG.md](CHANGELOG.md)。

---

## 核心特性

- **情感坐标打标**：valence（效价）+ arousal（唤醒度）两个连续维度，不是「开心/难过」这种离散标签
- **混合检索**：rapidfuzz + BM25 关键词与 cosine 向量语义融合，向量服务离线时自动退回关键词检索
- **自然遗忘**：改进版艾宾浩斯曲线，不活跃的记忆自动衰减归档，只淡去、不删除（`archive/`，无物理抹除）
- **权重池浮现**：未解决的、情绪强烈的记忆权重更高，对话开头自动浮现
- **Obsidian 原生**：每个记忆桶 = 一个 Markdown 文件 + YAML frontmatter，可直接用 Obsidian 浏览编辑
- **Dashboard**：内置 Web 管理面板，密码保护，桶列表 / 检索调试 / 记忆网络 / 配置管理 / Cloudflare Tunnel 一键连接

**15 个工具**（`breath` `breath_search` `breath_advanced` `hold` `grow` `source_read` `trace` `dream` `pulse` `plan` `anchor` `release` `letter_write` `letter_read` `I`）全部挂在**同一个 MCP 连接器 `/mcp`** 上，连上即拥有全部能力。完整用法见 [docs/CLAUDE_PROMPT.md](docs/CLAUDE_PROMPT.md)，逐工具技术规格见 [docs/INTERNALS.md](docs/INTERNALS.md) §3；程序化客户端可使用版本化的 [MCP 输出协议](docs/MCP_OUTPUT_PROTOCOL.md)。

---

## 快速开始 / Quick Start（Docker Hub 预构建镜像）

> 不需要 clone 代码，不需要 build。第一次完整跑通约 5 分钟。

> ⚠️ **必须有「持久磁盘」**：记忆桶是磁盘上的 `.md` 文件 + SQLite 向量库。本项目只支持自托管（Docker 或从源码部署），跑在自己的电脑、NAS 或 VPS 上，数据落在自己的盘。要给 Claude.ai 网页版用，就用内置的 **Cloudflare Tunnel** 一键拿一个公网 `https://…`（见「接入方式」）；只在同一台设备上用就走「仅本机回环免鉴权」。没有 API Key 就去 [硅基流动](https://siliconflow.cn/) 领免费额度，或用本地 Ollama bge-m3。

装好 [Docker Desktop](https://www.docker.com/products/docker-desktop/) 后：

首次从旧版本升级时，如 buckets 曾由 root 容器创建，先执行一次 `docker compose -f deploy/docker-compose.user.yml --profile permissions run --rm permissions`，再正常启动。应用容器默认以非 root UID 10001、只读根文件系统运行。

```bash
mkdir ombre-brain && cd ombre-brain

# 下载用户版 compose 文件（不需要提前准备 API Key，可以在 Dashboard 里随时填入并立即生效）
curl -O https://raw.githubusercontent.com/yxengram/Ombre-Brain/main/deploy/docker-compose.user.yml

# 拉取镜像并启动（第一次会下载约 500MB）
docker compose -f docker-compose.user.yml up -d
```

启动后在 Dashboard → **③ 引擎** 里填入 Key 并点「保存 Key」，立即热更新生效，无需重启。也可以提前在 `.env` 里写好：

```bash
echo "OMBRE_COMPRESS_API_KEY=your-key-here" > .env
echo "OMBRE_EMBED_API_KEY=your-embed-key" >> .env
echo "OMBRE_HOST_VAULT_DIR=D:/Ombre-Brain/buckets-data" >> .env
```

`OMBRE_HOST_VAULT_DIR` 指向宿主机持久目录，记忆、`config.yaml`、Tunnel token 都存在这里；重建容器不会清空。

**推荐免费方案：Google AI Studio**——[aistudio.google.com/apikey](https://aistudio.google.com/apikey) 领 key，脱水/打标用 `gemini-2.0-flash`，向量化用 `gemini-embedding-001`（1500 req/day 免费），Base URL 填 `https://generativelanguage.googleapis.com/v1beta/openai/`。也支持任何 OpenAI 兼容接口（DeepSeek / SiliconFlow / Ollama / LM Studio / vLLM 等）。

验证：`curl http://localhost:18001/health` 返回 `{"status":"ok",...}` 即成功；浏览器打开 `http://localhost:18001` 进 Dashboard，首次访问会引导设置密码。

---

## 接入方式 / Connect to Claude

### 方式一：本地 stdio（Claude Desktop，最简单）

同一台电脑用 Claude Desktop，不需要公网。打开配置文件（macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`，Windows：`%APPDATA%\Claude\claude_desktop_config.json`），加入：

```json
{
  "mcpServers": {
    "ombre-brain": {
      "command": "python",
      "args": ["/path/to/Ombre-Brain/src/server.py"]
    }
  }
}
```

Docker 跑的话改用：

```json
{
  "mcpServers": {
    "ombre-brain": {
      "type": "streamable-http",
      "url": "http://localhost:18001/mcp"
    }
  }
}
```

重启 Claude Desktop，全部 15 个工具会出现在同一连接器 `/mcp` 下。

---

### 方式二：HTTPS 远程连接（Claude.ai 网页版 / Claude Code / 手机）

想在手机、浏览器、多台设备上用。**必须先把服务暴露到公网**，推荐 Cloudflare Tunnel（免费）：

1. [Cloudflare Zero Trust](https://one.dash.cloudflare.com) → **Networks → Tunnels → Create a tunnel** → 选 **Cloudflared** → 起名
2. **Install connector** 页选 **Docker**，复制 `--token` 后面那串字符（以 `eyJ` 开头）
3. Ombre Brain Dashboard → **设置** → **Cloudflare Tunnel**，粘贴 token → 「保存 Token」→「启动」
4. 状态点变绿后，回 Cloudflare 添加 Public Hostname：Domain 填你的域名，Service Type 选 HTTP，URL 填 `localhost:8000`

或命令行手动跑：`cloudflared tunnel --no-autoupdate run --token eyJ...`

然后在 [claude.ai](https://claude.ai) → **Connectors** → **Add**，填入 `https://ombre.example.com/mcp`，会自动触发 OAuth 授权流程——弹出的授权页是你自己的服务器，密码就是 Dashboard 密码。access token 有效期 1 小时，refresh token 最长 30 天并支持轮换续期。

15 个工具全在**一个 MCP 端点 `/mcp`** 上（旧版 `/mcp-extra` 已退役，返回 404，不要单独添加）：

```
http(s)://<你的地址>:18001/mcp
```

`<你的地址>` 填什么：本机访问用 `http://localhost:18001/mcp`；直连 VPS 公网 IP 用 `http://服务器IP:18001/mcp`；用了 Tunnel/自有域名就整段换成域名，通常不带端口、走 https（例如 `https://ombre.example.com/mcp`）。端口以实际 `docker-compose` 的 `ports` 映射为准。

Claude Code 本地推荐用 stdio（更简单，无需 OAuth）：

```bash
claude mcp add ombre-brain python /path/to/server.py
# 远程 HTTPS（同 Claude.ai 流程）：
claude mcp add ombre-brain --transport http https://ombre.example.com/mcp
```

---

### 方式三：仅本机回环免鉴权（高级）

OB 与自有前端 / 自定义脚本运行在**同一设备**、客户端不支持 OAuth 时用。默认 `/mcp` 强制 OAuth 2.1；确认网络边界安全后可明确关闭：

```bash
export OMBRE_BIND_HOST=127.0.0.1
export OMBRE_MCP_REQUIRE_AUTH=false
# 或 config.yaml: mcp_require_auth: false
```

改完需**重启服务**。⚠️ 关闭鉴权后任何能访问 `/mcp` 的人都能读写全部记忆，只在明确的本机回环边界下用；跨设备连接改用下面的静态 Token。

---

### 方式四：OAuth + 静态 Token 共存（推荐给自建前端）

同一个 OB 实例既要连 Claude.ai 等 OAuth 客户端，又要连只会带固定 Bearer 的自建前端 / TypingMind / Kelivo 等：

```bash
OMBRE_MCP_AUTH_MODE=hybrid
OMBRE_MCP_TOKEN=一串足够长的随机密钥
```

也可以在 Dashboard「MCP 鉴权」区选「OAuth + 静态 Token 共存」，点「生成新 Token」。客户端调用时用 `Authorization: Bearer <token>` 或 `Ombre-MCP-Token: <token>` 请求头（不支持放进 URL 查询参数）。公网必须用 HTTPS，妥善保管并定期轮换 Token。

---

### Operit / 安卓 / Proot 本地桥接

用 Operit 等本地 MCP 客户端通过 Termux/Proot 跑，连接器一直黄灯时，按顺序检查三点：① `transport` 必须是 `streamable-http`（默认 `stdio` 不开 HTTP 服务）；② 同一手机回环可设 `OMBRE_BIND_HOST=127.0.0.1` + `OMBRE_MCP_REQUIRE_AUTH=false` 跳过 OAuth，跨设备用静态 Token；③ 客户端 URL 用 `127.0.0.1` 而不是 `localhost`（Proot 里 `localhost` 可能解析到 IPv6）。对齐后仍不行就看 `server.log` 里的 `MCP endpoint ready` 那行确认传输和鉴权。

---

## 从源码部署 / Deploy from Source

想自己改代码或部署到 VPS：

```bash
git clone https://github.com/yxengram/Ombre-Brain.git
cd Ombre-Brain
docker compose -f deploy/docker-compose.yml up -d
```

验证：`docker logs ombre-brain` 看到 `Uvicorn running on http://0.0.0.0:8000`；`curl http://localhost:18001/health`；Dashboard 在 `http://localhost:18001`。

> **端口口径**：Docker 容器内固定监听 `8000`（镜像写死），对外端口由 `docker-compose.yml` 的 `ports`（默认 `18001:8000`）决定，升级不用动这个映射；裸机直接监听 `OMBRE_PORT`（默认 `18001`）。

**VPS + nginx/Caddy 反代**：`deploy/docker-compose.yml` 默认端口是 `127.0.0.1:18001`（仅本机），同机反代应保留这个回环绑定。nginx 必须把浏览器看到的公网来源准确传给 OB，额外加 CORS 头不能修复 `Cross-origin request rejected`：

```nginx
location / {
    proxy_pass http://127.0.0.1:18001;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

外置代理还要在 `.env` 里把**直接连接 OB 的最后一跳代理 CIDR**加入 `OMBRE_TRUSTED_PROXY_CIDRS`（不要填 `0.0.0.0/0`），再 `docker compose ... up -d --force-recreate`。然后打开 Dashboard → `/onboarding` → 选「公网安全模式」，把 HTTPS 域名填入「公网连接地址」并保存、重启——这个地址是 OAuth 元数据、授权端点和 `/mcp` resource 的权威外部来源，不填的话反代后的容器可能只看到内部 `http://` 地址，Claude.ai 会拒绝连接。

**不用 Docker（纯 Python）**：

```bash
git clone https://github.com/yxengram/Ombre-Brain.git
cd Ombre-Brain
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install --require-hashes -r requirements.lock.txt
cp config.example.yaml config.yaml
python src/server.py
```

---

## 更新 / How to Update

```bash
# Docker Hub 镜像用户
docker pull thomas1997/ombre-brain:latest
docker compose -f docker-compose.user.yml down && docker compose -f docker-compose.user.yml up -d

# 从源码部署用户
cd Ombre-Brain && git pull origin main
docker compose -f deploy/docker-compose.yml down
docker compose -f deploy/docker-compose.yml build
docker compose -f deploy/docker-compose.yml up -d
```

记忆数据在 volume 里，更新不会丢失。启动日志会打印当前活动代码目录和 `code-state`；细节和脱困步骤见 [docs/OPERATIONS.md](docs/OPERATIONS.md)。

---

## 多人共用 / Obsidian / 配置

- **一个大脑多人用、记忆完全隔离**：每人一个独立数据目录 + 独立端口（`OMBRE_VAULT_DIR` / `OMBRE_PORT` / `OMBRE_OWNER_NAME` / `OMBRE_OWNER_COUNT`），本机一键启动器 `python deploy/multi_owner.py` 或 Docker 多实例 `docker compose -f deploy/docker-compose.multi.yml up -d`。完整说明见 [docs/MULTI_OWNER.md](docs/MULTI_OWNER.md)。
- **挂到 Obsidian**：`docker-compose.user.yml` 同目录 `.env` 设 `OMBRE_HOST_VAULT_DIR=/path/to/Obsidian Vault/Ombre Brain`，`docker compose -f docker-compose.user.yml up -d --force-recreate`，每条记忆就是该目录下的 Markdown 文件。
- **常用配置**（`config.yaml`，从 `config.example.yaml` 复制）：`transport`（Docker 用 `streamable-http`）、`dehydration.model` / `base_url`（打标 LLM，⚠️ `max_tokens` 别设太小，Gemini 2.5 系列有思考开销会截断 JSON，推荐 `gemini-2.0-flash` 或 4096+）、`embedding.api_format`（`gemini` 云端 / `ollama` 本地 bge-m3，两者切换会全库重算向量，别频繁切）、`decay.lambda`（衰减速率）。完整参数表见 [docs/INTERNALS.md](docs/INTERNALS.md)。

---

## 常见问题 / Troubleshooting

| 现象 | 解决 |
|---|---|
| 记忆 domain 显示「未分类」 | `dehydration.max_tokens` 设为 `4096`；换够强的打标模型（7B 级小模型吐不出结构化 JSON） |
| nginx/Caddy 反代后 OAuth 元数据或授权链接生成 `http://`，Claude.ai 拒绝连接 | 转发头来自未加入 `OMBRE_TRUSTED_PROXY_CIDRS` 的代理地址会被忽略；Dashboard → `/onboarding` → 公网安全模式填 HTTPS 域名并保存、重启；不要把 `0.0.0.0/0` 加入可信代理 |
| 连接成功但「no tools available」 | 确认连接 URL 末尾是 `/mcp` |
| 向量化不生效 | base_url 漏 `/v1`（→404）、model 漏厂商前缀如 `BAAI/`（→Model does not exist） |
| 在面板改了 key/配置，重启后又变回旧值 | env 变量优先级高于 config.yaml；启动时用 `-e OMBRE_XXX=...` 传的值会盖掉面板改动，二选一别混用 |
| 重启后记忆丢失 | 数据目录没挂持久盘。判断标准：能在宿主机文件夹里看到那些 `.md` 文件就是安全的；Dashboard → 系统诊断会直接告诉你 |
| Docker 构建在 `pip install` 处失败 | 用「快速开始」的预构建镜像，不需要本地构建；必须本地构建就换个 PyPI 镜像源 |
| Tunnel 状态红色 | Token 无效，或 VPN DNS 不支持 SRV 查询；新版 compose 默认双 region + HTTP/2 绕过，`--force-recreate` 一次 |

更完整的排障列表（含 Operit 黄灯三步法、Kelivo 接入、并发写入定位等）见 git 历史或直接读 [src/web/system.py](src/web/system.py) 的诊断逻辑——这份 README 只保留最常踩的几个。

---

## License

MIT。环境变量完整定义见 [docs/ENVIRONMENT_VARIABLES.md](docs/ENVIRONMENT_VARIABLES.md)，禁止从 README 片段猜变量名；永久兼容旧名：`OMBRE_API_KEY` → `OMBRE_COMPRESS_API_KEY`，`OMBRE_BASE_URL` → `OMBRE_COMPRESS_BASE_URL`，`PASSWORD` → `OMBRE_DASHBOARD_PASSWORD`，`OMBRE_BUCKETS_DIR` → `OMBRE_VAULT_DIR`。

v2.4.0 起的架构工作仅限个人、学习、研究及非商业自托管使用；商业托管/转售/改名转售/SaaS 转售需项目所有者许可，详见 [LICENSE.v2.4.0-NONCOMMERCIAL-NOTICE.md](LICENSE.v2.4.0-NONCOMMERCIAL-NOTICE.md)。
