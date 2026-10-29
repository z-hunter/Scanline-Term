param(
  [string]$Version = (Get-Content "$PSScriptRoot\..\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json).version
)
$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') { throw "Version must be a semantic version: $Version" }
$portableRoot = [IO.Path]::GetFullPath((Join-Path $root "src-tauri\target\portable"))
$stage = [IO.Path]::GetFullPath((Join-Path $portableRoot "Scanline-Term-$Version-portable-x64"))
$archiveRoot = [IO.Path]::GetFullPath((Join-Path $root "src-tauri\target\release\bundle\portable"))
$archive = [IO.Path]::GetFullPath((Join-Path $archiveRoot "Scanline-Term-$Version-portable-x64.zip"))
$separator = [IO.Path]::DirectorySeparatorChar
if (-not $stage.StartsWith($portableRoot.TrimEnd($separator) + $separator, [StringComparison]::OrdinalIgnoreCase)) { throw "Portable stage path escapes its target directory" }
if (-not $archive.StartsWith($archiveRoot.TrimEnd($separator) + $separator, [StringComparison]::OrdinalIgnoreCase)) { throw "Portable archive path escapes its target directory" }
if (Test-Path -LiteralPath $stage) {
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction Stop
  if (Test-Path -LiteralPath $stage) { throw "Could not remove previous portable stage: $stage" }
}
New-Item -ItemType Directory -Path $stage -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root "src-tauri\target\release\sterm.exe") -Destination $stage
$mcpBinary = Join-Path $root "src-tauri\target\release\scanline-term-mcp.exe"
if (-not (Test-Path -LiteralPath $mcpBinary)) { throw "Build the MCP sidecar first: cargo build --release --bin scanline-term-mcp" }
Copy-Item -LiteralPath $mcpBinary -Destination $stage
Copy-Item -LiteralPath (Join-Path $root "src-tauri\resources\conpty") -Destination $stage -Recurse
Copy-Item -LiteralPath (Join-Path $root "src-tauri\resources\fonts") -Destination $stage -Recurse
Copy-Item -LiteralPath (Join-Path $root "src-tauri\resources\presets") -Destination $stage -Recurse
Copy-Item -LiteralPath (Join-Path $root "src-tauri\resources\window-icon.ico") -Destination $stage
$luaSource = Join-Path $root "examples\lua"
$luaResource = Join-Path $stage "lua-examples"
foreach ($directory in @("editors", "modules", "scripts", "palettes", "lua-examples", "lua-examples\editors", "lua-examples\modules", "lua-examples\scripts", "lua-examples\palettes")) {
  New-Item -ItemType Directory -Path (Join-Path $stage $directory) -Force | Out-Null
}
foreach ($relativePath in @("sterm.lua", "editors\nvim.lua", "editors\hx.lua", "modules\modal_editor.lua", "scripts\far_preset.lua", "palettes\users.lua")) {
  Copy-Item -LiteralPath (Join-Path $luaSource $relativePath) -Destination (Join-Path $stage $relativePath)
  Copy-Item -LiteralPath (Join-Path $luaSource $relativePath) -Destination (Join-Path $luaResource $relativePath)
}
foreach ($requiredPath in @("conpty\x64", "fonts", "presets\default.json", "window-icon.ico", "sterm.lua", "editors\nvim.lua", "editors\hx.lua", "modules\modal_editor.lua", "scripts\far_preset.lua", "palettes\users.lua", "lua-examples\sterm.lua", "lua-examples\palettes\users.lua", "lua-examples\scripts\far_preset.lua")) {
  if (-not (Test-Path -LiteralPath (Join-Path $stage $requiredPath))) { throw "Portable package is missing required path: $requiredPath" }
}
Copy-Item -LiteralPath (Join-Path $root "README.md") -Destination $stage
New-Item -ItemType Directory -Path (Join-Path $stage "docs") -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root "docs\13-portable-installation.md") -Destination (Join-Path $stage "docs\PORTABLE-INSTALLATION.md")
New-Item -ItemType Directory -Path (Split-Path $archive) -Force | Out-Null
if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force -ErrorAction Stop }
Compress-Archive -Path $stage -DestinationPath $archive
Write-Output $archive
