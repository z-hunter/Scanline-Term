# Portable ZIP Installation

[← Documentation Index](./README.md)

The portable ZIP runs Scanline Term without an MSI installation or administrator rights.

## Requirements

- Windows 10 version 17763 or later, or Windows 11 (x64).
- [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).

Codex CLI is not required for the terminal. Install it separately and add it to `PATH` only to use the optional AI assistant.

## Installation

1. Download `Scanline-Term-<version>-portable-x64.zip` from the release assets.
2. Extract the entire archive to a writable folder, for example `C:\Tools\Scanline-Term`.
3. Keep `sterm.exe` alongside the `resources` folder. In particular, `resources\conpty\x64` is required for terminal sessions.
4. Run `sterm.exe`.

The portable copy does not add `sterm` to `PATH`. Add its folder to your user `PATH` manually if command-line launching is wanted.

## Fonts and presets

The ZIP includes `resources\fonts` and `resources\presets`.

- Presets are copied into `%APPDATA%\com.zhunter.scanlineterm\presets` on first launch.
- To use a bundled font, right-click its `.ttf` file in `resources\fonts` and choose **Install**. Font installation may require administrator approval depending on the chosen scope.

The MSI remains the recommended option when automatic PATH setup and font installation are wanted.
