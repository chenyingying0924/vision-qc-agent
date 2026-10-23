# 视觉质检 Agent · vision-qc-agent

一个**清单驱动**的多模态图片质检 / 洞察 Agent：上传电商商品图，用视觉大模型提取结构化视觉事实，
再用本地规则引擎逐条判定，输出可交付的质检报告（网页 + Markdown + 机读 JSON）。

> 一句话版本：
> 把「图片质检」这件靠人眼的事拆成两层：**模型只负责看**（输出结构化事实），
> **判罚在一段可审计的规则代码里**。这样结论可复现、阈值可调、还能解释为什么不合格。

---

## 1. 它解决什么问题

电商主图有明确的硬性规范（白底、无文字、主体占比、最小尺寸…），人工抽检 300 张图要几小时，
而且不同人判得不一样。这个 Agent 把「质检清单」变成可执行配置：

- **一批图进去** → 每张图一份报告出来，结论是 `合格 / 需优化 / 不合格` + 0-100 分；
- **不合格项按严重度排序**，每条都给出「实测值 vs 要求值」和具体改法；
- 想改标准？改 `checklists/*.json` 里的一个阈值即可，**不用改代码、不用重训、不花一个 token**。

## 2. 为什么这样设计（关键取舍）

| 决策 | 理由 |
| --- | --- |
| **模型只管"看"，判罚交给代码** | 让 LLM 直接输出「合格/不合格」无法解释、无法复现、还会随温度漂移。拆成「结构化事实 + 确定性规则」后，每个结论都能追到具体字段和阈值。 |
| **像素级指标由程序测量，不交给模型** | 分辨率、主体占比、背景白度是可以精确算的。模型只做语义判断（模特姿态、色差风险）。实测值还会作为「既成事实」喂回提示词，避免模型乱估。 |
| **一张图只调一次模型** | 一份清单的全部规则（11–12 条）共用一次视觉调用，规则再怎么加都不增加成本。规则引擎本身是纯函数。 |
| **零运行时依赖** | 只用 `node:http` + `node:zlib`，自己写了 PNG 解码、multipart 解析、SSE。`npm start` 在任何装了 Node 20+ 的机器上都能跑，演示不会因为装包失败翻车。 |
| **结果按「图 + 清单内容哈希 + 模型」缓存** | 同一张图重跑秒出；改了阈值会自然失效，不会拿旧结论骗人。 |
| **兜底模式** | 没有 API Key 时自动用本地像素指标推断事实，并在报告里**标注为兜底估计**，绝不冒充模型判断。 |

## 3. 30 秒跑起来

```bash
cd vision-qc-agent
npm start                      # 打开 http://127.0.0.1:4599
```

不需要 `npm install`（零依赖）。API Key 解析顺序：

1. 环境变量 `DEEPSEEK_API_KEY`
2. DSH 凭据库 `~/.dsh/.credentials.yaml`
3. 项目内 `.env`

**没有 Key 也能跑**：界面会自动进入「演示模式」，用本地像素指标给出兜底结论。

生成样例图（6 张典型问题图，需要本机有 Chrome / Edge）：

```bash
npm run samples                # → samples/
npm run samples:live           # 顺便用真实模型跑一遍并落盘报告
```

批量模式（CLI）：

```bash
node src/cli.mjs samples --save            # 跑整个目录
node src/cli.mjs a.png b.jpg --json out.json
node src/cli.mjs samples --mock            # 强制离线兜底
node src/cli.mjs samples --cost            # 打印成本面板
node src/cli.mjs samples --no-consistency  # 跳过 SKU 组一致性检查
node src/cli.mjs samples --checklist detail-page
```

人机回环（质检员推翻判定 → 回流成阈值建议）：

```bash
node src/cli.mjs review list
node src/cli.mjs review overturn --image 03-marketing-text.png --rule R05 \
  --reason business-exception --observed "54%" --note "平铺图主体略小可接受"
node src/cli.mjs review suggest --checklist ecom-main-image
```

