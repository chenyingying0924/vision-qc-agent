# 缺陷整改记录 · vision-qc-agent

> 对应 [`audit-report.md`](audit-report.md) 的问题编号。每条都写明：改了什么文件、改前/改后行为差异、
> 用什么命令验证、以及**是否真的关掉了**。
> 环境：macOS · Node v22.22.2 · git `main`（未提交，改动留在工作树）。

## 总览

| ID | 等级 | 一句话 | 状态 |
| --- | --- | --- | --- |
| BUG-001 | P1 | 单测依赖系统时钟，错峰时段必失败 | ✅ 已修复 |
| BUG-002 | P1 | UI E2E 断言绝对条数 + 写真实数据目录 | ✅ 已修复 |
| BUG-003 | P1 | 数值型环境变量未校验 → 静默零处理 + CLI 崩溃 | ✅ 已修复 |
| BUG-004 | P2 | 非图片文件被接受，真实模式会计费失败调用 | ✅ 已修复 |
| BUG-005 | P2 | 畸形 multipart 返回 500 | ✅ 已修复 |
| BUG-006 | P2 | 未知 checklistId 静默回退 | ✅ 已修复 |
| BUG-007 | P2 | 超量图片被静默截断 | ✅ 已修复 |
| BUG-008 | P2 | 模型输出未经校验，格式错误被当成商品缺陷 | ✅ 已修复 |
| BUG-009 | P2 | 清单阈值类型错误会静默失效 | ✅ 已修复 |
| BUG-010 | P3 | 一致性缓存命中时事件重复 | ✅ 已修复 |
| BUG-011 | P3 | `counts.pass` 与 `total` 不相加 | ✅ 已修复 |
| BUG-012 | P4 | README 两处与实测报告不符 | ✅ 已修正 |
| BUG-013 | P4 | docs 引用不存在的验证脚本 | ✅ 已修正 |
| BUG-014 | P4 | HTTP 层零自动化测试 | ✅ 已补齐 |
| BUG-015 | P4 | 缺 `.env.example`、未说明重置演示数据 | ✅ 已补齐 |
| BUG-016 | P2 | 审计中新发现：未知 provider 仍按 DeepSeek 调用但不计费 | ✅ 已修复 |

**汇总：P0 0 项 · P1 3 项 · P2 7 项 · P3 2 项 · P4 4 项，全部关闭；无未修复项。**
（BUG-016 是在整改 BUG-003 时通过验证 `loadConfig()` 附带发现的，已回填进审计报告口径。）

---

## BUG-001 · 单测依赖系统时钟

**原问题**：`test/extensions.test.mjs` 断言 `ratesFor("deepseek", ...).input === 0.3`，但 `ratesFor`
默认按 `new Date()` 判断 DeepSeek 峰谷价，错峰时段返回 0.15。

**改动**：`test/extensions.test.mjs`

```diff
- const rates = ratesFor("deepseek", "deepseek-v4-flash-vision-exp");
- assert.equal(rates.exact, true);
- assert.equal(rates.input, 0.3);
- const unknown = ratesFor("deepseek", "no-such-model");
+ const peak = ratesFor("deepseek", "deepseek-v4-flash-vision-exp", { at: "2026-09-17T02:00:00Z" });
+ assert.equal(peak.input, 0.3);
+ assert.equal(peak.offPeak, false);
+ const offPeak = ratesFor("deepseek", "deepseek-v4-flash-vision-exp", { at: "2026-09-17T12:00:00Z" });
+ assert.equal(offPeak.input, 0.15);   // 顺带把错峰折扣也纳入断言
```

**行为差异**：改前在 UTC 10:20 运行 → `0.15 !== 0.3` 失败；改后任何时刻都断言同一对确定值，
并且**多测了一条**（错峰价），覆盖率不降反升。

**验证**：`npm test` → 67/67 通过（本次运行时刻 UTC 10:2x，正是原本会失败的那个窗口）。

**遗留风险**：无。费率表本身的数字仍来自 2026-09-17 的官方页面，价格变动需人工更新
`src/core/pricing.mjs`（README 已声明核对日期）。

