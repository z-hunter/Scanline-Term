# Bundled ConPTY runtime

`x64/conpty.dll` and `x64/OpenConsole.exe` are matched Release/x64 private builds of the Microsoft Windows Terminal ConPTY pair, not unmodified Microsoft release artifacts; no diagnostic tracing remains in them. Keep both files from the same build: Scanline Term loads them through `conpty-oxide` to retain Win32 Input Mode support on Windows 10 1809 (build 17763), rather than selecting the OS runtime. These binaries retain the private diagnostic ProductName metadata.

## Resize reflow fix

The pair is built from the Microsoft Windows Terminal `v1.24.10921.0` source tag (commit `8474eb8329f8da11c0fcd748e5b19543703ccaa6`) with [`resize-reflow.patch`](./resize-reflow.patch). Apply the patch with `git apply --ignore-space-change` to accommodate the upstream CRLF source files. The patch trims trailing rows that contain only spaces when determining the Reflow extent, while preserving wrap-aware copying of rows inside that extent. It includes the two regression tests and the corrected `export11` expectation. The full source is not vendored.

## Reproduction notes

- Build the tagged Windows Terminal source with vcpkg baseline `fe1cde61e971d53c9687cf9a46308f8f55da19fa` and overlay `dep/vcpkg-overlay-ports`. The manifest pins fmt 11.1.4, ms-gsl 3.1.0, jsoncpp 1.9.5, cli11 2.4.2, and cmark 0.30.3.
- Restore matching official NuGet packages `Microsoft.Windows.SDK.CPP` and `Microsoft.Windows.SDK.CPP.x64`, both `10.0.22621.2428`.
- Restore `Microsoft.Windows.Terminal.Versioning` `0.5.240906013` from the configured `TerminalDependencies` Azure feed: `https://pkgs.dev.azure.com/shine-oss/terminal/_packaging/TerminalDependencies%40Local/nuget/v3/index.json`.
- Build with Visual Studio 2022 / MSVC `14.43.34808`.
- Use these import hooks instead of the package `Setup.ps1` (which rewrites checkout-wide build files). Save them as temporary files at the checkout root:

  `before-cpp.props`:

  ```xml
  <Project>
    <Import Project="$(RepoRoot)\packages\Microsoft.Windows.SDK.CPP.10.0.22621.2428\build\native\Microsoft.Windows.SDK.cpp.props" />
    <Import Project="$(RepoRoot)\packages\Microsoft.Windows.SDK.CPP.x64.10.0.22621.2428\build\native\Microsoft.Windows.SDK.cpp.x64.props" />
    <Import Project="$(RepoRoot)\packages\Microsoft.Windows.Terminal.Versioning.0.5.240906013\build\Microsoft.Windows.Terminal.Versioning.props" />
    <PropertyGroup>
      <VersionBuildNumber>2610</VersionBuildNumber>
      <VersionBuildRevision>20001</VersionBuildRevision>
      <VersionInfoFileFlags>0x8</VersionInfoFileFlags>
      <VersionInfoProductName>Scanline Term (private diagnostic build)</VersionInfoProductName>
      <VersionInfoBoxTag>Private Scanline Term diagnostic fork</VersionInfoBoxTag>
    </PropertyGroup>
  </Project>
  ```

  `after-cpp.targets`:

  ```xml
  <Project>
    <Import Project="$(RepoRoot)\packages\Microsoft.Windows.Terminal.Versioning.0.5.240906013\build\Microsoft.Windows.Terminal.Versioning.targets" />
  </Project>
  ```
- For the focused TAEF target, link `icuuc.lib;icuin.lib` before the umbrella ICU library so the test binary uses legacy system ICU DLLs available on Windows 10 17763.
- Run `TextBuffer.Unit.Tests` with the `ReflowTests` class; all 17 Reflow cases passed after the patch.
- Build `src/host/exe/Host.EXE.vcxproj` and `src/winconpty/dll/winconptydll.vcxproj` in Release/x64 with `/p:RepoRoot=<checkout>`, `WindowsTargetPlatformVersion=10.0.22621.0`, `SolutionDir` and `VcpkgRoot` pointing to checkout-local trailing-slash paths, and `/p:ForceImportBeforeCppProps=<before-cpp.props> /p:ForceImportAfterCppTargets=<after-cpp.targets>`. Set `VCPKG_MAX_CONCURRENCY=2`; use `/m:2 /nr:false`.

## Runtime provenance

Current pair: ProductVersion `1.24.261020001`, FileVersion `1.24.2610.20001`.

- `x64/conpty.dll` SHA-256: `206EE4BC1D94A7E5AB98CBCA2C66BE44A4EAAE93BEB90B74FA87A6C5E46EB278`
- `x64/OpenConsole.exe` SHA-256: `16A61DB2C243A7FF0C43E8298632124B6597A632F317A1A9F257A3E0C3FB61C0`

Validation: all 17 native `ReflowTests` cases passed. Rust bundled-backend tests `bundled_conpty_streams_win32_input_request` and `win32_input_mode_delivers_function_key` passed. Live MCP resize checks passed with the bundled pair: (1) Settings open, default CMD 126×35 → Trinitron touch 108×36 (width shrink), marker remains at the prompt, banner intact; (2) fresh default CMD 126×35 → 138×40 (growth) with Settings closed and tabs visible, marker remains at prompt row 3, banner intact; and (3) a fresh fullscreen scenario via the Tauri window API, panels closed, default CMD 126×35 → Trinitron 162×45 (growth), cursor stays on prompt row 3 and marker/banner are correct. Do not substitute one DLL from a different build.
