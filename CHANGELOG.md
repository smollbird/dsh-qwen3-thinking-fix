# Changelog

## 0.2.9 — 2026-09-28

### 变更（职责分离：插件只负责"转换"，可执行性交给 harness）

- **不再以"本次请求的工具表"作为切分门槛**（这是默认行为的变化）。理由：本插件的职责是把模型写的
  标记转成结构化 `tool-call`；"这个名字在当前模式下能不能被直接调用"是 harness 的策略，两者不是一回事，
  在插件里再写一份只会与运行时规则漂移。
- 副作用是**模型能得到可行动的反馈**：例如 PTC 下模型直接写 `<function=todo_write>`，切出后 harness 会回
  `unknown tool "todo_write": only `run_code` is callable directly — call `todo_write` from inside a
  `run_code` program instead`，模型据此自我纠正；而旧行为是静默变成正文，模型看不到任何提示。
- 想恢复旧行为（名字必须出现在本次请求的工具表里才切分）把 `strictToolList` 设为 `true`。
- **语法校验照旧**：名字仍必须匹配 `[A-Za-z0-9_-]{1,64}`，否则整段按正文 —— 这堵的是"非法名字写进历史
  导致整个会话被服务端 400"的那条路。
- 测试：`场景7` 改为"默认切出 / strict 不切出"双向断言；`0.2.7-1`、`0.2.8-1` 的拒绝路径改用 strict 触发；
  新增端到端 `E`（请求只给 `run_code` 时 `todo_write` 仍被切出）。合计 **62 个用例**。

## 0.2.8 — 2026-09-28

### 改进（把"为什么没切"写清楚）

- 拒绝切分时的 debug 原因现在逐条列出：`splitOnToolCall=false` / 名字缺失或非法 / 前面是引号反引号 /
  在代码围栏或行内代码里 / **不在本次请求的工具表里**，并在最后一条里点明 PTC 语义
  （`PTC 模式下模型只能直接调 run_code，其它工具必须在 run_code 里用 tools.X`）。
- 回归用例 `0.2.8-1`：断言拒绝原因里出现"工具表"，并核对正文逐字节保留，合计 **61 个用例**。

### 说明（真机上最容易被误判的一条）

- PTC preset 下，DSH 的工具运行时对"模型直接调用"做了 collapse：**只允许 `run_code`**
  （见 `@deepseek-ai/dsh-tools` 的 `resolveExecution` 文档："a MODEL-DIRECT call under `ptc`
  may only name the reserved `run_code` transport"），其它工具必须由 `run_code` 里的 SDK 子派发
  （`await tools.todo_write({...})`）。
- 因此正文里出现 `<function=todo_write>`（或 `edit`/`bash`…）这类**没被提供给模型的名字**时，
  插件按设计拒绝切分、整段按正文放行 —— 这不是插件失效；即使硬切出来，harness 也会以
  `UNKNOWN_TOOL` 拒绝。想让它直接可调，请把 agent preset 换成 `standard`（native 模式）。

## 0.2.7 — 2026-09-28

### 修复（拒绝切分时会改花正文）

- **名字不在白名单 / 名字非法而拒绝切分时，`<function=name>` 标签会被吞掉。** 匹配成功后
  `#matchMarker` 返回的 `rest` 在 `normalizeArguments=true` 下已经剥掉了标签头，旧代码只重发
  `<tool_call>` 前缀再接 `rest`，标签本身因此从正文里消失：
  输入 `<tool_call><function=read><parameter=file_path>a.json</parameter></tool_call>`、
  白名单 `["run_code"]` 时，输出变成 `<tool_call><parameter=file_path>…`（少了 `<function=read>`）。
  结构化适配器里因为 block-end 的原文覆盖语义没暴露，delta-only 适配器上就是可见的文本损坏。
- **修法**：拒绝时原样重发"被标记匹配吃掉的那一段"（`buf.slice(0, buf.length - m.rest.length)`），
  后续内容继续走流水线。回归用例 `0.2.7-1` 做逐字节校验，合计 **59 个用例**。

### 说明

- 排查"插件到底有没有加载"用的临时信标已从源码移除（源码与发布包都不含它）。
- 顺带记录一个容易误判的边界：**PTC preset 下模型能看到的工具表只有 `run_code`**，
  因此正文里出现的 `<tool_call><function=read>…`（或其他没在工具表里的名字）**按设计不执行**，
  整段按正文放行 —— 这不是"插件没生效"。要看真实转换效果，请用工具表里的名字（例如 `run_code`）。

