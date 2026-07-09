#!/usr/bin/env node
// 桌面控制台版本号管理，读写 tauri.conf.json 的 version 字段。
// Console UI 内 VersionFooter.vue 直接 import tauri.conf.json 取值。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TAURI_CONF_PATH = "src-tauri/tauri.conf.json";
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function usage() {
  console.error(
    [
      "usage: node scripts/desktop/console-version.mjs [X.Y.Z|--bump patch|minor|major] [--check] [--root <repo>]",
      "       no args → print current version",
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
        throw new Error(
          `--bump must be one of patch|minor|major, got: ${bump}`,
        );
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
    throw new Error(`version must look like 1.2.3: ${versionArg}`);
  }
  return { root, versionArg, bump, check };
}

function readConf(root) {
  const raw = readFileSync(join(root, TAURI_CONF_PATH), "utf8");
  const conf = JSON.parse(raw);
  if (!SEMVER_RE.test(conf.version)) {
    throw new Error(
      `invalid version field in ${TAURI_CONF_PATH}: ${conf.version}`,
    );
  }
  return { version: conf.version, conf };
}

function writeConf(root, conf) {
  writeFileSync(
    join(root, TAURI_CONF_PATH),
    JSON.stringify(conf, null, 2) + "\n",
    "utf8",
  );
}

function bumpVersion(raw, kind) {
  const [maj, min, pat] = raw.split(".").map(Number);
  if (kind === "major") return `${maj + 1}.0.0`;
  if (kind === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

function main() {
  const { root, versionArg, bump, check } = parseArgs(process.argv.slice(2));
  const { version, conf } = readConf(root);

  if (check) {
    if (versionArg && version !== versionArg) {
      throw new Error(
        `version drift: actual=${version}, expected=${versionArg}`,
      );
    }
    console.log(`version ok: ${version}`);
    return;
  }

  const next = bump ? bumpVersion(version, bump) : versionArg;
  if (!next) {
    console.log(version);
    return;
  }
  if (next === version) {
    console.log(`version already ${version}`);
    return;
  }

  writeConf(root, { ...conf, version: next });
  console.log(`${version} → ${next}`);
}

try {
  main();
} catch (error) {
  usage();
  console.error(`error: ${error.message}`);
  process.exit(1);
}
