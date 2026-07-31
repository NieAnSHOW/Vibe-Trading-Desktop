#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER_RE = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

function usage() {
  console.error("usage: node scripts/desktop/sync-version.mjs <vX.Y.Z|X.Y.Z> [--root <repo>] [--check]");
}

function parseArgs(argv) {
  let versionArg = null;
  let root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  let check = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("--root requires a path");
      }
      root = resolve(next);
      i += 1;
    } else if (arg === "--check") {
      check = true;
    } else if (!versionArg) {
      versionArg = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }

  if (!versionArg) {
    throw new Error("missing version argument");
  }

  const match = SEMVER_RE.exec(versionArg);
  if (!match) {
    throw new Error(`version must look like v1.2.3 or 1.2.3: ${versionArg}`);
  }

  return { version: match[1], displayVersion: `v${match[1]}`, root, check };
}

function readText(root, path) {
  return readFileSync(join(root, path), "utf8");
}

function writeText(root, path, content) {
  writeFileSync(join(root, path), content, "utf8");
}

function updateJson(root, path, updater) {
  const current = readText(root, path);
  const data = JSON.parse(current);
  updater(data);
  return `${JSON.stringify(data, null, 2)}\n`;
}

function replaceRequired(content, pattern, replacement, path) {
  if (!pattern.test(content)) {
    throw new Error(`could not find version field in ${path}`);
  }
  return content.replace(pattern, replacement);
}

function plannedUpdates(root, version, displayVersion) {
  return [
    {
      path: "src-tauri/tauri.conf.json",
      next: updateJson(root, "src-tauri/tauri.conf.json", (data) => {
        data.version = version;
      }),
    },
    {
      path: "src-tauri/Cargo.toml",
      next: replaceRequired(
        readText(root, "src-tauri/Cargo.toml"),
        /^version = "[^"]+"/m,
        `version = "${version}"`,
        "src-tauri/Cargo.toml"
      ),
    },
    {
      path: "pyproject.toml",
      next: replaceRequired(
        readText(root, "pyproject.toml"),
        /^version = "[^"]+"/m,
        `version = "${version}"`,
        "pyproject.toml"
      ),
    },
    {
      path: "src-tauri/Cargo.lock",
      next: replaceRequired(
        readText(root, "src-tauri/Cargo.lock"),
        /(\[\[package\]\]\nname = "trading-worker"\nversion = ")[^"]+(")/,
        `$1${version}$2`,
        "src-tauri/Cargo.lock"
      ),
    },
    {
      path: "frontend/src/components/layout/Layout.tsx",
      next: replaceRequired(
        readText(root, "frontend/src/components/layout/Layout.tsx"),
        /const APP_VERSION = "v[^"]+";/,
        `const APP_VERSION = "${displayVersion}";`,
        "frontend/src/components/layout/Layout.tsx"
      ),
    },
    {
      path: "frontend/src/i18n/locales/en.json",
      next: updateJson(root, "frontend/src/i18n/locales/en.json", (data) => {
        data.app.version = displayVersion;
      }),
    },
    {
      path: "frontend/src/i18n/locales/zh-CN.json",
      next: updateJson(root, "frontend/src/i18n/locales/zh-CN.json", (data) => {
        data.app.version = displayVersion;
      }),
    },
  ];
}

function main() {
  const { version, displayVersion, root, check } = parseArgs(process.argv.slice(2));
  const updates = plannedUpdates(root, version, displayVersion);
  const changed = updates.filter(({ path, next }) => readText(root, path) !== next);

  if (check) {
    if (changed.length > 0) {
      throw new Error(`version drift detected in: ${changed.map(({ path }) => path).join(", ")}`);
    }
    console.log(`All version surfaces already match ${displayVersion}.`);
    return;
  }

  for (const { path, next } of changed) {
    writeText(root, path, next);
    console.log(`updated ${path}`);
  }

  if (changed.length === 0) {
    console.log(`All version surfaces already match ${displayVersion}.`);
  } else {
    console.log(`Synchronized release version ${displayVersion}.`);
  }
}

try {
  main();
} catch (error) {
  usage();
  console.error(`error: ${error.message}`);
  process.exit(1);
}
