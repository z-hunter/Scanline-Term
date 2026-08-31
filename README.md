# Scanline Term

WebGL CRT terminal for Windows, built with React, Vite, and Tauri 2.

The demo renders an animated mock terminal into a virtual framebuffer and applies the CRT filter extracted from our Quest/Scanline engine:

```text
ConPTY (`cmd.exe`) ↔ Tauri commands/events ↔ VT screen buffer → canvas → CRTFilter → WebGL output canvas
```

## Included

- Curvature, vignette, bezel glow, scanlines, beam modulation, RGB split, bloom, screen glow, phosphor grain, persistence duration and trail intensity (0–4), HV breathing and anti-moiré pixels.
- Color output modes: Color, B&W (~6500K white phosphor), Green, Amber and Phosphor Blue.
- Separate image brightness/contrast controls and monochrome-only background desaturation; phosphor grain/static and scanlines are composited as an independent surface layer.
- Virtual modes: QVGA 320×240, VGA 640×480, SVGA 800×600 and XGA 1024×768.
- Native controls with validated `localStorage` settings and reset-to-defaults.
- In the Tauri app, a native Windows ConPTY session runs `cmd.exe`; its default `#ccc` on `#0c0c0c` and ANSI 16/256/RGB colors are composited into the CRT canvas, then recolored by the shader. The character grid resizes with the virtual resolution and display area. Click the screen to type or paste; Ctrl combinations, navigation, numpad application mode and F1–F24 are serialized as VT input. Browser/Vite preview keeps using the mock session.

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
