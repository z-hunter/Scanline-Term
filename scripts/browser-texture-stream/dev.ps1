$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$output = Join-Path $env:TEMP 'ScanlineTerm/browser-texture-stream'

if (!$env:WEBVIEW2_SDK_DIR) {
    $pocSdk = Join-Path $root '../WebView2TextureStreamPoC/sdk'
    if (Test-Path (Join-Path $pocSdk 'build/native/include/WebView2Experimental.h')) {
        $env:WEBVIEW2_SDK_DIR = (Resolve-Path $pocSdk).Path
    } else {
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
}

& (Join-Path $PSScriptRoot 'build.cmd')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$env:SCANLINE_BROWSER_TEXTURE_STREAM_DLL = Join-Path $output 'browser_texture_stream.dll'
$env:SCANLINE_BROWSER_TEXTURE_STREAM_TABS = '1'

$browserArguments = [string]$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
if ($browserArguments -notmatch '\bmsWebView2TextureStream\b') {
    if ($browserArguments -match '(^|\s)--enable-features=([^\s"]+)') {
        $browserArguments = $browserArguments -replace '(^|\s)--enable-features=([^\s"]+)', '$1--enable-features=$2,msWebView2TextureStream'
    } else {
        $browserArguments = "$browserArguments --enable-features=msWebView2TextureStream".Trim()
    }
}
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $browserArguments

Push-Location $root
try {
    npm run tauri:dev -- --no-watch
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
