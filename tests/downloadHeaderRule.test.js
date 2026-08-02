import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const backgroundSource = readFileSync(new URL("../background.js", import.meta.url), "utf8");
const contentSource = readFileSync(new URL("../content.js", import.meta.url), "utf8");
const injectSource = readFileSync(new URL("../inject.js", import.meta.url), "utf8");
const staticRules = JSON.parse(readFileSync(new URL("../rules.json", import.meta.url), "utf8"));
const ruleSource = backgroundSource.slice(
  backgroundSource.indexOf("async function ensureDownloadHeaderRule"),
  backgroundSource.indexOf("async function probeDownloadContentType")
);
const asrFetchSource = backgroundSource.slice(
  backgroundSource.indexOf("static async fetchAudioResourceWithFallback"),
  backgroundSource.indexOf("static async ensureGroqConnectivity")
);
const downloadMessageSource = backgroundSource.slice(
  backgroundSource.indexOf('if (msg.action === "DOWNLOAD_STREAM")'),
  backgroundSource.indexOf('if (msg.action === "PROBE_URL")')
);

describe("Bilibili media header rule", () => {
  it("sets Referer without rewriting the immutable request Origin", () => {
    expect(ruleSource).toContain('{ header: "Referer", operation: "set", value: "https://www.bilibili.com/" }');
    expect(ruleSource).not.toMatch(/header:\s*["']Origin["']/i);
    expect(staticRules.flatMap((rule) => rule.action?.requestHeaders || []))
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ header: "Origin" })
      ]));
  });

  it("refreshes the safe rule before ASR audio fetching", () => {
    expect(asrFetchSource).toContain("await ensureDownloadHeaderRule(url);");
  });

  it("uses the original extension fetch before the page fallback", () => {
    const extensionFetch = asrFetchSource.indexOf("this.fetchResourceToBlob(url");
    const pageFetch = asrFetchSource.indexOf("this.fetchResourceToBlobFromTab(url");
    expect(extensionFetch).toBeGreaterThan(-1);
    expect(pageFetch).toBeGreaterThan(extensionFetch);
    expect(asrFetchSource).toContain('fallback: "page_fetch"');
  });

  it("rejects HTML responses in the real download context", () => {
    expect(downloadMessageSource).toContain("await probeDownloadContentType(url)");
    expect(downloadMessageSource).toContain("responseMeta.isHtml");
    expect(downloadMessageSource).toContain('DOWNLOAD_URL_EXPIRED');
  });

  it("forces the requested media filename during Chrome filename resolution", () => {
    expect(backgroundSource).toContain("chrome.downloads.onDeterminingFilename?.addListener");
    expect(backgroundSource).toContain('suggest({ filename, conflictAction: "uniquify" })');
    expect(downloadMessageSource).toContain('conflictAction: "uniquify"');
  });

  it("requests fresh DASH signatures before preparing downloads", () => {
    expect(injectSource).toContain("async function refreshDashPlayInfo()");
    expect(injectSource).toContain('fnval: "4048"');
    expect(injectSource).toContain('jsonp: "jsonp"');
    expect(injectSource).toContain("window[callbackName] = (value) => finish(null, value)");
    expect(injectSource).toContain("data: playinfoRefreshActive ? null : resolvePlayInfo()");
    expect(injectSource).toContain('_source: "fresh_playurl"');
    expect(contentSource).toContain("refreshPlayInfoNow(7000, { force: true })");
    expect(contentSource).toContain("if (forceRefresh || !hasUsableStream)");
    expect(contentSource).toContain('String(info?._source || "") === "fresh_playurl"');
    expect(contentSource).toContain("Number(info?._ts || 0) >= startWait");
  });

  it("prefers direct-download CDN fallbacks over mirrorcosov HTML responses", () => {
    expect(contentSource).toContain("function getDirectDownloadHostPriority(url)");
    expect(contentSource).toContain('host.endsWith("akamaized.net") || host.includes("mirrorakam")');
    expect(contentSource).toContain('host.includes("mirrorcosov")');
    expect(contentSource).toContain('status === "unknown" && !unknownCandidate');
    expect(downloadMessageSource).toContain('if (status === "expired")');
  });
});