以 MCP 服务器运行（给 Agent 调用）：

```bash
npm run mcp      # stdio MCP，6 个工具
npm run install:dsh -- --write   # 把工具接进 DSH 的 web profile
```

测试（**67 个离线用例**，不联网、不调模型、不需要 Key）：

```bash
npm test
```

分四组：`core`（图像探测 / 规则引擎 / 提示词 / multipart）、`extensions`（成本、一致性、人机回环、
编排缓存）、`regressions`（审计发现的缺陷回归，每条对应 `docs/fix-log.md` 里的编号）、`http`
（真实启动服务，覆盖全部路由、SSE 帧、状态码语义、目录穿越，数据目录指向临时目录）。

另外三个需要环境的验证脚本：

```bash
npm run test:mcp    # 手写 JSON-RPC 探针，验证 MCP 握手与工具调用（mock、离线、带断言）
npm run test:dsh    # 用 DSH 自己的 MCP SDK 跑一遍握手（需要本机装过 DSH）
npm run test:ui     # 无头 Chrome 驱动真实页面（上传→运行→推翻→建议）
```

`npm run test:ui` 会**自己拉起服务**并指向临时数据目录，默认演示模式，跑完打印 `14/14 项通过`
并留下截图 `data/ui-e2e.png`；它不写项目的 `data/feedback.jsonl`，可以反复跑。
要跑真实模型：`QC_MOCK=0 npm run test:ui`（产生费用）；要打已经运行的服务：
`QC_URL=http://127.0.0.1:4599/ npm run test:ui`。

## 4. 工作流

```
图片字节
  ├─ 1. 测量   本地像素分析：尺寸/画幅/背景白度/主体占比/主体色/明暗离散度  (image/inspect.mjs)
  ├─ 2. 看图   多模态模型一次性输出 43 个结构化事实 + 思考链                (vision/provider.mjs)
  ├─ 3. 判定   清单规则在本地逐条评估：通过 / 不通过 / 未判定                (core/rules.mjs)
  ├─ 4. 复核   叠加质检员的推翻记录（人工判定优先，机器原判保留）            (core/feedback.mjs)
  ├─ 5. 汇总   按严重度加权算分、排序整改建议、给结论                        (core/rules.mjs)
  ├─ 6. 组内   图片≥2 张时做 SKU 一致性：本地 ΔE 实测 + 一次多图语义比对      (core/consistency.mjs)
  ├─ 7. 计价   记录 tokens，按峰谷费率算每张/每批/每月成本                   (core/pricing.mjs)
  └─ 8. 交付   网页实时流 + Markdown 报告 + batch.json 机读结果              (core/pipeline.mjs)
```

界面上能实时看到每个阶段：`排队中 → 像素测量 → 模型分析中 → 已提取事实 → 判定完成 → 一致性比对`，
右侧「执行轨迹」还会显示模型的思考摘要。

## 5. 四份质检清单（这不是配置项，是这套东西的价值所在）

同一套引擎，四份清单，**同一个事实在不同清单里阈值不同** —— 这就是「清单可插拔」的实证：

| 事实 | 主图 | 详情页 | 直播封面 | 设计稿走查 |
| --- | --- | --- | --- | --- |
| `productCoverage` 主体占比 | ≥ 60%（索引图要一眼看清） | — | ≥ 55%（缩略图更小） | ≥ 30%（版面本来就要留白） |
| `minSide` 最短边 | ≥ 800px | ≥ 750px | ≥ 800px | — |
| `textInImage` 文字量 | ∈ {none, minimal} | ∈ {none, minimal, moderate}（长图容忍更多信息） | ∈ {none, minimal} + 禁止促销价 | — |
| `saturationRatio` 色彩占比 | — | — | ≥ 18%（封面要冲击力） | **between [12,45]**（同一事实、反方向约束：品牌色不能太素也不能太花） |
| `blurRisk` 模糊 | ∈ {none, slight} | ∈ {none} | — | ∈ {none} |
| `backgroundWhiteness` 背景白度 | ≥ 92% | — | — | **不使用**（设计稿不适用平台白底规范） |

