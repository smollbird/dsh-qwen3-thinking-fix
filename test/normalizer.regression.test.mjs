// 回归测试：覆盖 lib/normalizer.js 修复过的具体缺陷（参数规范化 / JSON 形态 /
// 任意切分宽度 / 块后包装残留 / flush 后的标记识别 / 结构化上游不被伪 block-end
// 覆盖 / 日志兜底）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { Qwen3StreamNormalizer } from "../lib/normalizer.js";
import { apply } from "../lib/index.js";

/** 按给定片段喂 text-delta，收集全部产出。 */
function run(pieces, opts = {}, config = {}) {
  const n = new Qwen3StreamNormalizer(config, opts);
  const out = [];
  for (const p of pieces) out.push(...n.feed({ type: "text-delta", index: 0, text: p }));
  out.push(...n.flush());
  return out;
}

function split(s, w) {
  const a = [];
  for (let i = 0; i < s.length; i += w) a.push(s.slice(i, i + w));
  return a;
}

const joinOf = (out, type, field) =>
  out.filter((c) => c.type === type).map((c) => c[field]).join("");

const argsOf = (out) => joinOf(out, "tool-call-delta", "argumentsDelta");
const textOf = (out) => joinOf(out, "text-delta", "text");
const reasonOf = (out) => joinOf(out, "reasoning-delta", "text");

const XML = '先查天气再决定。<tool_call><function=weather>{"city":"SH"}</function>';
const JSON_FORM = '想想。<tool_call>{"name": "get_weather", "arguments": {"city": "SH"}}</tool_call>';

test("回归1：任意切分宽度下 arguments 都是可解析的 JSON 参数体", () => {
  for (let w = 1; w <= XML.length; w += 3) {
    const out = run(split(XML, w), { knownTools: [] });
    assert.equal(reasonOf(out), "先查天气再决定。", "width=" + w + " 思考文本应完整落到 reasoning");
    assert.deepEqual(JSON.parse(argsOf(out)), { city: "SH" }, "width=" + w + " arguments 应可 JSON.parse");
    assert.equal(textOf(out), "", "width=" + w + " 工具段不应留在正文");
    assert.ok(
      out.some((c) => c.type === "block-start" && c.blockType === "tool-call"),
      "width=" + w + " 应切出 tool-call 块",
    );
    assert.equal(out.filter((c) => c.type === "block-end").length, 1, "width=" + w + " 应恰好关闭一个自开块");
  }
});

test("回归2：JSON 形态取出 name，并把 arguments 规整为参数体", () => {
  const out = run(split(JSON_FORM, 4), { knownTools: [] });
  const names = out.filter((c) => c.type === "tool-call-delta" && c.name).map((c) => c.name);
  assert.deepEqual(names, ["get_weather"]);
  assert.deepEqual(JSON.parse(argsOf(out)), { city: "SH" });
  assert.equal(reasonOf(out), "想想。");
  assert.equal(textOf(out), "");
});

test("回归3：裸 <tool_call>（没有名字）不切分 —— 非法 name 会让整个会话被服务端 400", () => {
  const out = run(["<tool_call>"], { knownTools: [] });
  assert.ok(!out.some((c) => c.type === "tool-call-delta"), "绝不能建没有名字的 tool-call 块");
  assert.equal(textOf(out), "<tool_call>");
  const ok = run(["<tool_call><function=ping></function>"], { knownTools: [] });
  assert.deepEqual(JSON.parse(argsOf(ok)), {});
  assert.deepEqual(ok.filter((c) => c.type === "tool-call-delta" && c.name).map((c) => c.name), ["ping"]);
});

test("回归4：上游开的块不补 block-end（避免覆盖上游块）", () => {
  const n = new Qwen3StreamNormalizer({}, { knownTools: [] });
  const out = [];
  out.push(...n.feed({ type: "block-start", index: 0, blockType: "reasoning" }));
  out.push(...n.feed({ type: "reasoning-delta", index: 0, text: "上游思考" }));
  out.push(...n.feed({ type: "text-delta", index: 0, text: "<tool_call><function=ls>{}</function>" }));
  out.push(...n.flush());
  assert.equal(out.filter((c) => c.type === "block-end").length, 0);
  assert.ok(out.some((c) => c.type === "block-start" && c.blockType === "tool-call"));
});

