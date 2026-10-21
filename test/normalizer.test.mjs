import { test } from "node:test";
import assert from "node:assert/strict";
import { Qwen3StreamNormalizer, looksLikeMarkerPrefix } from "../lib/normalizer.js";
import { modelMatches } from "../lib/index.js";

/** 把一串文本切成固定宽度的 text-delta chunk 流喂给 normalizer，收集产出。 */
function feedText(chunks, width = 7) {
  const n = new Qwen3StreamNormalizer({}, { knownTools: [] });
  const out = [];
  const texts = Array.isArray(chunks) ? chunks : splitEvery(chunks, width);
  for (const t of texts) {
    out.push(...n.feed({ type: "text-delta", index: 0, text: t }));
  }
  out.push(...n.flush());
  return out;
}

function splitEvery(s, w) {
  const a = [];
  for (let i = 0; i < s.length; i += w) a.push(s.slice(i, i + w));
  return a;
}

const types = (out) => out.map((c) => c.type);

test("场景1：正常闭合 —— </thinking> 后跟正文产生 reasoning 段 + text 段，无 tool 切分", () => {
  const raw = "我需要搜索一下。</thinking>答案是 42。";
  const out = feedText(raw, 5);
  // </thinking> 被剥离，其后内容是普通 text
  const texts = out.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
  const reasons = out.filter((c) => c.type === "reasoning-delta").map((c) => c.text).join("");
  assert.equal(reasons, "我需要搜索一下。");
  assert.equal(texts, "答案是 42。");
  assert.ok(!texts.includes("</thinking>"));
});

test("场景2（目标）：隐式结束 —— 无 </thinking> 直接 <tool_call> 切出 tool-call 块", () => {
  const raw = "先查天气再决定。<tool_call><function=weather>{\"city\":\"SH\"}</function>";
  const out = feedText(raw, 6);
  assert.ok(types(out).includes("block-start"), "应有 block-start");
  const starts = out.filter((c) => c.type === "block-start");
  assert.ok(starts.some((c) => c.blockType === "tool-call"), "应切出 tool-call block-start");
  const toolDeltas = out.filter((c) => c.type === "tool-call-delta");
  assert.ok(toolDeltas.length > 0, "应有 tool-call-delta");
  const joined = toolDeltas.map((c) => c.argumentsDelta).join("");
  assert.deepEqual(JSON.parse(joined), { city: "SH" }, "arguments 应是可解析的 JSON 参数体");
  // 思考文本保留在 reasoning-delta
  const reason = out.filter((c) => c.type === "reasoning-delta").map((c) => c.text).join("");
  assert.ok(reason.includes("先查天气再决定"));
});

test("场景3：纯工具调用 —— 开头即 <tool_call> 直接进 TOOL，无 reasoning", () => {
  const raw = "<tool_call><function=bash>{\"cmd\":\"ls\"}</function>";
  const out = feedText(raw, 4);
  assert.ok(!types(out).includes("reasoning-delta"), "不应有 reasoning-delta");
  const starts = out.filter((c) => c.type === "block-start");
  assert.ok(starts.some((c) => c.blockType === "tool-call"));
  const toolDeltas = out.filter((c) => c.type === "tool-call-delta");
  const joined = toolDeltas.map((c) => c.argumentsDelta).join("");
  assert.deepEqual(JSON.parse(joined), { cmd: "ls" }, "arguments 应是可解析的 JSON 参数体");
});

test("场景4：跨 chunk 标记分割 —— <tool_call> 被拆到多个 chunk 仍能识别", () => {
  for (const pieces of [["<", "tool_call", "><fun", "ction=bash>{}</function>"], ["<tool", "_call><fun", "ction=bash>{}</fun", "ction>"], ["</thi", "nking>after"]]) {
    const n = new Qwen3StreamNormalizer({}, { knownTools: [] });
    const out = [];
    for (const p of pieces) {
      out.push(...n.feed({ type: "text-delta", index: 0, text: p }));
    }
    out.push(...n.flush());
    if (pieces[0].startsWith("</thi")) {
      const text = out.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
      assert.equal(text, "after");
    } else {
      assert.ok(
        out.some((c) => c.type === "block-start" && c.blockType === "tool-call"),
        "pieces=" + JSON.stringify(pieces) + " 应切出 tool-call",
      );
    }
  }
});

