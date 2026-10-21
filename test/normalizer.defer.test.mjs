// 0.2.5 修复回归：毒化形状（tool_use 后面还有正文）、合成块 index 撞车、
// block-end 原文精确清洗、代码语境守卫、延迟发射、replayState 对齐。
import { test } from "node:test";
import assert from "node:assert/strict";
import { Qwen3StreamNormalizer } from "../lib/normalizer.js";

const L = String.fromCharCode(10);
const BT = String.fromCharCode(96); // 反引号

/** 按给定 chunk 序列喂入，收集全部产出（最后 flush）。 */
function runChunks(chunks, opts = {}, config = {}) {
  const n = new Qwen3StreamNormalizer(config, opts);
  const out = [];
  for (const c of chunks) out.push(...n.feed(c));
  out.push(...n.flush());
  return out;
}

/** 按固定宽度切 text-delta。 */
function runText(text, w = 7, opts = {}, config = {}) {
  const n = new Qwen3StreamNormalizer(config, opts);
  const out = [];
  for (let i = 0; i < text.length; i += w) out.push(...n.feed({ type: "text-delta", index: 0, text: text.slice(i, i + w) }));
  out.push(...n.flush());
  return out;
}

const textOf = (out) => out.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
const reasonOf = (out) => out.filter((c) => c.type === "reasoning-delta").map((c) => c.text).join("");
const argsOf = (out) => out.filter((c) => c.type === "tool-call-delta").map((c) => c.argumentsDelta).join("");
const toolStarts = (out) => out.filter((c) => c.type === "block-start" && c.blockType === "tool-call");

/**
 * 复刻 BlockAssembler 的"首次出现即定序"语义，断言：工具调用块出现之后，
 * 不允许再出现任何新的 text/reasoning 块 —— 这正是 DeepSeek Messages 端点
 * 报 "tool_use ids were found without tool_result blocks immediately after" 的形状。
 */
function assertNoTextAfterTool(out) {
  const seen = new Set();
  const order = [];
  const kindOf = new Map();
  for (const c of out) {
    if (typeof c.index !== "number" || seen.has(c.index)) continue;
    let kind;
    if (c.type === "block-start") kind = c.blockType;
    else if (c.type === "text-delta") kind = "text";
    else if (c.type === "reasoning-delta") kind = "reasoning";
    else if (c.type === "tool-call-delta") kind = "tool-call";
    else continue;
    seen.add(c.index);
    order.push(c.index);
    kindOf.set(c.index, kind);
  }
  let sawTool = false;
  for (const index of order) {
    const kind = kindOf.get(index);
    if (kind === "tool-call") sawTool = true;
    else assert.ok(!sawTool, "工具调用块之后不能再有 " + kind + " 块（index=" + index + "）");
  }
}

const XML = '先查天气再决定。<tool_call><function=weather>{"city":"SH"}</function>';

test("0.2.5-1：结构化上游 —— 调用在块 0 末尾、块 1 还有正文，工具块必须排到最后", () => {
  const before = "我看一下。" + XML;
  const after = "好了，已经查完。";
  const out = runChunks([
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: before },
    { type: "block-end", index: 0, block: { type: "text", text: before } },
    { type: "block-start", index: 1, blockType: "text" },
    { type: "text-delta", index: 1, text: after },
    { type: "block-end", index: 1, block: { type: "text", text: after } },
  ], { knownTools: ["weather"] });
  assertNoTextAfterTool(out);
  assert.deepEqual(JSON.parse(argsOf(out)), { city: "SH" });
  assert.equal(textOf(out), "我看一下。先查天气再决定。" + after);
  // block-end 原文只删掉调用本身
  const ends = out.filter((c) => c.type === "block-end");
  assert.equal(ends[0].block.text, "我看一下。先查天气再决定。");
  assert.equal(ends[1].block.text, after);
  const start = toolStarts(out)[0];
  assert.ok(start.index > 1, "合成工具块 index 必须排在上游块之后，实际 " + start.index);
});