主图 12 条规则分四组，每条都写明「为什么」，因为报告要能拿去和运营讲道理：

| 组 | 规则 |
| --- | --- |
| 合规底线 | 背景纯白 ≥92% · 无营销文字 · 无水印/第三方 Logo |
| 质量标准 | 最短边 ≥800px · 主体占比 ≥60% · 1:1 方图 · 布光自然 |
| 质量细节 | 无线头/污渍/褶皱 · 无模糊 |
| 信息完整 | 色差风险低 · 关键细节可识别 · 背景无杂物 |

详情页 11 条（用途可辨识 / 信息完整 / 视觉质量）、直播封面 11 条（缩略图可辨识 / 冲击力 / 合规）、
设计稿 11 条（视觉层级 / 留白 / 色彩统一 / 文案对比 / 画面完整）。

### 加一条新规则只要三行

```json
{
  "id": "R13",
  "group": "质量标准",
  "title": "不得出现牛皮癣式拼图",
  "fact": "collageDetected",
  "op": "==",
  "value": false,
  "severity": "high",
  "suggest": "拆成单图主图；拼图会被平台判为低质。"
}
```

前提是该 `fact` 在 `src/core/facts.mjs` 的**事实目录**里登记过 —— 提示词、界面下拉、报告列都会自动跟着变，
不存在「改了清单忘了改提示词」的漂移。

## 6. SKU 组一致性：两个独立信号，故意不合并

同一次上传里只要 ≥2 张图，就自动做一次 SKU 组一致性检查：

1. **确定性信号（本地、免费、可复现）**：从每张图的**高饱和像素**里取主体色
   （白底不会被算进去），逐张与首图比 CIE76 色差 ΔE。首图默认为基准色。
   ΔE <2 不可感知 / <5 细看可辨 / <10 肉眼可辨 / ≥10 明显不是同一色。
2. **语义信号（一次多图模型调用）**：同一件商品？同色？材质细节一致？光影一致？每张图是什么用途？

**关键设计：两者冲突时以实测为准，并把冲突单独列出来。** 这才是这个功能的价值 ——
模型说「颜色一致」而实测 ΔE=49 的时候，工具的作用就是把这句话顶回去：

```
## 模型判断与实测结论冲突（需人工确认）
- 模型判定「颜色一致」，但实测主体色差 ΔE=49.4（#306fb2 vs #11756d）落在肉眼可辨区间
  —— 以实测为准，建议人工确认。
```

另外，实测色差（C05）被定为 **high** 严重度：它是算出来的，不像模型意见那样可以被「业务上可接受」讲掉。

## 7. 人机回环：质检员推翻 → 变成规则证据

这是让它从 demo 变成能落地的东西。任何一条 `不通过` 都能在界面上点「推翻」，选原因、写备注，
记录追加进 `data/feedback.jsonl`（append-only）。系统从这些记录里推出两件模型给不了的事：

1. **规则可靠性** —— 每条规则被推翻多少次、推翻率多少。一条被推翻 40% 的规则是**规则写得不好**，
   不是模型不好。
2. **阈值建议** —— 对数值型规则，被接受的样本值本身就在告诉你阈值该往哪挪：

```
$ node src/cli.mjs review suggest --checklist ecom-main-image

  R05 主体占比不低于 60%
    推翻 4 次 · 置信度 low
    业务上接受了低至 52% 的样本（中位数 54%）。建议把阈值从 60% 下调到约 54%，
    或改为按商品类目分档。下调属于放宽标准，需质检负责人确认后手工修改
    checklists/ecom-main-image.json。
```

