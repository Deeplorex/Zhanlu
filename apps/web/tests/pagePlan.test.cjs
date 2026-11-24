// Run with: node --test tests/pagePlan.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function load() {
  const source = fs.readFileSync(path.join(__dirname, "../src/features/pages/plan.ts"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports });
  return exports;
}

const P = load();
// 模块在 vm 沙箱里执行，数组原型的 realm 不同：一律按值比较
const same = (actual, expected) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)));

const ids = (plan) => plan.map((it) => it.id);
/** 用来源描述页序：d3＝当前文档原第 3 页，i:2＝导入第 2 页，b＝空白页 */
const order = (plan) => plan.map((it) => {
  const s = it.source;
  const base = s.kind === "blank" ? "b" : `${s.kind === "import" ? "i" : "d"}${s.page}`;
  return `${base}${it.copy ? "*" : ""}${P.rotateLabel(it.rotate) ? "@" + P.norm(it.rotate) : ""}`;
});
const at = (plan, n) => plan[n - 1].id; // 原第 n 页的实例（初始草稿）

test("初始草稿是原页序，每页一个实例", () => {
  const plan = P.initialPlan(4);
  assert.equal(plan.length, 4);
  assert.equal(new Set(ids(plan)).size, 4, "实例 ID 各不相同");
  assert.equal(P.isOriginal(plan, 4), true);
  assert.equal(P.isOriginal(P.initialPlan(3), 4), false);
});

test("任务计划兼容既有 {page, rotate}，导入页按文件 ID 引用，空白页带尺寸", () => {
  const plan = [
    ...P.initialPlan(2),
    ...P.importInstances({ id: "supp", name: "补充.pdf" }, [4, 2], "cur"),
    P.makeBlank(841.89, 595.28),
  ];
  plan[0].rotate = 90;
  same(P.toJobPlan(plan), [
    { page: 1, rotate: 90 }, { page: 2, rotate: 0 },
    { file: "supp", page: 4, rotate: 0 }, { file: "supp", page: 2, rotate: 0 },
    { blank: true, width: 841.89, height: 595.28, rotate: 0 },
  ]);
});

test("复制：新实例 ID、插在最后一张选中页之后、继承当时的旋转，之后各自独立", () => {
  const plan = P.initialPlan(5);
  const rotated = P.rotateSelection(plan, new Set([at(plan, 2), at(plan, 4)]), 90);
  const sel = new Set([at(rotated, 2), at(rotated, 4)]);
  const result = P.copySelected(rotated, sel);
  // 整组（按网格顺序）插到最后一张选中页之后
  same(order(result.plan), ["d1", "d2@90", "d3", "d4@90", "d2*@90", "d4*@90", "d5"]);
  assert.equal(new Set(ids(result.plan)).size, 7, "副本分配新的实例 ID");
  same(new Set(result.copies.map((it) => it.id)), new Set(ids(result.plan).slice(4, 6)));
  const copy = result.plan[4];
  assert.notEqual(copy.id, at(rotated, 2));
  const after = P.rotateSelection(result.plan, new Set([copy.id]), -90);
  assert.equal(after[1].rotate, 90, "原页不变");
  assert.equal(after[4].rotate, 0, "副本独立旋转");
  const trimmed = P.removeSelection(after, new Set([copy.id]));
  assert.equal(trimmed.length, 6);
  assert.equal(trimmed.some((it) => it.id === at(plan, 2)), true, "删除副本不影响原页");
});

test("从当前文档自身插入生成副本，从另一份 PDF 插入按给定顺序引用其页", () => {
  const selfCopies = P.importInstances({ id: "cur", name: "当前.pdf" }, [3, 1], "cur");
  same(selfCopies.map((it) => [it.source.kind, it.source.page, it.copy]), [["doc", 3, true], ["doc", 1, true]]);
  const other = P.importInstances({ id: "supp", name: "补充.pdf" }, [2, 4], "cur");
  same(other.map((it) => [it.source.kind, it.source.file, it.source.page, it.copy]), [
    ["import", "supp", 2, false], ["import", "supp", 4, false],
  ]);
  same(P.thumbSource(other[0], "cur"), { fileId: "supp", page: 2 });
  assert.equal(P.thumbSource(P.makeBlank(1, 1), "cur"), null);
});

