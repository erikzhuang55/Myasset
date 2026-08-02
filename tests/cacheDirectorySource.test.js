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
    expect(contentSource).toContain("if (!(cid > 0)) return null");
    expect(contentSource).toContain('reason: "route_cid_pending"');
    expect(contentSource).toContain('console.log("[CACHE_DIRECTORY]"');
  });

  it("only allows a missing route CID for a confirmed single-part video", () => {
    expect(backgroundSource).toContain("if (!(cid > 0)) return null");
    expect(backgroundSource).toContain('reason: "route_cid_pending"');
    expect(contentSource).toContain("return getCurrentRouteCid();");
    expect(contentSource).toContain("const isConfirmedSinglePartVideo = !routeTid && getCurrentRoutePartCount() === 1");
    expect(contentSource).toContain("if (routeCid !== cacheCid) return false");
  });

  it("keeps subtitle variants in the legacy top-level cache", () => {
    expect(backgroundSource).toContain("rootSubtitlePatch.subtitleVariants = variants");
    expect(backgroundSource).toContain("subtitleVariants: rootSubtitlePatch.subtitleVariants || current.subtitleVariants || {}");
  });
});