三条刻意的约束：**只建议、不自动改**（悄悄按反馈放宽标准，最后会得到一条什么都通过的规则）；
**设置证据门槛**（同一规则至少 2 次，或真实推翻率 ≥30%，否则不给建议，免得训练人忽略它）；
**枚举型规则给定性建议而不是编一个数字**。

推翻后当次报告会重算分数、撤掉对应整改建议，同时保留 `machineStatus` 供审计。

## 8. 成本面板：采购和运营一定会问

跑批会记录每次调用的 tokens（输入 / 缓存命中 / 输出 / 推理），按费率表折成钱：

```
$ node src/cli.mjs samples/01-perfect-white.png samples/04-watermark-logo.png --cost

成本面板
  tokens：输入 4,458（缓存命中 3,328，占 75%）· 输出 2,946（含推理 2,198）
  平均每张：3,702 tokens · $0.001947
  本批合计：$0.003894（2 张图）
  缓存省下：$0.000978（无缓存则需 $0.004873）
  费率：输入 $0.3/M · 缓存 $0.006/M · 输出 $1.2/M
  来源：https://api-docs.deepseek.com/quick_start/pricing（核对于 2026-09-17）
  月度外推：
      1,000 张/月 → $1.95
     10,000 张/月 → $19.47
    100,000 张/月 → $194.71
  排期建议：高峰 $0.002337/张 vs 错峰 $0.001168/张，省 50%
```

一致性结果也按「图片组」缓存：整批图片全部命中缓存时，成本面板显示 `$0`，不会再为一致性多付一次调用。

三个容易算错、这里都显式处理的点：**缓存命中与未命中是互斥的两个桶**（不能拿 `prompt_tokens` 全按未命中价算）、
**推理 token 已含在输出里**（不能重复计费）、**DeepSeek 按时段计价**（高峰为周一至周五
01:00–04:00 与 06:00–10:00 UTC，其余 5 折）。费率表在 `src/core/pricing.mjs`，每行都带来源与核对日期；
OpenAI 那几行在构建环境里访问不到官方定价页，**明确标注为未核实**而不是装作权威。

## 9. 接入 DSH：从「人打开的页面」变成「Agent 能调用的能力」

内置一个 **MCP stdio 服务器**（`src/mcp/server.mjs`），暴露 6 个工具：

| 工具 | 作用 |
| --- | --- |
| `qc_list_checklists` | 列出四份清单及全部规则与阈值 |
| `qc_inspect_images` | 质检本地图片（路径数组 + 清单 + 可选兜底），返回结论与建议 |
| `qc_write_reports` | 质检并把 Markdown 报告落盘，返回目录路径 |
| `qc_recent_reports` | 列出已缓存结果（同图+同清单+同模型不重复计费） |
| `qc_threshold_advice` | 依据推翻记录给出阈值调整建议 |
| `qc_cost_estimate` | 估算每张/每批/每月成本与峰谷排期 |

装进 DSH（已在本机执行过，`insert:` 包装是必须的，裸写 `{id,name,config}` 会被当成覆盖不存在的行而静默跳过）：

```bash
node scripts/install-dsh-integration.mjs            # 只打印，不改文件
node scripts/install-dsh-integration.mjs --write    # 写入 ~/.dsh/profiles/web/cordis.patch.yml
```

写完后工具会以 `mcp__qc__qc_inspect_images` 这样的名字出现在 Agent 的工具列表里，
DSH 的 web profile 会热加载该补丁。图片路径建议传绝对路径；相对路径按**调用方**的当前目录解析。
已验证：

