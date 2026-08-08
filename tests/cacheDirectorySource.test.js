import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const backgroundSource = readFileSync(new URL("../background.js", import.meta.url), "utf8");
const contentSource = readFileSync(new URL("../content.js", import.meta.url), "utf8");

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
    expect(contentSource).toContain("const isConfirmedSinglePartVideo = !routeTid && getCurrentRoutePartCount() === 1");
    expect(contentSource).toContain("if (routeCid !== cacheCid) return false");
    expect(contentSource).toContain("allowPendingSinglePartCid");
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
