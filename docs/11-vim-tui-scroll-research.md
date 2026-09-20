# Исследование: плавная прокрутка Vim/Neovim в TUI

## Вывод

Универсального семантического события «прокрутилось окно редактора» в VT-потоке
нет, поэтому реализован безопасный MVP с эвристикой frame-diff. При включённом
`smoothScrollback` включает обычную плавность scrollback, а вложенный
`smoothTuiScrolling` — сравнение сигнатур строк последнего кадра и нового
кадра для одного однозначного полноширинного сдвига. До двух строк могут
различаться лишь оформлением (цвет, inverse или текстовая декорация; подсветка
парных скобок); символы, ширина клеток и invisibility остаются строгими. Всё остальное
остаётся точным. В normal buffer
это возможно лишь внизу scrollback при неизменных `baseY` и `viewportY`.
Ложные срабатывания при неоднозначных или частично изменённых строках
намеренно отклоняются; повторяющиеся строки допустимы, если лучший candidate
опережает следующий минимум на две строки. False negatives допустимы.

Neovim RPC остаётся отдельным направлением: он может дать точные viewport/grid
события, но не является прозрачной надстройкой над уже работающим TUI.

## Текущий путь данных

| Шаг | Реализация |
| --- | --- |
| ConPTY | `src-tauri/src/main.rs`: `spawn_terminal`, `start_terminal`; reader thread читает по 4096 байт и шлёт `terminal-output`. |
| VT | `src/terminal/TerminalSession.ts`: listener `terminal-output` вызывает `terminal.write(Uint8Array)`. `@xterm/xterm` 6.0 парсит VT и владеет normal/alternate buffers. |
| Логическая сетка | `Terminal.buffer.active`; renderer читает `getLine(viewportY + row)`, курсор — `cursorX/cursorY`. Собственной модели VT margins в приложении нет. |
| Рендер | `src/terminal/TerminalRenderer.ts`: `onWriteParsed`/`onCursorMove` делают grid dirty, `draw()` сравнивает row signatures и перерисовывает изменённые строки в `sourceCanvas`, затем `compositedCanvas`. |
| Существующая плавность | `useTerminal.ts`: normal-buffer user scroll и output autoscroll вызывают `TerminalRenderer.beginScroll(fromViewportY,toViewportY)`. После `onWriteParsed` `TerminalRenderer.ts` сравнивает `rowSignatures` и при единственном вертикальном кандидате создаёт тот же `ScrollTransition` с row clip: в alternate buffer всегда, в normal buffer — только без изменения `baseY`/`viewportY` у нижней границы. |
| CRT | `App.tsx` передаёт canvas в `useCRT`; `CRTFilter` получает уже скомпозированный кадр. Анимация до CRT поэтому переиспользуема. |
| Ввод/выделение/мышь | `useTerminal.ts` направляет input сразу в новую `TerminalSession`; mouse hit-test идёт через `TerminalRenderer.cellAtPoint`, copy использует текущий xterm buffer. Selection хранится абсолютными `row,column`; её old-pixel snapshot отдельно не существует. |

Следствие: логика и ввод остаются в новом состоянии, а old-pixel snapshot
ограничен только текстовым row clip. `sourceCanvas` не содержит курсор; cursor и
tab images рисуются поверх композиции и не двигаются вместе с TUI.

## Что предоставляет xterm

Публичные события, используемые приложением: `onWriteParsed`, `onCursorMove`,
`onScroll`. Последнее означает изменение display viewport и полезно для
scrollback; оно не сообщает о scrolling region внутри alternate buffer.
`parser.registerCsiHandler()` доступен (и уже используется только для private
mouse/Win32 modes), но обработчик либо берёт CSI на себя, либо возвращает
`false` и отдаёт её стандартному parser. Публичного post-event с точной
операцией/margins нет. Вмешательство в private xterm internals ради этого
нельзя закладывать в архитектуру.

## Границы распознавания

