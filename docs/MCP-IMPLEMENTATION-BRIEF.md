# MCP stdio server implementation brief for DSH `dsh-mcp-client`

> 研究留档：实现 MCP 服务器时的协议依据。安装与使用请以 [README](../README.md) 为准。


Target: **DeepSeek Harness `@deepseek-ai/dsh-mcp-client` v0.1.5-rc.2**, which uses
**`@modelcontextprotocol/sdk` v1.30.0** (both resolved from
`<DSH_INSTALL>/node_modules/`).

Every claim below was read from source and (where marked ✅) verified by running the
real SDK client / real plugin against a hand-written stdio server.

> 验证脚本（`server.mjs` / `drive.mjs` / `edge.mjs` / `plugin-e2e.mjs` / `timeout.mjs`）
> 是当初临时搭的探针，没有随仓库发布 —— 它们是"研究过程"，不是项目资产。
> 仓库内可复核的等价物是 `test/mcp-probe.mjs`（手写 JSON-RPC，带断言）和
> `test/dsh-mcp-compat.mjs`（用 DSH 自己依赖的 SDK 跑握手）。

---

## 0. TL;DR — minimal server contract

| Item | Value |
|---|---|
| Framing | newline-delimited JSON-RPC 2.0, one object per line on stdin/stdout (no `Content-Length`) |
| stdout | JSON-RPC only; log to stderr |
| `initialize` reply | `{protocolVersion:"2025-11-25", capabilities:{tools:{listChanged:true}}, serverInfo:{name,version}}` |
| Client requests | `initialize` → (client sends `notifications/initialized`) → `tools/list` → `tools/call` |
| Result shape | `result.content = [{type:"text",text:"..."}]`; optional `structuredContent`; `isError` boolean |
| Shutdown | exit when stdin reaches EOF (then SIGTERM 2 s later, SIGKILL 2 s after that) |
| Capabilities required of the server | none strictly; declare `tools` (spec-correct) — `resources`/`prompts` are never used |

---

## 1. Protocol version requested, and the fallback logic

The plugin constructs the SDK client with **no** protocol options:

```js
// dsh-mcp-client/lib/index.js:617-620
const generation = new Client({
        name: "dsh-mcp-client",
        version: "0.0.1"
}, { capabilities: {} });
```

`ClientOptions` in SDK 1.30.0 has only `capabilities`, `jsonSchemaValidator`,
`listChanged` — **there is no `versionNegotiation` / `protocolVersion` option**
(`dist/esm/client/index.d.ts:22-83`), so the SDK sends its `LATEST_PROTOCOL_VERSION`:

```js
// @modelcontextprotocol/sdk/dist/esm/client/index.js:280-296  (Client.connect)
const result = await this.request({
    method: 'initialize',
    params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: this._capabilities,
        clientInfo: this._clientInfo
    }
}, InitializeResultSchema, options);
...
if (!SUPPORTED_PROTOCOL_VERSIONS.includes(result.protocolVersion)) {
    throw new Error(`Server's protocol version is not supported: ${result.protocolVersion}`);
}
```

```js
// @modelcontextprotocol/sdk/dist/esm/types.js:2-4
export const LATEST_PROTOCOL_VERSION = '2025-11-25';
export const DEFAULT_NEGOTIATED_PROTOCOL_VERSION = '2025-03-26';
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
```

* **Requested**: exactly `2025-11-25` — no older versions are offered, no client-side
  downgrade retry.
* **Accepted back**: any of `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`,
  `2024-10-07`. Anything else aborts initialization:
  `Server's protocol version is not supported: <v>`.
* **There is no fallback on the client side** (it does not retry with an older
  version). The only "fallback" in the tree is on the *server* side of the SDK
  (`dist/esm/server/index.js:263`): `SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion) ? requestedVersion : LATEST_PROTOCOL_VERSION`.
* ✅ Observed wire message: `{"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"dsh-mcp-client","version":"0.0.1"}},"jsonrpc":"2.0","id":0}`
* ✅ `2025-03-26` accepted; ✅ `2026-01-01` rejected with
  `Server's protocol version is not supported: 2026-01-01`.

