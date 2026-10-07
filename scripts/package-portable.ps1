param(
  [string]$Version = (Get-Content "$PSScriptRoot\..\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json).version
)

$root = Split-Path $PSScriptRoot -Parent
$stage = Join-Path $root "src-tauri\target\portable\Scanline-Term-$Version-portable-x64"
$archive = Join-Path $root "src-tauri\target\release\bundle\portable\Scanline-Term-$Version-portable-x64.zip"
Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path (Join-Path $stage "resources") -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root "src-tauri\target\release\sterm.exe") -Destination $stage
$mcpBinary = Join-Path $root "src-tauri\target\release\scanline-term-mcp.exe"
if (-not (Test-Path -LiteralPath $mcpBinary)) { throw "Build the MCP sidecar first: cargo build --release --bin scanline-term-mcp" }
Copy-Item -LiteralPath $mcpBinary -Destination $stage
Copy-Item -LiteralPath (Join-Path $root "src-tauri\resources\conpty") -Destination (Join-Path $stage "resources") -Recurse
Copy-Item -LiteralPath (Join-Path $root "src-tauri\resources\fonts") -Destination (Join-Path $stage "resources") -Recurse
Copy-Item -LiteralPath (Join-Path $root "src-tauri\resources\presets") -Destination (Join-Path $stage "resources") -Recurse
Copy-Item -LiteralPath (Join-Path $root "README.md") -Destination $stage
New-Item -ItemType Directory -Path (Join-Path $stage "docs") -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root "docs\13-portable-installation.md") -Destination (Join-Path $stage "docs\PORTABLE-INSTALLATION.md")
New-Item -ItemType Directory -Path (Split-Path $archive) -Force | Out-Null
Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
Compress-Archive -Path $stage -DestinationPath $archive
Write-Output $archive