| Категория | Можно узнать | Нельзя утверждать |
| --- | --- | --- |
| Однозначно | Если recorder видит `DECSTBM` и затем `CSI S/T`, область по строкам — текущие inclusive top/bottom, ширина весь экран; для `DECSLRM` — текущие inclusive left/right. `IL/DL`, `LF/IND/RI` однозначны только после учёта cursor, origin mode и margins. | Что это именно документ, а не status panel/меню. |
| Условно | До/после grid можно найти сдвиг одинакового блока, сгруппировать с близкими cursor moves и очисткой открывшейся полосы. | Намерение приложения; одинаковые строки, folds, wraps и redraw делают соответствие неединственным. |
| Нераспознаваемо | Частичная/full redraw известна как изменение клеток. | Скролл невозможно отличить от произвольного обновления без внешней семантики. |

Вертикальный split принципиально не решается обычным `DECSTBM`: он задаёт лишь
горизонтальные margins. Прямоугольник одновременно по строкам и колонкам
возможен только если фактическая трасса содержит и `DECSLRM` (поддержка и
использование должны быть измерены), либо если источник — Neovim multigrid.
`CSI S/T`, `IL/DL`, `LF`, `IND`, `RI` сами по себе не доказывают такой
прямоугольник.

## Наблюдения о Neovim UI

На машине имеется Neovim 0.11.0. Его локальная справка и официальный протокол
подтверждают `grid_scroll`, `win_viewport.scroll_delta`,
`win_viewport_margins` и `ext_multigrid`; `grid_scroll` оптимизирует copy cells,
а не означает семантический document scroll. `win_viewport.scroll_delta`
предназначен именно для smooth scroll, учитывает displayed/virtual lines (fold
считается одной) и приближен при прокрутке больше экрана.

Дополнительный `nvim_ui_attach()` опасен как transparent integration:

* при нескольких UI глобальный grid берёт минимальные width/height;
* по умолчанию UI capabilities — пересечение всех UI; TUI не запрашивает
  `ext_multigrid`, поэтому нужный поток может не включиться;
* `override` меняет это правило и потому может изменить возможности active TUI.

Значит RPC допустим лишь opt-in режимом с известным user-provided `--listen`
endpoint, той же геометрией и явной проверкой `nvim_list_uis()`/`option_set`.
Он не должен автоматически обнаруживаться или подключаться к произвольному
TUI. Стандартный launch Scanline Term сейчас принимает executable как одну
строку, не аргументы, поэтому запуск с гарантированным `--listen` тоже требует
отдельного изменения launch contract.

## Сравнение вариантов

| Вариант | Плюсы | Главный риск | Вердикт |
| --- | --- | --- | --- |
| A. VT clip animation | Малый путь, reuse canvas/CRT, zero impact на приложения при strict opt-in на явную VT-операцию. | Не знает, что движется Vim viewport; false negatives ожидаемы. Rectangular splits зависят от измеренного `DECSLRM`. | Единственный возможный общий POC, после трасс. |
| B. Frame-diff | Работает при redraw без явного scroll. | Высокие ложные срабатывания: statusline, одинаковый текст, selection, wrap/fold, multiple panes. O(rows*cols*shift) или сложнее; задержка до frame boundary. | Не включать в general terminal. Только offline-анализ трасс. |
| C. Neovim RPC UI | Exact grid/window geometry, multiple windows, `scroll_delta`, folds; clean flush boundary. | UI-size/capability negotiation, endpoint/security/lifecycle, два представления и TUI compatibility. | Исследовать отдельно как Neovim-specific mode, не как fallback. |

## Диагностический gate

Нужен отдельный dev-only ConPTY recorder, не подключённый к production event
path. Он должен использовать тот же `conpty-oxide` setup, записывать каждый
read как `{timestampNs, direction:"out", bytesBase64}` и отдельно записывать
ввод, resize и geometry. Не объединять read chunks: границы читаемых блоков
нужны для latency анализа, а VT parser затем восстановит непрерывный поток.

