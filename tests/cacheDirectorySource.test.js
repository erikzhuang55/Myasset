import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const backgroundSource = readFileSync(new URL("../background.js", import.meta.url), "utf8");
const contentSource = readFileSync(new URL("../content.js", import.meta.url), "utf8");

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

  it("preserves current subtitles while the route CID is still unresolved", () => {
    expect(contentSource).toContain("const canPreserveCurrentSubtitleCache = !acceptedCache");
    expect(contentSource).toContain("&& !(routeCid > 0)");
    expect(contentSource).toContain("&& normalizeBvidCase(appState.cache?.bvid || \"\") === target");
    expect(contentSource).toContain("&& hasSubtitleInCache(appState.cache)");
    expect(contentSource).toContain('logPartScopeDiagnostic("cache_preserved_while_cid_pending"');
  });

  it("keeps subtitle variants in the legacy top-level cache", () => {
    expect(backgroundSource).toContain("rootSubtitlePatch.subtitleVariants = variants");
    expect(backgroundSource).toContain("subtitleVariants: rootSubtitlePatch.subtitleVariants || current.subtitleVariants || {}");
  });
});