test("0.2.5-2：同一块里两个调用（中间夹正文）+ accept 策略 —— 两个调用都排在最后", () => {
  const raw = "先来。" + XML + "中间说明。" + XML;
  const out = runText(raw, 5, { knownTools: ["weather"] }, { trailingTextPolicy: "accept" });
  assertNoTextAfterTool(out);
  assert.equal(toolStarts(out).length, 2);
  const names = out.filter((c) => c.type === "tool-call-delta" && c.name).map((c) => c.name);
  assert.deepEqual(names, ["weather", "weather"]);
  // delta-only 适配器：调用之前的首段文本按"隐式推理结束"归 reasoning（0.2.4 以来的行为）
  assert.ok(reasonOf(out).includes("先来。"), "调用之前的文本保留（reasoning）");
  assert.ok(reasonOf(out).includes("中间说明。"), "调用之间的文本保留（reasoning）");
});

test("0.2.5-3：默认 reject 策略仍把'调用+正文'判为引用（行为不变）", () => {
  const raw = "看这个：" + XML + " 就这样。";
  const out = runText(raw, 4, { knownTools: ["weather"] });
  assert.equal(toolStarts(out).length, 0);
  assert.ok(textOf(out).includes("就这样。"));
});

test("0.2.5-4：代码围栏里的调用不执行（举例）", () => {
  const raw = "写法是这样的：" + L + BT + BT + BT + L + XML + L + BT + BT + BT + L + "记住了吗？";
  for (const w of [1, 5, 23]) {
    const out = runText(raw, w, { knownTools: ["weather"] });
    assert.equal(toolStarts(out).length, 0, "width=" + w + " 围栏里的调用不该执行");
    assert.ok(textOf(out).includes("记住了吗？"), "width=" + w);
  }
});

test("0.2.5-5：行内代码里的调用不执行；围栏闭合后的真调用照切", () => {
  const quoted = "举例：" + BT + XML + BT + "完";
  assert.equal(toolStarts(runText(quoted, 6, { knownTools: ["weather"] })).length, 0);
  const real = BT + BT + BT + L + "示例" + L + BT + BT + BT + L + XML;
  const out = runText(real, 7, { knownTools: ["weather"] });
  assert.equal(toolStarts(out).length, 1, "围栏闭合后的调用应执行");
  assert.deepEqual(JSON.parse(argsOf(out)), { city: "SH" });
  assertNoTextAfterTool(out);
});

test("0.2.5-6：延迟发射 —— 工具块在 flush 时才出现，且 block-end 数量不变", () => {
  const n = new Qwen3StreamNormalizer({}, { knownTools: ["weather"] });
  const mid = [];
  for (const p of XML.match(/[\s\S]{1,6}/g)) mid.push(...n.feed({ type: "text-delta", index: 0, text: p }));
  assert.equal(mid.filter((c) => c.type === "tool-call-delta").length, 0, "流中间不发射工具块");
  const end = n.flush();
  assert.equal(end.filter((c) => c.type === "tool-call-delta").length, 1, "flush 时发射");
  const all = [...mid, ...end];
  assert.equal(all.filter((c) => c.type === "block-end").length, 1);
  assert.equal(reasonOf(all), "先查天气再决定。");
  assertNoTextAfterTool(all);
});

test("0.2.5-7：replayState 被补齐（保住 signature，避免对不齐降级）", () => {
  const n = new Qwen3StreamNormalizer({}, { knownTools: ["weather"] });
  const out = [];
  out.push(...n.feed({ type: "block-start", index: 0, blockType: "text" }));
  out.push(...n.feed({ type: "text-delta", index: 0, text: XML }));
  const finish = { type: "finish", reason: { kind: "stop" }, replayState: { response: { kind: "deepseek-messages" }, blocks: [{ type: "text" }] } };
  out.push(...n.feed(finish));
  const last = out[out.length - 1];
  assert.equal(last.type, "finish");
  assert.equal(last.replayState.blocks.length, 2, "应补一个 tool-call 条目");
  assert.deepEqual(last.replayState.blocks.map((b) => b.type), ["text", "tool-call"]);
  assert.deepEqual(JSON.parse(argsOf(out)), { city: "SH" });
});

test("0.2.5-8：replayState 对不齐时原样透传（不猜）", () => {
  const n = new Qwen3StreamNormalizer({}, { knownTools: ["weather"] });
  const out = [];
  out.push(...n.feed({ type: "block-start", index: 0, blockType: "text" }));
  out.push(...n.feed({ type: "text-delta", index: 0, text: XML }));
  const finish = { type: "finish", reason: { kind: "stop" }, replayState: { blocks: [] } };
  out.push(...n.feed(finish));
  assert.deepEqual(out[out.length - 1].replayState.blocks, []);
});

