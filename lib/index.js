/**
 * dsh-qwen3-thinking-fix — DSH 插件入口。
 *
 * 职责边界：在模型流式输出到达 DSH 工具调用解析器之前，拦截并规范化 Qwen3 的
 * 思考/工具调用边界，把"无 </thinking> 但有 <tool_call> 的输出"修复为解析器可识别
 * 的结构化 chunk。不修改 DSH 核心，不修改模型推理，只做输出层的规范化。
 *
 * 挂载点：'llm/stream' waterfall（dsh-llm）。
 * 精确签名（dsh-llm/lib/types/index.d.ts:43，注意与常见的 per-chunk 直觉不同）：
 *
 *   'llm/stream'(options: GenerateOptions,
 *                next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>
 *
 * 因此本插件返回一个包装后的 AsyncIterable：消费 next() 的 chunk 流，逐 chunk
 * 喂给 Qwen3StreamNormalizer，产出修正后的 chunk 流。options 为 DEEP-FROZEN
 * （agent loop 请求带 markAgentLoopRequest 标记），只读不改。
 *
 * 失败模型：normalizer/feed 任何异常降级为透传；本监听器自身绝不 throw。
 *
 * 配置（cordis.patch.yml insert entry 的 config 字段）：
 *   modelPatterns: string[]   仅匹配这些模型名模式时启用（正则源字符串），默认 ['qwen3', 'Qwen3']
 *   stripThinkingTags: bool   是否剥离 </thinking> 文本标记，默认 true
 *   splitOnToolCall: bool     检测到 <tool_call> 时是否切分出 tool-call 块，默认 true
 *   normalizeArguments: bool  argumentsDelta 是否只发 JSON 参数体（默认 true）；
 *                             false = 逐字节保留模型原文（含 <tool_call> 包装）
 *   splitInReasoning: bool    思考块（reasoning-delta）里的 <tool_call> 是否也切分，
 *                             默认 false（思考里提到工具调用 ≠ 真想调用，切出来会真的执行）
 *   trailingTextPolicy: str   调用后面还有正文时怎么办：'reject'（默认）判为引用/举例、
 *                             整段按正文；'accept' 仍执行，正文排在工具调用之前
 *   realignReplayState: bool  注入工具块后是否补齐适配器的 replayState.blocks（保住
 *                             thinking signature），默认 true
 *   debug: bool               调试日志，默认 false
 *   modelPatterns 里的 "*"   匹配所有模型（不想限制模型名时用）
 *
 * 发射时机（0.2.5）：检测到的工具调用**不会在原地发射**，而是排队到消息末尾（flush）
 * 再追加为最后的 block-start/tool-call-delta。原因见 normalizer.js 的"毒化形状"注释：
 * 服务端不允许同一条 assistant 消息里 tool_use 之后还有 text/thinking 块。
 */
import { Qwen3StreamNormalizer } from "./normalizer.js";

export const name = "dsh-qwen3-thinking-fix";
// fiber 的 inject 声明决定 ctx 属性可达性 —— llm/stream 是 dsh-llm 的事件，
// 挂载 listener 本身不需要 ctx.llm，但声明 "llm" 保证本插件在 llm 服务之后装配。
export const inject = ["llm"];
export const VERSION = "0.2.9";

const DEFAULT_CONFIG = Object.freeze({
  // 默认不过滤模型名：Qwen3 经常被网关改名为别的 id（例如 utoken/agentic-compute-medium），
  // 按名字过滤会让插件"看起来没生效"。只在真正看到工具标记时才动手，所以放开是安全的；
  // 想限制就配 modelPatterns，例如 ["qwen3", "Qwen3"]。
  modelPatterns: ["*"],
  stripThinkingTags: true,
  splitOnToolCall: true,
  normalizeArguments: true,
  splitInReasoning: false,
  strictToolList: false,
  trailingTextPolicy: "reject",
  realignReplayState: true,
  debug: false,
});

const LOG_SCOPE = "dsh-qwen3-thinking-fix";

/**
 * 模型名匹配：任一 pattern 命中即启用。
 * @param {string} model
 * @param {string[]} patterns
 */
export function modelMatches(model, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  for (const p of patterns) {
    if (p === "*") return true; // 通配：连 model 缺失也照拦
    if (!model) continue;
    try {
      if (new RegExp(p, "i").test(model)) return true;
    } catch {
      if (String(model).toLowerCase().includes(String(p).toLowerCase())) return true;
    }
  }
  return false;
}

