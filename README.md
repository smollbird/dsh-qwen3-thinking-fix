# dsh-qwen3-thinking-fix

DSH 插件：规范化 Qwen3 的思考 / 工具调用边界，让工具调用在 agent loop 里不丢。

仓库：<https://github.com/smollbird/dsh-qwen3-thinking-fix> · 当前版本：**0.2.9**（变更见 [CHANGELOG.md](./CHANGELOG.md)）

## 安装

包内自带 `cordis.patch.yml`（`package.json` 的 `dsh.bundle.patch` 声明），用下面的任一方式装进 profile 后 **host 端自动注册 bundle，无需手动往 `cordis.patch.yml` 写 insert**。装完重启 DSH（桌面版 / `dsh web`）即生效。

### 方式一：DSH 插件面板（推荐）

1. 打开 DSH →「插件」→ 右上角 **「+ 添加插件」**；
2. 输入框**直接填 GitHub 仓库地址**（不是包名），点 **「安装」**：

   ```text
   https://github.com/smollbird/dsh-qwen3-thinking-fix.git
   ```

   > ⚠️ 这里**不能只填包名** `dsh-qwen3-thinking-fix`：面板会把裸包名当作 registry 查询（走右下角"安装源"，默认中国大陆镜像 npmmirror），而本包尚未发布到 npm，所以会显示"未找到相关插件"。填完整仓库 URL 则走 git 安装，与安装源无关。
   >
   > 想锁版本可在 URL 后加 ref（如 `...git#v0.2.9`）。

3. 安装完成后重启 DSH 即可。

> git 来源安装时 pnpm 会执行包的 prepare 脚本，若被拦截，按终端提示把打印的 key 加进 profile 目录的 `pnpm-workspace.yaml` 的 `allowBuilds`，再重新安装一次。

### 方式二：dsh CLI

```sh
# 从 GitHub 安装（main 分支最新代码）
dsh plugin --profile web add github:smollbird/dsh-qwen3-thinking-fix

# 或锁定发布 tag
dsh plugin --profile web add github:smollbird/dsh-qwen3-thinking-fix#v0.2.9
```

其它 profile 把 `web` 换成对应名字（如 `desktop`）。卸载：

```sh
dsh plugin --profile web remove dsh-qwen3-thinking-fix
```

> ⚠️ **裸包名现在装不了**：`dsh plugin add <包名>` 和插件面板一样，都是把裸名字发到 npm registry 查询；本包还没 `npm publish`，registry 上没有它，所以会报 not found。**必须带 `github:` 前缀**（或完整 URL）才走 git 安装。等发布到 npm 后，裸包名即可直接用。

### 方式三：本地源码 link（开发用，改源码重启即生效）

profile 的 `package.json`：

```json
{
  "dependencies": {
    "dsh-qwen3-thinking-fix": "link:/abs/path/dsh-qwen3-thinking-fix"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-qwen3-thinking-fix"]
    }
  }
}
```

然后在 profile 目录执行 `pnpm install`，重启桌面版 / 重载 profile。
bundle 自带 `cordis.patch.yml`，不需要手写 entry。

### 方式四：release tarball（稳定版）

```sh
dsh plugin --profile web add file:/abs/path/dsh-qwen3-thinking-fix-0.2.9.tgz
```

注意 `file:` 是**拷贝**安装（改源码后要重新打包再装）；要改源码即生效请用 `link:`。
tarball 可用 `pnpm pack` 在本仓库根目录生成：

```sh
pnpm pack      # 产出 dsh-qwen3-thinking-fix-<version>.tgz
```

包内只含 `index.js` / `lib` / `cordis.patch.yml` / `README.md` / `CHANGELOG.md` / `package.json`
（`files` 白名单，测试不进包）。这个 tarball 就是可直接 `npm publish` 的形态。

> ⚠️ **不要再往 profile 的 `cordis.patch.yml` 手动 insert 本插件**：bundle patch 已自动注册，重复 insert 同 id 会让加载器报 duplicate loader entry id 无法启动。旧版本按旧文档手动 insert 过的，请删除那行 insert。

## 问题

Qwen3（含 Qwen3-Coder 系）在思考阶段决定调用工具时，经常**不输出** `</thinking>` 闭合标签，
直接接着输出 `<tool_call>`。这类"隐式推理结束"的输出会引发两类断链：

1. 适配器把它整体当作普通 `text-delta` 下发 → 工具调用变成正文文本，agent loop 认为模型没有调工具；
2. 即使切出了 tool-call 块，DSH 工具层还会对 `arguments` 做 `JSON.parse` ——
   参数里带着 `<tool_call>` / `<function=name>` 包装时必然 `ToolArgsError: INVALID_ARGS`。

谁负责解析？OpenAI 兼容协议里"文本 → 结构化 tool_calls"是**服务端**的活（vLLM / SGLang / Ollama /
DashScope 等的 tool-call parser，或中间网关）。DSH 侧只消费结构化 chunk：`dsh-llm-pi-ai` 把上游的
`toolcall_start/delta/end` 翻成 `tool-call-delta`，agent loop 里没有任何文本标记解析器。
服务端正常解析时本插件不会介入；服务端没解析、markup 落进 content 时，由本插件兜底。