---

## BUG-002 · UI E2E 不可重复且污染演示数据

**原问题**：E2E 向真实服务的 `/api/feedback` 提交一条推翻记录（落进 `data/feedback.jsonl`），
然后断言面板显示「已记录 **1** 条」。日志是 append-only，第二次运行必然变成 2 条 → 断言失败；
而且这条 `note:"UI 端到端测试"` 的假记录会**永久推翻**该图对应规则，导致 README §12 的样例分数不再可复现。

**改动**：

| 文件 | 改动 |
| --- | --- |
| `src/config.mjs` | 新增 `dataDir`（`QC_DATA_DIR` 可覆盖，默认 `<appRoot>/data`） |
| `src/server.mjs` · `src/cli.mjs` · `src/mcp/server.mjs` | 推翻日志路径从硬编码 `<appRoot>/data` 改为 `config.dataDir` |
| `test/ui-e2e.mjs` | 改为**自托管**：自己 spawn `src/server.mjs`（`QC_MOCK=1 QC_NO_SAVE=1 QC_DATA_DIR=<临时目录> QC_PORT=<随机>`），轮询 `/api/health` 就绪后开跑，结束时杀进程并删临时目录；新增第 14 项检查「推翻记录写入临时数据目录」 |

**行为差异**：

- 改前：第二次运行 `12/13 项通过`，`data/feedback.jsonl` 每次 +1 行。
- 改后：连续两次运行均 `14/14 项通过`，`data/feedback.jsonl` 的行数与 md5 **前后完全一致**（实测 `2 行 / 5ed907e8…` → `2 行 / 5ed907e8…`）。
- 附带收益：`npm run test:ui` 不再需要先 `npm start`，也不再占用 4599 端口。

**数据清理**：本次审计第一次运行 E2E 时（修复前）确实向 `data/feedback.jsonl` 追加了 1 条
`R10 / UI 端到端测试` 记录。已定位并**仅删除这一条**，恢复到我接手前的状态（保留原有 1 条
`R07 / 2026-10-23T09:37:38Z`）。删除前的备份在 `/tmp/feedback.jsonl.before-restore`。
`data/` 在 `.gitignore` 内，不影响仓库。

**验证**：

```
$ node test/ui-e2e.mjs    # 14/14 项通过
$ node test/ui-e2e.mjs    # 14/14 项通过（第二次）
$ wc -l data/feedback.jsonl   # 2 → 2（未被改动）
```

**遗留风险**：`QC_URL` 模式下（指向外部服务）仍会写那个服务自己的数据目录 —— 这是使用者的选择，
测试输出里会标注「QC_URL 模式下跳过」。

---

## BUG-003 · 环境变量数值未校验

**原问题**：`Number(process.env.QC_CONCURRENCY || 3)`，写错成 `abc` 得到 `NaN`，一路传到
`Array.from({length: NaN})` → 0 个 worker → 一张图都没处理、`reports` 留空洞 → CLI 在
`report.image.name` 处 `TypeError`。`QC_MAX_UPLOAD_BYTES=abc` 更隐蔽：`size > NaN` 恒为 false，
上传上限直接失效。

**改动**：

| 文件 | 改动 |
| --- | --- |
| `src/config.mjs` | 新增导出 `intFromEnv(name, fallback, {min,max})`：非整数或越界即抛错并**指明变量名与范围**；5 个数值变量全部改用它 |
| `src/core/pipeline.mjs` | worker 数加 `Number.isInteger` 兜底（至少 1 个）；`Promise.all` 之后把 `reports` 的空洞补成 `{ok:false, error:{code:"NOT_PROCESSED"}}` |
| `src/cli.mjs` · `src/mcp/server.mjs` | 渲染失败报告时用 `report?.image?.name` / `report?.error?.message` 守卫 |
| `src/server.mjs` | 启动时 `loadConfigOrExit()`：配置错就打印一行「配置错误：…」并 `exit 1`，不再甩栈 |