test("场景5：流结束仍在 THINKING（无闭合无工具）—— flush 关闭块（安全降级）", () => {
  const n = new Qwen3StreamNormalizer({}, {});
  const out = [];
  out.push(...n.feed({ type: "text-delta", index: 0, text: "思考中但没结束" }));
  out.push(...n.flush());
  assert.ok(types(out).includes("block-end"), "flush 应补 block-end");
});

test("场景6：结构化上游（已有 block-start/reasoning-delta）原样跟随，不重复开块", () => {
  const n = new Qwen3StreamNormalizer({}, {});
  const out = [];
  out.push(...n.feed({ type: "block-start", index: 2, blockType: "reasoning" }));
  out.push(...n.feed({ type: "reasoning-delta", index: 2, text: "hi" }));
  out.push(...n.feed({ type: "block-end", index: 2, block: { type: "reasoning", text: "hi" } }));
  assert.deepEqual(types(out), ["block-start", "reasoning-delta", "block-end"]);
  assert.equal(out[0].index, 2);
});

test("场景7：不在工具表里的名字默认也切出调用（可执行性交给 harness）；strictToolList=true 时恢复不切分", () => {
  const call = '<tool_call><function=unknown>{"a":1}</function></tool_call>';
  const run = (config, opts) => {
    const n = new Qwen3StreamNormalizer(config, opts);
    const out = [];
    for (let i = 0; i < call.length; i += 5) out.push(...n.feed({ type: "text-delta", index: 0, text: call.slice(i, i + 5) }));
    out.push(...n.flush());
    return out;
  };
  const lax = run({}, { knownTools: ["weather"] });
  const laxArgs = lax.filter((c) => c.type === "tool-call-delta").map((c) => c.argumentsDelta).join("");
  assert.deepEqual(JSON.parse(laxArgs), { a: 1 }, "默认应切出调用，让 harness 去判可执行性");
  const strict = run({ strictToolList: true }, { knownTools: ["weather"] });
  assert.ok(!types(strict).includes("tool-call-delta"), "strict 模式仍不切分");
  assert.equal(strict.filter((c) => c.type === "text-delta").map((c) => c.text).join(""), call, "strict 拒绝时正文逐字节保留");
});

test("场景8：enabled=false 纯透传", () => {
  const n = new Qwen3StreamNormalizer({ enabled: false }, {});
  const chunk = { type: "text-delta", index: 0, text: "abc" };
  assert.deepEqual(n.feed(chunk), [chunk]);
  assert.deepEqual(n.flush(), []);
});

test("modelMatches：默认模式命中 qwen3 系，不命中其他", () => {
  assert.ok(modelMatches("qwen3-32b", ["qwen3", "Qwen3"]));
  assert.ok(modelMatches("Qwen3-Coder-30B", ["qwen3"]));
  assert.ok(!modelMatches("deepseek-v4-flash", ["qwen3"]));
  assert.ok(!modelMatches("gpt-5.2", ["qwen3"]));
  assert.ok(!modelMatches(undefined, ["qwen3"]));
});

test("looksLikeMarkerPrefix：前缀判定", () => {
  assert.ok(looksLikeMarkerPrefix("<"));
  assert.ok(looksLikeMarkerPrefix("<tool"));
  assert.ok(looksLikeMarkerPrefix("</t"));
  assert.ok(!looksLikeMarkerPrefix("hello"));
  assert.ok(!looksLikeMarkerPrefix("<xyzabc>"));
});