test("0.2.5-9：上游自己开的 tool-call 块原样透传，不重复开块", () => {
  const out = runChunks([
    { type: "block-start", index: 0, blockType: "tool-call" },
    { type: "tool-call-delta", index: 0, id: "call_1", name: "weather", argumentsDelta: '{"city":"SH"}' },
    { type: "block-end", index: 0, block: { type: "tool-call", id: "call_1", name: "weather", arguments: '{"city":"SH"}' } },
  ], { knownTools: ["weather"] });
  assert.deepEqual(out.map((c) => c.type), ["block-start", "tool-call-delta", "block-end"]);
  assert.equal(out[1].id, "call_1");
});

test("0.2.5-10：调用没闭合（截断）时按正文，绝不建非法调用", () => {
  const raw = "开始：" + '<tool_call><function=weather>{"city":"SH"';
  const out = runText(raw, 5, { knownTools: ["weather"] });
  assert.equal(toolStarts(out).length, 0);
  assert.ok(textOf(out).includes("<tool_call>"), "原文留在正文");
  assertNoTextAfterTool(out);
});

test("0.2.5-11：多行 <parameter> 参数在结构化上游 + 尾部正文下不丢字节", () => {
  const trace = "<tool_call>" + L + "<function=edit>" + L +
    "<parameter=file_path>" + L + "a/b.py" + L + "</parameter>" + L +
    "<parameter=old_string>" + L + "x = 1" + L + "</parameter>" + L +
    "<parameter=new_string>" + L + "x = 2" + L + "</parameter>" + L +
    "</function>" + L + "</tool_call>";
  const tail = "改完了。";
  const out = runChunks([
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: "动手：" + trace },
    { type: "block-end", index: 0, block: { type: "text", text: "动手：" + trace } },
    { type: "block-start", index: 1, blockType: "text" },
    { type: "text-delta", index: 1, text: tail },
    { type: "block-end", index: 1, block: { type: "text", text: tail } },
  ], { knownTools: ["edit"] });
  assertNoTextAfterTool(out);
  assert.deepEqual(JSON.parse(argsOf(out)), { file_path: "a/b.py", old_string: "x = 1", new_string: "x = 2" });
  assert.equal(textOf(out), "动手：" + tail);
  assert.equal(out.filter((c) => c.type === "block-end")[0].block.text, "动手：");
});

test("0.2.5-12：一个块里被否定的引用 + 另一个块里被接受的调用（清洗精确到调用）", () => {
  const quoted = "看：" + XML + " 后面还有话";
  const real = "真调用：" + XML;
  const out = runChunks([
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: quoted },
    { type: "block-end", index: 0, block: { type: "text", text: quoted } },
    { type: "block-start", index: 1, blockType: "text" },
    { type: "text-delta", index: 1, text: real },
    { type: "block-end", index: 1, block: { type: "text", text: real } },
  ], { knownTools: ["weather"] });
  assertNoTextAfterTool(out);
  assert.equal(toolStarts(out).length, 1, "只有块 1 的调用被执行");
  const ends = out.filter((c) => c.type === "block-end");
  assert.ok(ends[0].block.text.includes("<tool_call>"), "被否定的引用原文原样保留");
  assert.equal(ends[1].block.text, "真调用：先查天气再决定。", "被接受的调用从原文里精确删除（只删调用本身）");
  assert.equal(textOf(out), quoted + "真调用：先查天气再决定。");
});

test("0.2.6-1：代码围栏被 chunk 切开时，围栏之后的真实调用仍要执行", () => {
  const raw = "看这段：" + L + BT + BT + BT + L + "<tool_call><function=read><parameter=file_path>a.json</parameter></tool_call>" + L + BT + BT + BT + L + "就这样。" + L + L + "<tool_call><function=read><parameter=file_path>b.json</parameter></tool_call>";
  for (const w of [1, 2, 3, 4, 7]) {
    const out = runText(raw, w, { knownTools: ["read"] });
    const calls = out.filter((c) => c.type === "tool-call-delta");
    assert.equal(calls.length, 1, "width=" + w + " 只应执行围栏之外那一个调用");
    assert.equal(JSON.parse(calls[0].argumentsDelta).file_path, "b.json", "width=" + w);
    assertNoTextAfterTool(out);
  }
});

