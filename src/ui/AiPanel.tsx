import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { CodexModel } from "../ai/protocol";
import type { AiMessage } from "../ai/chatMessages";

export type { AiMessage } from "../ai/chatMessages";
type AiStatus = "idle" | "running" | "disconnected" | "error";
type AiSelection = { model: string; effort: string } | undefined;

const commands = [
  { name: "/model", description: "Choose model" },
  { name: "/effort", description: "Choose reasoning effort" },
  { name: "/status", description: "Show Codex status" },
  { name: "/help", description: "Show available commands" },
] as const;

export function AiPanel({
  messages,
  status,
  isProcessing = status === "running",
  sessionId,
  scrollRequest,
  signedIn,
  onSend,
  onCommand = () => undefined,
  onStop,
  onLogin,
  models = [],
  selection,
  modelCatalogError = null,
  onSelectModel = () => undefined,
  onSelectEffort = () => undefined,
  debug,
}: {
  messages: AiMessage[];
  status: AiStatus;
  isProcessing?: boolean;
  sessionId?: string;
  scrollRequest?: { sessionId: string; id: number };
  signedIn: boolean;
  onSend: (text: string) => void;
  onCommand?: (command: "status" | "help" | "unknown", raw?: string) => void;
  onStop: () => void;
  onLogin: () => void;
  models?: CodexModel[];
  selection?: AiSelection;
  modelCatalogError?: string | null;
  onSelectModel?: (modelId: string) => void;
  onSelectEffort?: (effort: string) => void;
  debug: string[];
}) {
  const [text, setText] = useState("");
  const [picker, setPicker] = useState<"model" | "effort" | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  const selectedModel = models.find((model) => model.id === selection?.model);
  const messagesRef = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  const followLive = useRef(true);
  const scrollToEnd = () => {
    const node = messagesRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  };
  const isAtBottom = (node: HTMLDivElement) =>
    node.scrollHeight - node.scrollTop - node.clientHeight <= 8;
  useLayoutEffect(() => {
    const node = messagesRef.current;
    if (!node || !sessionId) return;
    const saved = positions.current.get(sessionId);
    if (saved === undefined) {
      followLive.current = true;
      scrollToEnd();
    } else {
      node.scrollTop = saved;
      followLive.current = isAtBottom(node);
    }
  }, [sessionId]);
  useLayoutEffect(() => {
    if (scrollRequest?.sessionId !== sessionId) return;
    followLive.current = true;
    scrollToEnd();
  }, [scrollRequest, sessionId]);
  useLayoutEffect(() => {
    if (followLive.current) scrollToEnd();
  }, [messages]);
  const commandMatches = commands.filter((command) =>
    command.name.startsWith(text.trim().toLowerCase()),
  );
  const paletteVisible =
    text.trimStart().startsWith("/") && commandMatches.length > 0 && picker === null;

  const runCommand = (name: (typeof commands)[number]["name"]) => {
    setText("");
    if (name === "/model") setPicker("model");
    else if (name === "/effort") setPicker("effort");
    else onCommand(name.slice(1) as "status" | "help");
  };
  const submit = () => {
    if (!signedIn || !text.trim()) return;
    const command = text.trim().toLowerCase();
    if (command === "/model" || command === "/effort") {
      runCommand(command);
      return;
    }
    if (command === "/status" || command === "/help") {
      runCommand(command);
      return;
    }
    if (command.startsWith("/")) {
      onCommand("unknown", text.trim());
      setText("");
      return;
    }
    onSend(text);
    setText("");
  };
  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (paletteVisible) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setCommandIndex((index) =>
          (index + (event.key === "ArrowDown" ? 1 : commandMatches.length - 1)) %
          commandMatches.length,
        );
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setText("");
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        runCommand(commandMatches[commandIndex].name);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <aside className="ai-panel" aria-label="Codex assistant">
      <header>
        <strong>Codex</strong>
        <span>{status}</span>
      </header>
      {!signedIn && (
        <button type="button" onClick={onLogin}>
          Sign in with ChatGPT
        </button>
      )}
      <div
        ref={messagesRef}
        className="ai-messages"
        onScroll={(event) => {
          const node = event.currentTarget;
          followLive.current = isAtBottom(node);
          if (sessionId) positions.current.set(sessionId, node.scrollTop);
        }}
      >
        {messages.map((message, index) => (
          <p key={index} className={`ai-${message.role}`}>
            {message.text}
            {isProcessing && index === messages.length - 1 && message.role === "assistant" && (
              <TypingIndicator />
            )}
          </p>
        ))}
        {isProcessing && messages.at(-1)?.role !== "assistant" && <TypingIndicator />}
      </div>
      <div className="ai-composer">
        {paletteVisible && (
          <div className="ai-command-palette" role="listbox" aria-label="Commands">
            {commandMatches.map((command, index) => (
              <button
                key={command.name}
                type="button"
                role="option"
                aria-selected={index === commandIndex}
                className={index === commandIndex ? "active" : ""}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => runCommand(command.name)}
              >
                <code>{command.name}</code> <span>{command.description}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          autoFocus
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setCommandIndex(0);
          }}
          onKeyDown={onComposerKeyDown}
          placeholder="Ask Codex to work in this terminal"
        />
        {isProcessing && (
          <button type="button" onClick={onStop}>
            Stop
          </button>
        )}
      </div>
      <div className="ai-model-control">
        <button
          type="button"
          className="ai-model-indicator"
          disabled={!signedIn || !selection}
          onClick={() => setPicker("model")}
          aria-expanded={picker !== null}
        >
          {selection
            ? `${selectedModel?.displayName ?? selection.model} · ${selection.effort}`
            : signedIn
              ? "Codex default"
              : "Sign in to choose model"}
        </button>
        {picker && (
          <div className="ai-model-picker" role="dialog" aria-label="Codex model settings">
            <div className="ai-picker-tabs">
              <button type="button" className={picker === "model" ? "active" : ""} onClick={() => setPicker("model")}>Model</button>
              <button type="button" className={picker === "effort" ? "active" : ""} onClick={() => setPicker("effort")}>Reasoning</button>
              <button type="button" aria-label="Close model settings" onClick={() => setPicker(null)}>×</button>
            </div>
            {modelCatalogError && <p className="ai-picker-error">{modelCatalogError}</p>}
            {picker === "model" && models.map((model) => (
              <button key={model.id} type="button" className={model.id === selection?.model ? "active" : ""} onClick={() => { onSelectModel(model.id); setPicker("effort"); }}>
                {model.displayName}{model.isDefault ? " (default)" : ""}
              </button>
            ))}
            {picker === "effort" && selectedModel?.supportedReasoningEfforts.map((option) => (
              <button key={option.reasoningEffort} type="button" className={option.reasoningEffort === selection?.effort ? "active" : ""} onClick={() => { onSelectEffort(option.reasoningEffort); setPicker(null); }}>
                <strong>{option.reasoningEffort}</strong>{option.description ? ` — ${option.description}` : ""}
              </button>
            ))}
          </div>
        )}
      </div>
      <details className="ai-debug">
        <summary>Debug console ({debug.length})</summary>
        <pre>{debug.join("\n")}</pre>
      </details>
    </aside>
  );
}

function TypingIndicator() {
  return (
    <span className="ai-typing" role="status" aria-label="Codex is working">
      <span aria-hidden="true">.</span>
      <span aria-hidden="true">.</span>
      <span aria-hidden="true">.</span>
    </span>
  );
}