## 0.2.6 — 2026-09-28

### 修复（"插件加载了、却把真调用当正文"的元凶）

真机现象：信标证明 loader 已 import、`apply()` 已执行、`llm/stream` 监听器已注册、每次模型流都命中
`intercept`，但放在消息末尾的合法 `<tool_call>` 仍然原样留在正文里、没有被转换。

- **根因：0.2.5 新加的 markdown 代码语境守卫跨 chunk 失效。** 模型流是逐字/两三字下发的，
  代码围栏的开合（连续 3 个反引号）经常被切成 "`" + "``"；旧实现每片各自数 run，永远凑不出 3 个，
  于是围栏状态错乱 —— 只要消息里出现过一次代码块，**之后所有真实工具调用都会被判成"在代码里"**
  而整段按正文放行。实测：同一段真机文本按 2/3/4 字一片喂进去必定不转换，按 1/7/13/50/100 字一片
  却正常 —— 典型的 chunk 边界 bug。
- **修法**：结尾未判完的符号 run 先扣住，等下一片拼齐再判定（和标记的前瞻缓冲同一套思路）；
  `#inCodeContext()` 把"还没判完的 run"也算作代码语境（保守：宁可漏也不误执行）。
- 回归测试 2 个（`0.2.6-1` 围栏被切开时围栏**之后**的真实调用必须执行；`0.2.6-2` 围栏**之内**的
  示例在任何切分粒度下都不执行），合计 **58 个用例**。

### 说明

- 排障用的加载信标（`~/.dsh/q3fix-beacon.log`）只存在于本机调试版本，发布包不含它。

## 0.2.5 — 2026-09-28

### 修复（"会话被 400 毒化"的根因）

真机事故：助手消息里出现 `tool_use` 之后还有 text/thinking 块的形状时，DeepSeek Messages /
Anthropic 风格端点会返回 400 `tool_use ids were found without tool_result blocks immediately
after: <id>`（报错下标是 1-based 内容下标，指向"后面还有正文"的那个 tool_use）。这条脏消息
留在会话历史里 → **该会话此后每个请求都失败**。跨 83 个会话日志核对：命中的 2 个会话各自
恰好有 1 条这种形状的消息，其余会话为 0。

- **工具调用改为"延迟到消息末尾发射"**：检测到合法调用后不再原地建块，而是挂进 pending，
  正文继续流式下发；`flush()`（消息结束）时再作为最后的 block-start/tool-call-delta 追加。
  于是**不可能**产出"工具块后面还有正文"的形状 —— 即使模型在调用之后（同一块或后续块）
  继续写正文。等价保证：结构化上游里"调用在块 0 末尾 + 块 1 还有正文"、以及"两个调用中间
  夹正文"都不再毒化会话。
- **合成块 index 不再与上游撞车**：合成块 index 取 `max(当前, 上游已出现的最大 index) + 1`。
  旧实现用 `curIndex + 1`，与上游随后的 block-start 撞车时，上游的 block-end 会以覆盖语义
  把工具块冲掉 —— 工具调用被静默吞掉。
- **上游 block-end 原文按"已接受的调用"精确清洗**：只删真正被接受、并已作为工具块发射的
  调用原文（含紧跟的包装闭合标签），被否定的引用原样留在正文里；混合场景不再整段误删。
- **block-end 不再丢缓冲参数**：TOOL 状态只在上游自己开的工具块上跟随，插件自己的调用在
  发射时一次性解析，不存在"块结束时把参数/名字冲掉"的路径。
- **replayState 对齐**（`realignReplayState`，默认开）：插件注入了工具块后，把适配器
  `finish.replayState.blocks` 补齐对应的 `{type:"tool-call"}` 条目，保住 thinking
  signature、避免 `INVALID_REPLAY_STATE` 降级；对不齐时原样透传，不猜。

### 新增

- `trailingTextPolicy`（`"reject"` 默认 / `"accept"`）：调用后面还有正文时是判为引用
  （整段按正文，保持"宁可漏也不误执行"）还是照常执行（正文排在工具调用之前）。
  注意：**同一候选缓冲**里出现的后续正文才受这个策略影响；调用已闭合、正文出现在后面的
  块里时，调用一律照常执行（延迟发射，不毒化）。
