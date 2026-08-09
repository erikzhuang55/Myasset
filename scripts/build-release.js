import { copyFileSync, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyDirectory, writeZipFromDirectory } from "./archive.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const manifestPath = join(rootDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const version = String(manifest.version || "").trim();

if (!version) {
  throw new Error("manifest.json 缺少 version，无法打包。");
}

const distDir = join(rootDir, "dist");
const legacyReleaseName = `bilitato-v${version}`;

const releaseTargets = {
  chrome: {
    reviewUrl: "https://chromewebstore.google.com/detail/bilitato-ai%E9%99%AA%E4%BD%A0%E7%9C%8Bb%E7%AB%99/ggddcgdafeeoijoaohcffinbefcbpcga/reviews"
  },
  edge: {
    reviewUrl: process.env.BILITATO_EDGE_REVIEW_URL || "https://microsoftedge.microsoft.com/addons/search/bilitato"
  },
  firefox: {
    reviewUrl: process.env.BILITATO_FIREFOX_REVIEW_URL || "https://addons.mozilla.org/firefox/search/?q=Bilitato"
  }
};

const targetArg = process.argv.find((arg) => arg.startsWith("--target="))?.split("=")[1] || "all";
const targets = targetArg === "all" ? Object.keys(releaseTargets) : [targetArg];

for (const target of targets) {
  if (!releaseTargets[target]) {
    throw new Error(`未知打包目标：${target}。可选值：chrome、edge、firefox、all。`);
  }
}

const files = [
  "background.js",
  "content.js",
  "content.css",
  "inject.js",
  "logger.js",
  "html2canvas.min.js",
  "markdownRenderer.js",
  "storeConfig.js",
  "offscreen.html",
  "offscreen.js",
  "permission-request.html",
  "permission-request.js",
  "sidepanel.html",
  "sidepanel.css",
  "sidepanel.js",
  "rules.json",
  "subtitleProcessor.js"
];

const directories = [
  "assets",
  "content",
  "utils",
  "vendor",
  "node_modules/@ffmpeg/ffmpeg/dist/esm",
  "node_modules/@ffmpeg/core/dist/esm"
];

function copyRequiredFile(relativePath, releaseDir) {
  const source = join(rootDir, relativePath);
  if (!existsSync(source)) {
    throw new Error(`缺少上架必需文件：${relativePath}`);
  }
  copyFileSync(source, join(releaseDir, basename(relativePath)));
}

function copyRequiredDirectory(relativePath, releaseDir) {
  const source = join(rootDir, relativePath);
  const destination = join(releaseDir, relativePath);
  if (!existsSync(source)) {
    throw new Error(`缺少上架必需目录：${relativePath}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  copyDirectory(source, destination);
}

function writeStoreConfig(target, releaseDir) {
  const config = releaseTargets[target];
  const content = `globalThis.BILITATO_STORE_CONFIG = ${JSON.stringify({
    target,
    reviewUrl: config.reviewUrl
  }, null, 2)};\n`;
  writeFileSync(join(releaseDir, "storeConfig.js"), content, "utf8");
}

function createTargetManifest(target) {
  const targetManifest = JSON.parse(JSON.stringify(manifest));
  if (target !== "firefox") return targetManifest;

  targetManifest.permissions = (targetManifest.permissions || [])
    .filter((permission) => permission !== "offscreen" && permission !== "sidePanel");
  delete targetManifest.side_panel;
  targetManifest.sidebar_action = {
    default_title: targetManifest.action?.default_title || targetManifest.name,
    default_panel: "sidepanel.html",
    default_icon: targetManifest.action?.default_icon || targetManifest.icons,
    open_at_install: false
  };
  targetManifest.background = {
    scripts: ["background.js"],
    type: "module"
  };
  targetManifest.browser_specific_settings = {
    gecko: {
      id: process.env.BILITATO_FIREFOX_EXTENSION_ID || "bilitato@erikzhuang55",
      strict_min_version: "140.0",
      data_collection_permissions: {
        required: [
          "authenticationInfo",
          "browsingActivity",
          "personalCommunications",
          "personallyIdentifyingInfo",
          "websiteContent"
        ],
        optional: ["technicalAndInteraction"]
      }
    }
  };
  return targetManifest;
}

function writeTargetManifest(target, releaseDir) {
  const targetManifest = createTargetManifest(target);
  writeFileSync(join(releaseDir, "manifest.json"), `${JSON.stringify(targetManifest, null, 2)}\n`, "utf8");
}

function buildRelease(target) {
  const releaseName = `bilitato-${target}-v${version}`;
  const releaseDir = join(distDir, releaseName);
  const zipPath = join(distDir, `${releaseName}.zip`);

  rmSync(releaseDir, { recursive: true, force: true });
  rmSync(zipPath, { force: true });
  mkdirSync(releaseDir, { recursive: true });

  files.forEach((file) => copyRequiredFile(file, releaseDir));
  directories.forEach((directory) => copyRequiredDirectory(directory, releaseDir));
  writeTargetManifest(target, releaseDir);
  writeStoreConfig(target, releaseDir);

  writeZipFromDirectory(releaseDir, zipPath);
  console.log(`Release package ready: ${zipPath}`);
}

try {
  rmSync(join(distDir, legacyReleaseName), { recursive: true, force: true });
  rmSync(join(distDir, `${legacyReleaseName}.zip`), { force: true });

  for (const target of targets) {
    buildRelease(target);
  }
} catch (error) {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
}
