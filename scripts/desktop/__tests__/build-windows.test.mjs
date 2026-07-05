import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const script = readFileSync(join(repoRoot, "scripts", "desktop", "build-windows.ps1"), "utf8");
const installDepsScript = readFileSync(join(repoRoot, "scripts", "desktop", "install-deps.ps1"), "utf8");

test("SkipRuntime still installs and smokes Python dependencies", () => {
  const skipRuntimeBody = /if \(\$SkipRuntime\) \{(?<body>[\s\S]*?)\n  \}/.exec(script)?.groups?.body ?? "";
  assert.ok(skipRuntimeBody, "expected a -SkipRuntime branch in build-windows.ps1");
  assert.doesNotMatch(
    skipRuntimeBody,
    /\breturn\b/,
    "-SkipRuntime must not skip dependency installation and smoke checks"
  );
  assert.match(script, /install-deps\.ps1/, "build must install embedded Python dependencies");
  assert.match(script, /smoke_imports\.py|install-deps\.ps1/, "build must run embedded runtime smoke checks");
});

test("Windows dependency temp requirements are written as UTF-8", () => {
  assert.doesNotMatch(
    installDepsScript,
    /\|\s*Set-Content\s+\$tmpReq(?!\s+-Encoding)/,
    "uv requires requirements files to be UTF-8, not Windows PowerShell's default encoding"
  );
});

test("Windows build assembles console app without requiring Bash", () => {
  assert.doesNotMatch(
    script,
    /&\s+bash\b.*build-console\.sh/,
    "Windows build should not require bash to build console-app"
  );
  assert.match(
    script,
    /build-console\.ps1/,
    "Windows build should call the PowerShell console-app build script"
  );
});
