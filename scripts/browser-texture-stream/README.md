# Browser TextureStream

`npm run tauri:dev` and `npm run tauri:build` build the Windows capture companion automatically. The build requires the x64 Visual Studio C++ tools and Windows SDK. It restores the pinned WebView2 SDK from NuGet, or uses an absolute `WEBVIEW2_SDK_DIR` supplied by the developer. The MSI and portable ZIP place `browser_texture_stream.dll` beside `sterm.exe`.

With CRT enabled, the active browser tab uses TextureStream. With CRT disabled, the same WebView displays directly and capture stops. On a runtime without TextureStream support, the tab remains available in native display mode. Gallery uses the most recent captured preview when available.

The companion captures the tab's visual with Windows Graphics Capture. The main WebView receives a MediaStream and sends its frames through SVS. See the [historical A/B report](../../docs/browser-texture-stream-experiment.md) for the original experiment and reproduction instructions.