**行为差异**：

```
# 改前
$ QC_CONCURRENCY=abc node src/cli.mjs samples/01-perfect-white.png
待检图片：1 张，并发 NaN
运行失败：Cannot read properties of undefined (reading 'image')     # exit 0！

# 改后
$ QC_CONCURRENCY=abc node src/cli.mjs samples/01-perfect-white.png
运行失败：QC_CONCURRENCY 必须是 1–16 之间的整数，当前值为 "abc"      # exit 1
```

**验证**：`test/regressions.test.mjs` 中 3 条用例：
`intFromEnv` 6 种输入、`loadConfig` 报错文案、以及**直接用 `concurrency: NaN` 跑 `inspectBatch`**
断言「两张图都处理了、`reports` 无空洞、`ok + failed === total`」。

**遗留风险**：无。范围上限（并发 16、单批 100 张）是我按项目定位设的经验值，如需更大可在
`config.mjs` 里调整。

---

## BUG-016 · 未知 provider 仍按 DeepSeek 调用但不计费（整改中新发现）

**原问题**：`const active = providers[provider] ?? providers[DEFAULT_PROVIDER]` —— 传输层回退到
DeepSeek，但 `config.provider` 保留用户写的错名字。结果：真实扣费，`costOf()` 却因为费率表里
没有这个 provider 返回 `undefined`，成本面板显示「本次未调用模型（本地兜底），成本 $0」。

**改动**：`src/config.mjs` 改为白名单校验：

```js
if (!Object.hasOwn(providers, provider)) {
  throw new Error(`QC_PROVIDER="${provider}" 不受支持，可选：${Object.keys(providers).join(" / ")}`);
}
```

**验证**：

```
$ QC_PROVIDER=bogus node src/cli.mjs samples/01-perfect-white.png
运行失败：QC_PROVIDER="bogus" 不受支持，可选：deepseek / openai / anthropic
```

**遗留风险**：自定义网关请用 `QC_BASE_URL` + 现有 provider id，而不是编一个新 id（这是有意的约束：
费率表按 provider 组织，允许任意 id 就等于允许无价调用）。

---

## BUG-004 · 非图片文件被接受

**原问题**：上传 25 字节文本（命名 `fake.png`）→ `format:"unknown" width:0` → mock 模式下
`mockVisionFacts` 走"无法解码"分支生成整套伪事实，最后给出「不合格」；真实模式下会以
`data:image/unknown;base64` 调模型，必然 4xx 但已产生请求。

**改动**：

| 文件 | 改动 |
| --- | --- |
| `src/server.mjs` | 开 SSE **之前**校验：`detectFormat()` 为 `unknown` 的文件直接 `422 UNSUPPORTED_FORMAT`，响应带 `files` 列表 |
| `src/core/pipeline.mjs` | `measure()` 之后、调模型之前再校验一次 `measurement.supported`（守住 CLI / MCP 入口），抛 `QcError(UNSUPPORTED_FORMAT)` |
| `src/core/errors.mjs`（新增） | `QcError` + `httpStatusFor()`，状态码映射的单点 |

**行为差异**：改前该文件会走完链路并产出「不合格」；改后 HTTP 直接 422 并明确指出哪些文件不合格，
CLI/MCP 则把该图记为 `ok:false code=UNSUPPORTED_FORMAT`，且**不发生任何模型调用**。

**验证**：`test/http.test.mjs`「a non-image upload is refused before any vision work (422)」+
`test/regressions.test.mjs`「a non-image upload fails with UNSUPPORTED_FORMAT and never reaches the model」
（后者还断言没有 `image-facts` / `image-measured` 事件）。

**遗留风险**：只按魔数识别容器格式，不校验内容完整性 —— 一个被截断的 PNG 仍会被当作 PNG 送模型。
这属于"模型会告诉你它看不清"的范畴，不再额外做完整性校验。

---

## BUG-005 · 畸形 multipart 返回 500

