import { describe, expect, it } from "vitest";
import {
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