```bash
$ npm run test:mcp    # 手写 JSON-RPC 探针（带断言，10/10）
✔ initialize 返回协议版本与 serverInfo — 2025-11-25
✔ tools/list 返回 6 个工具
✔ qc_inspect_images（mock）返回两张图的结论与结构化内容 — 结论：2 张完成 · 平均 94/100
✔ 空 paths 返回 isError 而不是协议错误

$ npm run test:dsh    # 用 DSH 自己的 @modelcontextprotocol/sdk 跑握手
✔ initialize 握手成功（DSH 客户端 SDK）        ✔ tools/list 返回 6 个工具
✔ 未声明 outputSchema（避免 DSH 的 structuredContent 强制校验）
✔ 无效路径返回 isError 而不是协议错误          10/10 项通过
```

`outputSchema` 那条是踩过的坑：一旦声明，DSH 就会要求每次调用都返回 `structuredContent`，
否则报 `ToolOutputError`；不声明反而是最安全的。

## 10. 项目结构

```
vision-qc-agent/
├── src/
│   ├── server.mjs              零依赖 HTTP 服务：JSON API + multipart 上传 + SSE 进度 + 静态页面
│   ├── cli.mjs                 batch / review / mcp 三个子命令
│   ├── config.mjs              配置与凭据解析（env → DSH 凭据库 → .env）
│   ├── core/
│   │   ├── facts.mjs           事实目录：清单、提示词、界面共用的词汇表 + 模型输出归一化
│   │   ├── rules.mjs           清单校验 + 规则引擎 + 评分 + Markdown 渲染
│   │   ├── consistency.mjs     多图一致性：CIE76 ΔE 实测 + 语义比对 + 冲突检测
│   │   ├── feedback.mjs        人机回环：推翻日志 + 可靠性统计 + 阈值建议
│   │   ├── pricing.mjs         token 核算 + 峰谷费率 + 月度外推
│   │   ├── pipeline.mjs        编排：并发、缓存、进度事件、落盘
│   │   ├── errors.mjs          带 code 的错误（HTTP 状态映射的唯一来源）
│   │   └── multipart.mjs       手写 multipart 解析
│   ├── image/
│   │   ├── inspect.mjs         PNG 解码 + 像素指标（含主体色）+ 容器尺寸嗅探
│   │   └── synthetic.mjs       纯 Node PNG 编码（测试基准图）
│   ├── mcp/server.mjs          MCP stdio 服务器（6 个工具）
│   └── vision/
│       ├── prompt.mjs          由事实目录生成提示词
│       └── provider.mjs        OpenAI 兼容 / Anthropic 协议 + 多图调用 + JSON 修复重试 + 兜底事实
├── checklists/                 四份清单：主图 / 详情页 / 直播封面 / 设计稿走查
├── public/                     前端（原生 JS，无构建）
├── scripts/                    样例图生成器 + DSH 集成安装器
├── samples/ reports/ data/     样例图 · 落盘报告 · 推翻日志
├── docs/                       研究留档（MCP 实现简报、费率参考）+ 审计报告 / 整改记录 / 架构说明
└── test/                       67 个离线用例 + 3 个环境验证脚本（MCP / DSH / 无头浏览器）
```

配置项见 [`.env.example`](.env.example)（全部有默认值，不建 `.env` 也能跑）。

文档索引：

| 文档 | 内容 |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | 系统架构图、端到端数据流、关键设计决策、错误语义 |
| [`docs/known-limitations.md`](docs/known-limitations.md) | 适用边界与后续方向：格式支持、误报来源、一致性与成本口径、部署限制 |
| [`docs/audit-report.md`](docs/audit-report.md) | 一次完整的技术审计：16 项缺陷（含证据/触发条件/影响）、风险分级、整改顺序 |
| [`docs/fix-log.md`](docs/fix-log.md) | 逐项整改记录：改了什么、改前改后差异、验证命令与真实结果 |
| [`docs/release-checklist.md`](docs/release-checklist.md) | 发布就绪检查与最终验收结论（含明确的能力边界） |
| [`docs/api-pricing-reference-2026-09-17.md`](docs/api-pricing-reference-2026-09-17.md) | 费率表的来源与核对日期 |
| [`docs/MCP-IMPLEMENTATION-BRIEF.md`](docs/MCP-IMPLEMENTATION-BRIEF.md) | MCP 协议依据（研究留档） |

