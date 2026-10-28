// Run with: node --test tests/nativeDrag.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function setup(ackResponses = [{ accepted: true }]) {
  let now = 1000;
  let hit = null;
  let observer;
  let resolvePoll;
  const handlers = new Map();
  const timers = [];
  const acks = [];
  const pending = new Promise((resolve) => { resolvePoll = resolve; });
  class FakeEvent {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; this.bubbles = options.bubbles; this.stopped = false; }
    stopPropagation() { this.stopped = true; }
  }
  class FakeElement {
    constructor() { this.listeners = new Map(); this.isConnected = true; this.visible = true; this.dialog = false; }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    removeEventListener(type) { this.listeners.delete(type); }
    dispatchEvent(event) { this.listeners.get(event.type)?.(event); }
    contains(other) { return other === this; }
    getClientRects() { return this.visible ? [{}] : []; }
    matches() { return this.dialog; }
    querySelector() { return null; }
  }
  const window = {
    devicePixelRatio: 2,
    addEventListener: (type, fn) => handlers.set(type, fn),
    removeEventListener: (type) => handlers.delete(type),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
  };
  const document = { body: new FakeElement(), elementFromPoint: (x, y) => { assert.equal(x, 50); assert.equal(y, 25); return hit; } };
  class FakeMutationObserver {
    constructor(fn) { observer = fn; }
    observe() {}
    disconnect() {}
  }
  const source = fs.readFileSync(path.join(__dirname, "../src/shared/nativeDrag.ts"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  const context = { exports, window, document, Element: FakeElement, MutationObserver: FakeMutationObserver,
    CustomEvent: FakeEvent, Event: FakeEvent, Date: { now: () => now },
    require: (name) => name === "react" ? { useRef: (value) => ({ current: value }), useEffect: (fn) => fn() }
      : name === "./api" ? { get: () => pending, post: async (url, body) => {
        acks.push({ url, body }); return ackResponses.shift() || { accepted: false };
      } } : require(name) };
  vm.runInNewContext(compiled, context);
  const element = new FakeElement();
  hit = element;
  const received = [];
  exports.useNativeDrop({ current: element }, (result) => received.push(result));
  exports.startNativeDropBridge();
  return {
    element, received, timers, acks,
    start: (id, at = now) => handlers.get("zhanlu:native-drop-start")(new FakeEvent("start", { detail: { id, physicalX: 100, physicalY: 50, at } })),
    result: async (id) => { resolvePoll({ drops: [{ id, files: [{ id: "file" }], errors: [] }] }); await new Promise(setImmediate); },
    navigate: () => { now += 10; handlers.get("hashchange")(); },
    changeDialog: () => { now += 10; const dialog = new FakeElement(); dialog.dialog = true; observer([{ type: "childList", addedNodes: [dialog], removedNodes: [] }]); },
    hideHit: () => { hit = new FakeElement(); },
  };
}

test("physical coordinates bind to the visible drop target and deliver registered files", async () => {
  const env = setup(); env.start("a"); await env.result("a");
  assert.equal(env.received.length, 1);
  assert.equal(env.received[0].files[0].id, "file");
  assert.deepEqual(JSON.parse(JSON.stringify(env.acks)), [{ url: "/api/desktop/drop-accept", body: { id: "a" } }]);
});

test("registration result arriving before the start event is buffered", async () => {
  const env = setup(); await env.result("a"); env.start("a");
  assert.equal(env.received.length, 1);
});

test("navigation after the drop prevents delayed delivery", async () => {
  const env = setup(); env.start("a"); env.navigate(); await env.result("a");
  assert.equal(env.received.length, 0);
});

test("a dialog opened after the drop prevents delayed delivery", async () => {
  const env = setup(); env.start("a"); env.changeDialog(); await env.result("a");
  assert.equal(env.received.length, 0);
});

test("a start event delayed past navigation cannot bind to a new page", async () => {
  const env = setup(); env.navigate(); env.start("a", 1000); await env.result("a");
  assert.equal(env.received.length, 0);
  assert.equal(env.acks.length, 0);
});

test("a drop outside a target never authorizes registration", () => {
  const env = setup(); env.hideHit(); env.start("a");
  assert.equal(env.acks.length, 0);
});

test("an acknowledgement arriving before stdin retries only while its target is current", async () => {
  const env = setup([{ accepted: false }, { accepted: true }]); env.start("a");
  await new Promise(setImmediate);
  assert.equal(env.acks.length, 1);
  env.navigate(); env.timers.find((t) => t.ms === 300).fn();
  await new Promise(setImmediate);
  assert.equal(env.acks.length, 1);
});

test("confirmation retries after stdin arrives and then delivers the result", async () => {
  const env = setup([{ accepted: false }, { accepted: true }]); env.start("a");
  await new Promise(setImmediate);
  env.timers.find((t) => t.ms === 300).fn();
  await new Promise(setImmediate);
  assert.equal(env.acks.length, 2);
  await env.result("a");
  assert.equal(env.received.length, 1);
});

test("an expired registration shows an error at the original target", async () => {
  const env = setup([{ accepted: false, expired: true }]); env.start("a");
  await new Promise(setImmediate);
  assert.match(env.received[0].errors[0], /过期/);
});

test("a target no longer under the original drop point cannot receive files", async () => {
  const env = setup(); env.start("a"); env.hideHit(); await env.result("a");
  assert.equal(env.received.length, 0);
});

test("long-running registrations have a ten-minute timeout with a visible error", () => {
  const env = setup(); env.start("a");
  const timeout = env.timers.find((t) => t.ms === 600000);
  assert.ok(timeout); timeout.fn();
  assert.match(env.received[0].errors[0], /超时/);
});
