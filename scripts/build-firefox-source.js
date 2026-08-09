import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyDirectory, writeZipFromDirectory } from "./archive.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const distDir = join(rootDir, "dist");
const manifest = JSON.parse(readFileSync(join(rootDir, "manifest.json"), "utf8"));
const version = String(manifest.version || "").trim();

if (!version) {
  throw new Error("manifest.json 缺少 version，无法生成 Firefox 源码包。");
}

const sourceName = `bilitato-firefox-v${version}-source`;
const sourceDir = join(distDir, sourceName);
const zipPath = join(distDir, `${sourceName}.zip`);

const sourceFiles = [
  "AMO_BUILD.md",
  "Privacy Policy.md",
  "README.md",
  "background.js",
  "content.css",
  "content.js",
  "html2canvas.min.js",
  "inject.js",
  "logger.js",
  "manifest.json",
  "markdownRenderer.js",
  "offscreen.html",
  "offscreen.js",
  "package-lock.json",
  "package.json",
  "permission-request.html",
  "permission-request.js",
  "rules.json",
  "sidepanel.css",
  "sidepanel.html",
  "sidepanel.js",
  "storeConfig.js",
  "subtitleProcessor.js",
  "vitest.config.js"
];

const sourceDirectories = [
  "assets",
  "content",
  "scripts",
  "supabase",
  "tests",
  "utils"
];

function copySourcePath(relativePath) {
  const source = join(rootDir, relativePath);
  const destination = join(sourceDir, relativePath);
  if (!existsSync(source)) {
    throw new Error(`源码包缺少必需路径：${relativePath}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  if (sourceDirectories.includes(relativePath)) {
    copyDirectory(source, destination);
  } else {
    copyFileSync(source, destination);
  }
}

rmSync(sourceDir, { recursive: true, force: true });
rmSync(zipPath, { force: true });
mkdirSync(sourceDir, { recursive: true });
sourceFiles.forEach(copySourcePath);
sourceDirectories.forEach(copySourcePath);
writeZipFromDirectory(sourceDir, zipPath);

console.log(`Firefox source package ready: ${zipPath}`);
