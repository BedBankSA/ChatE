import { describe, expect, it } from "vitest";
import {
  ALL_MODELS_FAILED_MESSAGE,
  comparisonSettledNotice,
  runStatusText,
  successSummaryText,
  successfulComparisonRuns,
  visibleComparisonRuns,
  type PublicRun,
} from "@/domain/comparison/view";

const base: PublicRun = {
  modelId: "m",
  displayName: "M",
  provider: "openrouter",
  status: "completed",
  message: null,
  outputText: "جواب",
  effort: null,
  labels: [],
  completionMs: null,
};

function run(status: string, modelId = "m"): PublicRun {
  return { ...base, modelId, status };
}

describe("results filtering (الزبدة فقط)", () => {
  it("renders only completed answers and still-running placeholders", () => {
    const runs = [
      run("completed", "a"),
      run("queued", "b"),
      run("running", "c"),
      run("failed", "d"),
      run("incomplete", "e"),
      run("policy_blocked", "f"),
      run("unfit", "g"),
      run("context_exceeded", "h"),
      run("live_disabled", "i"),
      run("cancelled", "j"),
    ];
    expect(visibleComparisonRuns(runs).map((item) => item.modelId)).toEqual(["a", "b", "c"]);
    expect(successfulComparisonRuns(runs).map((item) => item.modelId)).toEqual(["a"]);
  });

  it("keeps the header summary positive-only", () => {
    expect(successSummaryText(0)).toBe("لم تصل إجابات ناجحة بعد.");
    expect(successSummaryText(1)).toBe("تم استلام إجابة واحدة بنجاح.");
    expect(successSummaryText(2)).toBe("تم استلام إجابتين بنجاح.");
    expect(successSummaryText(4)).toBe("تم استلام 4 إجابات بنجاح.");
    expect(successSummaryText(4)).not.toContain("تعذر");
    expect(successSummaryText(4)).not.toContain("فشل");
  });
});
describe("settled result notice", () => {
  it("reports an all-failed comparison as an error, never as a success", () => {
    const allFailed = [run("failed"), run("policy_blocked")];
    expect(comparisonSettledNotice(allFailed)).toEqual({ kind: "error", text: ALL_MODELS_FAILED_MESSAGE });
    expect(comparisonSettledNotice([])).toEqual({ kind: "error", text: "لم تصل إجابات ناجحة بعد." });
    expect(comparisonSettledNotice([run("completed"), run("failed")])).toEqual({
      kind: "success",
      text: successSummaryText(1),
    });
  });

  it("translates every stored status including the comparison-level closed state", () => {
    expect(runStatusText("closed")).toBe("اكتمل");
    expect(runStatusText("failed")).toBe("تعذر");
    expect(runStatusText("something-new")).toBe("something-new");
  });
});
