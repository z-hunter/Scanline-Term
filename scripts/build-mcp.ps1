$ErrorActionPreference = "Stop"
$env:TAURI_CONFIG = $null
cargo build --manifest-path (Join-Path $PSScriptRoot "..\src-tauri\Cargo.toml") --release --bin scanline-term-mcp
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
