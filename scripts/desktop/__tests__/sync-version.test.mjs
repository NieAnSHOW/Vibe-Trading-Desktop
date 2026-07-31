import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const script = join(repoRoot, "scripts", "desktop", "sync-version.mjs");

function writeFixture(root, path, content) {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

function readFixture(root, path) {
  return readFileSync(join(root, path), "utf8");
}

test("syncs a tag version into desktop, package, and visible UI metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-version-sync-"));

  writeFixture(
    root,
    "src-tauri/tauri.conf.json",
    JSON.stringify({ productName: "Trading Worker", version: "0.1.0" }, null, 2) + "\n"
  );
  writeFixture(root, "src-tauri/Cargo.toml", '[package]\nname = "trading-worker"\nversion = "0.1.0"\n');
  writeFixture(root, "src-tauri/Cargo.lock", '[[package]]\nname = "trading-worker"\nversion = "0.1.0"\n');
  writeFixture(root, "pyproject.toml", '[project]\nname = "vibe-trading-ai"\nversion = "0.1.9"\n');
  writeFixture(
    root,
    "frontend/src/components/layout/Layout.tsx",
    '// Bump on each release; one place keeps the footer in sync with package.json.\nconst APP_VERSION = "v0.1.9";\n'
  );
  writeFixture(root, "frontend/src/i18n/locales/en.json", JSON.stringify({ app: { version: "v0.1.9" } }, null, 2) + "\n");
  writeFixture(root, "frontend/src/i18n/locales/zh-CN.json", JSON.stringify({ app: { version: "v0.1.9" } }, null, 2) + "\n");

  execFileSync(process.execPath, [script, "v1.2.3", "--root", root], { stdio: "pipe" });

  assert.equal(JSON.parse(readFixture(root, "src-tauri/tauri.conf.json")).version, "1.2.3");
  assert.match(readFixture(root, "src-tauri/Cargo.toml"), /^version = "1\.2\.3"$/m);
  assert.match(readFixture(root, "src-tauri/Cargo.lock"), /^version = "1\.2\.3"$/m);
  assert.match(readFixture(root, "pyproject.toml"), /^version = "1\.2\.3"$/m);
  assert.match(readFixture(root, "frontend/src/components/layout/Layout.tsx"), /const APP_VERSION = "v1\.2\.3";/);
  assert.equal(JSON.parse(readFixture(root, "frontend/src/i18n/locales/en.json")).app.version, "v1.2.3");
  assert.equal(JSON.parse(readFixture(root, "frontend/src/i18n/locales/zh-CN.json")).app.version, "v1.2.3");
});

test("check mode fails when any version surface drifts", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-version-check-"));

  writeFixture(root, "src-tauri/tauri.conf.json", JSON.stringify({ version: "1.2.3" }, null, 2) + "\n");
  writeFixture(root, "src-tauri/Cargo.toml", '[package]\nname = "trading-worker"\nversion = "1.2.3"\n');
  writeFixture(root, "src-tauri/Cargo.lock", '[[package]]\nname = "trading-worker"\nversion = "1.2.3"\n');
  writeFixture(root, "pyproject.toml", '[project]\nname = "vibe-trading-ai"\nversion = "9.9.9"\n');
  writeFixture(root, "frontend/src/components/layout/Layout.tsx", 'const APP_VERSION = "v1.2.3";\n');
  writeFixture(root, "frontend/src/i18n/locales/en.json", JSON.stringify({ app: { version: "v1.2.3" } }, null, 2) + "\n");
  writeFixture(root, "frontend/src/i18n/locales/zh-CN.json", JSON.stringify({ app: { version: "v1.2.3" } }, null, 2) + "\n");

  assert.throws(
    () => execFileSync(process.execPath, [script, "1.2.3", "--root", root, "--check"], { stdio: "pipe" }),
    /Command failed/
  );
});
