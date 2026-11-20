# Browser TextureStream experiment

On this branch, `npm run tauri:dev` and `npm run tauri:dev:texture-stream` start the same experimental Windows dev app. Stop an existing dev instance before restarting so WebView2 starts with the feature enabled. The launcher builds the native DLL with the Visual Studio C++ tools and Windows SDK. It uses `WEBVIEW2_SDK_DIR`, the sibling PoC SDK, or the pinned prerelease SDK restored from NuGet. `npm run tauri:dev:wry` starts the regular Wry host.

In a web tab, open **Settings → CRT**, enable **CRT Emulation**, and select **Frame capture → TextureStream (experimental)**. The selection applies to browser tabs in the current app session. CDP screencast starts as the default. If TextureStream fails, the panel reports the fallback and the tab resumes CDP capture.

With CRT disabled, the tab displays its native WebView directly. Capture runs when CRT is enabled or while previewing a CRT preset. Gallery uses the most recent captured preview when available.

The experimental launcher uses one WebView2 CompositionController per browser tab. CDP, TextureStream, navigation, and input all target that browser instance, so changing capture modes preserves the page. Native display uses the same controller with CRT off. The WGC stream only runs for the active CRT tab. The existing Wry browser host is available when the companion or feature is unavailable.

The pinned SVS can composite the video through its existing overlay. For the direct WebGL path used in the benchmark, point `SCANLINE_SVS_EXPERIMENT` to an SVS worktree with `VirtualScreenRenderer.renderVideo` before running the launcher.

## Standalone benchmark bridge

The benchmark API also supports an isolated composition-hosted WebView2 loading the local benchmark page. That entry point accepts only `http://localhost:5173/texture-stream-benchmark.html`. The normal tab entry point uses a registered tab handle.

Build from an x64 Visual Studio 2022 developer prompt, with `WEBVIEW2_SDK_DIR` set to a WebView2 SDK folder containing `build/native/include/WebView2Experimental.h`:

```powershell
$env:WEBVIEW2_SDK_DIR = 'C:\path\to\WebView2-SDK'
cmd /c scripts\browser-texture-stream\build.cmd
$env:SCANLINE_BROWSER_TEXTURE_STREAM_DLL = Join-Path $env:TEMP 'ScanlineTerm\browser-texture-stream\browser_texture_stream.dll'
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--enable-features=msWebView2TextureStream'
npm run tauri:dev:wry
```

The API is experimental and runtime-gated by `--enable-features=msWebView2TextureStream`. The launcher and example scope the flag to the launched dev process. The source uses WGC `CreateFromVisual` on Windows 10 1809 and later.