test("移动：保留组内相对顺序与实例 ID，非连续多选也可整组移动", () => {
  const plan = P.initialPlan(6);
  const sel = new Set([at(plan, 2), at(plan, 5)]);
  const next = P.moveTo(plan, sel, 0);
  same(order(next), ["d2", "d5", "d1", "d3", "d4", "d6"]);
  same(ids(next).slice(0, 2), [at(plan, 2), at(plan, 5)], "实例 ID 稳定（锚点）");
  assert.equal(P.sameOrder(next, plan), false);
  assert.equal(P.moveTo(plan, sel, 0).find((it) => it.id === at(plan, 2)).moved, true, "被移动的当前文档页标记来源");
  // 单页移走再移回：与原草稿是同一批实例的同一种排列
  const lifted = P.moveTo(plan, new Set([at(plan, 2)]), 0);
  same(order(lifted), ["d2", "d1", "d3", "d4", "d5", "d6"]);
  const back = P.moveTo(lifted, new Set([at(plan, 2)]), 1);
  assert.equal(P.sameOrder(back, plan), true, "移回原处与原草稿同序");
  assert.equal(P.sameOrder(back, lifted), false);
});

test("上移／下移只对连续选区生效，越界返回 null", () => {
  const plan = P.initialPlan(5);
  const mid = new Set([at(plan, 2), at(plan, 3)]);
  same(order(P.shiftSelection(plan, mid, -1)), ["d2", "d3", "d1", "d4", "d5"]);
  same(order(P.shiftSelection(plan, mid, 1)), ["d1", "d4", "d2", "d3", "d5"]);
  assert.equal(P.shiftSelection(plan, new Set([at(plan, 1)]), -1), null);
  assert.equal(P.shiftSelection(plan, new Set([at(plan, 5)]), 1), null);
  assert.equal(P.shiftSelection(plan, new Set([at(plan, 1), at(plan, 3)]), 1), null, "非连续选区不可整体移动");
  assert.equal(P.shiftSelection(plan, new Set([1, 2, 3, 4, 5].map((n) => at(plan, n))), 1), null, "全选无位可移");
});

test("删除至少保留一页；旋转累计归一", () => {
  const plan = P.initialPlan(3);
  assert.equal(P.removeSelection(plan, new Set(ids(plan))), null);
  const rotated = P.rotateSelection(P.rotateSelection(plan, new Set([at(plan, 1)]), -90), new Set([at(plan, 1)]), 180);
  assert.equal(rotated[0].rotate, 90);
  assert.equal(P.rotateLabel(rotated[0].rotate), "右转 90°");
  assert.equal(P.rotateLabel(270), "左转 90°");
  assert.equal(P.rotateLabel(180), "旋转 180°");
});

test("交接词四页样本：另存 7 页，顺序为原 1、旋转副本、原 2、空白页、导入 2、导入 4、原 3", () => {
  let plan = P.initialPlan(4);
  // 在原第 2 页后插入空白页
  plan = P.insertAt(plan, 2, [P.makeBlank(595, 842)]);
  same(order(plan), ["d1", "d2", "b", "d3", "d4"]);
  // 再在空白页后插入补充 PDF 的第 2、4 页
  plan = P.insertAt(plan, 3, P.importInstances({ id: "supp", name: "补充.pdf" }, [2, 4], "cur"));
  same(order(plan), ["d1", "d2", "b", "i2", "i4", "d3", "d4"]);
  // 复制原第 3 页
  const origin3 = plan.find((it) => it.source.kind === "doc" && it.source.page === 3);
  const copied = P.copySelected(plan, new Set([origin3.id]));
  plan = copied.plan;
  // 副本独立右转
  plan = P.rotateSelection(plan, new Set([copied.copies[0].id]), 90);
  // 副本移到原第 2 页前
  plan = P.moveTo(plan, new Set([copied.copies[0].id]), 1);
  // 删除原第 4 页
  plan = P.removeSelection(plan, new Set([plan.find((it) => it.source.kind === "doc" && it.source.page === 4).id]));
  assert.equal(plan.length, 7);
  same(order(plan), ["d1", "d3*@90", "d2", "b", "i2", "i4", "d3"]);
  same(P.toJobPlan(plan), [
    { page: 1, rotate: 0 }, { page: 3, rotate: 90 }, { page: 2, rotate: 0 },
    { blank: true, width: 595, height: 842, rotate: 0 },
    { file: "supp", page: 2, rotate: 0 }, { file: "supp", page: 4, rotate: 0 }, { page: 3, rotate: 0 },
  ]);
});

