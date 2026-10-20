"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");

function collectJsFiles(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (["node_modules", "backup", "archive", ".audit"].includes(entry.name)) continue;
      collectJsFiles(path.join(dir, entry.name), out);
    } else if (entry.name.endsWith(".js")) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// Collect relative require()/import specifiers without executing the module.
// Comments and string literals are skipped so that doc examples such as
// `require("./src/agent/goal-bridge")` are not mistaken for real imports.
function relativeSpecifiers(src) {
  const found = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const q = c; i++;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      if (word === "require" || word === "from") {
        let k = j;
        while (k < n && /\s/.test(src[k])) k++;
        if (src[k] === "(") {
          k++;
          while (k < n && /\s/.test(src[k])) k++;
          const q = src[k];
          if (q === '"' || q === "'") {
            k++;
            let spec = "";
            while (k < n && src[k] !== q) { spec += src[k]; k++; }
            if (spec.startsWith(".")) found.push(spec);
          }
        }
      }
      i = j;
      continue;
    }
    i++;
  }
  return found;
}

test("every relative require in src/ resolves to a real file", () => {
  const files = collectJsFiles(SRC, []);
  const broken = [];
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    for (const spec of relativeSpecifiers(src)) {
      const base = path.resolve(path.dirname(file), spec);
      const candidates = [base, base + ".js", path.join(base, "index.js")];
      if (!candidates.some((c) => fs.existsSync(c))) {
        broken.push(path.relative(path.join(__dirname, ".."), file) + " -> " + spec);
      }
    }
  }
  assert.deepEqual(broken, [], "unresolved relative requires:\n" + broken.join("\n"));
});

test("src/agent/index.js loads and exposes its public factories", () => {
  const mod = require("../src/agent/index");
  for (const name of [
    "createAgentTools", "createSafety", "createTargetEngine",
    "createEquitySnapshotter", "resetTargetEngineState",
    "createGoalBridge", "createMcpBridge", "createAttributionEngine",
  ]) {
    assert.notEqual(mod[name], undefined, "missing export: " + name);
  }
});

test("src/agent/index.js exports TARGET_PHASES and DEFAULT_STATE_PATH", () => {
  const mod = require("../src/agent/index");
  assert.ok(Array.isArray(mod.TARGET_PHASES));
  assert.equal(typeof mod.DEFAULT_STATE_PATH, "string");
});