**Recommendation**: echo the version you were sent (`params.protocolVersion`, if it is
in the supported list), or hard-code `2025-11-25`. `LATEST_PROTOCOL_VERSION` is also
exported as `"DRAFT-2026-v1"` from `dist/esm/spec.types.js:12`, but that module is only
re-exported by `experimental/tasks` and is **not** used by this client path — do not
use it.

---

## 2. Exact stdio message sequence and the minimal handshake

✅ Captured from the real client (ids are the SDK's counter starting at **0**, and the
server must echo the exact `id` value):

```
C→S {"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"dsh-mcp-client","version":"0.0.1"}},"jsonrpc":"2.0","id":0}
S→C {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"...","version":"..."}}}
C→S {"method":"notifications/initialized","jsonrpc":"2.0"}          ← notification, no id, no params
C→S {"method":"tools/list","jsonrpc":"2.0","id":1}                  ← no params on the first page
S→C {"jsonrpc":"2.0","id":1,"result":{"tools":[…]}}
```

Minimal handshake for DSH to consider the server "ready": the plugin awaits
`connect()` (initialize round-trip + `notifications/initialized`) **and** the initial
tool sync (`tools/list` drain) before activating:

```js
// dsh-mcp-client/lib/index.js:642-648
await generation.connect(createTransport(config));
...
await enqueueSync(generation, startup ? startupOpts : opts);
```
```js
// dsh-mcp-client/lib/index.js:787-788
const outcome = await connection.ready;
if (outcome.error !== void 0 && config.failOnStartupError) throw new Error(...);
```

Rules the server must honour:

* The `initialize` result is validated against `InitializeResultSchema`
  (`types.js:540-556`): `protocolVersion` (string), `capabilities` (object — **required,
  may be `{}`**), `serverInfo` (`{name, version}`), optional `instructions`.
* Reply envelopes are **strict**: `JSONRPCResultResponseSchema` /
  `JSONRPCErrorResponseSchema` are `.strict()` (`types.js:135-140`, `175-194`) — send
  exactly `jsonrpc`, `id`, and `result` (or `error`). Result *payloads* extend
  `ResultSchema = z.looseObject({...})` (`types.js:100`), so extra payload keys are fine.
* Echo `id` verbatim (numbers here; strings also legal per `RequestIdSchema`).
* Never reply to `notifications/initialized` (it has no `id`).
* If `tools/list` fails, the plugin tears the generation down and reconnects with
  exponential backoff, so the server process is restarted repeatedly
  (`connection.js` region, `index.js:616-675`).

---

## 3. Required server capabilities

**Strictly required: none.** The client declares `capabilities: {}` itself and never
sets `enforceStrictCapabilities`, so the SDK never calls `assertCapabilityForMethod`:

```js
// @modelcontextprotocol/sdk/dist/esm/shared/protocol.js:623-630  (Protocol.request)
if (this._options?.enforceStrictCapabilities === true) {
    try { this.assertCapabilityForMethod(request.method); ...
```
```js
// @modelcontextprotocol/sdk/dist/esm/client/index.js:361-365
case 'tools/call':
case 'tools/list':
    if (!this._serverCapabilities?.tools) {
        throw new Error(`Server does not support tools (required for ${method})`);
    }
```
plus the plugin bypasses the SDK's typed helpers entirely — it uses raw
`client.request({method:"tools/list"|"tools/call"})` (`index.js:87-105`).

* ✅ Verified: a server replying `capabilities: {}` still completes initialize and
  serves `tools/list` successfully.
* ✅ Verified: a server declaring only `{tools:{}}` works fully.
* `resources`, `prompts`, `logging`, `completions`, `tasks` are **never** requested by
  this bridge — declaring them has no effect. Do not bother.