test("内容签名只看来源与旋转；草稿回到已另存的那一版时签名相同", () => {
  const plan = P.initialPlan(3);
  const edited = P.insertAt(plan, 3, [P.makeBlank(1, 1)]);
  assert.notEqual(P.contentKey(edited), P.contentKey(plan));
  const again = P.insertAt(plan, 3, [P.makeBlank(1, 1)]);
  assert.equal(P.contentKey(again), P.contentKey(edited), "实例 ID 不同但内容相同");
  assert.equal(P.sameOrder(again, edited), false, "实例不同则不是同一批实例的排列");
  const rotated = P.rotateSelection(plan, new Set([at(plan, 2)]), 360);
  assert.equal(P.contentKey(rotated), P.contentKey(plan), "360° 等于未旋转");
});

test("卡片页码与来源：位置在前，导入页与副本同时显示来源，被移动的页显示原页", () => {
  let plan = P.initialPlan(4);
  plan = P.moveTo(plan, new Set([at(plan, 4)]), 1);
  assert.equal(P.cardLabel(plan[1], 1), "2 · 原第 4 页");
  assert.equal(P.cardLabel(plan[0], 0), "1", "被挤开的页不标来源");
  const withImport = P.insertAt(plan, 4, P.importInstances({ id: "s", name: "补充.pdf" }, [2], "cur"));
  assert.equal(P.cardLabel(withImport[4], 4), "5 · 导入 · 原第 2 页");
  const rotated = P.rotateSelection(withImport, new Set([withImport[4].id]), 90);
  assert.equal(P.cardLabel(rotated[4], 4), "5·导入·原第2页·右转90°", "来源＋旋转共四段：紧凑写法以放进卡片");
  const blank = P.insertAt(rotated, 5, [P.makeBlank(1, 1)]);
  assert.equal(P.cardLabel(blank[5], 5), "6 · 空白页");
  // 此时页序为 原1、原4、原2、原3、导入2、空白：复制原第 4 页，副本紧跟其后
  const copy = P.copySelected(blank, new Set([blank.find((it) => it.source.kind === "doc" && it.source.page === 4).id]));
  assert.equal(P.cardLabel(copy.plan[2], 2), "3 · 副本 · 原第 4 页");
});

test("选区说明、页码列表与变更摘要与画板文案一致", () => {
  const plan = P.initialPlan(20);
  const pick = (nums) => new Set(nums.map((n) => at(plan, n)));
  assert.equal(P.pageListText([1, 2, 3, 5, 8, 9, 10]), "1–3、5、8–10");
  assert.equal(P.pageListText([2, 4]), "2、4");
  same(P.selectionLabel(plan, pick([4])), { main: "已选第 4 页" });
  same(P.selectionLabel(plan, pick([5, 6])), { main: "已选第 5、6 页" });
  assert.equal(P.selectionLabel(plan, new Set()), null);
  same(P.selectionLabel(plan, pick([5, 6, 7])), { main: "已选第 5、6、7 页" });
  same(P.selectionLabel(plan, pick([1, 2, 3, 5, 8, 9, 10, 12])), { main: "已选第 1–3、5、8–10、12 页" });
  same(P.selectionLabel(plan, new Set(ids(plan))), { main: "已选全部 20 页", note: "至少保留 1 页" });
  assert.equal(P.describeChange({ kind: "insert", n: 2 }, 22), "插入 2 页 · 共 22 页");
  assert.equal(P.describeChange({ kind: "blank", n: 1 }, 21), "插入 1 张空白页 · 共 21 页");
  assert.equal(P.describeChange({ kind: "move", n: 1 }, 20), "移动 1 页 · 共 20 页");
  assert.equal(P.describeChange({ kind: "copy", n: 1 }, 21), "复制 1 页 · 共 21 页");
  assert.equal(P.describeChange({ kind: "delete", n: 1 }, 19), "删除 1 页 · 共 19 页");
});

