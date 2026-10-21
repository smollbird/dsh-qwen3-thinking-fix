// 端到端回归：把 chunk 流喂过 llm/stream 处理器，再用一个"最小 BlockAssembler"
// 复刻 DSH 的组装语义，断言最终 assistant 消息里**工具调用块之后没有 text/reasoning 块**
// —— 这正是 DeepSeek Messages 端点会 400 的形状（0.2.5 的核心修复）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";

const L = String.fromCharCode(10);

/** 最小 BlockAssembler：首次出现定序；block-end 的 block 覆盖已流出的 delta。 */
class MiniAssembler {
  constructor() {
    this.partials = new Map();
    this.order = [];
  }
  ensure(index, blockType) {
    let p = this.partials.get(index);
    if (!p) {
      p = { blockType, text: "", args: "", id: undefined, name: undefined };
      this.partials.set(index, p);
      this.order.push(index);
    }
    return p;
  }
  push(c) {
    if (c.type === "block-start") {
      if (!this.partials.has(c.index)) {
        this.order.push(c.index);
        this.partials.set(c.index, { blockType: c.blockType, text: "", args: "", id: undefined, name: undefined });
      }
      return;
    }
    if (c.type === "text-delta" || c.type === "reasoning-delta") {
      const p = this.ensure(c.index, c.type === "text-delta" ? "text" : "reasoning");
      if (p.block) return;
      p.text += c.text;
      return;
    }
    if (c.type === "tool-call-delta") {
      const p = this.ensure(c.index, "tool-call");
      if (p.block) return;
      p.id = c.id;
      if (c.name) p.name = c.name;
      p.args += c.argumentsDelta;
      return;
    }
    if (c.type === "block-end") {
      const p = this.ensure(c.index, c.block.type);
      if (!p.block) p.block = c.block;
    }
  }
  blocks() {
    return this.order.map((index) => {
      const p = this.partials.get(index);
      if (p.block) return p.block;
      if (p.blockType === "text") return { type: "text", text: p.text };
      if (p.blockType === "reasoning") return { type: "reasoning", text: p.text };
      return { type: "tool-call", id: p.id ?? "call-" + index, name: p.name ?? "", arguments: p.args };
    });
  }
}

/** 把 chunk 流喂过 apply() 装出来的 llm/stream 处理器，返回产出的 chunk 与组装后的消息。 */
async function pipe(chunks, config = {}, options = {}) {
  const handlers = new Map();
  apply({ on: (e, h) => handlers.set(e, h), logger: { info: () => {} } }, config);
  async function* upstream() {
    for (const c of chunks) yield c;
  }
  const out = [];
  for await (const c of handlers.get("llm/stream")({ model: "Qwen3-32B", tools: [{ name: "edit" }, { name: "weather" }], ...options }, () => upstream())) {
    out.push(c);
  }
  const asm = new MiniAssembler();
  for (const c of out) asm.push(c);
  return { out, blocks: asm.blocks() };
}

/** 断言：组装后的消息里，工具调用块之后不能还有 text/reasoning 块。 */
function assertNoTextAfterTool(blocks) {
  let sawTool = false;
  for (const b of blocks) {
    if (b.type === "tool-call") sawTool = true;
    else assert.ok(!sawTool, "工具调用块之后不能再有 " + b.type + " 块");
  }
}

const EDIT_CALL =
  "<tool_call>" + L +
  "<function=edit>" + L +
  "<parameter=file_path>" + L +
  "/Users/houshichao/work/uaienergyanalysis/src/core/space/eaboundary.js" + L +
  "</parameter>" + L +
  "<parameter=old_string>" + L +
  "        'inRegion', !!(this._getRegion?.() && this._getRegion()._xaIsHaving?.(this)));" + L +
  "</parameter>" + L +
  "<parameter=new_string>" + L +
  "        'inRegion', !!(this._getRegion?.()?._getItemsByType?.(UVita.EABoundary.type)?._xaIsHaving?.(this)));" + L +
  "</parameter>" + L +
  "</function>" + L +
  "</tool_call>";

