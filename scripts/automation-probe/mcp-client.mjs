/* global process, setTimeout, clearTimeout */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PIPE_NAME = "scanline-term-mcp-dev";
const PROTOCOL_VERSION = "2025-11-25";
const REQUEST_TIMEOUT_MS = 10_000;
const ALLOWED_TOOLS = new Set([
  "create_terminal",
  "list_terminals",
  "observe_terminal",
  "send_terminal_input",
  "close_terminal",
]);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sidecarPath = path.join(repoRoot, "src-tauri", "target", "debug", "scanline-term-mcp.exe");
const child = spawn(sidecarPath, ["--pipe", PIPE_NAME], {
  cwd: repoRoot,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let nextId = 1;
let closed = false;
let inputQueue = Promise.resolve();
const pending = new Map();
const childLines = createInterface({ input: child.stdout });

function writeResponse(response) {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function diagnostic(message) {
  process.stderr.write(`${message}\n`);
}

function rejectAll(reason) {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
  pending.clear();
}

function onChildLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    diagnostic("MCP sidecar emitted invalid JSON on stdout");
    return;
  }

  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  clearTimeout(entry.timer);
  if (message.error) {
    entry.reject(new Error(message.error.message || "MCP JSON-RPC request failed"));
  } else {
    entry.resolve(message.result);
  }
}

childLines.on("line", onChildLine);
// Drain stderr without forwarding it: child diagnostics may echo request data.
child.stderr.resume();

child.on("error", (error) => {
  closed = true;
  rejectAll(`Could not start debug MCP sidecar (${error.code || "spawn error"})`);
});
child.on("close", (code) => {
  closed = true;
  rejectAll(`Debug MCP sidecar closed (${code ?? "no exit code"})`);
});

function rpc(method, params = {}) {
  if (closed || child.stdin.destroyed) return Promise.reject(new Error("Debug MCP sidecar is closed"));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP ${method} timed out after ${REQUEST_TIMEOUT_MS} ms`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
      if (!error) return;
      pending.delete(id);
      clearTimeout(timer);
      reject(new Error(`MCP ${method} write failed`));
    });
  });
}

async function initialize() {
  await rpc("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "scanline-term-automation-probe", version: "1.0.0" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
}

async function callTool(name, args) {
  if (!ALLOWED_TOOLS.has(name)) throw new Error(`Unsupported MCP tool: ${name}`);
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("arguments must be a JSON object");
  }
  const response = await rpc("tools/call", { name, arguments: args });
  if (response?.isError) {
    const message = response.structuredContent?.error
      || response.content?.find((item) => item.type === "text")?.text
      || "MCP tool reported an error";
    throw new Error(String(message));
  }
  return response?.structuredContent ?? response;
}

async function handleLine(line) {
  let request;
  try {
    request = JSON.parse(line);
    if (!request || typeof request !== "object" || typeof request.name !== "string") {
      throw new Error("request must contain a string name and object arguments");
    }
    const result = await callTool(request.name, request.arguments ?? {});
    writeResponse({ ok: true, result });
  } catch (error) {
    writeResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function shutdown() {
  if (closed) return;
  child.stdin.end();
  await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    new Promise((resolve) => setTimeout(resolve, 500)),
  ]);
  if (!child.killed && child.exitCode === null) child.kill();
}

async function run() {
  try {
    await initialize();
  } catch (error) {
    writeResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    await shutdown();
    process.exitCode = 1;
    return;
  }

  // Do not consume commands until the MCP initialize handshake has completed.
  const inputLines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  inputLines.on("line", (line) => {
    if (!line.trim()) return;
    inputQueue = inputQueue.then(() => handleLine(line));
  });
  inputLines.on("close", async () => {
    await inputQueue;
    await shutdown();
  });
}

run().catch(async (error) => {
  diagnostic(error instanceof Error ? error.message : String(error));
  await shutdown();
  process.exitCode = 1;
});
