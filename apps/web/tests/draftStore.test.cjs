// Run with: node --test tests/draftStore.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

/** draftStore 只做类型导入，转译后不依赖其他模块；plan 的真实实现在此用不到 */
function load() {
  const source = fs.readFileSync(path.join(__dirname, "../src/features/pages/draftStore.ts"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports });
  return exports;
}

const draft = (n, sel = []) => ({ plan: Array.from({ length: n }, (_, i) => ({ id: "p" + i })), sel: new Set(sel), last: null });
const saved = (n, dirty) => ({ draft: draft(n), history: [], appliedKey: null, dirty, name: "a.pdf", dir: null, lastSource: null, importSizes: {} });

test("没有保存过草稿的文件既取不到草稿，也不算有未应用变更", () => {
  const s = load();
  assert.equal(s.loadDraft("a"), null);
  assert.equal(s.hasUnsavedDraft("a"), false);
});

test("保存后可按文件 ID 取回同一份草稿，未应用变更状态一并保留", () => {
  const s = load();
  s.saveDraft("a", saved(5, true));
  assert.equal(s.loadDraft("a").draft.plan.length, 5);
  assert.equal(s.hasUnsavedDraft("a"), true);
  // 已另存（dirty=false）的草稿仍可恢复，但关闭标签不需要确认
  s.saveDraft("a", saved(5, false));
  assert.equal(s.loadDraft("a").draft.plan.length, 5);
  assert.equal(s.hasUnsavedDraft("a"), false);
  assert.equal(s.loadDraft("b"), null, "其他文件互不影响");
});

test("关闭标签后丢弃对应草稿，仍打开的标签保留；被丢弃的不再算未应用变更", () => {
  const s = load();
  s.saveDraft("a", saved(3, true));
  s.saveDraft("b", saved(4, true));
  s.pruneDrafts(new Set(["b"]));
  assert.equal(s.loadDraft("a"), null);
  assert.equal(s.hasUnsavedDraft("a"), false);
  assert.equal(s.hasUnsavedDraft("b"), true);
  s.dropDraft("b");
  assert.equal(s.loadDraft("b"), null);
});
