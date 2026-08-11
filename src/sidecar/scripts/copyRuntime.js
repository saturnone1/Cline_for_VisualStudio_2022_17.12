"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const artifactsRoot = path.resolve(root, "..", "..", "artifacts");
const packageSidecar = path.join(artifactsRoot, "Sidecar");
const packageNodeModules = path.join(artifactsRoot, ".staging", "node_modules");
const packageNodeModulesZip = path.join(packageSidecar, "node_modules.zip");
const packageNodeModulesFingerprint = path.join(packageSidecar, "node_modules.fingerprint");
const source = path.join(dist, "main.js");
const target = path.join(packageSidecar, "cline-sidecar.js");

fs.mkdirSync(packageSidecar, { recursive: true });
for (const directory of ["application", "bootstrap", "domain", "features", "infrastructure", "presentation", "diagnostics", "host", "ipc", "sdk", "webview", "runtime"]) {
  fs.rmSync(path.join(packageSidecar, directory), { recursive: true, force: true });
}
fs.copyFileSync(source, target);
for (const layer of ["application", "bootstrap", "domain", "features", "infrastructure", "presentation"]) {
  copyDirectory(path.join(dist, layer), path.join(packageSidecar, layer));
}
copyDirectory(path.join(root, "node_modules"), packageNodeModules, shouldCopyRuntimeNodeModuleEntry);
fs.writeFileSync(packageNodeModulesFingerprint, fingerprintDirectory(packageNodeModules), "utf8");
createZip(packageNodeModules, packageNodeModulesZip);
linkNodeModulesForLocalSmokeTests(packageNodeModules, path.join(packageSidecar, "node_modules"));

console.log(`Copied ${path.relative(root, source)} -> ${path.relative(root, target)}`);
console.log(`Packed ${path.relative(root, packageNodeModules)} -> ${path.relative(root, packageNodeModulesZip)}`);

function copyDirectory(sourceDir, targetDir, shouldCopyEntry) {
  if (!fs.existsSync(sourceDir)) {
    return;
  }

  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (shouldCopyEntry && !shouldCopyEntry(sourcePath, entry)) {
      continue;
    }

    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath, shouldCopyEntry);
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function shouldCopyRuntimeNodeModuleEntry(sourcePath, entry) {
  if (entry.isDirectory()) {
    return ![
      ".bin",
      ".cache",
      ".github",
      "example",
      "examples",
      "test",
      "tests",
      "__tests__",
      "coverage",
    ].includes(entry.name);
  }

  const extension = path.extname(entry.name).toLowerCase();
  if ([".map", ".ts", ".md", ".markdown"].includes(extension)) {
    return false;
  }

  if (/^(license|licence|copying|changelog|readme|notice)(\..*)?$/i.test(entry.name)) {
    return false;
  }

  return true;
}

function linkNodeModulesForLocalSmokeTests(sourceDir, targetDir) {
  fs.rmSync(targetDir, { recursive: true, force: true });

  try {
    fs.symlinkSync(sourceDir, targetDir, "junction");
  } catch (error) {
    console.warn(`Could not create node_modules junction: ${error.message}`);
  }
}

function createZip(sourceDir, targetZip) {
  fs.rmSync(targetZip, { force: true });

  const result = spawnSync("tar.exe", ["-a", "-cf", targetZip, "-C", sourceDir, "."], {
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`Failed to create ${targetZip}`);
  }
}

function fingerprintDirectory(sourceDir) {
  const hash = crypto.createHash("sha256");
  for (const file of listFiles(sourceDir)) {
    const relativePath = path.relative(sourceDir, file).split(path.sep).join("/");
    const stat = fs.statSync(file);
    hash.update(`${relativePath}|${stat.size}\n`, "utf8");
    hash.update(fs.readFileSync(file));
    hash.update("\n", "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}

function listFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}