**改动**：`src/core/multipart.mjs` 抛 `QcError(..., "BAD_MULTIPART")`；`src/server.mjs` 的兜底
catch 改为 `json(res, httpStatusFor(error), { error, code })`。

**行为差异**：

```
$ curl -X POST -H 'content-type: text/plain' --data x /api/inspect
改前：500 {"error":"缺少 multipart boundary"}
改后：400 {"error":"请求缺少 multipart boundary（content-type 应为 multipart/form-data）","code":"BAD_MULTIPART"}
```

**验证**：`test/http.test.mjs`「a malformed multipart request answers 400, not 500」。

---

## BUG-006 · 未知 checklistId 静默回退

**改动**：`src/core/pipeline.mjs` 区分三种情况 —— 未提供 → 第一份（保持原行为）；
提供了但找不到 → 抛 `UNKNOWN_CHECKLIST` 并附可用 id。`src/server.mjs` 在开 SSE 之前先查一次，
直接返回 400（否则 SSE 已开只能发 `fatal` 事件）。

**行为差异**：

```
$ curl -F checklistId=does-not-exist -F images=@01.png /api/inspect
改前：200 + SSE，batch-start.checklist.id = "ecom-main-image"（用户以为自己用的是另一份清单）
改后：400 {"code":"UNKNOWN_CHECKLIST","available":["design-review","detail-page","ecom-main-image","live-cover"]}
```

**验证**：`test/http.test.mjs`「an unknown checklist id is a 400 with the valid ids」+
`test/regressions.test.mjs`（同时断言"省略 id 仍默认第一份"）。

**收尾补充**：同一类静默回退还有两处，一并改掉以统一错误语义 ——
`GET /api/adjustments?checklistId=<不存在>`（原来会拿第一份清单给建议 → 现在 400）、
MCP `qc_threshold_advice`（原来同样回退 → 现在返回 `isError`）。两处都补了断言。

---

## BUG-007 · 超量图片静默截断

**改动**：`inspectBatch` 新增 `dropped` 参数并写进 `batch.dropped` 与 `batch-start` 事件，
同时发一条 `batch-warning`；`server.mjs` 与 `mcp/server.mjs` 计算并传入真实丢弃数；
MCP 返回文本里多一行提示；前端 trace 里也显示这条警告。

**行为差异**：改前传 20 张只处理 12 张，`total:12`，无任何提示；改后 `total:12, dropped:8`
并出现「单批上限 12 张，已忽略 8 张未处理的图片」。

**验证**：`test/http.test.mjs`「over-cap uploads are reported with a dropped count」（`QC_MAX_IMAGES=2`
+ 3 张图 → `total:2, dropped:1` + `batch-warning`）；`test/regressions.test.mjs`「dropped images are reported」。

---

## BUG-008 · 模型输出未经校验

**原问题**：模型返回 `textInImage:"None"`、`hasWatermark:"false"` 这类值时，规则用 `===` 严格比较
直接判 `fail`，报告显示「实测 false / 要求 == false / 不通过」——把模型没按格式答题写成了商品缺陷。

**改动**：

| 文件 | 改动 |
| --- | --- |
| `src/core/facts.mjs` | 新增导出 `normalizeModelFacts(raw)`：按事实目录逐字段归一化 —— bool 接受 `"true"/"false"/"是"/"否"/1/0`；percent 接受数字或数字字符串并 clamp 0–100；enum 先精确、再 `trim + lowercase + 下划线转连字符` 匹配，**仍不匹配就丢弃**；number 解析失败即丢弃。返回 `{facts, dropped, coerced}` |
| `src/vision/provider.mjs` | `analyzeVision()` 里用它替换原来的 `{summary, confidence, ...fields}` 直通；`meta.normalized` 记录 `dropped/coerced` |
| `src/core/rules.mjs` | `report.model.normalized` 透出；Markdown 多一行说明被丢弃的字段名 |
| `src/core/consistency.mjs` | 同样加 `lenientEnum` / `lenientBool`：`"Same"` 能匹配到 `"same"`，`"probably"` 则降级为 `unknown`（不是判「不一致」） |

**行为差异**：