* Declaring `capabilities.tools = {}` is the honest, spec-correct choice. Add
  `listChanged: true` only if you will actually emit
  `notifications/tools/list_changed`, which the plugin does listen for:
  ```js
  // dsh-mcp-client/lib/index.js:632-640
  generation.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
          ...
          await enqueueSync(generation);
  ```
  (DSH registers this handler itself; the SDK's own `listChanged` auto-refresh option is
  not used. Extra notifications are harmless — an unmatched notification is ignored,
  `shared/protocol.js:273-282`.)
* If a tool advertises `execution: { taskSupport: "required" }`, the bridge refuses to
  call it (`index.js:257`): `Tool "<raw>" requires task-based execution, which this bridge does not support`. Don't set it.

---

## 4. Discovery and invocation

**Discovery** — `tools/list`, uncached, raw request, draining `nextCursor`:

```js
// dsh-mcp-client/lib/index.js:87-92
function listToolsUncached(client, cursor) {
    return client.request({
        method: "tools/list",
        ...cursor === void 0 ? {} : { params: { cursor } }
    }, ListToolsResultSchema);
}
```
```js
// dsh-mcp-client/lib/index.js:151-167
do {
    const response = await listToolsUncached(client, cursor);
    for (const tool of response.tools) {
        const publicName = publicToolName(opts.serverName, tool.name);
        if (definitions.has(publicName)) throw new Error(`... server listed tool "${tool.name}" more than once — invalid tool list`);
        ...
    }
    cursor = response.nextCursor;
    if (cursor) {
        if (seenCursors.has(cursor)) throw new Error(`... server repeated a tools/list continuation cursor — invalid tool list`);
        seenCursors.add(cursor);
    }
} while (cursor);
```

* Pagination is optional: omit `nextCursor` for a single page.
* If you paginate, each `nextCursor` value must be **new every page** — repeating one is
  a hard error (connection dropped and retried).
* Each page is validated against `ListToolsResultSchema`
  (`types.js:1283-1285` = `ResultSchema.extend({tools: z.array(ToolSchema)})` +
  optional `nextCursor`), so `tools` is required and each tool must satisfy
  `ToolSchema` (`types.js:1229-1273`): `name` required; `description` optional
  (defaults to `""` in the bridge, `index.js:160`); `inputSchema` required, must have
  `type:"object"` at the root; `outputSchema` optional (same object-root rule).
* No `tools/list` timeout is passed by the bridge, so the SDK default applies: **60 s**
  (`shared/protocol.js:712`, `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`).
* Keep names ASCII `[A-Za-z0-9_-]` and ≤ ~40 chars: the public name is
  `mcp__<serverName>__<rawName>` (≤64 chars, invalid chars → `_`), and any lossy
  normalization appends a 12-hex SHA-256, e.g. `mcp__demo__echo`
  (`index.js:70-126`, `730`).

**Invocation** — `tools/call` with `{name, arguments}`:

```js
// dsh-mcp-client/lib/index.js:94-105
return client.request({
    method: "tools/call",
    params: { name: rawName, arguments: args }
}, RawCallToolResultSchema, { signal: exec.signal, timeout: opts.toolCallTimeoutMs });
```
`RawCallToolResultSchema = z.record(z.string(), z.unknown())` (`index.js:76`) — i.e. the
result payload is **not** validated, the bridge does its own defensive shaping.

Result interpretation (`index.js:255-291`):

1. `arguments` is always an object (the bridge substitutes `{}` if the model args are
   not an object).
2. If `Array.isArray(result.content)` → `content` is used; otherwise it falls back to
   `JSON.stringify(result.toolResult)` (or `"(no output)"`) — the 2024-10-07 legacy
   shape. ✅ Verified both paths.
3. `structuredContent` is passed through when present.
4. `isError === true` → the executor **throws** `new Error(<text projection of content>)`,
   so the model sees a failed tool result. ✅ Verified against the real plugin:
   `boom threw: boom failed`.
5. A JSON-RPC `error` response rejects the request (SDK error path); nothing special.

**`structuredContent` gotcha**: the bridge declares this harness-side output schema
(`index.js:223-244`):

