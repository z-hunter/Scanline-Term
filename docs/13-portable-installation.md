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
3. Keep `sterm.exe` beside the `conpty`, `fonts`, `presets`, and `lua-examples` folders, plus `window-icon.ico`. In particular, `conpty\x64` is required for terminal sessions; these resource paths are relative to the executable.
4. Run `sterm.exe`.

The Windows V1 portable packaging script adds the config layout to the ZIP: `sterm.lua` beside `sterm.exe`, with the `editors` and `modules` directories beside it. The entry registers the shared module but leaves the Neovim and Helix `sterm.use` blocks commented out; uncomment the binding you want to activate. Custom shells can be declared in this user-authored file, while the selected default shell is stored in the GUI-managed settings block by stable profile ID. Existing portable config files are preserved during startup seeding; upgrade preservation has not been separately release-validated. The user reports manually enabling and testing the Neovim and Helix bindings in installed 0.6.0 and confirming they work. The packaged Neovim Caps/MCP smoke is scoped separately from a full focus/tab/reload/error matrix.

The portable copy does not add `sterm` to `PATH`. Add its folder to your user `PATH` manually if command-line launching is wanted.

## Fonts and presets

The ZIP includes `fonts` and `presets` beside the executable.

- Presets are copied into `%APPDATA%\com.zhunter.scanlineterm\presets` on first launch.
- To use a bundled font, right-click its `.ttf` file in `fonts` and choose **Install**. Font installation may require administrator approval depending on the chosen scope.

The MSI remains the recommended option when automatic PATH setup and font installation are wanted.
