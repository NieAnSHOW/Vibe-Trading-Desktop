#!/usr/bin/env node
// 桌面控制台独立版本号管理。
// 与 sync-version.mjs(release 语义版本,联动 tauri.conf.json/Cargo.toml/pyproject/frontend)
// 刻意解耦:console-dist/index.html 是独立迭代的 UI 产物,版本空间单独演进。
// 锚点:index.html 里 footer 的 data-console-version="vX.Y.Z"。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const INDEX_PATH = "src-tauri/console-dist/index.html";
const ANCHOR_RE = /data-console-version="(v?(\d+\.\d+\.\d+))"/;
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

function usage() {
  console.error(
    [
      "usage: node scripts/desktop/console-version.mjs [vX.Y.Z|--bump patch|minor|major] [--check] [--root <repo>]",
      "       no args → print current console version",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  let root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  let versionArg = null;
  let bump = null;
  let check = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      root = resolve(argv[++i] ?? ".");
    } else if (arg === "--check") {
      check = true;
    } else if (arg === "--bump") {
      bump = argv[++i];
      if (!["patch", "minor", "major"].includes(bump)) {
        throw new Error(`--bump must be one of patch|minor|major, got: ${bump}`);
      }
    } else if (!versionArg) {
      versionArg = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  if (versionArg && bump) {
    throw new Error("cannot combine a literal version with --bump");
  }
  if (versionArg && !SEMVER_RE.test(versionArg)) {
    throw new Error(`version must look like v1.2.3 or 1.2.3: ${versionArg}`);
  }
  return { root, versionArg, bump, check };
}

function readVersion(root) {
  const html = readFileSync(join(root, INDEX_PATH), "utf8");
  const m = ANCHOR_RE.exec(html);
  if (!m) {
    throw new Error(`could not find data-console-version anchor in ${INDEX_PATH}`);
  }
  return { display: m[1], raw: m[2], html };
}

function bumpVersion(raw, kind) {
  const [, maj, min, pat] = SEMVER_RE.exec(`v${raw}`);
  const next = { major: +maj, minor: +min, patch: +pat };
  if (kind === "major") {
    next.major += 1;
    next.minor = 0;
    next.patch = 0;
  } else if (kind === "minor") {
    next.minor += 1;
    next.patch = 0;
  } else {
    next.patch += 1;
  }
  return `${next.major}.${next.minor}.${next.patch}`;
}

function writeVersion(root, html, nextDisplay) {
  const next = html.replace(ANCHOR_RE, `data-console-version="${nextDisplay}"`);
  writeFileSync(join(root, INDEX_PATH), next, "utf8");
}

function main() {
  const { root, versionArg, bump, check } = parseArgs(process.argv.slice(2));
  const { display, raw, html } = readVersion(root);

  if (check) {
    if (versionArg) {
      const want = versionArg.replace(/^v/, "");
      if (raw !== want) {
        throw new Error(`console version drift: anchor=v${raw}, expected=v${want}`);
      }
      console.log(`console version ok: v${want}`);
      return;
    }
    // ponytail: 无期望值时的 --check 退化为"锚点可解析"自检。
    console.log(`console version ok: ${display}`);
    return;
  }

  const nextDisplay = bump ? `v${bumpVersion(raw, bump)}` : versionArg;
  if (!nextDisplay) {
    console.log(display);
    return;
  }
  if (nextDisplay === display) {
    console.log(`console version already ${display}`);
    return;
  }
  writeVersion(root, html, nextDisplay);
  console.log(`console version ${display} → ${nextDisplay}`);
}

try {
  main();
} catch (error) {
  usage();
  console.error(`error: ${error.message}`);
  process.exit(1);
}