test("回归5：自开块的 block-end 必须带上累积文本", () => {
  const out = run(["先想一下"], {});
  const end = out.find((c) => c.type === "block-end");
  assert.ok(end, "flush 应补 block-end");
  assert.equal(end.block.text, "先想一下");
});

test("回归6：</thinking> 形态在任意宽度下无损（标签被剥离）", () => {
  const raw = "我需要搜索一下。</thinking>答案是 42。";
  for (let w = 1; w <= 9; w += 2) {
    const out = run(split(raw, w), { knownTools: [] });
    const both = reasonOf(out) + textOf(out);
    assert.equal(both, "我需要搜索一下。答案是 42。", "width=" + w);
  }
});

test("回归7：ctx.logger 缺失 + debug=true 时不抛（日志兜底）", async () => {
  const handlers = new Map();
  const ctx = { on(ev, h) { handlers.set(ev, h); } };
  const original = console.info;
  const seen = [];
  console.info = (...a) => { seen.push(a.join(" ")); };
  try {
    apply(ctx, { debug: true });
    const handler = handlers.get("llm/stream");
    assert.equal(typeof handler, "function");
    async function* upstream() {
      yield { type: "text-delta", index: 0, text: "hi" };
    }
    const out = [];
    for await (const c of handler({ model: "Qwen3-32B", tools: [] }, () => upstream())) out.push(c);
    assert.ok(out.length > 0, "应产出 chunk");
    assert.ok(seen.length > 0, "debug=true 应写出日志");
  } finally {
    console.info = original;
  }
});

test("回归8：normalizeArguments=false 时逐字节保留模型原文", () => {
  for (let w = 1; w <= 17; w += 5) {
    const out = run(split(XML, w), { knownTools: [] }, { normalizeArguments: false });
    assert.equal(reasonOf(out) + argsOf(out), XML, "width=" + w);
  }
});

test("回归9：调用后面还有正文 → 判为引用，整段按文本（不误执行）", () => {
  const raw = '<tool_call><function=ls>{"cmd":"ls"}</function></tool_call>之后';
  for (let w = 1; w <= 13; w += 3) {
    const out = run(split(raw, w), { knownTools: [] });
    assert.ok(!out.some((c) => c.type === "tool-call-delta"), "width=" + w + " 后面还有正文 → 不当真调用");
    assert.ok(textOf(out).includes("之后"), "width=" + w);
  }
  // 结尾干净（只有包装标签）时照切
  const ok = run(['<tool_call><function=ls>{"cmd":"ls"}</function></tool_call>'], { knownTools: [] });
  assert.deepEqual(JSON.parse(argsOf(ok)), { cmd: "ls" });
  assert.equal(textOf(ok), "");
});

test("回归10：嵌套对象 / 字符串里的括号不影响 JSON 完整性判定", () => {
  const raw = '<tool_call>{"name": "x", "arguments": {"a": {"b": "}"}, "c": [1,2]}}</tool_call>';
  const out = run(split(raw, 3), { knownTools: ["x"] });
  assert.deepEqual(JSON.parse(argsOf(out)), { a: { b: "}" }, c: [1, 2] });
});

test("回归11：无参数工具调用也给出可解析的空参数，并带上工具名", () => {
  const out = run(['<tool_call><function=ping></function>'], { knownTools: [] });
  assert.deepEqual(JSON.parse(argsOf(out)), {});
  assert.deepEqual(out.filter((c) => c.type === "tool-call-delta" && c.name).map((c) => c.name), ["ping"]);
});