test("插入和移动保留页前与页后锚点，移动排除选中页", () => {
  const plan = P.initialPlan(4);
  const choices = P.positionOptions(plan);
  const pick = (items, label) => items.find((o) => o.label === label);
  assert.equal(pick(choices, "第 1 页后").at, 1);
  assert.equal(pick(choices, "第 2 页前").at, 1);
  assert.equal(pick(choices, "第 2 页前").anchor, plan[1]);
  assert.equal(choices[0].anchor, plan[0]);
  assert.equal(choices.at(-1).anchor, plan[3]);
  assert.equal(new Set(choices.map((o) => o.value)).size, choices.length);
  const moving = new Set([plan[0].id, plan[2].id]);
  const moves = P.positionOptions(plan, moving);
  assert.equal(pick(moves, "第 3 页后"), undefined);
  assert.equal(pick(moves, "第 4 页前").at, 1);
  const afterFour = pick(moves, "第 4 页后");
  same(order(P.moveTo(plan, moving, afterFour.at)), ["d2", "d4", "d1", "d3"]);
});

test("显示尺寸含待应用旋转：横竖互换；空白页用自己的尺寸；取不到返回 null", () => {
  const doc = P.initialPlan(2);
  const sizes = [[595, 842], [842, 595]];
  const resolve = (src) => (src.kind === "doc" ? sizes[src.page - 1] : undefined);
  same(P.pageSizeOf(doc[0], resolve), [595, 842]);
  same(P.pageSizeOf(P.rotateSelection(doc, new Set([doc[0].id]), 90)[0], resolve), [842, 595]);
  same(P.pageSizeOf(P.rotateSelection(doc, new Set([doc[1].id]), 180)[1], resolve), [842, 595]);
  same(P.pageSizeOf(P.makeBlank(300, 400), resolve), [300, 400]);
  assert.equal(P.pageSizeOf(P.positionOptions([])[0].anchor, resolve), null);
  assert.equal(P.pageSizeOf(P.importInstances({ id: "x", name: "x.pdf" }, [1], "cur")[0], resolve), null);
});

test("另存核对统计草稿的实际变更，撤销的操作不会留下摘要", () => {
  const original = P.initialPlan(4);
  const withCopy = P.copySelected(original, new Set([original[1].id]));
  const copyId = withCopy.copies[0].id;
  let draft = P.moveTo(withCopy.plan, new Set([original[2].id]), 0);
  draft = P.rotateSelection(draft, new Set([copyId]), 90);
  draft = P.removeSelection(draft, new Set([original[3].id]));
  draft = P.insertAt(draft, 1, [P.makeBlank(842, 595), ...P.importInstances({ id: "x", name: "x.pdf" }, [2, 4], "cur")]);
  assert.equal(P.describeOutput(draft, 4), "插入 1 张空白页 · 插入 2 页 · 复制 1 页 · 移动 1 页 · 旋转 1 页 · 删除 1 页 · 共 7 页");
  const movedCopy = P.moveTo(withCopy.plan, new Set([copyId]), 0);
  assert.equal(P.describeOutput(movedCopy, 4), "复制 1 页 · 移动 1 页 · 共 5 页");
  assert.equal(P.describeOutput(original, 4), "共 4 页");
});

test("默认输出名与区间选区", () => {
  assert.equal(P.defaultName("循环利用项目汇报.pdf"), "循环利用项目汇报-整理.pdf");
  assert.equal(P.defaultName("无扩展名"), "无扩展名-整理.pdf");
  const plan = P.initialPlan(5);
  const range = P.rangeBetween(plan, at(plan, 4), at(plan, 2));
  same([...range], [at(plan, 2), at(plan, 3), at(plan, 4)]);
});