test("0.2.6-2：围栏内的调用在任何切分粒度下都不执行（围栏开合跨 chunk）", () => {
  const raw = "示例：" + L + BT + BT + BT + L + "<tool_call><function=read><parameter=file_path>a.json</parameter></tool_call>" + L + BT + BT + BT + L + "结束";
  for (const w of [1, 2, 3, 5]) {
    const out = runText(raw, w, { knownTools: ["read"] });
    assert.equal(out.filter((c) => c.type === "tool-call-delta").length, 0, "width=" + w + " 围栏内不该执行");
    assert.ok(textOf(out).includes("结束"), "width=" + w);
  }
});


test("0.2.7-1：名字不在白名单而拒绝切分时，正文必须逐字节保留（不能吃掉 <function=…> 标签）", () => {
  const raw = "<tool_call><function=read><parameter=file_path>a.json</parameter></tool_call>";
  for (const w of [1, 3, 5, 9]) {
    const out = runText(raw, w, { knownTools: ["run_code"] }, { strictToolList: true });
    assert.equal(out.filter((c) => c.type === "tool-call-delta").length, 0, "width=" + w + " 不该执行");
    assert.equal(textOf(out), raw, "width=" + w + " 正文必须与模型原文一致");
  }
});


test("0.2.8-1：标签之间带空格的形态（真机 todo_write 原文）在任意切分下都切得出来", () => {
  const raw = "Considering the limited time, I have to give the solution now." + L + L +
    '<tool_call> <function=todo_write> <parameter=todos> [{"content": "a", "status": "in_progress"}, {"content": "b", "status": "pending"}] </parameter> </function> </tool_call>';
  for (const w of [1, 2, 4, 9, 40]) {
    const out = runText(raw, w, { knownTools: ["todo_write"] });
    const calls = out.filter((c) => c.type === "tool-call-delta");
    assert.equal(calls.length, 1, "width=" + w);
    assert.equal(calls[0].name, "todo_write", "width=" + w);
    const args = JSON.parse(calls[0].argumentsDelta);
    assert.ok(Array.isArray(args.todos), "width=" + w + " todos 必须是数组");
    assert.deepEqual(args.todos, [{ content: "a", status: "in_progress" }, { content: "b", status: "pending" }], "width=" + w);
    // delta-only 流：调用之前的首段文本按"隐式推理结束"归 reasoning（0.2.x 既有行为）
    assert.ok((reasonOf(out) + textOf(out)).includes("Considering the limited time"), "width=" + w + " 前置文本保留");
    assertNoTextAfterTool(out);
  }
  // 默认：名字不在工具表里也照样切出来，能不能执行交给 harness（PTC 会回 UNKNOWN_TOOL 指路）
  const lax = runText(raw, 7, { knownTools: ["run_code"] });
  assert.equal(lax.filter((c) => c.type === "tool-call-delta").length, 1, "默认应切出调用");
  // strictToolList=true 时恢复旧行为：整段按正文，且逐字节保留
  const refused = runText(raw, 7, { knownTools: ["run_code"] }, { strictToolList: true });
  assert.equal(refused.filter((c) => c.type === "tool-call-delta").length, 0, "strict 下不该执行");
  assert.equal(textOf(refused), raw, "拒绝时正文必须逐字节保留");
});


test("0.2.9-1：strictToolList 拒绝时，原因里要写明「不在本次请求的工具表里」", () => {
  const logs = [];
  const n = new Qwen3StreamNormalizer({ strictToolList: true }, { knownTools: ["run_code"], debug: true, onDebug: (m) => logs.push(m) });
  const raw = '<tool_call> <function=todo_write> <parameter=todos> [{"content":"a","status":"pending"}] </parameter> </function> </tool_call>';
  const out = [];
  for (let i = 0; i < raw.length; i += 5) out.push(...n.feed({ type: "text-delta", index: 0, text: raw.slice(i, i + 5) }));
  out.push(...n.flush());
  assert.equal(out.filter((c) => c.type === "tool-call-delta").length, 0, "不该执行");
  assert.ok(logs.some((m) => m.includes("工具表")), "拒绝原因应说明不在工具表里：" + JSON.stringify(logs));
  assert.equal(out.filter((c) => c.type === "text-delta").map((c) => c.text).join(""), raw, "正文逐字节保留");
});