// ── <parameter=name>value</parameter> 块式参数（Qwen3-Coder / Anthropic 风格）──
const PARAM_FORM =
  '<tool_call><function=edit>' +
  '<parameter=file_path>cloud/device_service/domain/services/agency_cleanup.py</parameter>' +
  '<parameter=old_string>from cloud.shared.models import ( Alert, Bed, Device, </parameter>' +
  '<parameter=new_string>from cloud.shared.models import ( Alert, Bed, Campus, Device, </parameter>' +
  '</function></tool_call>';

test("回归12：<parameter=name> 块式参数在任意宽度下解析成 JSON 对象", () => {
  for (let w = 1; w <= 19; w += 3) {
    const out = run(split(PARAM_FORM, w), { knownTools: ["edit"] });
    assert.deepEqual(JSON.parse(argsOf(out)), {
      file_path: "cloud/device_service/domain/services/agency_cleanup.py",
      old_string: "from cloud.shared.models import ( Alert, Bed, Device, ",
      new_string: "from cloud.shared.models import ( Alert, Bed, Campus, Device, ",
    }, "width=" + w);
    assert.deepEqual(
      out.filter((c) => c.type === "tool-call-delta" && c.name).map((c) => c.name),
      ["edit"], "width=" + w + " 应带工具名");
    assert.equal(textOf(out), "", "width=" + w + " 不应漏到正文");
  }
});

test("回归13：参数值内的换行/引号/反斜杠正确转义，包装换行被去掉", () => {
  const nl = String.fromCharCode(10);
  const bs = String.fromCharCode(92);
  const raw = '<tool_call><function=edit><parameter=old_string>' + nl +
    'he said "hi" ' + bs + ' 2' + nl + 'second' + nl + '</parameter></function></tool_call>';
  const out = run(split(raw, 5), { knownTools: ["edit"] });
  assert.deepEqual(JSON.parse(argsOf(out)), { old_string: 'he said "hi" ' + bs + ' 2' + nl + 'second' });
});

test("回归14：没有名字的块式参数不切分（名字缺失会让服务端 400，宁可当正文）", () => {
  const raw = '<tool_call><parameter=file_path>a.py</parameter></tool_call>';
  for (let w = 1; w <= 9; w += 2) {
    const out = run(split(raw, w), { knownTools: ["edit"] });
    assert.ok(!out.some((c) => c.type === "tool-call-delta"), "width=" + w + " 无名字 → 不切分");
    assert.ok(textOf(out).includes("<parameter=file_path>"), "width=" + w + " 原文应留在正文");
  }
  // 有 <name=> 包装时照切
  const ok = run(['<tool_call><name=edit><parameter=file_path>a.py</parameter></tool_call>'], { knownTools: ["edit"] });
  assert.deepEqual(JSON.parse(argsOf(ok)), { file_path: "a.py" });
});

test("回归15：同名参数聚成数组，不互相覆盖", () => {
  const raw = '<tool_call><function=edit><parameter=file_path>a.py</parameter>' +
    '<parameter=file_path>b.py</parameter></function></tool_call>';
  const out = run(split(raw, 7), { knownTools: ["edit"] });
  assert.deepEqual(JSON.parse(argsOf(out)), { file_path: ["a.py", "b.py"] });
});

test("回归16：<parameter name=\"x\"> 属性写法同样识别", () => {
  const raw = '<tool_call><function=read_file><parameter name="file_path">a.py</parameter></function></tool_call>';
  const out = run(split(raw, 6), { knownTools: ["read_file"] });
  assert.deepEqual(JSON.parse(argsOf(out)), { file_path: "a.py" });
});

test("回归17：apply 默认开启参数规范化（argumentsDelta 只有 JSON 参数体）", async () => {
  const handlers = new Map();
  apply({ on: (e, h) => handlers.set(e, h), logger: { info: () => {} } }, {});
  const out = [];
  async function* up() { yield { type: "text-delta", index: 0, text: XML }; }
  for await (const c of handlers.get("llm/stream")({ model: "Qwen3-32B", tools: [{ name: "weather" }] }, () => up())) out.push(c);
  assert.deepEqual(JSON.parse(argsOf(out)), { city: "SH" });
});

