"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const packageSidecar = path.resolve(root, "..", "VsClineAgent", "Sidecar");
const packageNodeModules = path.resolve(root, "..", "VsClineAgent", "M", "node_modules");
const packageNodeModulesZip = path.join(packageSidecar, "node_modules.zip");
const source = path.join(dist, "main.js");
const target = path.join(packageSidecar, "cline-sidecar.js");

fs.mkdirSync(packageSidecar, { recursive: true });
fs.copyFileSync(source, target);
copyDirectory(path.join(dist, "host"), path.join(packageSidecar, "host"));
copyDirectory(path.join(dist, "ipc"), path.join(packageSidecar, "ipc"));
copyDirectory(path.join(dist, "sdk"), path.join(packageSidecar, "sdk"));
copyDirectory(path.join(dist, "diagnostics"), path.join(packageSidecar, "diagnostics"));
copyDirectory(path.join(dist, "webview"), path.join(packageSidecar, "webview"));
copyDirectory(path.join(root, "node_modules"), packageNodeModules, shouldCopyRuntimeNodeModuleEntry);
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
