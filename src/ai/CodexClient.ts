import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { CodexEvent, CodexModel, CodexModelList, Json, Rpc } from "./protocol";

type Listener = (message: Rpc) => void;
type DebugListener = (line: string) => void;
export class CodexClient {
  private id = 1;
  private generation = 0;
  private pending = new Map<
    number,
    { resolve: (result: Json) => void; reject: (reason: Error) => void }
  >();
  private listeners = new Set<Listener>();
  private disconnectListeners = new Set<() => void>();
  private debugListeners = new Set<DebugListener>();
  private unlisten: UnlistenFn[] = [];
  workspace = "";
  async start() {
    const started = await invoke<{ generation: number; workspace: string }>(
      "codex_start",
    );
    this.generation = started.generation;
    this.workspace = started.workspace;
    if (!this.unlisten.length)
      this.unlisten = await Promise.all([
        listen<CodexEvent>("codex-message", ({ payload }) =>
          this.receive(payload),
        ),
        listen<{ generation: number }>("codex-exit", ({ payload }) => {
          if (payload.generation === this.generation)
            this.fail(new Error("Codex app-server disconnected"));
        }),
      ]);
    try {
      await this.request("initialize", {
        clientInfo: { name: "scanline-term", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      await this.notify("initialized");
    } catch (reason) {
      if (!String(reason).includes("Already initialized")) throw reason;
    }
  }
  async request(method: string, params: Json = {}): Promise<Json> {
    const id = this.id++;
    const reply = new Promise<Json>((resolve, reject) =>
      this.pending.set(id, { resolve, reject }),
    );
    const message = { jsonrpc: "2.0" as const, id, method, params };
    this.debug(`→ ${JSON.stringify(message)}`);
    try {
      await invoke("codex_send", { message });
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
    return reply;
  }
  async listModels(): Promise<CodexModel[]> {
    const models: CodexModel[] = [];
    let cursor: string | null | undefined;
    do {
      const result = (await this.request("model/list", {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      })) as unknown as CodexModelList;
      if (!Array.isArray(result.data)) throw new Error("Codex returned an invalid model list");
      models.push(...result.data.filter((model) => !model.hidden));
      cursor = result.nextCursor;
    } while (cursor);
    return models;
  }
  notify(method: string, params: Json = {}) {
    const message = { jsonrpc: "2.0" as const, method, params };
    this.debug(`→ ${JSON.stringify(message)}`);
    return invoke("codex_send", { message });
  }
  respond(id: number, result: Json) {
    const message = { jsonrpc: "2.0" as const, id, result };
    this.debug(`→ ${JSON.stringify(message)}`);
    return invoke("codex_send", { message });
  }
  on(listener: Listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  onDebug(listener: DebugListener) {
    this.debugListeners.add(listener);
    return () => {
      this.debugListeners.delete(listener);
    };
  }
  onDisconnect(listener: () => void) {
    this.disconnectListeners.add(listener);
    return () => {
      this.disconnectListeners.delete(listener);
    };
  }
  async stop() {
    this.fail(new Error("Codex stopped"), false);
    this.unlisten.splice(0).forEach((item) => item());
    await invoke("codex_stop");
  }
  private receive({ generation, message }: CodexEvent) {
    if (generation !== this.generation) return;
    this.debug(`← ${JSON.stringify(message)}`);
    if (message.method) {
      this.listeners.forEach((listener) => listener(message));
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result ?? null);
    }
  }
  private fail(error: Error, disconnected = true) {
    this.pending.forEach(({ reject }) => reject(error));
    this.pending.clear();
    if (disconnected) this.disconnectListeners.forEach((listener) => listener());
  }
  private debug(line: string) {
    this.debugListeners.forEach((listener) => listener(line));
  }
}
