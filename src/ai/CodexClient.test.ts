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

  it("handles start(), pending codex_start, stop(), then start() without stale overwrite", async () => {
    let resolveFirstStart!: (value: { generation: number; workspace: string }) => void;
    let startCallCount = 0;
    mocked.invoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "codex_start") {
        startCallCount++;
        if (startCallCount === 1) {
          return new Promise((resolve) => {
            resolveFirstStart = resolve;
          });
        }
        return Promise.resolve({ generation: 2, workspace: "/workspace/2" });
      }
      if (command === "codex_send") {
        const payload = args as { generation?: number; message?: { id?: number } };
        if (payload?.message?.id !== undefined) {
          queueMicrotask(() => {
            receive({
              generation: payload.generation ?? 2,
              message: { jsonrpc: "2.0", id: payload.message!.id, result: {} },
            });
          });
        }
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });

    const firstStart = client.start();
    await client.stop();
    const secondStart = client.start();
    await secondStart;

    expect(client.workspace).toBe("/workspace/2");

    resolveFirstStart({ generation: 1, workspace: "/workspace/1" });
    await firstStart;

    expect(client.workspace).toBe("/workspace/2");
    expect(mocked.invoke).toHaveBeenCalledWith("codex_stop", { generation: 1 });
  });

  it("cancels and rejects stale initialize request and stops generation when start A sends initialize before start B becomes active", async () => {
    let startACallCount = 0;
    mocked.invoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "codex_start") {
        startACallCount++;
        if (startACallCount === 1) {
          return Promise.resolve({ generation: 1, workspace: "/workspace/1" });
        }
        return Promise.resolve({ generation: 2, workspace: "/workspace/2" });
      }
      if (command === "codex_send") {
        const payload = args as { generation?: number; message?: { id?: number; method?: string } };
        if (payload?.generation === 1 && payload?.message?.method === "initialize") {
          return Promise.resolve(undefined);
        }
        if (payload?.message?.id !== undefined) {
          queueMicrotask(() => {
            receive({
              generation: payload.generation ?? 2,
              message: { jsonrpc: "2.0", id: payload.message!.id, result: {} },
            });
          });
        }
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });

    const startA = client.start();
    await vi.waitFor(() => {
      expect(mocked.invoke).toHaveBeenCalledWith(
        "codex_send",
        expect.objectContaining({
          generation: 1,
          message: expect.objectContaining({ method: "initialize" }),
        }),
      );
    });

    const startB = client.start();
    await startB;
    await startA;

    expect(mocked.invoke).toHaveBeenCalledWith("codex_stop", { generation: 1 });
    expect(client.workspace).toBe("/workspace/2");

    const pendingMap = (client as unknown as { pending: Map<number, unknown> }).pending;
    expect(pendingMap.size).toBe(0);
  });
});