test("回归18：apply 会把 normalizeArguments=false 透传给 normalizer（保留原文）", async () => {
  const handlers = new Map();
  apply({ on: (e, h) => handlers.set(e, h), logger: { info: () => {} } }, { normalizeArguments: false });
  const out = [];
  async function* up() { yield { type: "text-delta", index: 0, text: XML }; }
  for await (const c of handlers.get("llm/stream")({ model: "Qwen3-32B", tools: [{ name: "weather" }] }, () => up())) out.push(c);
  assert.equal(reasonOf(out) + argsOf(out), XML);
});

test("回归19：modelPatterns 里的 * 匹配任意模型名", async () => {
  const handlers = new Map();
  apply({ on: (e, h) => handlers.set(e, h) }, { modelPatterns: ["*"] });
  const out = [];
  async function* up() { yield { type: "text-delta", index: 0, text: XML }; }
  for await (const c of handlers.get("llm/stream")({ model: "some-other-model", tools: [] }, () => up())) out.push(c);
  assert.deepEqual(JSON.parse(argsOf(out)), { city: "SH" });
});
// ── 真实样本：多行 / 缩进 / 空行 / 中文注释的块式参数（用户实际会话里的一条）──
const L = String.fromCharCode(10);
const REAL_TRACE =
  '<tool_call>' + L +
  '<function=edit>' + L +
  '<parameter=file_path>' + L +
  'cloud/device_service/domain/services/agency_cleanup.py' + L +
  '</parameter>' + L +
  '<parameter=old_string>' + L +
  '    bed_repo.delete_by_agency(agency_id)' + L +
  '    room_repo.delete_by_agency(agency_id)' + L + L +
  '    user_ids = user_repo.list_ids_by_agency(agency_id)' + L +
  '</parameter>' + L +
  '<parameter=new_string>' + L +
  '    bed_repo.delete_by_agency(agency_id)' + L +
  '    room_repo.delete_by_agency(agency_id)' + L + L +
  '    # 院区(campus)挂在机构下：删机构前先清掉仍指向本机构院区的设备/告警的 campus_id，' + L +
  '    # 再删院区行，否则会撞 devices.campus_id / alerts.campus_id 外键' + L +
  '    campus_ids = [' + L +
  '        cid for (cid,) in db.query(Campus.id).filter(Campus.agency_id == agency_id).all()' + L +
  '    ]' + L +
  '    if campus_ids:' + L +
  '        db.query(Device).filter(Device.campus_id.in_(campus_ids)).update(' + L +
  '            {Device.campus_id: None}, synchronize_session=False)' + L +
  '        db.query(Alert).filter(Alert.campus_id.in_(campus_ids)).update(' + L +
  '            {Alert.campus_id: None}, synchronize_session=False)' + L +
  '        db.query(Campus).filter(Campus.agency_id == agency_id).delete(synchronize_session=False)' + L + L +
  '    user_ids = user_repo.list_ids_by_agency(agency_id)' + L +
  '</parameter>' + L +
  '</function>' + L +
  '</tool_call>';
const REAL_OLD = [
  '    bed_repo.delete_by_agency(agency_id)',
  '    room_repo.delete_by_agency(agency_id)',
  '',
  '    user_ids = user_repo.list_ids_by_agency(agency_id)',
].join(L);

test("回归20：真实样本 —— 多行/缩进/空行/中文注释的参数值逐字节保真", () => {
  for (const w of [1, 3, 7, 13, 41, 97]) {
    const out = run(split(REAL_TRACE, w), { knownTools: ["edit"] });
    const args = JSON.parse(argsOf(out));
    assert.deepEqual(Object.keys(args), ["file_path", "old_string", "new_string"], "width=" + w);
    assert.equal(args.file_path, "cloud/device_service/domain/services/agency_cleanup.py", "width=" + w);
    assert.equal(args.old_string, REAL_OLD, "width=" + w + " old_string 必须与文件内容逐字节一致");
    assert.ok(args.new_string.startsWith("    bed_repo.delete_by_agency(agency_id)" + L), "width=" + w + " 首行缩进保留");
    assert.ok(args.new_string.endsWith("    user_ids = user_repo.list_ids_by_agency(agency_id)"), "width=" + w + " 末行不带包装换行");
    assert.ok(args.new_string.includes(L + L + "    # 院区(campus)挂在机构下"), "width=" + w + " 空行与中文注释保留");
    assert.equal(args.new_string.indexOf("\r"), -1, "width=" + w + " 不应有回车");
    assert.equal(textOf(out), "", "width=" + w + " 不应漏进正文");
    assert.deepEqual(out.filter((c) => c.type === "tool-call-delta" && c.name).map((c) => c.name), ["edit"]);
  }
});