```js
schema: { type:"object",
  properties: { content: {type:"array",items:{}}, structuredContent: structuredSchema ?? {} },
  required: structuredSchema === void 0 ? ["content"] : ["content","structuredContent"],
  additionalProperties: false }
```

and `ToolRuntime` validates every returned value against it
(`dsh-tools/lib/index.js:3411-3419`, `validateJsonSchemaValue(tool.output.schema, …)`).
So: if your `tools/list` entry declares an `outputSchema` that DSH's subset checker
accepts, then **every** `tools/call` result for that tool MUST include
`structuredContent` (otherwise `ToolOutputError`). If `outputSchema` is absent or
unsupported (dropped via `supportedOutputSchema` → `assertSupportedJsonSchema`,
`index.js:180-189`), `structuredContent` is optional. Simplest safe choice: omit
`outputSchema`.

`content` block handling (`projectContent`, `index.js:399-452`):
`text` → kept; `resource_link` → `Resource link: <name> (<uri>)`; `audio` → placeholder;
`resource` → `[embedded resource unsupported…]`; `image` → real image only if the
current model route declares image input, else a text diagnostic; unknown types →
`[unsupported MCP content type: <t>]`. `resource_link` needs both `name` and `uri`.

---

## 5. Result → model text, and truncation limits

Text projection joins the `text` blocks in order with a single `"\n"`; there is **no
truncation in the bridge**:

```js
// dsh-mcp-client/lib/index.js:399-401
function extractText(mcpContent, toolName) {
    return projectContent(mcpContent, toolName).map((block) => block.text).join("\n");
}
```
```js
// dsh-mcp-client/lib/index.js:237-242
render(_args, value) {
    return [{ type: "text", text: extractText(value.content, rawName) }];
}
```
✅ Verified: two text blocks `line-1`, `line-2 …` render as the single text
`"line-1\nline-2 …"`.

Empty content projects to `(<tool> returned no model-visible content)`
(`index.js:448-451`).

