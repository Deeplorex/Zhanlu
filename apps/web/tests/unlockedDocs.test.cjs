// Run with: node --test tests/unlockedDocs.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function load() {
  const source = fs.readFileSync(path.join(__dirname, "../src/features/reader/unlockedDocs.ts"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports });
  return exports;
}

function fakeTask() {
  const task = { destroys: 0, async destroy() { task.destroys += 1; } };
  return task;
}

test("未解锁的文档没有可复用的加载任务", () => {
  const m = load();
  assert.equal(m.unlockedDoc("a"), null);
});

test("解锁后复用同一加载任务，并由此接管销毁", () => {
  const m = load();
  const task = fakeTask();
  m.keepUnlockedDoc("a", task);
  assert.equal(m.unlockedDoc("a"), task);
  assert.equal(m.ownsUnlockedDoc("a", task), true);
  assert.equal(m.ownsUnlockedDoc("a", fakeTask()), false, "同 id 的其他加载任务不算接管");
  assert.equal(m.ownsUnlockedDoc("b", task), false);
  assert.equal(task.destroys, 0);
});

test("标签关闭后销毁其已解锁文档，仍打开的标签保留", () => {
  const m = load();
  const a = fakeTask();
  const b = fakeTask();
  m.keepUnlockedDoc("a", a);
  m.keepUnlockedDoc("b", b);
  m.releaseUnlockedDocs(new Set(["b"]));
  assert.equal(m.unlockedDoc("a"), null, "关闭的标签不再保持解锁");
  assert.equal(a.destroys, 1);
  assert.equal(m.unlockedDoc("b"), b);
  assert.equal(b.destroys, 0);
});

test("重复清理不重复销毁，关闭全部标签后逐个销毁", () => {
  const m = load();
  const a = fakeTask();
  const b = fakeTask();
  m.keepUnlockedDoc("a", a);
  m.keepUnlockedDoc("b", b);
  m.releaseUnlockedDocs(new Set(["a", "b"]));
  m.releaseUnlockedDocs(new Set());
  m.releaseUnlockedDocs(new Set());
  assert.deepEqual([a.destroys, b.destroys], [1, 1]);
  assert.equal(m.unlockedDoc("a"), null);
  assert.equal(m.unlockedDoc("b"), null);
});

test("销毁失败不影响其余文档的清理", () => {
  const m = load();
  const a = { async destroy() { throw new Error("worker gone"); } };
  const b = fakeTask();
  m.keepUnlockedDoc("a", a);
  m.keepUnlockedDoc("b", b);
  m.releaseUnlockedDocs(new Set());
  assert.equal(m.unlockedDoc("a"), null);
  assert.equal(m.unlockedDoc("b"), null);
  assert.equal(b.destroys, 1);
});