test("回归21：splitInReasoning 默认关 —— 思考块里的工具标记原样留在 reasoning", () => {
  const n = new Qwen3StreamNormalizer({}, { knownTools: ["edit"] });
  const out = [];
  out.push(...n.feed({ type: "block-start", index: 0, blockType: "reasoning" }));
  out.push(...n.feed({ type: "reasoning-delta", index: 0, text: "想想。" + REAL_TRACE }));
  out.push(...n.flush());
  assert.ok(!out.some((c) => c.type === "tool-call-delta"), "默认不切分思考块");
  assert.ok(out.some((c) => c.type === "reasoning-delta" && c.text.includes("<tool_call>")), "标记原样透传");
});

test("回归22：splitInReasoning=true 时把思考块里的工具调用切出来（上游的块不补 block-end）", () => {
  const n = new Qwen3StreamNormalizer({ splitInReasoning: true }, { knownTools: ["edit"] });
  const out = [];
  out.push(...n.feed({ type: "block-start", index: 0, blockType: "reasoning" }));
  out.push(...n.feed({ type: "reasoning-delta", index: 0, text: "想想。" }));
  for (let i = 0; i < REAL_TRACE.length; i += 9) {
    out.push(...n.feed({ type: "reasoning-delta", index: 0, text: REAL_TRACE.slice(i, i + 9) }));
  }
  out.push(...n.flush());
  assert.equal(reasonOf(out), "想想。", "思考文本保持 reasoning-delta");
  const starts = out.filter((c) => c.type === "block-start");
  assert.deepEqual(starts.map((c) => c.blockType), ["reasoning", "tool-call"]);
  assert.equal(argsOf(out).includes("<parameter"), false, "参数体不应带包装");
  assert.equal(JSON.parse(argsOf(out)).file_path, "cloud/device_service/domain/services/agency_cleanup.py");
  assert.equal(out.filter((c) => c.type === "block-end").length, 0, "上游开的 reasoning 块不补 block-end");
});

test("回归23：apply 把 splitInReasoning 透传下去（默认 false / 显式 true）", async () => {
  const mk = (cfg) => { const h = new Map(); apply({ on: (e, x) => h.set(e, x) }, cfg); return h.get("llm/stream"); };
  const feed = async (handler) => {
    const out = [];
    async function* up() {
      yield { type: "block-start", index: 0, blockType: "reasoning" };
      yield { type: "reasoning-delta", index: 0, text: "想想。" + REAL_TRACE };
    }
    for await (const c of handler({ model: "Qwen3-32B", tools: [{ name: "edit" }] }, () => up())) out.push(c);
    return out;
  };
  assert.ok(!(await feed(mk({}))).some((c) => c.type === "tool-call-delta"), "默认关");
  assert.ok((await feed(mk({ splitInReasoning: true }))).some((c) => c.type === "tool-call-delta"), "显式开");
});
// ── 上游 block-end 会把"它自己攒的原文"塞回来（覆盖语义），工具段必须在里面剥掉 ──
const DQ = String.fromCharCode(34);
const BS = String.fromCharCode(92);
const SHELL_TRACE =
  '<tool_call>' + L + '<function=edit>' + L +
  '<parameter=file_path>' + L + 'deploy/smoke/http/edge_to_cloud.sh' + L + '</parameter>' + L +
  '<parameter=old_string>' + L +
  '    ' + DQ + '$(jq -nc --arg name ' + DQ + '$SMOKE_ELDERLY_NAME' + DQ + ' ' + BS + L +
  '      ' + "'" + '{name:$name, floor:' + DQ + '2层' + DQ + ', room:' + DQ + '101' + DQ + ', bed_no:' + DQ + '1' + DQ + ', status:' + DQ + 'active' + DQ + '}' + "'" + ')' + DQ + ' ' + BS + L +
  '</parameter>' + L +
  '<parameter=new_string>' + L +
  '    ' + DQ + '$(jq -nc --arg name ' + DQ + '$SMOKE_ELDERLY_NAME' + DQ + ' --arg b ' + DQ + '$SMOKE_BUILDING' + DQ + ' ' + BS + L +
  '      ' + "'" + '{name:$name, building:$b, floor:' + DQ + '2层' + DQ + ', room:' + DQ + '101' + DQ + ', bed_no:' + DQ + '1' + DQ + ', status:' + DQ + 'active' + DQ + '}' + "'" + ')' + DQ + ' ' + BS + L +
  '</parameter>' + L + '</function>' + L + '</tool_call>';