## 11. HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 当前视觉线路、凭据来源、可用供应商 |
| GET | `/api/checklists` | 已加载的质检清单（含规则明细） |
| GET | `/api/facts` | 事实目录（可用来做配置界面） |
| GET | `/api/reports` | 进程内缓存的质检结果 |
| POST | `/api/inspect` | multipart（`images` + `checklistId` + `mock` + `consistency`），返回 SSE 事件流 |
| GET | `/api/feedback` | 推翻记录与按规则聚合的统计 |
| POST | `/api/feedback` | 记录一次推翻（`imageName` `ruleId` `reason` `note` `reviewer` `context`） |
| GET | `/api/adjustments` | 依据推翻记录生成阈值调整建议 |
| GET | `/api/pricing` | 费率表与外推样例 |

错误响应统一为 `{error, code}`，状态码由 `code` 决定（`src/core/errors.mjs` 是唯一映射处）：

| 状态 | code | 触发条件 |
| --- | --- | --- |
| 400 | `BAD_MULTIPART` | 不是合法的 multipart 请求 |
| 400 | `BAD_JSON` / `BAD_FIELD` | 推翻接口的请求体不合法 |
| 400 | `UNKNOWN_CHECKLIST` | `checklistId` 不存在，响应里带 `available` 列表 |
| 413 | `PAYLOAD_TOO_LARGE` | 超过 `QC_MAX_UPLOAD_BYTES` |
| 422 | `UNSUPPORTED_FORMAT` | 上传的文件不是 PNG/JPEG/WebP/GIF，响应里带 `files` 列表 |

超过 `QC_MAX_IMAGES` 的部分不会被静默丢弃：`batch-start` 事件带 `dropped` 计数，并额外发一条
`batch-warning`。

SSE 事件类型：`batch-start` `batch-warning` `image-start` `image-measured` `image-thinking` `image-facts`
`image-report` `image-done` `image-cached` `image-error` `consistency-start` `consistency-facts`
`consistency-report` `consistency-error` `cost` `saved` `batch-end` `complete` `fatal`。

## 12. 已验证的真实结果

用 `deepseek-v4-flash-vision-exp` 跑 `samples/` 六张样例图（真实调用，非模拟）：

| 样例 | 分数 | 结论 | 模型抓到的关键问题 |
| --- | --- | --- | --- |
| 01 纯白底 | 86 | 不合格 | 主体占比 44%、色差风险 high（矢量图无材质纹理） |
| 02 浅灰底 | 88 | 需优化 | 色差风险 medium、细节不可辨识 |
| 03 促销文字 | 74 | 不合格 | **画面文字量 moderate**（合规硬性违规） |
| 04 水印 Logo | 75 | 不合格 | **检出未授权水印** |
| 05 低分辨率杂乱 | 69 | 不合格 | **背景白度 0% + 最短边 520px** |
| 06 暗调过曝 | 73 | 不合格 | **背景白度 0% + 色差风险 high** |

平均 78/100，六图 + 一致性真实调用共 **$0.0253（平均 $0.0033/张、5,183 tokens/张、缓存命中 86%）**，耗时 65.7s。

> 分数与结论不是单调关系：**三条 medium 同时不通过即判不合格**（所以 86 分也可能不合格）。
> 分数衡量的是「离标准多远」，结论衡量的是「能不能上线」。

UI 端到端（无头 Chrome 驱动真实页面，测试自己拉起服务、用临时数据目录）：**14/14 项通过** ——
上传 → SSE 渲染 → 成本条 → 一致性卡片与色差色块 → 点「推翻」提交 → 复核面板刷新 → 阈值建议面板
→ 推翻记录落到隔离目录（两图含一致性约 $0.0049）。

---

MIT License · 零运行时依赖 · Node ≥ 20.6
