import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const script = readFileSync(join(repoRoot, "scripts", "desktop", "build-windows.ps1"), "utf8");
const installDepsScript = readFileSync(join(repoRoot, "scripts", "desktop", "install-deps.ps1"), "utf8");
const fetchRuntimeScript = readFileSync(join(repoRoot, "scripts", "desktop", "fetch-runtime.ps1"), "utf8");
const relocateSmokePsScript = readFileSync(join(repoRoot, "scripts", "desktop", "relocate-smoke.ps1"), "utf8");
const relocateSmokeShScript = readFileSync(join(repoRoot, "scripts", "desktop", "relocate-smoke.sh"), "utf8");

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

test("standalone desktop scripts anchor paths to the repository root", () => {
  const rootAnchor = '$Root = (Resolve-Path "$PSScriptRoot\\..\\..").Path';
  assert.ok(installDepsScript.includes(rootAnchor), "install-deps must derive the repository root from PSScriptRoot");
  assert.ok(fetchRuntimeScript.includes(rootAnchor), "fetch-runtime must derive the repository root from PSScriptRoot");
  assert.ok(relocateSmokePsScript.includes(rootAnchor), "PowerShell relocation smoke must derive the repository root from PSScriptRoot");
  assert.match(
    installDepsScript,
    /\$Runtime = Join-Path \$Root "\.desktop-build\\python-runtime"/,
    "install-deps must place its default runtime under the repository root"
  );
  assert.match(
    installDepsScript,
    /\$AgentPath = Join-Path \$Root "agent"/,
    "install-deps smoke must import the repository's agent package"
  );
  assert.match(
    fetchRuntimeScript,
    /\$OutDir = Join-Path \$Root "\.desktop-build\\python-runtime"/,
    "fetch-runtime must place its default output under the repository root"
  );
  assert.match(
    relocateSmokePsScript,
    /\$AgentPath = Join-Path \$Root "agent"/,
    "PowerShell relocation smoke must import the repository's agent package"
  );
  assert.match(
    relocateSmokePsScript,
    /\$env:PYTHONPATH = if \(\$env:PYTHONPATH\)/,
    "PowerShell relocation smoke must pass the agent path to its Python subprocess"
  );
  assert.match(
    relocateSmokeShScript,
    /AGENT_DIR="\$ROOT\/agent"/,
    "shell relocation smoke must import the repository's agent package"
  );
  assert.match(
    relocateSmokeShScript,
    /PYTHONPATH="\$AGENT_DIR\$\{PYTHONPATH:\+\:\$PYTHONPATH\}"/,
    "shell relocation smoke must pass the agent path to its Python subprocess"
  );
});