const SHELL_OLD = [
  '    ' + DQ + '$(jq -nc --arg name ' + DQ + '$SMOKE_ELDERLY_NAME' + DQ + ' ' + BS,
  '      ' + "'" + '{name:$name, floor:' + DQ + '2层' + DQ + ', room:' + DQ + '101' + DQ + ', bed_no:' + DQ + '1' + DQ + ', status:' + DQ + 'active' + DQ + '}' + "'" + ')' + DQ + ' ' + BS,
].join(L);
const SHELL_NEW = [
  '    ' + DQ + '$(jq -nc --arg name ' + DQ + '$SMOKE_ELDERLY_NAME' + DQ + ' --arg b ' + DQ + '$SMOKE_BUILDING' + DQ + ' ' + BS,
  '      ' + "'" + '{name:$name, building:$b, floor:' + DQ + '2层' + DQ + ', room:' + DQ + '101' + DQ + ', bed_no:' + DQ + '1' + DQ + ', status:' + DQ + 'active' + DQ + '}' + "'" + ')' + DQ + ' ' + BS,
].join(L);

test("回归24：上游 block-end 塞回来的原文里，工具段被剥离（不再复活成正文）", () => {
  const n = new Qwen3StreamNormalizer({}, { knownTools: ["edit"] });
  const out = [];
  out.push(...n.feed({ type: "block-start", index: 0, blockType: "text" }));
  for (let i = 0; i < SHELL_TRACE.length; i += 6) {
    out.push(...n.feed({ type: "text-delta", index: 0, text: SHELL_TRACE.slice(i, i + 6) }));
  }
  out.push(...n.feed({ type: "block-end", index: 0, block: { type: "text", text: SHELL_TRACE } }));
  out.push(...n.flush());
  const args = JSON.parse(argsOf(out));
  assert.equal(args.file_path, "deploy/smoke/http/edge_to_cloud.sh");
  assert.equal(args.old_string, SHELL_OLD, "shell 行继续符与引号逐字节保留");
  assert.equal(args.new_string, SHELL_NEW);
  const end = out.find((c) => c.type === "block-end");
  assert.ok(end, "block-end 应透传");
  assert.equal(end.block.text, "", "原文里的工具段必须剥干净");
  assert.equal(textOf(out), "", "不应漏进正文");
});

