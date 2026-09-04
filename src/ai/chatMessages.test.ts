import { describe, expect, it } from "vitest";
import { appendAgentDelta, completeAgentMessage } from "./chatMessages";

describe("agent chat messages", () => {
  it("joins only deltas from the same agent message", () => {
    const first = appendAgentDelta([], "item-1", "Hello");
    expect(appendAgentDelta(first, "item-1", " world")).toEqual([
      { role: "assistant", itemId: "item-1", text: "Hello world" },
    ]);
    expect(appendAgentDelta(first, "item-2", "Next")).toHaveLength(2);
  });

  it("keeps earlier commentary when a final agent message arrives", () => {
    const commentary = appendAgentDelta([], "commentary", "Checking output.");
    expect(completeAgentMessage(commentary, "final", "Done.")).toEqual([
      { role: "assistant", itemId: "commentary", text: "Checking output." },
      { role: "assistant", itemId: "final", text: "Done." },
    ]);
  });
});