## 支持的三种工具调用写法

| 模型输出 | 处理方式 |
| --- | --- |
| `<tool_call><function=NAME>{"k":"v"}</function></tool_call>` | 流式增量下发 JSON 参数体 |
| `<tool_call>{"name":"NAME","arguments":{...}}</tool_call>` | 取出 `arguments` 值后下发 |
| `<tool_call><function=NAME><parameter=k>v</parameter>...</function></tool_call>` | 解析成 JSON 对象后下发 |

第三种（块式 XML 参数）细节：

- 也支持 `<parameter name="k">value</parameter>` 属性写法；
- 同名参数聚成数组（例如一次输出里多个同名 edit 参数），不互相覆盖；
- 没有 `<function=NAME>` 包装的 `<tool_call><parameter=...>` 同样切分；
- 参数值首尾的包装换行被剥离，值内部的换行 / 引号 / 反斜杠按 JSON 正确转义；
- 工具名也接受 `<name=tool_name>` / `<tool_name=tool_name>` 写法（不只有 `<function=>`）；
- 参数值本身是 JSON 对象/数组时按值解析（`todos` 这类拿到数组而不是字符串）。

## 做法

挂在 dsh-llm 的 `llm/stream` waterfall 上，把 text-delta 流按状态机重新切分：

| 输入形态 | 产出 |
| --- | --- |
| 首段文本 + `</thinking>` | 前段 reasoning-delta，标签剥离，其后 text-delta |
| 首段文本 + `<tool_call>`（无闭合标签） | 前段 reasoning-delta，开关 tool-call 块，参数以 tool-call-delta 续发 |
| 开头就是 `<tool_call>` | 直接开 tool-call 块，不产生 reasoning-delta |
| `<function=name>JSON</function>` | argumentsDelta 只发 JSON 体（包装 / 闭合标签丢弃） |
| `<function=name><parameter=k>v</parameter>…` | 拼成 `{"k":"v"}` 后下发（同名聚成数组） |
| `<tool_call>{"name":…,"arguments":{…}}` | 取出 `arguments` 值，JSON.stringify 后下发 |
| 无参数的工具调用 | argumentsDelta 发 `{}`，保证工具名送达且可 JSON.parse |
| 块后的 `</tool_call>` 残留 | 丢弃；其后另有真内容则另开一个 text 块 |
| 跨 chunk 被切开的标记 / 闭合标签 / 参数标签 | 前瞻缓冲拼齐后再判定，不吞字不重复 |
| 结构化上游（已有 block-start/reasoning-delta） | 原样跟随，不重复开块、不伪 block-end |
| 上游 block-end 里塞回的原文（含工具段） | 只删**已接受**的调用原文再透传 —— block-end 有**覆盖**语义，否则原文里的 XML 会复活成正文 |
| 工具调用的发射时机 | **延迟到消息末尾**（flush）才追加为最后的块：助手消息里 tool_use 后面绝不能再有正文，否则服务端会 400 并且该会话此后每个请求都失败 |
| 合成块的 index | 取"上游已出现的最大 index + 1"，不与上游的 block-start 撞车（撞车会被 block-end 覆盖、静默吞掉调用） |
| 代码围栏 / 行内代码里的标记 | 一律当举例，不切分、不执行 |
| 名字缺失 / 非法（不是 `[A-Za-z0-9_-]{1,64}`） | **不切分**，按普通文本 —— 非法 name 写进历史会让整个会话被服务端 400 |
| 调用后面还有正文、或标记被反引号/引号包着 | 判为"引用/举例"，整段按文本，**不执行**工具（真调用总在末尾） |

工具名支持 `<function=weather>`（Qwen3-Coder）与 `{"name": "weather", ...}`（Qwen3）两种形态。

**只负责转换，不判可执行性**：只要名字语法合法（`[A-Za-z0-9_-]{1,64}`），本插件就把它切成结构化
`tool-call`；"这个工具在当前模式下能不能被直接调用"由 harness 判定并回错误（例如 PTC 下会回
`unknown tool "x": only run_code is callable directly …`，模型据此自我纠正）。想恢复"名字必须在请求
工具表里才切分"的旧行为，把 `strictToolList` 设为 `true`。

失败模型：任何内部异常都降级为透传，监听器绝不 throw。

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: dsh-qwen3-thinking-fix
  config:
    modelPatterns: ["*"]                # 默认不限模型；要限制就写正则源字符串，如 ["qwen3"]
    stripThinkingTags: true             # 是否剥离 </thinking> 文本标记
    splitOnToolCall: true               # 检测到 <tool_call> 时切分块
    normalizeArguments: true            # argumentsDelta 只发 JSON 参数体
    splitInReasoning: false             # 思考块(reasoning-delta)里的 <tool_call> 是否也切分
    strictToolList: false               # 是否要求名字在本次请求的工具表里才切分（默认 false：只转，不判可执行性）
    trailingTextPolicy: reject          # 调用后面还有正文：reject=判为引用（默认）/ accept=照常执行
    realignReplayState: true            # 注入工具块后补齐 replayState.blocks（保住 thinking signature）
    debug: false                        # 调试日志