test("回归25：同一块里工具调用前后还有正文时，只剥工具段、留下正文", () => {
  const before = "先看一下：";
  const text = before + XML; // 调用在块末尾 → 真调用
  const n = new Qwen3StreamNormalizer({}, { knownTools: ["weather"] });
  const out = [];
  out.push(...n.feed({ type: "block-start", index: 0, blockType: "text" }));
  out.push(...n.feed({ type: "text-delta", index: 0, text }));
  out.push(...n.feed({ type: "block-end", index: 0, block: { type: "text", text } }));
  out.push(...n.flush());
  const end = out.find((c) => c.type === "block-end");
  assert.ok(end, "block-end 应透传");
  // 调用之前的正文是内容、必须留下；工具段本身必须剥掉
  assert.equal(end.block.text, before + "先查天气再决定。");
  assert.ok(!end.block.text.includes("<tool_call>"));
  assert.ok(!end.block.text.includes("<function="));
  assert.deepEqual(JSON.parse(argsOf(out)), { city: "SH" });
});
// ── 真实会话里挖出来的另外两种写法（utoken/agentic-compute-medium 的 Qwen3 端点）──
test("回归26：<name=run_code> 包装也能取出工具名", () => {
  const raw = "<tool_call>" + L + "<name=run_code>" + L + "<parameter=code>" + L +
    "const a = 1;" + L + "</parameter>" + L + "</tool_call>";
  for (const w of [1, 5, 17]) {
    const out = run(split(raw, w), { knownTools: ["run_code"] });
    assert.deepEqual(out.filter((c) => c.type === "tool-call-delta" && c.name).map((c) => c.name), ["run_code"], "width=" + w);
    assert.deepEqual(JSON.parse(argsOf(out)), { code: "const a = 1;" }, "width=" + w);
  }
});

test("回归27：参数值是 JSON 数组/对象时按值解析，普通文本仍是字符串", () => {
  const js = "<tool_call>" + L + "<function=todo_write>" + L + "<parameter=todos>" + L +
    '[{"content": "a", "status": "pending"}]' + L + "</parameter>" + L + "</function>" + L + "</tool_call>";
  const args = JSON.parse(argsOf(run(split(js, 7), { knownTools: ["todo_write"] })));
  assert.ok(Array.isArray(args.todos), "todos 必须是数组，不能是字符串");
  assert.deepEqual(args.todos, [{ content: "a", status: "pending" }]);

  const txt = "<tool_call>" + L + "<function=edit>" + L + "<parameter=old_string>" + L +
    "[not json" + L + "</parameter>" + L + "</function>" + L + "</tool_call>";
  assert.deepEqual(JSON.parse(argsOf(run(split(txt, 6), { knownTools: ["edit"] }))), { old_string: "[not json" });
});

test("回归29：正文里引用工具调用（反引号包着 / 后面还有正文）不会被当真调用", () => {
  const quoted = "我之前的写法是 `" + XML + "`，那是错的。";
  const out = run([quoted], { knownTools: ["weather"] });
  assert.ok(!out.some((c) => c.type === "tool-call-delta"), "反引号里的举例不切分");
  assert.ok(textOf(out).includes("那是错的。"));

  const trailing = "看这个：" + XML + " 就这样。";
  const out2 = run([trailing], { knownTools: ["weather"] });
  assert.ok(!out2.some((c) => c.type === "tool-call-delta"), "调用后面还有正文 → 判为引用");
  assert.ok(textOf(out2).includes("就这样。"));
});

test("回归30：工具名非法（字符集 / 超长）时不切分 —— 否则服务端会 400", () => {
  for (const name of ["web.search", "x".repeat(65)]) {
    const raw = "<tool_call><function=" + name + '>{"a":1}</function></tool_call>';
    const out = run([raw], { knownTools: [] });
    assert.ok(!out.some((c) => c.type === "tool-call-delta"), "name=" + name.slice(0, 12));
  }
  const ok = run(['<tool_call><function=web_search>{"a":1}</function></tool_call>'], { knownTools: [] });
  assert.deepEqual(JSON.parse(argsOf(ok)), { a: 1 });
});

test("回归28：默认配置能拦下别名模型（utoken/agentic-compute-medium）", async () => {
  const handlers = new Map();
  apply({ on: (e, h) => handlers.set(e, h), logger: { info: () => {} } }, {});
  const out = [];
  async function* up() { yield { type: "text-delta", index: 0, text: XML }; }
  for await (const c of handlers.get("llm/stream")({ model: "utoken/agentic-compute-medium", tools: [{ name: "weather" }] }, () => up())) out.push(c);
  assert.deepEqual(JSON.parse(argsOf(out)), { city: "SH" }, "默认应拦截别名模型");
});