| 模型返回 | 改前 | 改后 |
| --- | --- | --- |
| `textInImage: "None"` | R02 fail | R02 pass（归一为 `none`） |
| `hasWatermark: "false"` | R03 fail（"实测 false / 要求 false / 不通过"） | R03 pass |
| `textInImage: "a lot"` | R02 fail，报告说商品文字太多 | R02 **unknown**，报告说"模型未返回可判定值，建议人工复核" |
| `colorConsistency: "Same"` | C02 fail | C02 pass |
| `colorConsistency: "kinda"` | C02 fail | C02 unknown |

**验证**：`test/regressions.test.mjs` 4 条（归一化、越界丢弃、percent clamp、一致性宽容）。

**遗留风险**：归一化只解决"格式漂移"，不解决"模型看错"。看错仍要靠人工推翻与一致性冲突检测兜。

---

## BUG-009 · 清单阈值类型错误静默失效

**改动**：`src/core/rules.mjs` 的 `validateChecklist` 增加 5 条校验 —— 有序比较符必须是有限数、
`between` 两端必须是有限数且 `min <= max`、`in` 不能是空数组、`==/!=` 的 value 必填。

**行为差异**：

```
{op:">=", value:"800"}  改前：静默变成 >= 0（永远通过），报告仍印 ">= 800"
                        改后：启动即报 rule[0].value must be a finite number for the ">=" operator
{op:"between", value:[45,12]}  改前：span 变成 1，分数无意义
                               改后：报 must be ordered [min, max]
```

**验证**：`test/regressions.test.mjs` 2 条 —— 5 种错误配置各被拒 + 4 份现有清单仍全部通过
（12/11/11/11 条规则数量不变）。

---

## BUG-010 · 一致性事件重复

**改动**：`src/core/pipeline.mjs` 删除缓存分支里的 `onEvent(consistency-report)`，统一由函数尾部发一次。

**验证**：`test/http.test.mjs`「a two-image batch produces exactly one consistency-report event」
（统计 SSE 里该事件的帧数 === 1）。

---

## BUG-011 · 统计口径不相加

**改动**：`src/core/feedback.mjs` 的 `annotateReport` 改为逐状态计数
（原来 `pass = total - fail - unknown` 会把 overturned 计进 pass）；`src/core/rules.mjs` 的
`evaluate` 也统一写成显式过滤，两处口径一致。

**验证**：`test/regressions.test.mjs`「counts add up after an overturn」断言
`pass + fail + unknown + overturned === total`。

---

## BUG-012 / 013 / 015 · 文档与工程文件

| ID | 改动 |
| --- | --- |
| BUG-012 | README §13 改写「单次采样的边界会翻盘」：`500px` → `1000×1000`；「一条 high 规则」→「R05（medium）从通过变成不通过，medium 失败累计到 3 条」；并说明原始报告在作者本机 `reports/`（不入库），给出重跑复核的方式 |
| BUG-013 | `docs/MCP-IMPLEMENTATION-BRIEF.md` 说明验证脚本未随仓库发布，并指向仓库内可复核的 `test/mcp-probe.mjs` 与 `test/dsh-mcp-compat.mjs` |
| BUG-015 | 新增 `.env.example`（13 个变量 + 默认值 + 解析顺序）；README §13 增补「推翻日志会让样例分数漂移，删 `data/feedback.jsonl` 即回到初始结果」 |

README 另外同步了：测试数量 42 → 67、`npm run test:ui` 的新用法（自托管/临时数据目录/`QC_URL` 逃生口）、
UI E2E 13/13 → 14/14、错误码表、`batch-warning` 事件、`core/errors.mjs` 目录项、`.env.example` 指引。

**遗留风险**：README §12 的样例分数来自 2026-10-23 的真实调用记录（`reports/2026-10-23T09-09-17/`），
属于**历史事实**，不会因为本次整改而改变；但若在带推翻记录的 `data/` 下重跑，分数会不同 —— 这是人机回环
的预期行为，已在 §13 说明。

---

