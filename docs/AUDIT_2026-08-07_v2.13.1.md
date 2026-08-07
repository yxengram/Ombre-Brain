# Ombre Brain 功能检测报告（源码级审计）

日期：2026-08-07　版本：2.13.1

## 检测范围说明

MCP 连接器在首次 `pulse()` 之后掉线，本轮**没有跑真实打标调用**。结论来自源码审计 + 交叉验证你附的四轮测试结果 + 本地跑完整测试套件（2229 passed / 6 failed / 98 skipped）。

---

## 一、静默写错数据（最高优先级，你的测试没覆盖到）

### 1. `x or 默认值` 吞掉 0.0

- **现象**：显式传 `valence=0`（极度消极）或 `arousal=0`（完全平静）会被当成"没传"，落盘成 0.5 / 0.3。0.0 恰恰是情感上最有意义的那一端。
- **根因（写盘，会污染数据）**：
  - `src/tools/grow/core.py:88-89` — `valence=item.get("valence") or 0.5`、`arousal=item.get("arousal") or 0.3`
  - `src/tools/_common.py:880-881` — 合并时 `old_v = metadata.get("valence") or 0.5`，老桶存的 0.0 被当缺省，平均后把值抬高
- **根因（只影响显示）**：`src/tools/anchor/core.py:163-164`、`src/tools/dream/output.py:350-351`、`:573`
- **建议**：全部改成 `is None` 判断。检索侧 `ombrebrain/retrieval/bucket_scoring.py:102-103` 用的是 `meta.get(k, default)`，是对的 —— 打分没被污染，可以参照它改。

---

## 二、plan 自动闭环判定过松（对应你的问题 6）

- **现象**：话题相近就可能把 active plan 标成 resolved，关键细节不匹配也照标。
- **根因**：
  1. `src/tools/_common.py:1265` 的候选列表是 `keyword_candidates + vector_candidates + active_plans` —— 最后那个兜底意味着**每次写入都会把所有 active plan（上限 10 个）送进 LLM 判定**，关键词/向量预筛等于没有约束力。
  2. 阈值不对称：合并同一事件要 `_SAME_EVENT_CONFIDENCE_MIN = 0.85`，而把一条承诺标记完成只要 `_PLAN_LLM_CONFIDENCE_MIN = 0.7`（`_common.py:85-86`）。承诺比合并更不该误判。
  3. 判定 prompt（`src/dehydrator.py:1057-1060`）只要求"明确表示已完成/放弃"，没有要求关键实体（对象、时间、数量）逐项匹配。
- **建议**：去掉 `+ active_plans` 兜底（或改成仅在预筛零命中时送 top-1）；`_PLAN_LLM_CONFIDENCE_MIN` 提到 0.85；prompt 加一条"plan 中的关键实体若在新事件中缺失或不一致 → 一律 false"。
- ⚠️ 这属于 CLAUDE.md 里"改核心记忆语义前先对齐"的范围，建议先确认再动。

---

## 三、打标质量（你的问题 1 / 3 / 4 / 5，全部是 prompt 层）

### 3. 中性事实 valence 恒偏正（问题 5）

- **根因**：`src/dehydrator.py:259` 的输出示例写的是 `"valence": 0.7`，digest 版 `:194` 同样。模型会强锚定格式示例里的数字 —— 这就是为什么换 4 个模型都落在 0.6~0.8、从没到过 0.5。
- **建议**：示例改成 `0.5`，并加硬规则"纯陈述性事实、无情绪色彩 → valence 必须 0.5"。顺带：示例里 `"arousal": 0.4` 和代码默认 `_DEFAULT_AROUSAL = 0.3`（`:106`）也不一致。

### 4. domain 压缩 + 正负情绪不对称是**同一个根因**（问题 3 + 4）

- **根因**：`src/dehydrator.py:236` 的"选最精确的 1~2 个"。名额只有 1~2 个时，正面事件的名额被具体领域（工作/学习/编程）吃光，情绪类 domain 挤不进来；负面事件常常没有具体领域可选，"情绪"才浮上来 —— 不对称是名额预算的副产物，不是模型偏见。
- 代码上限 `_DOMAIN_MAX = 3`（`:110`）**不是瓶颈**，只调它没有任何效果，prompt 先卡住了。
- **建议**：prompt 改成"1~3 个；内容带明显情绪色彩时必须额外保留一个 内心/身心 类 domain"，`_DOMAIN_MAX` 同步提到 4。

### 5. 极短输入标签 0~15 乱跳（问题 1）

- **根因**：`src/dehydrator.py:247-250` 的"总计 10~15 个"是无条件规则，不看输入长度。"测试"两个字也被要求引申出 8~10 个扩展词，结果完全取决于模型愿不愿意瞎编。
- **建议**：prompt 加长度闸门"原文少于 10 字或无可提取实体时，tags 最多 3 个，只允许原文出现过的词，禁止引申"；代码侧再按 `len(content)` 动态收紧 `_TAGS_MAX`，给一个模型绕不过的硬底线。

### 5b. 「0 个标签」还有第二条代码级成因

`src/dehydrator.py:927-929` 对模型返回的 JSON **完全不做类型校验**：

- `result.get("domain", ["未分类"])[:3]` —— 模型返回 `"domain": "编程"`（字符串，弱模型常见）时切片得到的还是**字符串**，到 `src/tools/hold/core.py:66-68` 的 isinstance 检查被整个替换成 `["未分类"]`，分类静默丢失。
- `result.get("tags", [])[:15]` —— 同理，字符串 tags 到 `hold/core.py:74` 变成 `[]`（0 个标签）；而 `"tags": null` 会让 `None[:15]` 抛 TypeError，这个异常在 `_parse_analysis` 的 try 之外，一路冒到 `hold/core.py:51` 被捕获 → **整份打标结果降级成默认值**，连 domain/valence/arousal/suggested_name 一起赔进去。

