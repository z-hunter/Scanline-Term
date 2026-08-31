# Scanline Term

Reusable WebGL CRT shader demo and foundation for a retro Windows terminal, built with React, Vite, and Tauri 2.

The demo renders an animated mock terminal into a virtual framebuffer and applies the CRT filter extracted from our Quest/Scanline engine:

```text
mock terminal canvas → CRTFilter → WebGL output canvas → Tauri window
```

## Included

- Curvature, vignette, bezel glow, scanlines, beam modulation, RGB split, bloom, screen glow, phosphor grain, persistence duration and trail intensity (0–4), HV breathing and anti-moiré pixels.
- Virtual modes: QVGA 320×240, VGA 640×480, SVGA 800×600 and XGA 1024×768.
- Native controls with validated `localStorage` settings and reset-to-defaults.
- A mock terminal only. Windows ConPTY and a real shell are deliberately deferred.

## Development

Install Rust with the MSVC toolchain, Microsoft C++ Build Tools and WebView2 on Windows, then run:

```sh
npm install
npm run dev
npm run tauri:dev
npm test
npm run build
npm run tauri:build
```

The project is MIT licensed. `CRTFilter.ts` originated in our Quest/Scanline project and is maintained here as an independent, framework-free module.

See [BACKLOG.md](BACKLOG.md) for the next persistence and physical-screen improvements.