Для каждой комбинации `nvim --clean -u NONE --noplugin`/user config,
`TERM` (минимум `xterm-256color`, `screen-256color`) и geometry (80x24,
120x40) собрать отдельный файл:

1. normal window: Ctrl-E/Ctrl-Y, cursor-edge arrows, PgUp/PgDn, wheel;
2. horizontal/vertical split, three windows, statusline/cmdline;
3. wrapped long lines, folds, one-line/multi-line, BOF/EOF;
4. resize during idle и animation;
5. Vim (после установки) и доступные Neovim versions.

Analyzer replay должен вести независимое состояние: DECSTBM, DECSLRM, DECOM,
cursor и buffer kind; на каждой candidate operation печатать `{top,bottom,left,
right,dy,sourceBytes,time}` плюс grid before/after. Acceptance gate: zero
unexplained candidates на FAR, MC, less, htop-like fixtures; для Vim — exact
clip for every annotated action. До этого таблица конкретных VT sequences
намеренно не заполнена: в этой среде не был выполнен интерактивный ConPTY
capture, и выдавать документированные ожидаемые последовательности за
измеренный результат было бы неверно.

## Фактические ограничения MVP

* Поддерживается только одна полноширинная вертикальная область за кадр.
  Vertical splits, несколько одновременных областей и горизонтальные margins не
  распознаются как отдельные panes.
* Сравнение точное: текст, ширина клетки, цвета, RGB/palette flags и атрибуты
  должны совпадать. Цветовая правка или недостаток доказательств завершает кадр
  сразу.
* Сдвиг ищется только между полным предыдущим snapshot и VT-output кадром при
  неизменных размерах grid. В normal buffer дополнительно нужны нижняя граница
  scrollback и неизменные `baseY`/`viewportY`, поэтому обычное добавление строк
  не конфликтует с эвристикой. Resize, tab switch, settings/font change,
  selection и image edit отменяют переход.
* Новый output заменяет активную анимацию последним logical target; очередь кадров
  не создаётся. Обычный переход ограничивает скорость примерно 240 px/s, а при
  отставании более шести строк включается быстрый переход длительностью 100–240 ms.

## Безопасный POC / дальнейшее развитие

1. Ввести internal visual-only `RectScrollTransition` рядом с существующим
   `ScrollTransition`: old/new snapshots, pixel clip, `dy`, duration. Не
   менять xterm buffer, viewport, input или selection.
2. После `terminal.write(... callback)` создавать transition только по
   recorder-confirmed candidate. Snapshot old frame до write, target — после
   `onWriteParsed`; clip переводить из cell rect в `terminalContentOffset` и
   cell size. За пределами rect всегда брать target canvas.
3. Cursor и selection рисовать из new logical grid поверх animated pixels;
   mouse/copy направлять в new grid. На resize, tab switch, focus/copy/image
   edit, unrecognized write или overlapping/non-collinear new operation —
   cancel на target сразу. Новая same-rect same-direction operation может
   переснять from-frame и заменить destination; не ставить очередь.
4. Duration capped at 100–240 ms, proportional to min(abs(dy), rect height).
   Large scroll jumps и partial redraw без explicit op — immediate.
5. Добавить минимальные fixture replay tests для margins/clip/direction и
   renderer test, что cancel всегда показывает target. Manual matrix: Vim,
   Neovim, FAR, MC, less, htop equivalent, mouse tracking, resize, split.

Это сохраняет инвариант: terminal grid немедленно новая, а animation — только
временный visual overlay. Нет backpressure на ConPTY: parser продолжает
принимать output, а новый кадр отменяет старую анимацию.

## Источники

* [Neovim UI protocol](https://neovim.io/doc/user/api-ui-events/) — UI
  capability negotiation, `flush`, multigrid, `grid_scroll`, `win_viewport`.
* [Neovim API](https://neovim.io/doc/user/api/) — `nvim_list_uis` и RPC model.
