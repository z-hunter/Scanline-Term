# Backlog

## Deferred product work

- Add ANSI text attributes such as bold, underline and strikethrough to the CRT canvas renderer.
- Add selection, clipboard shortcuts and mouse-mode behavior.

## Browser home page (MVP)

- Replace the blank `Menu+B` new-tab state with a local React bookmark dashboard: categorized links, search, per-link shortcuts, and a minimal editor persisted in existing `localStorage` settings.
- Keep it serverless and dependency-free. Selecting a link should use the existing browser navigation; do not embed ThinkDashboard's Go service, Docker setup, or JSON API.
- Start with a single dashboard page and the current visual language. Add pages, themes, import/export, or custom assets only if the MVP proves insufficient.

Reference: <https://github.com/MatiasDesuu/ThinkDashboard/tree/main>
