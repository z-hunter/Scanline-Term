import { describe, expect, it } from "vitest";
import { defaultAiSelection, effectiveAiSelection } from "./modelSelection";
import type { CodexModel } from "./protocol";

const luna: CodexModel = {
  id: "gpt-5.6-luna",
  model: "gpt-5.6-luna",
  displayName: "GPT-5.6-Luna",
  defaultReasoningEffort: "low",
  supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }],
};
const terra: CodexModel = {
  id: "gpt-5.6-terra",
  model: "gpt-5.6-terra",
  displayName: "GPT-5.6-Terra",
  defaultReasoningEffort: "high",
  supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }],
  isDefault: true,
};

describe("AI model selection", () => {
  it("prefers Luna with medium reasoning for a new tab", () => {
    expect(defaultAiSelection([terra, luna])).toEqual({ model: luna.id, effort: "medium" });
  });

  it("falls back to the server default and repairs unsupported efforts", () => {
    expect(defaultAiSelection([terra])).toEqual({ model: terra.id, effort: "high" });
    expect(effectiveAiSelection([terra], { model: terra.id, effort: "low" })).toEqual({ model: terra.id, effort: "high" });
  });
});
