# Scanline Term — Technical Documentation

> Comprehensive reference for developers and coding agents working on the Scanline Term codebase.

## Documentation Index

| Document | Audience | Contents |
|----------|----------|----------|
| [Project Overview](./01-overview.md) | All | Purpose, UX goals, capabilities, platform support, technology stack |
| [Architecture](./02-architecture.md) | All | Diagrams, data flows, WebView/Rust boundary, concurrency model |
| [Codebase Guide](./03-codebase-guide.md) | Developers | Repository tree, file-by-file walkthrough, public API surface |
| [Core Systems](./04-core-systems.md) | Developers | Console host, ConPTY, input handling, rendering, CRT pipeline, fonts |
| [Design Decisions](./05-design-decisions.md) | All | Rationale for key architectural choices |
| [Development Workflow](./06-development.md) | Developers | Prerequisites, commands, Tauri config, troubleshooting builds |
| [Testing & Validation](./07-testing.md) | Developers/QA | Test layout, validation checklists, manual vs automated |
| [Troubleshooting](./08-troubleshooting.md) | Developers/Ops | Symptoms, causes, diagnostics, fixes, known limitations |
| [Extension Guide](./09-extension-guide.md) | Developers | Recipes for adding profiles, settings, shortcuts, commands |
| [Agent Guide](./AGENT_GUIDE.md) | Coding agents | Safe editing, high-risk files, change impact map |

## Quick Links

- **Source (frontend):** [`src/`](../src/)
- **Source (Rust backend):** [`src-tauri/src/main.rs`](../src-tauri/src/main.rs)
- **CRT shader/filter:** [`src/crt/CRTFilter.ts`](../src/crt/CRTFilter.ts)
- **Settings & defaults:** [`src/crt/settings.ts`](../src/crt/settings.ts)
- **Tauri config:** [`src-tauri/tauri.conf.json`](../src-tauri/tauri.conf.json)
- **Tests:** `npm test` (Vitest) and `cargo test` (Rust)

---

*Generated from source as of v0.1.0. When in doubt, treat the repository source code as authoritative.*
