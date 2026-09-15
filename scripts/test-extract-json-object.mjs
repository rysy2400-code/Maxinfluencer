#!/usr/bin/env node
/**
 * 验证 LLM 输出 JSON 的健壮解析：模型把同一段 JSON 输出两遍时，
 * 不能因为贪婪正则 `/\{[\s\S]*\}/` 而抛 JSON.parse 错误。
 *
 * 用法：node scripts/test-extract-json-object.mjs
 */
import assert from "node:assert/strict";
import { extractFirstJsonObject, parseFirstJsonObject } from "../lib/utils/extract-json-object.js";
import { parseExecutionSchedulerDecision } from "../lib/agents/campaign-execution-agent.js";

let passed = 0;
const cases = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    cases.push(`  ✓ ${name}`);
  } catch (e) {
    cases.push(`  ✗ ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

const single = '{ "needTool": true, "toolName": "modify_campaign", "params": { "scope": "whole" } }';

check("单个对象：正常解析", () => {
  assert.deepEqual(parseFirstJsonObject(single).toolName, "modify_campaign");
});

check("markdown 代码块包裹：正常解析", () => {
  const raw = "```json\n" + single + "\n```";
  assert.deepEqual(parseFirstJsonObject(raw).toolName, "modify_campaign");
});

check("前后夹带说明文字：取第一个对象", () => {
  const raw = `好的，结果如下：\n${single}\n以上。`;
  assert.deepEqual(parseFirstJsonObject(raw).toolName, "modify_campaign");
});

check("同一 JSON 输出两遍：取第一段，不抛错（本次线上故障场景）", () => {
  const raw = `${single}\n${single}`;
  assert.doesNotThrow(() => extractFirstJsonObject(raw));
  assert.deepEqual(parseFirstJsonObject(raw).toolName, "modify_campaign");
});

check("两段内容不同的 JSON：取第一段", () => {
  const second = '{ "needTool": false, "toolName": null, "params": null, "reply": "x" }';
  assert.deepEqual(parseFirstJsonObject(`${single}\n${second}`).toolName, "modify_campaign");
});

check("字符串内部含花括号：括号配对不误判", () => {
  const raw = '{ "accountType": "基地在{sao paulo}的达人}" , "note": "a\\"b" }';
  assert.deepEqual(parseFirstJsonObject(raw).accountType, "基地在{sao paulo}的达人}");
});

check("无 JSON / 空输入：返回 fallback，不抛错", () => {
  assert.deepEqual(parseFirstJsonObject("抱歉，我无法处理。"), {});
  assert.deepEqual(parseFirstJsonObject(""), {});
  assert.deepEqual(parseFirstJsonObject(null), {});
});

check("残缺 JSON：不抛错，返回 fallback", () => {
  assert.deepEqual(parseFirstJsonObject('{ "needTool": true'), {});
});

check("调度器解析：重复 JSON 不再抛错，且保留决策", () => {
  const decision1 =
    '{ "needTool": true, "toolName": "modify_campaign", "params": { "scope": "whole", "changes": { "screeningConditions": { "accountType": "互动率要求5%以上，base在巴西圣保罗加戈亚尼亚的美食探店类或母婴类红人都可以" } } } }';
  const decision2 =
    '{ "needTool": true, "toolName": "modify_campaign", "params": { "scope": "whole" } }';
  const raw = `${decision1}\n${decision2}`;
  const decision = parseExecutionSchedulerDecision(raw);
  assert.equal(decision.needTool, true);
  assert.equal(decision.toolName, "modify_campaign");
  assert.equal(
    decision.params.changes.screeningConditions.accountType,
    "互动率要求5%以上，base在巴西圣保罗加戈亚尼亚的美食探店类或母婴类红人都可以"
  );
});

check("调度器解析：垃圾输入返回空决策而非抛错", () => {
  const decision = parseExecutionSchedulerDecision("模型抽风没有返回 JSON");
  assert.deepEqual(decision, { needTool: false, toolName: null, params: {}, reply: "" });
});

console.log("extract-json-object 测试：");
console.log(cases.join("\n"));
console.log(`\n${passed}/${cases.length} 通过`);