- **markdown 语境守卫**：工具标记落在代码围栏（连续 3 个及以上反引号/波浪号）或行内代码里
  时一律不切分（那是举例），补上"末尾一个格式完全正确的示例仍会被执行"的漏洞。
- 回归测试 12 个（`test/normalizer.defer.test.mjs`）+ 端到端 4 个
  （`test/normalizer.stream.test.mjs`，含两个真机事故原文的最小 BlockAssembler 组装校验）。
  合计 **56 个用例**。

### 行为变化（升级须知）

- 工具卡片会在**消息生成结束时**才出现（参数不再逐片流式下发）。这是为了拿到"整条消息里
  调用是不是最后一个内容块"这一事实，代价是卡片出现得晚一点。
- 延迟发射只影响插件自己切出来的调用；上游已经结构化的 `tool-call-delta` 仍然原样透传。

## 0.2.4 — 2026-09-28

### 修复（`function name must match [A-Za-z0-9_-]{1,64}` 400 的根因）

- **名字缺失/非法时一律不切分**。真机事故链：模型在**正文里引用** `<tool_call>` 讲语法
  （"我刚才输出的是 `<tool_call><function=edit>…` 这种写法"），旧逻辑把它切成了一个
  **没有名字**的 tool-call（`name: ""`）；这个空名被写进会话历史，之后**每个请求**
  都被服务端 400 拒绝（历史里带着 `{"type":"function_call","name":""}`），整个会话废掉。
  现在：名字必须匹配 `[A-Za-z0-9_-]{1,64}` 才建块，否则整段按普通文本。