test("端到端-A：真实事故形状（正文引用 <tool_call> + 后面还有正文）不再毒化会话", async () => {
  const text = "我的写法是 " + '"' + "<tool_call>" + L + "<function=edit>{}" + L + "</function>" + L + "</tool_call>" + L + " 这就是你之前停掉的写法。";
  const { blocks } = await pipe([
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: text.slice(0, 30) },
    { type: "text-delta", index: 0, text: text.slice(30) },
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "finish", reason: { kind: "stop" } },
  ]);
  assertNoTextAfterTool(blocks);
  assert.ok(!blocks.some((b) => b.type === "tool-call"), "引用不该被当成真调用（默认 reject）");
});

test("端到端-B：真实工单（调用在消息末尾，多行 <parameter>）仍然正常执行", async () => {
  const head = "Now, I'll apply the edits using the proper edit tool." + L + "The previous edits didn't apply — applying them now:" + L + L;
  const text = head + EDIT_CALL;
  const { blocks } = await pipe([
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: text.slice(0, 120) },
    { type: "text-delta", index: 0, text: text.slice(120) },
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "finish", reason: { kind: "stop" } },
  ]);
  assertNoTextAfterTool(blocks);
  const calls = blocks.filter((b) => b.type === "tool-call");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "edit");
  assert.deepEqual(JSON.parse(calls[0].arguments), {
    file_path: "/Users/houshichao/work/uaienergyanalysis/src/core/space/eaboundary.js",
    old_string: "        'inRegion', !!(this._getRegion?.() && this._getRegion()._xaIsHaving?.(this)));",
    new_string: "        'inRegion', !!(this._getRegion?.()?._getItemsByType?.(UVita.EABoundary.type)?._xaIsHaving?.(this)));",
  });
  assert.equal(blocks[0].type, "text");
  assert.ok(blocks[0].text.startsWith("Now, I'll apply the edits"));
  assert.ok(blocks[blocks.length - 1].type === "tool-call", "工具调用排在最后");
});

test("端到端-C：结构化流（块 0 末尾调用 + 块 1 正文）产出的消息不再触发 400 形状", async () => {
  const a = "先看一下：" + EDIT_CALL;
  const b = "接着补充一句说明。";
  const { blocks } = await pipe([
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: a },
    { type: "block-end", index: 0, block: { type: "text", text: a } },
    { type: "block-start", index: 1, blockType: "text" },
    { type: "text-delta", index: 1, text: b },
    { type: "block-end", index: 1, block: { type: "text", text: b } },
    { type: "finish", reason: { kind: "stop" } },
  ]);
  assertNoTextAfterTool(blocks);
  assert.deepEqual(blocks.map((x) => x.type), ["text", "text", "tool-call"]);
  assert.equal(blocks[0].text, "先看一下：");
  assert.equal(blocks[1].text, b);
  assert.equal(blocks[2].name, "edit");
});

test("端到端-D：reasoning + 调用（隐式推理结束）仍是 reasoning 在前、调用在后", async () => {
  const { blocks } = await pipe([
    { type: "block-start", index: 0, blockType: "reasoning" },
    { type: "reasoning-delta", index: 0, text: "先想一下。" },
    { type: "block-end", index: 0, block: { type: "reasoning", text: "先想一下。" } },
    { type: "text-delta", index: 1, text: EDIT_CALL },
    { type: "finish", reason: { kind: "stop" } },
  ]);
  assertNoTextAfterTool(blocks);
  assert.deepEqual(blocks.map((x) => x.type), ["reasoning", "tool-call"]);
  assert.equal(blocks[1].name, "edit");
});

test("端到端-E：请求里只提供 run_code 时，todo_write 的 XML 也照样切出（可执行性交给 harness）", async () => {
  const text = '<tool_call> <function=todo_write> <parameter=todos> [{"content":"a","status":"pending"}] </parameter> </function> </tool_call>';
  const { blocks } = await pipe([
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "finish", reason: { kind: "stop" } },
  ], {}, { tools: [{ name: "run_code" }] });
  assertNoTextAfterTool(blocks);
  const calls = blocks.filter((b) => b.type === "tool-call");
  assert.equal(calls.length, 1, "插件不按工具表设门槛，照样切出调用");
  assert.equal(calls[0].name, "todo_write");
  assert.deepEqual(JSON.parse(calls[0].arguments).todos, [{ content: "a", status: "pending" }]);
});

