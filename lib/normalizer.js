/**
 * dsh-qwen3-thinking-fix — 流式规范化状态机（纯逻辑，不依赖 DSH 运行时）。
 *
 * 背景：Qwen3 模型在思考阶段决定调用工具时，可能不输出 </thinking> 闭合标签，
 * 直接以 <tool_call> 开头继续输出。DSH 的下游（BlockAssembler / agent loop）信任
 * 结构化 StreamChunk（reasoning-delta / text-delta / tool-call-delta）；当适配器把这种
 * "隐式推理结束"的输出全部当作 text-delta 下发时，工具调用变成普通文本，链路断裂。
 *
 * 本模块在 chunk 流上维护状态机，检测 text-delta 中跨越思考/工具边界的内容并
 * 重新切分为结构化 chunk：
 *
 *   - IDLE 状态收到的首段文本默认延迟为"预文本"：若之后出现 </thinking> 或
 *     <tool_call> → 整段归入 reasoning（思考泄漏形态）；否则 flush 时按 text 下发
 *   - text-delta 中出现 </thinking> → 结束思考段，剥离标签本身
 *   - text-delta 中出现合法 <tool_call>（名字合法、不在引用/代码语境里）→ 先扣住候选，
 *     到块/流边界再定案
 *   - 定案为真调用后**不在原地发射**，而是挂进 pending，等整条消息的正文都发完，
 *     在 flush() 里作为**最后**的块发射 —— 见下面"毒化形状"
 *   - 参数规范化（normalizeArguments，默认开）：丢掉 <tool_call> / <function=name>
 *     包装与闭合标签，只把 JSON 参数体作为 argumentsDelta 下发。DSH 工具层对
 *     arguments 做 JSON.parse，带上包装会直接 ToolArgsError: INVALID_ARGS
 *   - 跨 chunk 的标记（如 chunk 以 "<tool" 结尾）用前瞻缓冲区拼接判断
 *
 * 为什么"工具调用必须排在最后"（0.3.0 的核心修复）：
 * DeepSeek Messages / Anthropic 风格的端点要求 assistant 消息里每个 tool_use 后面
 * 紧跟 tool_result；同一条 assistant 消息里 tool_use 之后只要再出现 text/thinking
 * 块，服务端就 400（"tool_use ids were found without tool_result blocks immediately
 * after: …"），而且这条脏消息留在会话历史里 → 该会话此后**每个请求**都失败。
 * 旧实现遇到"调用在块末尾、后面还有别的块"时会在原地发射工具块，于是正文排到了
 * 工具块后面，正好产出这个必 400 的形状。现在：调用先在 pending 里排队，正文照常
 * 流式下发，flush() 时再把工具块追加到消息末尾 → 不可能出现"工具块后面还有正文"。
 *
 * 失败模型：任何内部异常降级为透传（never throw）——middleware 抛错会被当作插件
 * 失败向上传播，而畸形输入应当中性通过。
 */

/** 块状态 */
export const STATE = {
  IDLE: "IDLE",           // 尚未观察到任何内容块
  PENDING: "PENDING",     // IDLE 后的首段文本：归 reasoning 还是 text 未定
  THINKING: "THINKING",   // 已确认思考段（reasoning）
  TEXT: "TEXT",           // 普通正文段
  TOOL: "TOOL",           // 上游自己开的工具调用段（只跟随，不接管）
};

