use std::io::{self, BufRead, BufReader, Write};

use interprocess::local_socket::{GenericNamespaced, Stream, prelude::*};
use serde_json::{Value, json};

const SOCKET_NAME: &str = "scanline-term-mcp";
const PROTOCOL_VERSION: &str = "2025-11-25";

struct BridgeClient {
    reader: Option<BufReader<Stream>>,
    next_id: u64,
}

impl BridgeClient {
    fn new() -> Self {
        Self {
            reader: None,
            next_id: 1,
        }
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        if self.reader.is_none() {
            let name = SOCKET_NAME
                .to_ns_name::<GenericNamespaced>()
                .map_err(|error| format!("invalid MCP socket name: {error}"))?;
            let stream = Stream::connect(name)
                .map_err(|error| format!("Scanline Term MCP mode is unavailable: {error}"))?;
            self.reader = Some(BufReader::new(stream));
        }

        let request_id = self.next_id.to_string();
        self.next_id += 1;
        let request = json!({ "requestId": request_id, "method": method, "params": params });
        let reader = self.reader.as_mut().expect("bridge reader initialized");
        let write_result = serde_json::to_writer(&mut reader.get_mut(), &request)
            .map_err(|error| io::Error::other(error.to_string()))
            .and_then(|_| reader.get_mut().write_all(b"\n"))
            .and_then(|_| reader.get_mut().flush());
        if write_result.is_err() {
            self.reader = None;
            return Err("Scanline Term MCP connection was closed".into());
        }

        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => {
                self.reader = None;
                return Err("Scanline Term MCP connection was closed".into());
            }
            Ok(_) => {}
        }
        let response: Value = serde_json::from_str(line.trim())
            .map_err(|error| format!("invalid Scanline Term response: {error}"))?;
        if let Some(error) = response.get("error").and_then(Value::as_str) {
            return Err(error.to_owned());
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }
}

fn main() {
    let stdin = io::stdin();
    let mut bridge = BridgeClient::new();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                write_json(&json_rpc_error(
                    Value::Null,
                    -32700,
                    &format!("Parse error: {error}"),
                ));
                continue;
            }
        };
        if let Some(response) = handle_request(&mut bridge, &request) {
            write_json(&response);
        }
    }
}

fn handle_request(bridge: &mut BridgeClient, request: &Value) -> Option<Value> {
    let id = request.get("id").cloned();
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if method == "notifications/initialized" || id.is_none() {
        return None;
    }
    let id = id.expect("checked above");
    match method {
        "initialize" => Some(json_rpc_result(
            id,
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "scanline-term", "version": env!("CARGO_PKG_VERSION") },
            }),
        )),
        "ping" => Some(json_rpc_result(id, json!({}))),
        "tools/list" => Some(json_rpc_result(id, json!({ "tools": tool_definitions() }))),
        "tools/call" => {
            let params = request.get("params").and_then(Value::as_object);
            let Some(name) = params
                .and_then(|value| value.get("name"))
                .and_then(Value::as_str)
            else {
                return Some(json_rpc_error(
                    id,
                    -32602,
                    "tools/call requires a tool name",
                ));
            };
            let arguments = params
                .and_then(|value| value.get("arguments"))
                .cloned()
                .unwrap_or_else(|| json!({}));
            match bridge.call(name, arguments) {
                Ok(result) => Some(tool_result(id, result, false)),
                Err(error) => Some(tool_result(id, json!({ "error": error }), true)),
            }
        }
        _ => Some(json_rpc_error(
            id,
            -32601,
            &format!("Unknown MCP method: {method}"),
        )),
    }
}

fn tool_result(id: Value, result: Value, is_error: bool) -> Value {
    let text = serde_json::to_string_pretty(&result).unwrap_or_else(|_| result.to_string());
    json_rpc_result(
        id,
        json!({
            "content": [{ "type": "text", "text": text }],
            "isError": is_error,
            "structuredContent": result,
        }),
    )
}