## BUG-014 · HTTP 层零测试

**改动**：

| 文件 | 内容 |
| --- | --- |
| `test/http.test.mjs`（新增，11 条） | 进程内启动真实 server（`QC_NO_LISTEN=1` + `listen(0)` + 临时 `QC_DATA_DIR`），覆盖 health 不泄密钥、清单/事实、SSE 全帧序列、一致性事件唯一、超量 dropped、400/422/405 语义、目录穿越 4 种写法、推翻记录落盘位置、adjustments |
| `test/mcp-probe.mjs`（改写） | 从"只打印"变成 10 条断言并以非零码退出；新增 `qc_inspect_images`（mock）、空 paths、未知 checklistId 三条真实调用 |
| `test/regressions.test.mjs`（新增，14 条） | 上述 BUG-003/004/006/007/008/009/011/016 的回归 |
| `.github/workflows/ci.yml` | 增加 `npm run test:mcp` 一步（离线、mock、无需 Key） |
| `package.json` | `test` 纳入 4 个文件；新增 `test:unit` / `test:http` |

**验证结果**（全部真实执行）：

| 命令 | 改前 | 改后 |
| --- | --- | --- |
| `npm test` | 42 tests / 41 pass / **1 fail** | **67 tests / 67 pass / 0 fail**（461 ms） |
| `npm run test:mcp` | 只打印，无断言，永远 exit 0 | **10/10 项通过**，失败即 exit 1 |
| `npm run test:dsh` | 10/10 | **10/10** |
| `npm run test:ui` | 13 项，第二次必失败（12/13） | **14/14**，可重复 |
| 语法检查 | 25 个 `.mjs` | 25/25 通过 |

---

## 改动文件清单（本次整改）

**新增**

```
src/core/errors.mjs
test/regressions.test.mjs
test/http.test.mjs
.env.example
docs/audit-report.md
docs/fix-log.md
docs/architecture.md
docs/release-checklist.md
```

**修改**

```
src/config.mjs           intFromEnv + provider 白名单 + dataDir
src/core/pipeline.mjs    清单解析/worker 兜底/空洞补齐/格式校验/dropped/事件去重
src/core/rules.mjs       阈值类型校验、counts 显式统计、model.normalized、Markdown 说明行
src/core/facts.mjs       normalizeModelFacts
src/core/consistency.mjs lenientEnum / lenientBool
src/core/feedback.mjs    counts 口径
src/core/multipart.mjs   QcError
src/server.mjs           开流前校验、状态码按 code 映射、启动配置错提示、feedback dataDir
src/cli.mjs              dataDir、渲染守卫、image-error/batch-warning 输出
src/mcp/server.mjs       dataDir、dropped、渲染与 structuredContent 守卫
src/vision/provider.mjs  接入 normalizeModelFacts
public/app.js            丢弃提示、batch-warning、JSON 错误解析
test/extensions.test.mjs 固定峰谷时刻
test/ui-e2e.mjs          自托管 + 临时数据目录 + 隔离检查（13 → 14 项）
test/mcp-probe.mjs       加断言
package.json             test 脚本
.github/workflows/ci.yml 增加 MCP 探针步骤
README.md                测试数量/用法/错误码/两处数据订正/重置演示说明
docs/MCP-IMPLEMENTATION-BRIEF.md  验证脚本说明
```

**未改动**（有意保留）：4 份清单的业务阈值、评分公式与结论规则、费率表数字、
`vision/prompt.mjs`、`image/inspect.mjs`、`image/synthetic.mjs`、`scripts/*`、
样例图与历史报告。

**本次没有做**（记录在案的后续项）：OPT-001 缓存上限、OPT-002 429 退避重试、OPT-003 prompt 分层、
OPT-004 容差常量化、OPT-005 CSP 头。理由见审计报告 §7。

**发布**：整改阶段未动 git；经用户确认后提交并推送为 `75717b6`（27 files, +2534/−93），
`origin/main` 已同步。仓库可见性与 About 文案由作者确认（本机 `gh` 未登录，无法代为核验）。