/** Qwen3 思考闭合标签 */
const CLOSE_THINKING = "</thinking>";
/** Qwen3 工具调用开标签 */
const TOOL_OPEN = "<tool_call>";
/** 触发标记探测的候选前缀（标记被 chunk 切开时的最早可判位置） */
const MARKER_PREFIXES = ["<tool", "</t"];
/** 工具调用体的闭合标记 */
const TOOL_CLOSERS = ["</function>", "</tool_call>"];
/** tool 块之后残留的包装标签 */
const TOOL_WRAPPER_RE = /<\/?(?:tool_call|function|parameter)(?:=[^>]*)?>/g;
/** 收尾残留里"可能是标签前缀"的形状 */
const PARTIAL_TAG_RE = /^<\/?[a-z_]*(?:=[^>]*)?$/i;
/** 服务端允许的函数名：1-64 个 [A-Za-z0-9_-]。名字非法/缺失时绝不能建 tool-call 块 ——
 *  会话历史里一旦记下非法 name，之后**每个请求**都会被服务端 400 拒绝。 */
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 上游 block-end 里"复活"的整段工具调用（兜底清洗用） */
const TOOL_SEGMENT_RE = /<tool_call>[\s\S]*?(?:<\/tool_call>|<\/function>(?![\s\S]*<\/tool_call>)|$)/g;
/** Qwen3-Coder / Anthropic 风格的参数块 */
const PARAM_RE = /<parameter(?:\s*=\s*|\s+name\s*=\s*["']?)([A-Za-z0-9_.:-]+)["']?\s*>([\s\S]*?)<\/parameter>/g;
/** 调用结尾之后跟着的包装闭合标签（如 </function>\n</tool_call>） */
const TRAILING_CLOSERS_RE = /^(?:\s*<\/(?:tool_call|function|parameter)>)+\s*/;
/** <function=name> / <name=name> / <tool_name=name> 头部标签 */
const FUNCTION_TAG_RE = /^<(?:function|name|tool_name|tool)\b[^>]*>/i;

/**
 * @typedef {object} NormalizerConfig
 * @property {boolean} [enabled]             总开关（false = 纯透传）
 * @property {boolean} [stripThinkingTags]   是否剥离 </thinking> 文本标记
 * @property {boolean} [splitOnToolCall]     检测到 <tool_call> 时是否切分块
 * @property {boolean} [normalizeArguments]  true（默认）= argumentsDelta 只发 JSON 参数体；
 *                                           false = 逐字节保留模型原文（含包装标签）
 * @property {boolean} [splitInReasoning]    reasoning-delta 里的 <tool_call> 是否也切分
 * @property {boolean} [strictToolList]      是否要求工具名出现在"本次请求的工具表"里才切分。
 *                                           默认 false：本模块只负责把标记转成结构化调用，
 *                                           "这个工具能不能被直接调用"由 harness 自己判定
 *                                           （PTC 会回 UNKNOWN_TOOL 并提示改用 run_code）。
 * @property {'reject'|'accept'} [trailingTextPolicy] 调用后面还有正文时怎么办：
 *                                           'reject'（默认）= 判为引用/举例，整段按正文；
 *                                           'accept' = 仍执行，正文照常排在工具调用之前
 * @property {boolean} [realignReplayState]  注入工具块后是否补齐适配器的 replayState.blocks
 */

const DEFAULTS = Object.freeze({
  enabled: true,
  stripThinkingTags: true,
  splitOnToolCall: true,
  normalizeArguments: true,
  splitInReasoning: false,
  strictToolList: false,
  trailingTextPolicy: "reject",
  realignReplayState: true,
});

/**
 * 判断一串（可能是前缀的）片段是否"可能"是某个完整标记的开头。
 * @param {string} partial
 * @returns {boolean}
 */
export function looksLikeMarkerPrefix(partial) {
  if (typeof partial !== "string" || !partial.startsWith("<")) return false;
  if (CLOSE_THINKING.startsWith(partial)) return true;
  if (TOOL_OPEN.startsWith(partial)) return true;
  return /^<\/?[a-z_]*$/.test(partial);
}

/**
 * 从 "<function=weather" / "<name=run_code" 这类头部提取工具名。
 * @param {string} text
 * @returns {string|undefined}
 */
function xmlToolName(text) {
  if (!text) return undefined;
  const body = String(text).replace(/^\s*</, "");
  const named = /^(?:function|name|tool_name|tool)\s*=\s*([A-Za-z0-9_.:-]+)/i.exec(body);
  if (named) return named[1];
  const any = /([A-Za-z0-9_.:-]+)/.exec(body);
  return any ? any[1] : undefined;
}

/**
 * 从 Qwen3 的 JSON 形态调用体里提取已闭合的 "name" 值。
 * @param {string} text
 * @returns {string|undefined}
 */
function jsonToolName(text) {
  const m = /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  return m ? m[1] : undefined;
}

/**
 * 从 JSON 形态的调用体里取出参数体。
 * @param {string} text
 * @returns {string|undefined}
 */
function jsonArguments(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const raw = obj.arguments ?? obj.parameters ?? obj.args ?? obj.input;
  if (raw === undefined) return "{}";
  try {
    const s = JSON.stringify(raw);
    return typeof s === "string" ? s : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 从上游 block-end 携带的原文里剥掉整段工具调用标记（兜底：当无法按"已接受的调用原文"
 * 精确删除时使用）。
 * @param {string} text
 * @returns {string}
 */
function stripToolSegments(text) {
  return String(text ?? "").replace(TOOL_SEGMENT_RE, "");
}

/**
 * 去掉参数值首尾的"包装换行"。
 * @param {string} v
 */
function stripWrapperNewlines(v) {
  return String(v).replace(/^\r?\n/, "").replace(/\r?\n[ \t]*$/, "");
}

/**
 * 参数值本身就是 JSON 对象/数组时按值取。
 * @param {string} v
 */
function maybeJsonValue(v) {
  const t = String(v).trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return v;
  try {
    const parsed = JSON.parse(t);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // 不是 JSON：保持字符串
  }
  return v;
}

/**
 * 解析 <parameter=name>value</parameter> 块，拼成参数对象。
 * @param {string} text
 * @returns {object|undefined}
 */
function xmlParameters(text) {
  const src = String(text ?? "");
  const out = {};
  let count = 0;
  PARAM_RE.lastIndex = 0;
  let m;
  while ((m = PARAM_RE.exec(src)) !== null) {
    const key = m[1];
    const val = maybeJsonValue(stripWrapperNewlines(m[2]));
    count += 1;
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      if (Array.isArray(out[key])) out[key].push(val);
      else out[key] = [out[key], val];
    } else {
      out[key] = val;
    }
  }
  return count > 0 ? out : undefined;
}

/**
 * 流式规范化器。
 */
export class Qwen3StreamNormalizer {
  /**
   * @param {NormalizerConfig} [config]
   * @param {{ knownTools?: Set<string>|string[], debug?: boolean, onDebug?: (msg: string) => void }} [opts]
   */
  constructor(config = {}, opts = {}) {
    const given = config ?? {};
    const merged = { ...DEFAULTS };
    for (const k of Object.keys(given)) {
      if (given[k] !== undefined) merged[k] = given[k];
    }
    this.cfg = merged;
    this.knownTools = opts.knownTools instanceof Set
      ? opts.knownTools
      : new Set(Array.isArray(opts.knownTools) ? opts.knownTools : []);
    this.debug = Boolean(opts.debug);
    this.onDebug = opts.onDebug;

    this.state = STATE.IDLE;
    this.lookahead = "";
    this.pre = "";
    this.curIndex = 0;
    this.curId = undefined;
    this.curText = "";
    this.ownBlock = false;
    this.sawFirstBlock = false;

    // ── 候选 / 待发射的工具调用 ──
    this.cand = null;         // { name, shape, index, own }
    this.candBuf = "";        // 候选原文（从 <tool_call> 起）
    this.pending = [];        // 已定案、等消息末尾发射的调用
    this.accepted = [];       // 已接受调用的原文（用于清洗上游 block-end）
    this.diverted = new Set();// 被抽走文本的上游块 index
    this.prevChar = "\n";     // 标记前一个字符（判断是不是被引号/代码包起来的举例）

    this.maxIndex = 0;             // 上游出现过的最大块 index（避免合成块撞车）
    this.blockIndices = new Set(); // 我们下发过 block-start 的 index（replayState 对齐用）
    this.injectedToolBlocks = 0;   // 本消息里由本模块新增的 tool-call 块数

    // ── markdown 语境（代码围栏 / 行内代码）──
    this.mdFence = null;      // 围栏分隔符，null = 不在围栏里
    this.mdTicks = 0;         // 行内代码的反引号长度，0 = 不在行内代码里
    this.mdPending = "";      // 结尾未判完的符号 run（跨 chunk 拼 ``` 用）
  }

  #dbg(msg) {
    if (this.debug) this.onDebug?.(msg);
  }

  #makeToolId() {
    return "q3fix-" + Math.random().toString(36).slice(2, 10);
  }

  /**
   * 工具名是否可接受。
   *
   * 默认（strictToolList=false）**只做语法校验**：名字由 TOOL_NAME_RE 在 #pump 里把关，
   * 其余一律切出结构化调用 —— 本模块的职责是"把模型写的标记转成调用"，
   * "这个名字在当前模式下能不能被直接调用"是 harness 的策略（PTC 下会回
   * `unknown tool "x": only run_code is callable directly …`，模型据此自我纠正）。
   * 这样也避免把"呈现用的工具表"当成"可执行性"来判，两个概念本来就不同。
   *
   * 配 strictToolList=true 时恢复旧行为：名字必须出现在本次请求的工具表里才切分。
   * @param {string|undefined} name
   */
  #acceptTool(name) {
    if (!name) return true;
    if (!this.cfg.strictToolList) return true;
    if (this.knownTools.size === 0) return true;
    return this.knownTools.has(name);
  }

  /** 标记是否落在代码围栏 / 行内代码里（那里的 <tool_call> 是举例）。 */
  #inCodeContext() {
    if (this.mdFence !== null || this.mdTicks > 0) return true;
    // 扣住的 run 还没判完（标记紧跟在反引号/波浪号后面）：保守当作代码语境。
    return this.mdPending.length > 0;
  }

  /**
   * 跟踪 markdown 代码语境：围栏（连续 3 个及以上反引号或波浪号）与行内代码
   * （等长反引号配对）。判定偏保守 —— 宁可把标记当举例，也不误执行。
   * @param {string} text
   */
  #trackMarkdown(text) {
    const pending = this.mdPending;
    if (!text && !pending) return;
    let s = pending + (text ?? "");
    this.mdPending = "";
    // 结尾的符号 run 可能被下一片延长（``` 常被切成 ` + ``）：
    // 先扣住，等下一片拼齐再判定，否则围栏状态会错乱。
    const tail = /[`~]+$/.exec(s);
    if (tail) {
      this.mdPending = tail[0];
      s = s.slice(0, s.length - tail[0].length);
    }
    this.#scanMarkdown(s);
  }

  /** 扫描一段 run 已完整的文本，更新围栏 / 行内代码状态。 */
  #scanMarkdown(text) {
    if (!text) return;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (ch !== "\u0060" && ch !== "~") continue;
      let j = i;
      while (j < text.length && text[j] === ch) j += 1;
      const run = j - i;
      if (run >= 3) {
        if (this.mdFence === null) this.mdFence = ch.repeat(run);
        else if (this.mdFence[0] === ch && run >= this.mdFence.length) this.mdFence = null;
      } else if (ch === "\u0060" && this.mdFence === null) {
        if (this.mdTicks === 0) this.mdTicks = run;
        else if (this.mdTicks === run) this.mdTicks = 0;
      }
      i = j - 1;
    }
  }

  /** 下一个可用的块 index：始终排在上游已出现的 index 之后，避免撞车覆盖。 */
  #nextIndex() {
    if (!this.sawFirstBlock) return this.curIndex;
    return Math.max(this.curIndex, this.maxIndex) + 1;
  }

  /**
   * 关闭当前块。只有本模块自开的块才补 block-end，且必须带上累积文本
   * （BlockAssembler 以 block-end 的 block 覆盖已流出的 delta）。
   * @param {any[]} out
   */
  #closeCurrent(out) {
    if (this.state === STATE.IDLE || this.state === STATE.PENDING) return;
    const kind = this.state === STATE.THINKING ? "reasoning" : "text";
    if (this.ownBlock) {
      out.push({
        type: "block-end",
        index: this.curIndex,
        block: { type: kind, text: this.curText },
      });
    }
    this.state = STATE.IDLE;
    this.ownBlock = false;
    this.curText = "";
  }

  /**
   * 开一个新块。
   * @param {any[]} out
   * @param {'reasoning'|'text'} kind
   */
  #openBlock(out, kind) {
    if (this.state !== STATE.IDLE && this.state !== STATE.PENDING) this.#closeCurrent(out);
    const index = this.#nextIndex();
    out.push({ type: "block-start", index, blockType: kind });
    this.blockIndices.add(index);
    this.curIndex = index;
    this.sawFirstBlock = true;
    this.ownBlock = true;
    this.curText = "";
    this.state = kind === "reasoning" ? STATE.THINKING : STATE.TEXT;
  }

  /**
   * 把预文本按指定归属落地（开块 + 下发）。
   * @param {any[]} out
   * @param {'reasoning'|'text'} kind
   */
  #landPre(out, kind) {
    const pre = this.pre;
    this.pre = "";
    if (!pre) {
      if (this.state === STATE.PENDING) this.state = STATE.IDLE;
      return;
    }
    if (this.state === STATE.PENDING) this.state = STATE.IDLE;
    this.#emitText(pre, out, kind);
  }

  /**
   * 已定语境下输出一段文本。
   * @param {string} text
   * @param {any[]} out
   * @param {'reasoning'|'text'} [assumeKind]
   */
  #emitText(text, out, assumeKind = "text") {
    if (!text) return;
    if (this.state === STATE.PENDING) {
      this.pre += text;
      this.#landPre(out, assumeKind);
      return;
    }
    if (this.state === STATE.IDLE) this.#openBlock(out, assumeKind);
    if (this.state === STATE.THINKING) {
      this.curText += text;
      out.push({ type: "reasoning-delta", index: this.curIndex, text });
    } else {
      this.curText += text;
      out.push({ type: "text-delta", index: this.curIndex, text });
    }
  }

  /**
   * 普通文本入口：首段（还没出现过 block）延迟为预文本，其余按当前语境下发。
   * @param {string} text
   * @param {any[]} out
   */
  #routeText(text, out) {
    if (!text) return;
    this.#trackMarkdown(text);
    this.prevChar = text.slice(-1);
    if (this.state === STATE.PENDING || (this.state === STATE.IDLE && !this.sawFirstBlock)) {
      this.state = STATE.PENDING;
      this.pre += text;
      return;
    }
    this.#emitText(text, out, this.state === STATE.THINKING ? "reasoning" : "text");
  }

  /** 缓冲区里最早的标记候选位置。 */
  #markerStart(buf) {
    let best = -1;
    for (const p of MARKER_PREFIXES) {
      const i = buf.indexOf(p);
      if (i >= 0 && (best < 0 || i < best)) best = i;
    }
    return best;
  }

  /** 缓冲区末尾有多少字符是标记的"未完成前缀"。 */
  #trailingPrefix(buf) {
    const max = Math.max(TOOL_OPEN.length, CLOSE_THINKING.length) - 1;
    const from = Math.max(0, buf.length - max);
    for (let i = from; i < buf.length; i += 1) {
      const tail = buf.slice(i);
      if (TOOL_OPEN.startsWith(tail) || CLOSE_THINKING.startsWith(tail)) return buf.length - i;
    }
    return 0;
  }

  /** 缓冲区里最早的闭合标记位置。 */
  #closerStart(buf) {
    let best = -1;
    for (const c of TOOL_CLOSERS) {
      const i = buf.indexOf(c);
      if (i >= 0 && (best < 0 || i < best)) best = i;
    }
    return best;
  }

  /** 候选调用在缓冲区里的结束位置（紧跟 </tool_call> / </function> 之后）。 */
  #callCloseEnd(buf) {
    const a = buf.indexOf("</tool_call>");
    const b = buf.indexOf("</function>");
    if (a >= 0 && (b < 0 || a < b)) return a + "</tool_call>".length;
    if (b >= 0) return b + "</function>".length;
    return -1;
  }

  /**
   * 从缓冲开头尝试识别标记（调用方已保证开头就是候选）。
   * @param {string} buf
   * @param {boolean} final
   */
  #matchMarker(buf, final) {
    if (buf.length === 0) return { kind: "none", consumed: 0, rest: "" };

    if (CLOSE_THINKING.startsWith(buf) && buf.length < CLOSE_THINKING.length) {
      return final
        ? { kind: "none", consumed: 0, rest: buf }
        : { kind: "prefix", consumed: 0, rest: buf };
    }
    if (buf.startsWith(CLOSE_THINKING)) {
      return {
        kind: "close-think",
        consumed: CLOSE_THINKING.length,
        rest: buf.slice(CLOSE_THINKING.length),
      };
    }
    if (buf.startsWith("</t")) {
      return { kind: "none", consumed: 0, rest: buf };
    }

    if (TOOL_OPEN.startsWith(buf) && buf.length < TOOL_OPEN.length) {
      return final
        ? { kind: "none", consumed: 0, rest: buf }
        : { kind: "prefix", consumed: 0, rest: buf };
    }
    if (buf.startsWith(TOOL_OPEN)) {
      const raw = buf.slice(TOOL_OPEN.length);
      const lead = /^\s*/.exec(raw)[0];
      const after = raw.slice(lead.length);
      const norm = Boolean(this.cfg.normalizeArguments);
      const keep = norm ? after : raw;
      if (after.length === 0) {
        return final
          ? { kind: "tool-call", consumed: TOOL_OPEN.length, rest: "", shape: "xml" }
          : { kind: "prefix", consumed: 0, rest: buf };
      }
      if (after.startsWith("{")) {
        const name = jsonToolName(after);
        if (name) {
          return { kind: "tool-call", consumed: TOOL_OPEN.length, name, rest: keep, shape: "json" };
        }
        const forming = !final && !after.includes("}") && !after.includes("\n") && after.length <= 40;
        if (forming) return { kind: "prefix", consumed: 0, rest: buf };
        return { kind: "tool-call", consumed: TOOL_OPEN.length, rest: keep, shape: "json" };
      }
      const gt = after.indexOf(">");
      if (gt === -1) {
        if (/^<[^\s>]*$/.test(after)) {
          return final
            ? {
                kind: "tool-call",
                consumed: TOOL_OPEN.length,
                name: FUNCTION_TAG_RE.test(after) ? xmlToolName(after) : undefined,
                rest: keep,
                shape: "xml",
              }
            : { kind: "prefix", consumed: 0, rest: buf };
        }
        return { kind: "tool-call", consumed: TOOL_OPEN.length, rest: keep, shape: "xml" };
      }
      const tag = after.slice(0, gt + 1);
      if (!FUNCTION_TAG_RE.test(tag)) {
        return { kind: "tool-call", consumed: TOOL_OPEN.length, rest: keep, shape: "xml" };
      }
      return {
        kind: "tool-call",
        consumed: TOOL_OPEN.length,
        name: xmlToolName(tag),
        rest: norm ? after.slice(gt + 1) : keep,
        shape: "xml",
      };
    }
    return { kind: "none", consumed: 0, rest: buf };
  }

  /**
   * 候选定案。返回 true = 已处理（cand 已清空），false = 还不到定案时机。
   *
   * 规则：
   *   - 调用没闭合 + final → 否定（按正文，保持"宁可漏"）
   *   - 后面还有正文：
   *       trailingTextPolicy='reject'（默认）→ 否定（引用/举例）
   *       trailingTextPolicy='accept'        → 接受，正文照常下发（排在调用之前）
   *   - 后面只有包装标签/空白 → 只有到了块/流边界才接受；否则继续等
   *     （等后面的正文，好把它判成"引用"）
   *
   * @param {any[]} out
   * @param {boolean} final 流已结束
   * @param {boolean} boundary 块/流的边界（block-end / block-start / finish / flush）
   * @returns {boolean}
   */
  #decideCandidate(out, final, boundary) {
    if (!this.cand) return false;
    const buf = this.candBuf;
    const closeEnd = this.#callCloseEnd(buf);
    if (closeEnd < 0) {
      if (!final) return false;
      this.#rejectCandidate(out, "调用没有闭合");
      return true;
    }
    const call = buf.slice(0, closeEnd);
    let rest = buf.slice(closeEnd);
    // 尾部可能是个还没收全的包装标签（"</t"、"</funct"）：等下一片拼齐再判定，
    // 否则会被当成"调用后面还有正文"而误判为引用。
    const lastLt = rest.lastIndexOf("<");
    const tagTail = lastLt >= 0 ? rest.slice(lastLt) : "";
    const partialTail = tagTail !== "" && !tagTail.includes(">") && PARTIAL_TAG_RE.test(tagTail);
    if (partialTail && !final) return false;
    if (partialTail) rest = rest.slice(0, lastLt); // 流已结束：当截断产物丢弃
    const meaningful = rest.replace(TOOL_WRAPPER_RE, "").trim().length > 0;
    if (meaningful && this.cfg.trailingTextPolicy !== "accept") {
      this.#rejectCandidate(out, "调用后面还有正文，判定为引用/举例");
      return true;
    }
    if (!meaningful && !boundary) return false;
    rest = rest.replace(TRAILING_CLOSERS_RE, "");
    this.#acceptCandidate(call);
    this.cand = null;
    this.candBuf = "";
    this.prevChar = call.slice(-1) || this.prevChar;
    if (rest) this.#pump(rest, out, false);
    return true;
  }

  /** 反复定案，直到没有候选或暂时定不下来。 */
  #resolveAll(out, final, boundary) {
    let guard = 0;
    while (this.cand && this.#decideCandidate(out, final, boundary) && ++guard < 10000) {
      // 继续：接受时 rest 里可能还有下一个调用
    }
  }

  /**
   * 接受一个调用：不动正文流，只把调用原文挂进 pending，等消息末尾统一发射。
   * @param {string} text 从 <tool_call> 到闭合标签的原文
   */
  #acceptCandidate(text) {
    const cand = this.cand;
    this.pending.push({
      name: cand?.name,
      shape: cand?.shape,
      text,
      index: cand?.index,
      own: cand?.own === true,
    });
    this.accepted.push(text);
    if (cand && !cand.own) this.diverted.add(cand.index);
    this.#dbg("候选工具调用已接受（延迟到消息末尾发射）name=" + (cand?.name || "?") + " index=" + cand?.index);
  }

  /**
   * 否定候选：整段（含标记）按普通文本下发。注意**不能**重走 #pump —— 那会再次
   * 命中同一个标记、无限循环。
   * @param {any[]} out
   * @param {string} why
   */
  #rejectCandidate(out, why) {
    const buf = this.candBuf;
    this.cand = null;
    this.candBuf = "";
    this.#dbg("候选工具调用被否（" + why + "），按正文处理");
    this.#routeText(buf, out);
  }

  /**
   * 把一个已接受的调用原文解析成 { name, argsText }。
   * @param {{ name?: string, shape?: string, text: string }} call
   */
  #parseCall(call) {
    const name = call.name;
    const text = String(call.text ?? "");
    if (!this.cfg.normalizeArguments) return { name, argsText: text };
    const body0 = text.startsWith(TOOL_OPEN) ? text.slice(TOOL_OPEN.length) : text;
    if (call.shape === "json") {
      const i = this.#closerStart(body0);
      const body = (i >= 0 ? body0.slice(0, i) : body0).trim();
      if (!body) return { name, argsText: "{}" };
      const args = jsonArguments(body);
      return { name, argsText: args === undefined ? body : args };
    }
    let body = body0.replace(/^\s+/, "");
    const tag = FUNCTION_TAG_RE.exec(body);
    if (tag) body = body.slice(tag[0].length);
    const ci = this.#closerStart(body);
    if (ci >= 0) body = body.slice(0, ci);
    const trimmed = body.trim();
    if (!trimmed) return { name, argsText: "{}" };
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return { name, argsText: trimmed };
    const obj = xmlParameters(body);
    if (obj) return { name, argsText: JSON.stringify(obj) };
    return { name, argsText: trimmed };
  }

  /**
   * 在消息末尾发射所有挂起的调用（排在全部正文之后）。
   * @param {any[]} out
   */
  #emitPending(out) {
    if (this.pending.length === 0) return;
    const calls = this.pending;
    this.pending = [];
    for (const call of calls) {
      const { name, argsText } = this.#parseCall(call);
      const index = this.#nextIndex();
      const id = this.#makeToolId();
      out.push({ type: "block-start", index, blockType: "tool-call" });
      out.push({
        type: "tool-call-delta",
        index,
        id,
        ...name === undefined ? {} : { name },
        argumentsDelta: argsText,
      });
      this.blockIndices.add(index);
      this.curIndex = index;
      this.sawFirstBlock = true;
      this.ownBlock = false;
      this.curText = "";
      this.state = STATE.IDLE;
      this.injectedToolBlocks += 1;
      this.#dbg("发射延迟工具调用 index=" + index + " name=" + (name || "?"));
    }
  }

  /**
   * 清洗上游 block-end 塞回来的原文：只删掉**已接受**的调用原文（及其紧跟的包装
   * 闭合标签），这样被否定的"引用"仍原样留在正文里。
   * @param {string} raw
   */
  #cleanBlockText(raw) {
    let out = String(raw ?? "");
    let changed = false;
    for (const call of this.accepted) {
      const i = out.indexOf(call);
      if (i < 0) continue;
      let end = i + call.length;
      const m = TRAILING_CLOSERS_RE.exec(out.slice(end));
      if (m) end += m[0].length;
      out = out.slice(0, i) + out.slice(end);
      changed = true;
    }
    if (!changed) out = stripToolSegments(out);
    return out;
  }

  /**
   * 注入工具块后，把适配器的 replayState.blocks 补齐到与消息内容对齐（保住
   * thinking signature，避免 INVALID_REPLAY_STATE 降级）。对不齐就原样透传。
   * @param {any} chunk
   */
  #realignReplay(chunk) {
    if (!this.cfg.realignReplayState) return chunk;
    if (this.injectedToolBlocks === 0) return chunk;
    const env = chunk?.replayState;
    if (!env || !Array.isArray(env.blocks)) return chunk;
    const expected = this.blockIndices.size - this.injectedToolBlocks;
    if (env.blocks.length !== expected) return chunk;
    const blocks = [...env.blocks];
    for (let i = 0; i < this.injectedToolBlocks; i += 1) blocks.push({ type: "tool-call" });
    this.#dbg("replayState 已补齐 " + this.injectedToolBlocks + " 个 tool-call 条目");
    return { ...chunk, replayState: { ...env, blocks } };
  }

  /**
   * 消化一段文本：路由普通文本 + 处理标记。
   * @param {string} text
   * @param {any[]} out
   * @param {boolean} final
   */
  #pump(text, out, final) {
    let buf = this.lookahead + text;
    this.lookahead = "";
    while (buf.length > 0) {
      const start = this.#markerStart(buf);
      if (start < 0) {
        const hold = final ? 0 : this.#trailingPrefix(buf);
        const cut = buf.length - hold;
        if (cut > 0) this.#routeText(buf.slice(0, cut), out);
        this.lookahead = hold > 0 ? buf.slice(cut) : "";
        return;
      }
      if (start > 0) {
        this.#routeText(buf.slice(0, start), out);
        buf = buf.slice(start);
      }

      const m = this.#matchMarker(buf, final);

      if (m.kind === "prefix") {
        this.lookahead = buf;
        return;
      }

      if (m.kind === "close-think") {
        this.#onCloseThinking(out);
        buf = m.rest;
        continue;
      }

      if (m.kind === "tool-call") {
        const named = typeof m.name === "string" && TOOL_NAME_RE.test(m.name);
        const quoted = this.prevChar === "\u0060" || this.prevChar === '"' || this.prevChar === "'";
        const inCode = this.#inCodeContext();
        if (!(this.cfg.splitOnToolCall && named && !quoted && !inCode && this.#acceptTool(m.name))) {
          const why = [];
          if (!this.cfg.splitOnToolCall) why.push("splitOnToolCall=false");
          if (!named) why.push("名字缺失或非法（服务端只接受 [A-Za-z0-9_-]{1,64}）");
          if (quoted) why.push("前面是引号/反引号，像举例");
          if (inCode) why.push("在代码围栏/行内代码里，像举例");
          if (named && !this.#acceptTool(m.name)) why.push("不在本次请求的工具表里（strictToolList=true 时按此拒绝；默认 false 会切出来交给 harness 判定）");
          this.#dbg("不切分 tool-call：name=" + JSON.stringify(m.name ?? null) + "（" + why.join("；") + "）");
          // 注意：必须原样发出"被标记匹配吃掉的那一段"，不能只发 TOOL_OPEN ——
          // m.rest 里已经剥掉了 <function=name> 头（normalizeArguments=true 时），
          // 只发 TOOL_OPEN 会把标签本身吞掉，正文被改花（0.2.7 修复）。
          const consumed = buf.length - m.rest.length;
          this.#routeText(consumed > 0 ? buf.slice(0, consumed) : TOOL_OPEN, out);
          buf = m.rest;
          continue;
        }
        if (this.knownTools.size > 0 && !this.knownTools.has(m.name)) {
          this.#dbg("工具名 " + JSON.stringify(m.name) + " 不在本次请求的工具表里；仍切出调用，交给 harness 判定可执行性");
        }
        // 扣住候选：不在这里发射，等块/流边界定案，再等消息末尾统一发射
        this.cand = {
          name: m.name,
          shape: m.shape,
          index: this.curIndex,
          own: this.ownBlock,
        };
        this.candBuf = buf;
        return;
      }

      // kind === 'none'：候选不成立
      if (final) {
        this.#routeText(buf, out);
        buf = "";
      } else {
        this.#routeText(buf.slice(0, 1), out);
        buf = buf.slice(1);
      }
    }
  }

  /**
   * </thinking> 处理：预文本归 reasoning、按配置决定是否剥离标签、结束思考块。
   * @param {any[]} out
   */
  #onCloseThinking(out) {
    if (this.state === STATE.PENDING) {
      this.state = STATE.IDLE;
      if (this.pre) {
        this.#openBlock(out, "reasoning");
        this.#emitText(this.pre, out, "reasoning");
        this.pre = "";
      }
    }
    if (!this.cfg.stripThinkingTags) {
      if (this.state === STATE.THINKING) {
        this.curText += CLOSE_THINKING;
        out.push({ type: "reasoning-delta", index: this.curIndex, text: CLOSE_THINKING });
      } else {
        this.#emitText(CLOSE_THINKING, out, "text");
      }
    }
    if (this.state === STATE.THINKING) this.#closeCurrent(out);
  }

  /** 状态复位（异常降级用）。 */
  #reset() {
    this.lookahead = "";
    this.pre = "";
    this.cand = null;
    this.candBuf = "";
    this.pending = [];
    this.accepted = [];
    this.diverted.clear();
    this.state = STATE.IDLE;
    this.ownBlock = false;
    this.curText = "";
    this.mdFence = null;
    this.mdTicks = 0;
    this.mdPending = "";
  }

  /**
   * 主入口：吃掉一个上游 chunk，返回需要下发的 chunk 数组。
   * @param {any} chunk
   * @returns {any[]}
   */
  feed(chunk) {
    if (!this.cfg.enabled) return [chunk];
    if (!chunk || typeof chunk !== "object") return [chunk];
    try {
      const out = [];
      if (typeof chunk.index === "number" && Number.isFinite(chunk.index)) {
        this.maxIndex = Math.max(this.maxIndex, chunk.index);
      }
      const texty = chunk.type === "text-delta"
        || (chunk.type === "reasoning-delta" && this.cfg.splitInReasoning && typeof chunk.text === "string");

      if (this.cand) {
        if (texty) {
          this.candBuf += chunk.text;
          this.#resolveAll(out, false, false);
          return out;
        }
        // 块/流边界：定案（闭合且后面干净 → 接受；否则按策略）
        this.#resolveAll(out, chunk.type === "finish" || chunk.type === "usage", true);
      }

      if (chunk.type !== "text-delta") {
        if (chunk.type === "reasoning-delta" && typeof chunk.text === "string") {
          if (!this.cfg.splitInReasoning) {
            if (/<tool_call>/.test(chunk.text)) {
              this.#dbg("reasoning 里出现 <tool_call>，若确认是真实调用请打开 splitInReasoning");
            }
            return [chunk];
          }
          if (this.state !== STATE.TOOL) {
            if (typeof chunk.index === "number") this.curIndex = chunk.index;
            this.state = STATE.THINKING;
            this.ownBlock = false;
            this.sawFirstBlock = true;
          }
          this.#pump(chunk.text, out, false);
          this.#resolveAll(out, false, false);
          return out;
        }
        if (chunk.type === "block-start") {
          if (this.state === STATE.PENDING && this.pre) {
            const kind = chunk.blockType === "reasoning" ? "reasoning" : "text";
            this.state = STATE.IDLE;
            this.#openBlock(out, kind);
            this.#emitText(this.pre, out, kind);
            this.pre = "";
            this.#closeCurrent(out);
          }
          this.state = chunk.blockType === "reasoning"
            ? STATE.THINKING
            : chunk.blockType === "tool-call" ? STATE.TOOL : STATE.TEXT;
          this.curIndex = chunk.index;
          if (chunk.blockType === "tool-call" && !this.curId) this.curId = this.#makeToolId();
          this.ownBlock = false;
          this.curText = "";
          this.sawFirstBlock = true;
          this.blockIndices.add(chunk.index);
          out.push(chunk);
          return out;
        }
        if (chunk.type === "block-end") {
          if (this.state === STATE.PENDING && this.pre) {
            const kind = chunk.block?.type === "reasoning" ? "reasoning" : "text";
            this.state = STATE.IDLE;
            this.#openBlock(out, kind);
            this.#emitText(this.pre, out, kind);
            this.pre = "";
            this.#closeCurrent(out);
          }
          if (chunk.index === this.curIndex && this.state !== STATE.IDLE && this.state !== STATE.PENDING) {
            this.state = STATE.IDLE;
            this.ownBlock = false;
            this.curText = "";
          }
          // 该块的原文本被我们抽走当工具调用：只删已接受的调用原文，
          // 否则 block-end 的覆盖语义会把 <tool_call> 原文复活成正文。
          let outChunk = chunk;
          if (this.diverted.has(chunk.index)) {
            this.diverted.delete(chunk.index);
            const raw = typeof chunk.block?.text === "string" ? chunk.block.text : "";
            const cleaned = this.#cleanBlockText(raw);
            if (cleaned !== raw) {
              outChunk = { ...chunk, block: { ...chunk.block, text: cleaned } };
              this.#dbg("block-end 原文里的工具段已剥离 index=" + chunk.index);
            }
          }
          out.push(outChunk);
          return out;
        }
        if (chunk.type === "finish" || chunk.type === "usage") {
          const flushed = this.flush();
          const terminal = chunk.type === "finish" ? this.#realignReplay(chunk) : chunk;
          return [...flushed, terminal];
        }
        return [chunk];
      }

      // ── text-delta：核心处理路径 ──
      if (typeof chunk.text !== "string") return [chunk];
      this.#pump(chunk.text, out, false);
      this.#resolveAll(out, false, false);
      return out;
    } catch {
      this.#reset();
      return [chunk];
    }
  }

  /**
   * 流结束时调用：定案最后的候选，吐出缓冲文本，关掉自开块，最后发射挂起的工具调用。
   * @returns {any[]}
   */
  flush() {
    if (!this.cfg.enabled) return [];
    try {
      const out = [];
      this.#resolveAll(out, true, true);

      const tail = this.lookahead;
      this.lookahead = "";
      if (tail) {
        this.#pump(tail, out, true);
        this.#resolveAll(out, true, true);
      }

      // 预文本归属：有工具调用要发射 → 隐式推理结束，归 reasoning；否则安全降级归正文
      const kind = this.pending.length > 0 || this.state === STATE.THINKING ? "reasoning" : "text";
      const leftover = this.pre + this.lookahead;
      this.pre = "";
      this.lookahead = "";
      if (leftover) this.#emitText(leftover, out, kind);

      // 工具块必须排在正文之后：先关闭当前块，再发射
      this.#closeCurrent(out);
      this.#emitPending(out);
      return out;
    } catch {
      this.#reset();
      return [];
    }
  }
}