Limits that apply *outside* the bridge (this profile's composition):

* **Spill policy** — plain-text tool results above `maxInlineBytes: 50000`
  (`dsh-base/cordis.patch.yml`, row `spill-policy`) are replaced with a bounded
  head/tail preview plus a retrievable spill file.
* **Tool-result pruner** — during compaction, results above `thresholdChars: 8192`
  become `headChars: 4096` + marker + `tailChars: 1024`
  (`dsh-base/cordis.patch.yml`, row `tool-result-pruner`).
* **Per-call timeout** — `toolCallTimeoutMs`, default `60000`
  (`index.js:728`, `750`); the SDK sends `notifications/cancelled` and rejects with
  `-32001 Request timed out`. ✅ Verified:
  `{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1,"reason":"McpError: MCP error -32001: Request timed out"}}`.
* Because the rendered result is a single `text` block, keep large payloads out of the
  result yourself if you care about context size.

---

## 6. Transport details

* **Newline-delimited JSON, not `Content-Length`.** `serializeMessage = JSON.stringify(message) + '\n'`
  and the reader splits on `'\n'` (stripping a trailing `\r`)
  (`shared/stdio.js:6-40`, `client/stdio.js:179-191`). A `Content-Length`-framed server
  will **not** work.
* Line/frame cap: `STDIO_DEFAULT_MAX_BUFFER_SIZE = 10 * 1024 * 1024` bytes; exceeding it
  clears the buffer and errors the transport (`shared/stdio.js:2,10-17`). Keep single
  messages well under 10 MiB.
* stdout must carry JSON-RPC only. A malformed line raises a transport error but the
  reader continues (`client/stdio.js:129-142`); stderr is inherited by the DSH host by
  default (`stderr ?? 'inherit'`, `client/stdio.js:71`), so use stderr freely for logs.
* Spawn: `shell:false`, `stdio:['pipe','pipe','inherit']`, env =
  `{...getDefaultEnvironment(), ...configEnv}`; DSH's `configEnv` is
  `{...scrubbedParentEnv(), ...config.env}` (`index.js:28-33`). `scrubbedParentEnv`
  **drops credential-shaped names and every `DSH_*` variable**
  (`dsh-subprocess/lib/index.js:50-56`) — so pass anything sensitive explicitly via
  `config.env`.
* `cwd` defaults to `""` (`index.js:749`); observed effect with the SDK's `cross-spawn`
  is "inherit the DSH host's cwd". Set `cwd` explicitly if your server resolves
  relative paths. (Flagged: plain `spawnSync` with `cwd: ''` errors `ENOENT`, while
  `cross-spawn`/`spawn` tolerate it — do not rely on the empty default.)
* **`notifications/initialized` is sent by the client** (after the initialize result,
  before `tools/list`) — `client/index.js:302-305`. Just ignore it.
* **`ping`**: the SDK client answers server→client pings automatically and never pings
  the server itself. You may implement `ping` → `{}` defensively; not required.
* **`notifications/cancelled`**: sent by the client on timeout/abort with
  `{requestId, reason}`; handling is optional (abort your work and don't reply to a
  cancelled id). Late responses to a cancelled id are simply dropped.
* **`shutdown`/`exit` do not exist in SDK 1.30.0** (no `ShutdownRequestSchema`
  anywhere in `dist/esm`) and the DSH client never sends them. Teardown ladder is:
  close stdin (EOF) → wait 2 s → `SIGTERM` → wait 2 s → `SIGKILL`
  (`client/stdio.js:143-180`). **Exit cleanly on stdin EOF** (✅ verified: the plugin's
  disposal produced `stdin closed -> exit` immediately).
* Each reconnect creates a *fresh* child process; the plugin's reconnect defaults are
  `{enabled:true, initialDelayMs:500, maxDelayMs:30000, maxAttempts:10}`
  (`index.js:472-477`), and after `maxAttempts` consecutive failures the server's tools
  are unregistered until reload/HMR (`index.js:589-595`).

---

## 7. Installing the server in DSH

### Which package

`@deepseek-ai/dsh-mcp-client` must be resolvable from the profile. In **this**
installation it already is — no install needed:

```
~/.dsh/profiles/node_modules/@deepseek-ai/dsh-mcp-client ->
  <DSH_INSTALL>/node_modules/@deepseek-ai/dsh-mcp-client
```
(it is a dependency of the `dsh` CLI: `dsh/package.json:58`). Elsewhere, install it into
the profile with the pnpm-forwarding launcher:
`dsh plugin --profile web add @deepseek-ai/dsh-mcp-client`. Note it declares **no**
`dsh.bundle`, so it is never added to `dsh.profile.bundles` — it is loaded by an
explicit patch row (below).

### Where config lives

The web profile is `$DSH_HOME/profiles/web` (`$DSH_HOME` = `~/.dsh`):

* `~/.dsh/profiles/web/cordis.yml` — the empty root `[]`; **do not edit**
  (`PROFILE_ROOT_CONFIG`, `dsh/lib/profile-boot-Dk-7KqJc.js:120-127`).
* `~/.dsh/profiles/web/cordis.patch.yml` — the user patch layer; **edit this**
  (currently `[]`).
* `~/.dsh/cordis.patch.yml` — home-level layer, applied *after* the profile layer, so it
  outranks it; it does not exist yet (`homePatchPath()`, `profile-boot-Dk-7KqJc.js:110-116`,
  layer order at `:211-222`).
* The web profile has `patchReload: "live"` (`package.json` + `PROFILE_TEMPLATES`,
  `dsh-app-boot/lib/index.js:332-336`), and boot auto-mounts timer+HMR and calls
  `watchUserPatches` for both files (`profile-boot-Dk-7KqJc.js:321-345`), so an edit to
  either patch file applies without restarting the GUI.

### Patch syntax — **the `insert:` wrapper is mandatory**

`applyEntryPatches` treats a bare `{id, name, config}` patch as an *override* of an
existing row; an unknown id warns and is **skipped**:

```js
// dsh-app-boot/lib/index.js:89-101
if (!id) { warn("patch: id is required for non-insert patches"); continue; }
const target = entryMap.get(id);
if (!target) { warn("patch: entry %C not found", id); continue; }
```
New rows are added with `insert` (and `insert` *without* an `id` appends to the
top-level list — `dsh-app-boot/lib/index.js:72-87`). ✅ Empirically verified with
`composeEntries`: the bare form yields `[]` + warning `patch: entry "mcp-demo" not found`;
the wrapped form yields the row. (The package README's "Minimal configuration" example
shows the bare form — it is wrong for a profile patch file.)

### Ready-to-paste config

`~/.dsh/profiles/web/cordis.patch.yml` (replace the whole file; keep the leading `[]`
only if you want no plugins):

```yaml
- insert:
    - id: mcp-demo
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio                          # required: stdio | streamable-http
        serverName: demo                          # required: /^[A-Za-z0-9_-]{1,32}$/, unique per scope
        command: /absolute/path/to/node   # or plain `node`
        args:
          - /absolute/path/to/server.mjs
        env:
          MY_CUSTOM_VAR: hello                    # literal string (schema is dict(String))
          # MY_TOKEN: !!js process.env.MY_TOKEN   # `!!js` expressions are allowed
        cwd: /absolute/path/to                    # optional; default "" inherits the host cwd
        toolCallTimeoutMs: 60000                  # optional; per tools/call
        failOnStartupError: true                  # optional; default false
        reconnect:                                # optional; all four fields optional
          enabled: true
          initialDelayMs: 500
          maxDelayMs: 30000
          maxAttempts: 10
```

Resulting model-facing tool names: `mcp__demo__<toolName>`. Verify the row took effect
with `dsh --dump-config` (or the DSH logs, which print
`mcp-client(<serverName>): …` warnings/errors).

### Config schema (authoritative, from `index.js:737-761`)

```js
const Reconnect = z.object({
    enabled: z.boolean().default(true),
    initialDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(500),
    maxDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(30000),
    maxAttempts: z.number().step(1).min(1).default(10)
});
const Config = z.union([z.object({
    transport: z.const("stdio"),
    serverName: z.string().required().pattern(/^[A-Za-z0-9_-]{1,32}$/),
    command: z.string().required(),
    args: z.array(String).default([]),
    env: z.dict(String).default({}),
    cwd: z.string().default(""),
    toolCallTimeoutMs: z.number().default(60000),
    failOnStartupError: z.boolean().default(false),
    reconnect: Reconnect
}), z.object({
    transport: z.const("streamable-http"),
    serverName: z.string().required().pattern(...),
    url: z.string().required(),
    headers: z.dict(String).default({}),
    toolCallTimeoutMs: z.number().default(60000),
    failOnStartupError: z.boolean().default(false),
    reconnect: Reconnect
})]);
```

Extra reconnect keys are rejected (`index.js:491`): `…reconnect.<k> is not a reconnect
option`. Unknown top-level config keys are not explicitly rejected by the union, but
stick to the list. `serverName` duplicates inside one registration scope throw at load
(`index.js:779`).

---

## Not determined / caveats

* `docs/config-catalog.md` (referenced by the package README) is not shipped in this
  installation, so I could not cross-check the generated catalog.
* Whether the loader's "live" patch reload re-registers the row *in place* (it re-applies
  the patch list; the plugin then hot-swaps the instance) — path confirmed at
  `profile-boot-Dk-7KqJc.js:321-345`, but I did not run the GUI reload.
* `cwd: ""` behaviour depends on `cross-spawn`/`spawn` internals (observed: inherits the
  parent cwd; `spawnSync` disagrees) — set `cwd` explicitly.
* The exact JSON Schema subset accepted for a tool `outputSchema` lives in
  `dsh-tools/lib/index.js:234-338` (`type` must be a single string, only
  `properties/required/additionalProperties/items/enum/const`, …). Omitting
  `outputSchema` sidesteps it entirely.
