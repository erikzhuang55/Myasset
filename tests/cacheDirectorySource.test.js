import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const backgroundSource = readFileSync(new URL("../background.js", import.meta.url), "utf8");
const contentSource = readFileSync(new URL("../content.js", import.meta.url), "utf8");
const injectSource = readFileSync(new URL("../inject.js", import.meta.url), "utf8");

function readStandaloneFunction(source, name) {
  const match = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  if (!match) throw new Error(`Missing function: ${name}`);
  return Function(`"use strict"; ${match[0]}; return ${name};`)();
}

function readFunctionWithContext(source, name, context) {
  const match = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  if (!match) throw new Error(`Missing function: ${name}`);
  const keys = Object.keys(context);
  return Function(...keys, `"use strict"; ${match[0]}; return ${name};`)(...keys.map((key) => context[key]));
}

describe("CID-scoped AI cache with legacy subtitle flow", () => {
  it("keeps subtitles at the top while AI results remain in CID parts", () => {
    expect(backgroundSource).toContain("const VIDEO_CACHE_SCHEMA_VERSION = 3");
    expect(backgroundSource).toContain("const TOP_LEVEL_SUBTITLE_CACHE_FIELDS");
    expect(backgroundSource).toContain("...rootSubtitlePatch");
    expect(backgroundSource).toContain('throw new Error("写入分 P 缓存时缺少 cid")');
  });

  it("selects the active CID before content consumes a storage change", () => {
    expect(contentSource).toContain("function selectCacheDirectoryPart(");
    expect(contentSource).toMatch(/cache: selectCacheDirectoryPart\([\s\S]*?getCurrentRouteCid\(\)/);
    expect(contentSource).toContain("const pendingPartKey = `${bvid.toLowerCase()}::single-pending`");
    expect(contentSource).toContain("if (allowPendingSinglePart && pendingPart");
    expect(contentSource).toContain('reason: "route_cid_pending"');
    expect(contentSource).toContain('console.log("[CACHE_DIRECTORY]"');
  });

  it("only allows a missing route CID for a confirmed single-part video", () => {
    expect(backgroundSource).toContain("Number(context?.partCount || 0) !== 1");
    expect(backgroundSource).toContain("function isPendingSinglePartContext");
    expect(backgroundSource).toContain("promotePendingSinglePartCache");
    expect(backgroundSource).toContain("Object.values(cache.parts)");
    expect(backgroundSource).toContain("allowPendingSinglePartCid");
    expect(backgroundSource).toContain('reason: "route_cid_pending"');
    expect(contentSource).toContain("return getCurrentRouteCid();");
    expect(contentSource).toContain("const isConfirmedSinglePartVideo = !routeTid && confirmedPartCount === 1");
    expect(contentSource).toContain("if (routeCid !== cacheCid) return false");
    expect(contentSource).toContain("allowPendingSinglePartCid");
  });

  it("uses confirmed single-part cache metadata while route CID is still unresolved", () => {
    const selectCacheDirectoryPart = readFunctionWithContext(contentSource, "selectCacheDirectoryPart", {
      normalizeBvidCase: (value) => String(value || "").toLowerCase(),
      getRoutePartId: () => "",
      getCurrentRoutePartCount: () => 0
    });
    const cache = {
      bvid: "BV1SINGLE",
      cid: 123,
      partCount: 1,
      parts: {
        "bv1single::123": {
          cid: 123,
          partCount: 1,
          rawSubtitle: [{ text: "单 P 字幕" }]
        }
      }
    };

    expect(selectCacheDirectoryPart(cache, "BV1SINGLE", 0)?.rawSubtitle).toHaveLength(1);

    cache.partCount = 2;
    expect(selectCacheDirectoryPart(cache, "BV1SINGLE", 0)).toBeNull();
  });

  it("recovers CID and part count from Bilibili pagelist metadata", () => {
    const selectBiliPagelistIdentity = readStandaloneFunction(backgroundSource, "selectBiliPagelistIdentity");
    const pages = [
      { page: 1, cid: 101 },
      { page: 2, cid: 202 },
    ];

    expect(selectBiliPagelistIdentity(pages, 2)).toEqual({ cid: 202, partCount: 2 });
    expect(selectBiliPagelistIdentity([{ page: 1, cid: 303 }], 1)).toEqual({ cid: 303, partCount: 1 });
    expect(backgroundSource).toContain("async function resolveSubtitleCaptureIdentity(");
    expect(backgroundSource).toContain("https://api.bilibili.com/x/player/pagelist?bvid=");
    expect(backgroundSource).toContain("async function resolveBiliPagelistIdentityInPage(");
    expect(backgroundSource).toContain('source: "pagelist_page"');
    expect(contentSource).toContain("rawBvid: String(getBvidFromUrl(location.href)");
    expect(contentSource).toContain("isSubtitleUiLoading() || appState.subtitleCacheSyncPending");
  });

  it("captures CID from Bilibili subtitle metadata before the subtitle body arrives", () => {
    expect(injectSource).toContain("function getSubtitleMetadataIdentity(rawUrl)");
    expect(injectSource).toContain('/\\/x\\/v2\\/subtitle\\/web\\/view$/i.test(parsed.pathname)');
    expect(injectSource).toContain('parsed.searchParams.get("oid")');
    expect(injectSource).toContain('parsed.searchParams.get("pid")');
    expect(injectSource).toContain("rememberSubtitleMetadataIdentity(url, requestMeta)");
    expect(injectSource).toContain("rememberSubtitleMetadataIdentity(rawUrl, this.__biliRequestMeta)");
    expect(injectSource).toContain('emitLog("subtitle_identity_observed"');
    expect(injectSource).toContain("subtitleIdentityMatchesRoute");
    expect(injectSource).toContain("Number(latestSubtitleIdentity?.aid || 0) > 0");
    expect(injectSource).toContain("Number(latestSubtitleIdentity.aid) === currentAid");
    expect(injectSource).toContain("Number(latestSubtitleIdentity.cid) === referenceCid");
    expect(injectSource).toContain("keepCurrentSubtitleIdentity");
    expect(injectSource.indexOf("subtitleIdentityMatchesRoute ? Number(latestSubtitleIdentity?.cid)"))
      .toBeLessThan(injectSource.indexOf("|| referenceCid;"));
    expect(backgroundSource).toContain("if (currentCid > 0) {");
  });

  it("does not trust a subtitle metadata CID until its AID and route CID agree", () => {
    const identityBlockStart = injectSource.indexOf("const subtitleIdentityMatchesRoute =");
    const identityBlockEnd = injectSource.indexOf("const cid =", identityBlockStart);
    const identityBlock = injectSource.slice(identityBlockStart, identityBlockEnd);

    expect(identityBlock).toContain("latestSubtitleIdentity?.verified === true");
    expect(identityBlock).toContain("Number(latestSubtitleIdentity.aid) === currentAid");
    expect(identityBlock).toContain("Number(latestSubtitleIdentity.cid) === referenceCid");
    expect(injectSource).toContain("const verified = aidMatches && cidMatches");
    expect(injectSource).toContain("aid: identity.aid");
  });

  it("reconciles a detected subtitle CID into the task cache after storage arrived first", () => {
    expect(contentSource).toContain("function getVerifiedSubtitleCidForCurrentRoute(");
    expect(contentSource).toContain("getCurrentRouteCid() || getVerifiedSubtitleCidForCurrentRoute(target)");
    expect(contentSource).toContain("syncActiveCacheByBvid(incomingBvid).catch(() => {})");
  });

  it("restarts subtitle timing and DOM observation on inject route switches", () => {
    const routeSwitchStart = contentSource.indexOf('if (msgType === "BILI_ROUTE_SWITCH")');
    const routeSwitchEnd = contentSource.indexOf('if (msgType !== "BILI_SUBTITLE_DATA") return;', routeSwitchStart);
    const routeSwitchBlock = contentSource.slice(routeSwitchStart, routeSwitchEnd);

    expect(routeSwitchBlock).toContain("appState.injectBvidChangedAt = Date.now()");
    expect(routeSwitchBlock).toContain("beginSubtitleObservation(routeBvid)");
  });

  it("treats an omitted p parameter and p=1 as the same route part", () => {
    const normalizeComparablePartId = readStandaloneFunction(contentSource, "normalizeComparablePartId");
    expect(normalizeComparablePartId("")).toBe("1");
    expect(normalizeComparablePartId(null)).toBe("1");
    expect(normalizeComparablePartId("1")).toBe("1");
    expect(normalizeComparablePartId("01")).toBe("1");
    expect(normalizeComparablePartId("2")).toBe("2");
    expect(contentSource).toContain("&& routeTid === tabStateTid");
    expect(contentSource).toContain("normalizeComparablePartId(cacheTid) === normalizeComparablePartId(routeTid)");
    expect(contentSource).toContain("`${bvid.toLowerCase()}|${normalizeComparablePartId(p)}`");
  });

  it("preserves current subtitles while the route CID is still unresolved", () => {
    expect(contentSource).toContain("const canPreserveCurrentSubtitleCache = !acceptedCache");
    expect(contentSource).toContain("&& !(routeCid > 0)");
    expect(contentSource).toContain("&& normalizeBvidCase(appState.cache?.bvid || \"\") === target");
    expect(contentSource).toContain("&& hasSubtitleInCache(appState.cache)");
    expect(contentSource).toContain('logPartScopeDiagnostic("cache_preserved_while_cid_pending"');
  });

  it("keeps verified ready subtitles when a same-route reset arrives late", () => {
    const normalizeComparablePartId = readStandaloneFunction(contentSource, "normalizeComparablePartId");
    const coordinator = {
      phase: "ready",
      routeKey: "bv1test|3",
      rowsRouteKey: "bv1test|3",
      rows: [{ text: "当前分 P 字幕" }],
      rowsCid: 300
    };
    const shouldPreserve = readFunctionWithContext(contentSource, "shouldPreserveReadySubtitleForRoute", {
      normalizeComparablePartId,
      subtitleUiCoordinator: coordinator,
      logSubtitleDiagnostic() {}
    });

    expect(shouldPreserve("BV1TEST", "3", 300)).toBe(true);
    expect(shouldPreserve("BV1TEST", "2", 300)).toBe(false);
    expect(shouldPreserve("BV1TEST", "3", 200)).toBe(false);
    coordinator.phase = "probing";
    expect(shouldPreserve("BV1TEST", "3", 300)).toBe(false);
    expect(contentSource).toContain("function shouldPreserveReadySubtitleForRoute(bvid, p, cid = 0)");
    expect(contentSource).toContain('subtitleUiCoordinator.phase === "ready"');
    expect(contentSource).toContain("subtitleUiCoordinator.rowsRouteKey === routeKey");
    expect(contentSource).toContain("if (targetCid > 0 && rowsCid !== targetCid) return false");
    expect(contentSource).toContain('logSubtitleDiagnostic("route_reset_preserved"');
    expect(contentSource).toContain("resetAllState({ preserveReadySubtitle })");
    expect(contentSource).toContain("if (!preserveReadySubtitle) clearCCListImmediately()");
  });

  it("keeps subtitle variants in the legacy top-level cache", () => {
    expect(backgroundSource).toContain("rootSubtitlePatch.subtitleVariants = variants");
    expect(backgroundSource).toContain("subtitleVariants: rootSubtitlePatch.subtitleVariants || current.subtitleVariants || {}");
  });
});
