# Browser TextureStream

`npm run tauri:dev` and `npm run tauri:build` build the Windows capture companion automatically. The build requires the x64 Visual Studio C++ tools and Windows SDK. It restores the pinned WebView2 SDK from NuGet, or uses an absolute `WEBVIEW2_SDK_DIR` supplied by the developer. The MSI and portable ZIP place `browser_texture_stream.dll` beside `sterm.exe`.

With CRT enabled, the active browser tab uses TextureStream. With CRT disabled, the same WebView displays directly and capture stops. On a runtime without TextureStream support, the tab remains available in native display mode. Gallery uses the most recent captured preview when available.

The companion captures the tab's visual with Windows Graphics Capture. The main WebView receives a MediaStream and sends its frames through SVS. See the [historical A/B report](../../docs/browser-texture-stream-experiment.md) for the original experiment and reproduction instructions.

## Frame path and lifetime

1. Each Windows browser tab owns one WebView2 CompositionController. With CRT off it is displayed directly. With CRT on, the active tab stays visible offscreen so WebView2 continues rendering the same document.
2. Windows Graphics Capture reads the tab's composition visual. The companion converts captured BGRA frames to shared NV12 textures and publishes them through WebView2 TextureStream.
3. The main WebView receives a MediaStream through `chrome.webview.getTextureStream`. The receiver in [browser-benchmark.ts](../../src/crt/browser-benchmark.ts) drives a video element and cleans up tracks and the native stream on stop, failure, or replacement.
4. [useCRT.ts](../../src/crt/useCRT.ts) submits video to SVS. The pinned SVS version uses the video-backed overlay; a development SVS worktree may provide direct `renderVideo`. The host caches a reduced preview for Gallery. Mouse, wheel, and keyboard input use the DevTools Input domain and return to the same tab.

The browser host, capture bridge, and Windows Graphics Capture depend on Windows, WebView2 and D3D11. The bridge enables the WebView2 experimental feature at startup and restricts the stream's receiving origin to the main application WebView. Only the active tab may start a stream. Turning CRT off, leaving the tab, opening Gallery, or resizing tears down or replaces the stream. If support is unavailable or a stream fails, the browser is displayed directly and the panel reports the failure. The API is experimental and its availability depends on the installed WebView2 runtime.

## Legacy CDP capture and porting

The JPEG/CDP implementation is preserved as a commented block in [App.tsx](../../src/App.tsx). Its `Page.startScreencast`, `Page.stopScreencast`, and `Page.screencastFrameAck` entries are also commented in the [browser_devtools allowlist](../../src-tauri/src/browser.rs). It is inactive and is not the automatic failure path. The earlier working implementation and benchmark can be inspected at commit `3a6664f`.

The former flow starts a screencast, receives `Page.screencastFrame` events through the native bridge, decodes JPEG frames in the frontend, updates the SVS browser overlay and Gallery preview, and acknowledges each frame. It stops the screencast and removes its listener on teardown. The DevTools Input commands remain active independently of this capture path.

For another OS, first select an embedded browser engine and determine whether it exposes a suitable frame capture API and input forwarding. CDP screencast is a candidate only when that engine and host expose the required protocol methods and events. The preserved code uses Windows-specific WebView2 COM APIs, so uncommenting it alone does not produce a cross-platform implementation. Adapt the native event and command bridge, the frontend capture lifecycle and capability checks, and the input mapping for the target platform. Keep frame acknowledgement, cleanup, resize, tab isolation, and document identity intact. Validate browser rendering and interaction on the target OS.
