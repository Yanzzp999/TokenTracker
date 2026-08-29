const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const pluginPath = path.resolve(__dirname, "..", "dashboard", "scripts", "copy-registry-plugin.mjs");

test("copy registry rejects an unterminated quoted field", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-copy-registry-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const copyPath = path.join(tempDir, "copy.csv");
  fs.writeFileSync(
    copyPath,
    'key,module,page,component,slot,text\nexample,core,home,Hero,title,"unfinished\n',
    "utf8",
  );

  const { readCopyRegistry } = await import(pathToFileURL(pluginPath).href);
  assert.throws(
    () => readCopyRegistry(copyPath),
    /Copy registry contains an unterminated quoted field/,
  );
});
