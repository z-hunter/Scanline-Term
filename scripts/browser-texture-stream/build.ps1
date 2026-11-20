$ErrorActionPreference = 'Stop'
$output = Join-Path $env:TEMP 'ScanlineTerm/browser-texture-stream'

if (!$env:WEBVIEW2_SDK_DIR) {
    $version = '1.0.4365-prerelease'
    $env:WEBVIEW2_SDK_DIR = Join-Path $output $version
    if (!(Test-Path (Join-Path $env:WEBVIEW2_SDK_DIR 'build/native/include/WebView2Experimental.h'))) {
        New-Item -ItemType Directory -Force -Path $output | Out-Null
        $package = Join-Path $output "microsoft.web.webview2.$version.nupkg"
        $url = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$version/microsoft.web.webview2.$version.nupkg"
        & curl.exe -fsSL $url -o $package
        if ($LASTEXITCODE -ne 0) { throw 'WebView2 SDK download failed.' }
        if ((Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash -ne '07FE4A9D1831CDEDA72672E84FAC4BC52DBF99D3D04D2530C6D087B54F14CDEB') {
            throw 'Unexpected WebView2 SDK package hash.'
        }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::ExtractToDirectory($package, $env:WEBVIEW2_SDK_DIR)
    }
}

$env:SCANLINE_TEXTURE_OUT = Join-Path $output 'build'
& (Join-Path $PSScriptRoot 'build.cmd')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Copy-Item -LiteralPath (Join-Path $env:SCANLINE_TEXTURE_OUT 'browser_texture_stream.dll') `
    -Destination (Join-Path $PSScriptRoot '../../src-tauri/resources/browser-texture-stream/browser_texture_stream.dll')