这两条路径都产出「恰好 0 个标签」，是 R4 那次「测试」= 0 标签的另一个可能成因，与 prompt 无关。
**建议**：在 `_parse_analysis` 内对每个字段做 `isinstance` 归一（非 list 就包成单元素 list 或丢弃），让某个字段畸形时只损失它自己，不拖垮整份结果。

### 6. 合并时 tags / domain 不设上限

- **现象**：新建走 `[:15]` / `[:3]` 截断（`dehydrator.py:927,929`），合并走**无上限 union**（`src/tools/_common.py:898,900-902`）。同一个桶被反复合并后 tags 可以无限增长。
- 已确认 `bucket_manager.update()`（`src/bucket_manager.py:2317-2322`）对 `tags` / `domain` 是原样写入，没有任何截断兜底。
- **影响不只是 frontmatter 变胖**：`src/bm25_index.py:61,71` 把 tags 拼进检索文档，标签膨胀会稀释 BM25 权重 —— 这是真实的检索退化。
- **建议**：合并后同样套 `_TAGS_MAX` / `_DOMAIN_MAX`。

---

## 四、更正你报告里的一条结论：arousal 不是存储层取整

- 你的总结写"100% 确认是存储层固定取整"。**不成立**：`_clamp_unit`（`src/bucket_manager.py:290-305`）不做四舍五入，`create()`（`:1484`）原样落盘 float。
- 真实原因是**所有读出口都用 `:.1f` 格式化**：`dehydrator.py:799`、`tools/anchor/core.py:171`、`tools/dream/output.py:360`、`tools/grow/shortpath.py:72`。`f"{0.05:.1f}"` == `"0.1"`；而 `valence=0.1` 格式化后正好等于自己，所以看起来"只有 arousal 有问题"。
- **自证方法（不需要 API key）**：`GET /api/bucket/{bucket_id}`（`src/web/buckets.py:178-207`）直接返回原始 metadata JSON，或直接看 `.md` 的 frontmatter —— 里面应该是 0.05。
- **建议**：显示改 2 位小数或 `:g`。数据本身没坏，不用迁移。

---

## 五、设计问题（建议先确认意图，别直接改）

### 7. `extra_tags` 是覆盖而不是追加

`src/tools/hold/core.py:75`：`all_tags = list(dict.fromkeys(extra_tags if extra_tags else model_tags))` —— 只要调用方传了 1 个 tag，10~15 个自动标签**全部丢弃**。变量名叫 `extra_tags`（追加语义），行为是替换。
**建议**：确认是否有意为之；若要追加，改成 `dict.fromkeys(extra_tags + model_tags)`。

### 8. `source_read` 的适用范围（你的问题 7）

只有 `grow` 传了 source / source_ranges 时才写 `source_refs`（`src/tools/grow/core.py:238-241`）；`hold` 从不写 —— 因为 hold 的正文本身就是原文，没有独立的原文证据层。所以"对 hold 桶不生效"是设计如此，不是 bug。
**建议**：把 `src/tools/source_read/core.py:158` 的"该桶没有原文证据引用。"改成说明适用范围的文案（如"这条记忆的正文即原文，没有独立原文层；source_read 只适用于 grow 带 source_ranges 创建的桶"）。

---

## 六、本地测试套件：6 个失败

`2229 passed, 6 failed, 98 skipped`。CI 跑 Linux，这 6 个都只在 macOS 上炸：

- `test_backup_archive.py` 2 个 —— `src/migrate_engine.py:1310-1315` 用 `os.path.normcase` 判断是否同一目标文件，posix 下不折叠大小写，但 macOS/Windows 文件系统大小写不敏感 → 只有大小写不同的桶名在导入 overwrite 时会误报"恢复目标已存在"。**这是真实的 macOS/Windows 用户会踩到的 bug，Linux CI 抓不到**。建议改用 `os.path.samefile`（目标存在时）。
- `test_entrypoint_code_bootstrap.py` 4 个 —— `subprocess` 读 shell 输出时 `UnicodeDecodeError: 0xbc`。**未确认**：疑似 macOS 下 BSD 工具在非 UTF-8 locale 吐的字节，但我没有定位 `0xbc` 的具体来源，不排除 `entrypoint.sh` 本身的问题。建议先给 subprocess 调用加 `errors="replace"`，让它在 macOS 上至少能跑出真实断言结果再判断。

⚠️ 注意：上面第一~三节的问题**测试全绿正是因为这些路径没有覆盖**（0.0 边界值、合并后标签数上限、plan 判定候选集都没有断言）。

---

## 七、并发写入（你报告的陌生记忆）

不是代码 bug。用桶 frontmatter 里的 `source_tool`（`bucket_manager.py:1516`）、`provenance`、`created` 三个字段能直接定位是哪个客户端、哪条路径写进来的。

---

## 建议处理顺序

1. `or 0.5` / `or 0.3` 的 falsy-zero（改 4 处写盘 + 3 处显示，纯 bug，无语义争议）
2. 打标 prompt 三处（valence 示例 → 0.5、domain 名额 1~3 + 情绪保底、tags 长度闸门）—— 一次改完，四轮换模型解决不了的三个问题一起消失
3. 合并时补 tags/domain 截断
4. `:.1f` → 2 位小数
5. `migrate_engine` 大小写不敏感文件系统
6. `source_read` 文案 + `extra_tags` 语义（先确认）
7. plan 闭环阈值（先对齐再动）