fn tool_definitions() -> Vec<Value> {
    vec![
        tool(
            "create_terminal",
            "Open an owned Scanline Term console session.",
            json!({
                "type": "object", "properties": {
                    "command": { "type": "string" }, "args": { "type": "array", "items": { "type": "string" } },
                    "cwd": { "type": "string" }, "preset": { "type": "string" },
                    "cols": { "type": "integer", "minimum": 20, "maximum": 300 }, "rows": { "type": "integer", "minimum": 8, "maximum": 150 }
                }, "additionalProperties": false
            }),
        ),
        tool(
            "list_terminals",
            "List console sessions owned by this MCP connection.",
            object_schema(),
        ),
        tool(
            "observe_terminal",
            "Read the current screen and optionally the complete plain-text scrollback.",
            json!({
                "type": "object", "properties": {
                    "handle": { "type": "string" }, "includeScrollback": { "type": "boolean" },
                    "afterSequence": { "type": "integer" }, "quietMs": { "type": "integer" }, "timeoutMs": { "type": "integer" }
                }, "required": ["handle"], "additionalProperties": false
            }),
        ),
        tool(
            "send_terminal_input",
            "Send text or a canonical key to a console TUI.",
            json!({
                "type": "object", "properties": { "handle": { "type": "string" }, "action": input_action_schema() },
                "required": ["handle", "action"], "additionalProperties": false
            }),
        ),
        tool(
            "send_terminal_mouse",
            "Send primary/secondary TUI mouse input or wheel; middle click is reserved by Scanline Term.",
            json!({
                "type": "object", "properties": { "handle": { "type": "string" }, "action": mouse_action_schema() },
                "required": ["handle", "action"], "additionalProperties": false
            }),
        ),
        tool(
            "resize_terminal",
            "Resize an owned console session.",
            json!({
                "type": "object", "properties": { "handle": { "type": "string" }, "cols": { "type": "integer", "minimum": 20, "maximum": 300 }, "rows": { "type": "integer", "minimum": 8, "maximum": 150 } },
                "required": ["handle", "cols", "rows"], "additionalProperties": false
            }),
        ),
        tool(
            "close_terminal",
            "Close an owned console session.",
            json!({
                "type": "object", "properties": { "handle": { "type": "string" } }, "required": ["handle"], "additionalProperties": false
            }),
        ),
    ]
}

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({ "name": name, "description": description, "inputSchema": input_schema })
}

fn object_schema() -> Value {
    json!({ "type": "object", "additionalProperties": false })
}

fn input_action_schema() -> Value {
    json!({
        "oneOf": [
            { "type": "object", "properties": { "kind": { "const": "text" }, "text": { "type": "string", "maxLength": 65536 }, "submit": { "type": "boolean" } }, "required": ["kind", "text"], "additionalProperties": false },
            { "type": "object", "properties": { "kind": { "const": "key" }, "key": { "type": "string", "minLength": 1 }, "ctrl": { "type": "boolean" }, "alt": { "type": "boolean" }, "shift": { "type": "boolean" }, "repeat": { "type": "integer", "minimum": 1, "maximum": 100 } }, "required": ["kind", "key"], "additionalProperties": false }
        ]
    })
}

fn mouse_action_schema() -> Value {
    json!({
        "oneOf": [
            { "type": "object", "properties": { "action": { "enum": ["click", "press", "release"] }, "button": { "enum": ["primary", "secondary"] }, "col": { "type": "integer", "minimum": 1 }, "row": { "type": "integer", "minimum": 1 }, "ctrl": { "type": "boolean" }, "alt": { "type": "boolean" }, "shift": { "type": "boolean" } }, "required": ["action", "button", "col", "row"], "additionalProperties": false },
            { "type": "object", "properties": { "action": { "const": "move" }, "heldButton": { "enum": ["primary", "secondary"] }, "col": { "type": "integer", "minimum": 1 }, "row": { "type": "integer", "minimum": 1 }, "ctrl": { "type": "boolean" }, "alt": { "type": "boolean" }, "shift": { "type": "boolean" } }, "required": ["action", "col", "row"], "additionalProperties": false },
            { "type": "object", "properties": { "action": { "const": "wheel" }, "direction": { "enum": ["up", "down"] }, "steps": { "type": "integer", "minimum": 1, "maximum": 100 }, "col": { "type": "integer", "minimum": 1 }, "row": { "type": "integer", "minimum": 1 }, "ctrl": { "type": "boolean" }, "alt": { "type": "boolean" }, "shift": { "type": "boolean" } }, "required": ["action", "direction", "col", "row"], "additionalProperties": false }
        ]
    })
}

fn json_rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn json_rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn write_json(value: &Value) {
    let mut stdout = io::stdout().lock();
    let _ = serde_json::to_writer(&mut stdout, value);
    let _ = stdout.write_all(b"\n");
    let _ = stdout.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_reports_tools_capability() {
        let mut bridge = BridgeClient::new();
        let response = handle_request(
            &mut bridge,
            &json!({ "id": 1, "method": "initialize", "params": {} }),
        )
        .expect("initialize response");
        assert_eq!(
            response["result"]["capabilities"]["tools"]["listChanged"],
            false
        );
    }

    #[test]
    fn tools_list_contains_terminal_operations() {
        let mut bridge = BridgeClient::new();
        let response = handle_request(&mut bridge, &json!({ "id": 1, "method": "tools/list" }))
            .expect("tools/list response");
        let names = response["result"]["tools"]
            .as_array()
            .expect("tool array")
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect::<Vec<_>>();
        assert!(names.contains(&"observe_terminal"));
        assert!(names.contains(&"send_terminal_mouse"));
    }

    #[test]
    fn initialized_notification_has_no_response() {
        let mut bridge = BridgeClient::new();
        assert!(
            handle_request(
                &mut bridge,
                &json!({ "method": "notifications/initialized" })
            )
            .is_none()
        );
    }
}
