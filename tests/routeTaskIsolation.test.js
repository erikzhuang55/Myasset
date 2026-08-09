import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const content = readFileSync(new URL("../content.js", import.meta.url), "utf8");

describe("multipart task UI isolation", () => {
  it("ignores results and errors returned after the route changes", () => {
    const runTasksStart = content.indexOf("async function runTasks(tasks, options = {})");
    const runTasksEnd = content.indexOf("async function handleSendChat", runTasksStart);
    const source = content.slice(runTasksStart, runTasksEnd);

    expect(source).toContain("const requestRouteKey = getCurrentRouteVideoKey()");
    expect(source).toContain("stale_task_result_ignored");
    expect(source).toContain("stale_task_error_ignored");
    expect(source).toContain("if (isRequestRouteCurrent())");
  });

  it("clears transient pending and error state during a part switch", () => {
    const resetStart = content.indexOf("function resetPageStateByBvidSwitch");
    const resetEnd = content.indexOf("function resetAllState", resetStart);
    const source = content.slice(resetStart, resetEnd);

    expect(source).toContain("appState.localPending = { tasks: {}, transcription: false }");
    expect(source).toContain("appState.panelErrors = {}");
  });
});