/**
 * 从 GenerateOptions 提取已知工具名集合（用于 <tool_call> 工具名校验）。
 * @param {{ tools?: Array<{ name?: string }> }} options
 */
function knownToolsOf(options) {
  const tools = Array.isArray(options?.tools) ? options.tools : [];
  const set = new Set();
  for (const t of tools) {
    if (t && typeof t.name === "string") set.add(t.name);
  }
  return set;
}

/**
 * 取本插件的 logger（ctx.logger 不可用时退回 console）。
 * @param {{ logger?: Function|object }} ctx
 */
export function resolveLog(ctx) {
  try {
    if (ctx && typeof ctx.logger === "function") {
      const scoped = ctx.logger(LOG_SCOPE);
      if (scoped) return scoped;
    }
    if (ctx && ctx.logger && typeof ctx.logger.info === "function") return ctx.logger;
  } catch {
    // 忽略：退回 console
  }
  return console;
}

/**
 * 把任意 logger 形状包成单参数函数。注意不能写成 log.info?.(m) ?? log(m)：
 * info() 返回 undefined，?? 右侧会无条件求值，ctx.logger 缺失时 log 是 console
 * 对象、不可调用 → TypeError。
 * @param {any} log
 * @returns {(msg: string) => void}
 */
export function makeLogFn(log) {
  return function logMsg(msg) {
    try {
      if (log && typeof log.info === "function") log.info(msg);
      else if (log && typeof log.log === "function") log.log(msg);
      else if (typeof log === "function") log(msg);
      else console.info("[" + LOG_SCOPE + "] " + msg);
    } catch {
      // 日志失败绝不影响 chunk 流
    }
  };
}

/**
 * 包装上游 chunk 流：逐 chunk 规范化，流结束时 flush。
 * @param {AsyncIterable<any>} upstream
 * @param {object} config
 * @param {object} options GenerateOptions（只读）
 * @param {(msg: string) => void} logMsg
 */
async function* transform(upstream, config, options, logMsg) {
  const ncfg = {
    enabled: true,
    stripThinkingTags: config.stripThinkingTags,
    splitOnToolCall: config.splitOnToolCall,
    normalizeArguments: config.normalizeArguments,
    splitInReasoning: config.splitInReasoning,
    strictToolList: config.strictToolList,
    trailingTextPolicy: config.trailingTextPolicy,
    realignReplayState: config.realignReplayState,
  };
  const normalizer = new Qwen3StreamNormalizer(
    ncfg,
    {
      knownTools: knownToolsOf(options),
      debug: config.debug,
      onDebug: (m) => logMsg("[stream] model=" + (options?.model ?? "?") + " " + m),
    },
  );
  for await (const chunk of upstream) {
    for (const c of normalizer.feed(chunk)) yield c;
  }
  // 流自然结束：吐出残留 lookahead / 关闭活动块
  for (const c of normalizer.flush()) yield c;
}

/**
 * 插件装配入口。
 * @param {any} ctx
 * @param {object} [config]
 */
export function apply(ctx, config = {}) {
  const logMsg = makeLogFn(resolveLog(ctx));
  const cfg = {
    ...DEFAULT_CONFIG,
    ...(typeof config === "object" && config !== null ? config : {}),
  };

  // 加载时打一行：确认插件真的装了、版本对、匹配规则是什么
  logMsg("已加载 v" + VERSION + " modelPatterns=" + JSON.stringify(cfg.modelPatterns));

  let skipLogged = false;
  ctx.on("llm/stream", (options, next) => {
    // 不匹配的模型：零开销透传（首次打一行，便于排查"为什么没生效"）
    if (!modelMatches(options?.model, cfg.modelPatterns)) {
      if (!skipLogged) {
        skipLogged = true;
        logMsg("跳过 model=" + (options?.model ?? "(未提供)") + " modelPatterns=" + JSON.stringify(cfg.modelPatterns));
      }
      return next();
    }
    if (cfg.debug) logMsg("intercept model=" + (options?.model ?? "?"));
    // options 是冻结的（agent loop 请求），绝不改写；只包装 chunk 流。
    return transform(next(), cfg, options, logMsg);
  });
}
