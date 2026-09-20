# Backlog

## Kitty Terminal Graphics Protocol — V1

### Goal

Render static Kitty graphics in terminal tabs, including Unicode-placeholder
placements used by Neovim integrations.  The feature remains frontend-only:
ConPTY continues to carry raw bytes, xterm remains the logical VT grid, and
the existing Canvas/CRT pipeline displays the final composition.

### Supported V1 protocol surface

- APC framing: `ESC _ G <control> ; <base64 payload> ESC \`, including input
  split across ConPTY reads and direct-transfer chunks (`m=1`/`m=0`).
- Direct transfer only (`t=d`), static actions `a=t`, `a=T`, `a=p`, `a=q` and
  `a=d`; image IDs (`i`) and placement IDs (`p`).
- RGB (`f=24`), RGBA (`f=32`), PNG (`f=100`) and zlib (`o=z`).
- Source crop and destination geometry (`x/y/w/h`, `X/Y`, `c/r`), cursor policy
  `C=0/1`, non-negative z-index, query replies and quiet modes.
- Virtual placement `U=1` and rendering of `U+10EEEE` Unicode placeholders,
  including their row/column/image/placement metadata encoded in combining
  diacritics and foreground/underline RGB colors.
- Basic deletion (`d=a/A`, `d=i/I` with optional placement ID), terminal reset,
  clear-screen and alternate-buffer cleanup.
- Pixel-size replies for `CSI 14 t` and `CSI 16 t`, calculated from the same
  grid metrics as `TerminalRenderer`.

### Deliberately outside V1

- Animation/frame/composition actions (`a=f`, `a=a`, `a=c`).
- File, temporary-file and shared-memory transports (`t=f`, `t=t`, `t=s`).
- Relative placements, image numbers, usage hints, negative z-index and exact
  graphics movement within alternate-buffer scroll regions.
- Persistence across terminal-tab close/reopen and any new user setting.

### Implementation plan

1. Add one focused `src/terminal/kitty-graphics.ts` module plus unit tests. It
   owns APC parsing, strict control-data validation, chunk assembly, decoded
   image quota, image/placement state, protocol replies and cleanup. Reuse
   browser `createImageBitmap`, `ImageData` and `DecompressionStream`; do not
   add an image-decoder dependency.
2. Change `TerminalSession` output handling from one `terminal.write()` per
   ConPTY event to an ordered text/APC queue. Text must finish parsing before a
   placement reads the cursor; every later text segment waits for the graphics
   command. Keep unrelated APC bytes flowing to xterm unchanged.
3. Make `TerminalRenderer` consume Kitty placements as a distinct terminal
   layer: normal placements after text and before cursor; user-added tab images
   remain the top-most UI layer. Any visible Kitty placement cancels/skips the
   current heuristic smooth-scroll transition in V1 so graphics cannot drift
   from its text snapshot.
4. Anchor normal-buffer placements with xterm markers. For alternate buffer,
   retain the placement at its reported cell until the client updates/deletes
   it; this is sufficient for explicit Neovim redraws but is not full scroll-
   region semantics.
5. Implement Unicode placeholders in the renderer, not as synthetic images:
   scan visible cells for `U+10EEEE`, decode diacritics and foreground RGB into
   the virtual placement/image tile, then draw just that tile into the cell.
   Placeholder characters themselves must be invisible in normal glyph output.
6. The public xterm `IBufferCell` API exposes foreground color but not underline
   color, while Kitty uses underline RGB for placement ID. First check the
   installed/xterm-update API. If it remains absent, isolate one read-only,
   version-pinned runtime accessor for the existing cell's `extended`
   underline-color data and cover it with a regression test; do not fork or
   duplicate xterm's parser/buffer implementation.
7. Apply resource limits before allocation and decoding: bounded APC control
   frame, 16M pixels and 64 MiB decoded data per image, 128 MiB per session,
   bounded placement count, PNG IHDR validation and streaming decompression
   limits. Dispose `ImageBitmap`s on delete/session close.
8. Test fragmented APC/chunks, malformed input and quiet/error replies; raw,
   PNG and compressed decoding; cursor ordering; crop/scale/z placement;
   clear/reset/delete; `CSI 14/16t`; normal-buffer marker movement; and complete
   placeholder metadata plus the compact left-to-right inference rules.
9. Manual acceptance: direct `kitten icat`/`chafa` fixture with CRT on/off,
   Neovim `image.nvim` in normal and Unicode-placeholder modes, redraw/scroll,
   resize, alternate-buffer switch, tab switch and memory-limit rejection.

### Technical constraints to preserve

- Do not claim general/full Kitty compatibility in UI or documentation; call
  this a static V1 subset and return a protocol error for unsupported actions.
- Do not make the terminal read a path named by a child process.
- Do not use xterm private parser state. The one narrowly-scoped cell metadata
  accessor above is acceptable only if a public underline-color API is absent,
  and must fail closed after an xterm version change.
- Keep input, mouse, selection, logical cursor and copy bound to xterm's new
  grid. Graphics are a renderer-side visual layer only.
