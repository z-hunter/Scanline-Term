import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  invoke: vi.fn(),
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocked.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (name: string, handler: (event: { payload: unknown }) => void) => {
      mocked.handlers.set(name, handler);
      return () => mocked.handlers.delete(name);
    },
  ),
}));

import { CodexClient } from "./CodexClient";

describe("CodexClient", () => {
  let client: CodexClient;
  let receive: (event: { generation: number; message: unknown }) => void;

  beforeEach(() => {
    mocked.invoke.mockReset();
    mocked.handlers.clear();
    client = new CodexClient();
    receive = (
      client as unknown as {
        receive: (event: { generation: number; message: unknown }) => void;
      }
    ).receive.bind(client);
  });

  it("removes the pending id when invoke('codex_send') rejects", async () => {
    mocked.invoke.mockRejectedValue(new Error("IPC transmission error"));

    await expect(client.request("test_method", { foo: "bar" })).rejects.toThrow(
      "IPC transmission error",
    );

    // Verify pending map does not retain the entry
    // Access private pending map for assertion
    const pendingMap = (client as unknown as { pending: Map<number, unknown> })
      .pending;
    expect(pendingMap.size).toBe(0);
  });

  it("preserves reply-promise behavior for successful sends", async () => {
    mocked.invoke.mockResolvedValue(undefined);

    const promise = client.request("test_method", { hello: "world" });

    // Pending map has the entry while waiting
    const pendingMap = (client as unknown as { pending: Map<number, unknown> })
      .pending;
    expect(pendingMap.size).toBe(1);

    // Simulate response arriving
    receive({
      generation: 0,
      message: {
        jsonrpc: "2.0",
        id: 1,
        result: { status: "ok" },
      },
    });

    const result = await promise;
    expect(result).toEqual({ status: "ok" });
    expect(pendingMap.size).toBe(0);
  });

  it("loads every visible page of the model catalog", async () => {
    mocked.invoke.mockResolvedValue(undefined);

    const models = client.listModels();
    receive({ generation: 0, message: { jsonrpc: "2.0", id: 1, result: { data: [{ id: "luna", model: "luna", displayName: "Luna", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }], nextCursor: "next" } } });
    await vi.waitFor(() => expect(mocked.invoke).toHaveBeenCalledTimes(2));
    receive({ generation: 0, message: { jsonrpc: "2.0", id: 2, result: { data: [{ id: "hidden", model: "hidden", displayName: "Hidden", hidden: true, defaultReasoningEffort: "low", supportedReasoningEfforts: [] }, { id: "terra", model: "terra", displayName: "Terra", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], nextCursor: null } } });

    await expect(models).resolves.toMatchObject([{ id: "luna" }, { id: "terra" }]);
    expect(mocked.invoke).toHaveBeenNthCalledWith(1, "codex_send", expect.objectContaining({ message: expect.objectContaining({ method: "model/list", params: { limit: 100, includeHidden: false } }) }));
    expect(mocked.invoke).toHaveBeenNthCalledWith(2, "codex_send", expect.objectContaining({ message: expect.objectContaining({ method: "model/list", params: { limit: 100, includeHidden: false, cursor: "next" } }) }));
  });

  it("rejects an invalid model-list response", async () => {
    mocked.invoke.mockResolvedValue(undefined);

    const models = client.listModels();
    receive({ generation: 0, message: { jsonrpc: "2.0", id: 1, result: null } });

    await expect(models).rejects.toThrow("Codex returned an invalid model list");
  });

  it("rejects a repeated model-list cursor", async () => {
    mocked.invoke.mockResolvedValue(undefined);

    const models = client.listModels();
    receive({ generation: 0, message: { jsonrpc: "2.0", id: 1, result: { data: [], nextCursor: "again" } } });
    await vi.waitFor(() => expect(mocked.invoke).toHaveBeenCalledTimes(2));
    receive({ generation: 0, message: { jsonrpc: "2.0", id: 2, result: { data: [], nextCursor: "again" } } });

    await expect(models).rejects.toThrow("Codex returned a repeated model cursor");
  });
});