- **候选延迟提交**：真工具调用后面不会有正文。检测到调用后先扣住，等块结束/流结束再定案：
  - 后面没有别的正文（或紧跟下一个调用）→ 提交，正常建 tool-call 块；
  - 后面还有正文 / 调用没闭合 → 判为"引用/举例"，整段按文本，**不执行**工具；
  - 标记紧跟在反引号/引号后面（`\`<tool_call>``）→ 直接判为引用。
  这样"模型讨论工具调用语法"不会被误当成真调用执行（edit/bash 这类是有副作用的）。

### 测试

- 40 个用例（回归 30 个）：新增/改写了 回归3（裸 `<tool_call>` 不切分）、回归9（后面还有正文 →
  按文本）、回归14（无名字块式参数不切分）、回归25（调用在块末尾 + block-end 原文清洗）、
  回归29（反引号/后接正文的引用不执行）、回归30（非法名字不切分）。

## 0.2.3 — 2026-09-28

### 修复（真机上"重启也没生效"的根因）

- **默认不再按模型名过滤**：`modelPatterns` 默认从 `["qwen3", "Qwen3"]` 改成 `["*"]`。
  真机排查发现同一个 Qwen3 端点被网关改名成了 `utoken/agentic-compute-medium`，
  名字里没有 `qwen3` → 插件**直接跳过、一次都没跑**。插件只在真的看到工具标记时才动手，
  所以放开模型过滤是安全的；要限制就自己配 `modelPatterns`。
- `"*"` 现在连 `model` 缺失的请求也照拦（此前 `!model` 会先返回 false）。
- 加载时打一行 `已加载 v<version> modelPatterns=...`；首次跳过某个模型也打一行
  `跳过 model=...` —— 以后"插件到底有没有跑"看日志即可。

### 新增（从真实会话日志里挖出来的另外两种写法）

- `<tool_call><name=run_code><parameter=code>...</parameter></tool_call>`：
  工具名写在 `<name=>`（而不是 `<function=>`）时也能取到名字；此前参数对但**名字是空的**，
  下游会当成未知工具。同时兼容 `<tool_name=>` / `<tool=>`。
- 参数值本身是 JSON 对象/数组时**按值解析**：`<parameter=todos>[{"content":"a"}...]</parameter>`
  现在得到数组而不是字符串（`todo_write` 这类工具要求数组，收到字符串会报类型错）。
  只有 `{` / `[` 开头且能解析对象/数组才转换，代码、路径等普通文本仍是字符串。
- 回归 26 / 27 / 28：`<name=>` 包装、JSON 值按值解析、默认配置能拦下别名模型。

## 0.2.2 — 2026-09-28

### 修复

- **上游 `block-end` 会把工具段"复活"成正文**：我们把某个 text/reasoning 块的文本切成了
  `tool-call` 块之后，上游仍会在该块的 `block-end` 里带上它自己攒的原文；BlockAssembler
  以 `block-end` 的 block **覆盖**已流出的 delta，于是 `<tool_call>…` 原文又回到正文里 ——
  表现就是"工具卡片出现了、但正文里还明晃晃一串 XML"。现在会记住被抽走文本的块 index，
  在它的 `block-end` 上把工具段剥掉再透传（该块里工具调用**之前/之后**的真实正文保留）。
- 回归 24 / 25：真实 shell 样本（含 `"$VAR"`、行继续符、中文、单引号）的 block-end 清洗；
  以及"同一块里工具段前后还有正文"时只剥工具段。

### 说明

- 剥段规则：`<tool_call>…` 优先截到 `</tool_call>`；没有闭合标签时退到 `</function>`，
  这样标记之后如果还有正文不会被误删。

## 0.2.1 — 2026-09-28

### 新增

- `splitInReasoning`（默认 `false`）：思考块（`reasoning-delta`）里出现的 `<tool_call>` 是否也切分。
  默认关是刻意的 —— 模型在思考里"提到"工具调用的字面量并不等于真想调用，切出来会真的执行工具（有副作用）。
  关着的时候如果思考里出现 `<tool_call>`，`debug: true` 会打一条提示日志，便于判断该不该打开。
- 回归 20：拿真实会话里的多行 / 缩进 / 空行 / 中文注释参数块做逐字节保真测试
  （`file_path` 值独占一行，`old_string` / `new_string` 是多行代码）。
- 回归 21-23：`splitInReasoning` 关/开两种行为 + 从 `apply()` 透传。

### 说明

- 块式参数的多行值处理：只剥掉值首尾的**包装换行**，内部缩进、空行、中文注释原样保留，
  这样 `old_string` 才能和文件内容逐字节匹配上。

## 0.2.0 — 2026-09-28

### 新增
- 支持 `<tool_call><function=NAME><parameter=k>v</parameter>...</function></tool_call>` 块式 XML 参数
  （Qwen3-Coder / Anthropic 风格）：解析成 JSON 参数对象后下发，同名参数聚成数组；
  同时支持 `<parameter name="k">` 属性写法。此前这种写法会被原样当参数发出去，
  下游 `JSON.parse` 直接 `ToolArgsError: INVALID_ARGS`。
- 没有 `<function=NAME>` 包装的 `<tool_call><parameter=k>v</parameter></tool_call>` 也能切分
  （此前首个 `>` 会被误当成函数标签结束，参数体被切坏）。
- `modelPatterns` 支持 `"*"`：匹配所有模型名（不想按模型名限制时用）。

### 修复
- `normalizeArguments` 现在真正从插件配置透传到 normalizer（0.1.0 的 README 写了这个开关，
  但入口没转发，配置成 `false` 也不会生效；默认值恰好是 true 所以没暴露出来）。
- 配置里显式传 `undefined` 不再顶掉默认值（逐键合并）。
- 参数体形态判定在标签只到一半时（如 `<p`、`<param`）会误判成 JSON 体，
  导致参数块被逐片原样下发 —— 改为等标签成形后再判定。
- 参数值首尾的包装换行被剥离（`<parameter=new_string>\n代码\n</parameter>` 里的换行是排版，
  留在 `old_string` 里会让编辑工具精确匹配失败）；值内部的换行 / 引号 / 反斜杠按 JSON 正确转义。
- 工具块之后的残留文本也会剥掉 `<parameter>` 标签。

### 测试
- 29 个用例全绿：`node --test test/*.test.mjs`（规格 10 + 回归 19）。
- 新增回归 12-19：块式参数在 1..19 任意切分宽度下的解析、转义、同名参数、
  `<parameter name=>` 写法、无 function 包装、`apply` 配置透传、`*` 通配。

## 0.1.0

- 首个版本：`llm/stream` 瀑布拦截 Qwen3 的隐式推理结束（无 `</thinking>` 直接 `<tool_call>`），
  切分出 `tool-call` 块；JSON 参数规范化（`normalizeArguments`）；跨 chunk 标记拼接。