```

> `trailingTextPolicy` 只作用于**同一个候选缓冲**里跟在调用后面的正文。调用本身已经闭合、
> 正文出现在后面的块里时，调用一律照常执行（延迟发射，不会再毒化会话）。

## 测试

```sh
node --test test/*.test.mjs
```

62 个用例：

- `test/normalizer.test.mjs`：原始规格 10 个；
- `test/normalizer.regression.test.mjs`：回归 30 个（任意切分宽度、JSON 体 / 块式参数 /
  无 function / `<name=>` 包装、转义、同名参数、JSON 值按值解析、真实多行与 shell 样本逐字节
  保真、block-end 原文清洗、名字合法性、引用举例不执行、块后残留、上游块不被覆盖、配置透传、
  `*` 通配、`splitInReasoning` 关/开、日志兜底）；
- `test/normalizer.defer.test.mjs`：0.2.5 回归 12 个（毒化形状、index 撞车、精确清洗、
  代码围栏守卫、延迟发射、replayState 对齐、截断调用、多行参数不丢字节…）；
- `test/normalizer.stream.test.mjs`：端到端 4 个，把 chunk 流喂过 `llm/stream` 处理器，
  再用最小 BlockAssembler 复刻 DSH 组装语义，直接用**两个真机事故原文**断言"工具块之后没有
  正文块"这个必 400 形状不再出现（其中一条是 uaienergyanalysis 工单里的 `eaboundary.js` edit）。

## 已知限制

- **默认不限模型**（`modelPatterns: ["*"]`）：Qwen3 端点常被网关改名（例如
  `utoken/agentic-compute-medium`），按名字过滤会让插件"看起来没生效"。如果你自己把
  `modelPatterns` 收紧成 `["qwen3"]`，别名模型就不会被拦 —— 排查时先看日志里有没有
  `已加载 v<version>` 和 `跳过 model=...`。
- 块式 XML 参数（`<parameter=...>`）不流式增量：要等 `</function>` / `</tool_call>` 闭合后
  才能拼成对象，因此长参数的 argumentsDelta 会一次性下发。
- 参数规范化只剥包装，不修复模型本身给出的畸形 JSON；解析不了时原样透出，下游仍会报参数错误。
- 需要"逐字节保留原文"时把 `normalizeArguments` 设为 `false`（arguments 里会带 `<tool_call>` 包装）。
- 服务端（OpenAI 兼容 API / 推理引擎）如果已经正确返回结构化 tool_calls，本插件不会介入 ——
  那种情况下上游下发的是 tool-call-delta，而不是 text-delta。
- **"引用"与"真调用"靠四条判定**：① 名字必须合法；② 标记前一个字符不能是反引号/引号；
  ③ 标记不能落在代码围栏或行内代码里；④ 调用后面（同一候选缓冲内）不能还有正文
  （`trailingTextPolicy: reject` 时）。四条都不命中才建块。
  已知边界：调用已经闭合、正文出现在**后面的块**里时，调用照常执行（延迟发射保证不毒化会话）；
  若某条正文既没被引号/围栏包住、又跟在调用之后，但它出现在后面的块里，仍会被当成真调用。
  完全不想冒险就把 `splitOnToolCall` 设为 `false`，或开 `debug: true` 看每次定案原因。
- **工具卡片出现得晚**：调用一律延迟到消息结束（flush）时才发射，所以卡片会在正文流完之后
  一次性出现，参数也不再逐片流式下发。这是换取"工具块永远排在消息末尾"的代价。
- **PTC preset 下看不到"转换成功"是正常的**：DSH 的工具运行时对"模型直接调用"做了 collapse ——
  只有 `run_code` 允许被模型直接调用，其它工具必须由 `run_code` 里的 SDK 子派发
  （`await tools.todo_write({...})`）。所以正文里出现 `<function=todo_write>` / `<function=edit>` 这类
  **没被提供给模型的名字**时，本插件按设计拒绝切分、整段按正文放行（不是插件失效；硬切出来 harness
  也会以 `UNKNOWN_TOOL` 拒绝）。想直接可调就换 `standard`（native）preset。
  开 `debug: true` 时日志会写清拒绝原因（含"不在本次请求的工具表里"）。
- **思考块里的工具调用默认不切**：如果 UI 里看到 `<tool_call>` 是在 thinking 块**内部**（而不是
  content 块里），那说明上游把整段当成了 reasoning-delta —— 把 `splitInReasoning` 设为 `true`。
  之所以默认关，是因为"思考里提到工具调用"和"真要调用"在文本上无法区分，切出来会真的执行工具。
