# План MCP-режима Scanline Term

## Статус реализации

Основной MVP реализован: shared terminal automation, snapshots со стилями, owner-scoped named pipe, stdio sidecar, MCP setting, cleanup при disconnect, mouse/keyboard/resize/close tools и blue/green frame glow добавлены в кодовую базу. Live Windows/Tauri smoke-тест подтвердил создание видимых вкладок, keyboard/text input, ANSI style runs, TUI primary/wheel mouse, middle-button rejection, owner isolation и cleanup при disconnect. Расширенная матрица FAR/left-handed mapping/installer остаётся отдельной проверкой.

## Цель

Добавить отключённый по умолчанию MCP-режим, в котором внешний агент может создавать видимые терминальные вкладки Scanline Term и работать с ними как пользователь: читать экран и scrollback, вводить текст и клавиши, управлять мышью в консольных TUI, изменять размер и закрывать сессии.

Каждое MCP-подключение видит и контролирует только созданные им сессии. При разрыве подключения все принадлежащие ему вкладки и процессы ConPTY закрываются.

## Не входит в первую версию

- Управление интерфейсом Scanline Term, браузерными вкладками, настройками или AI-панелью.
- Снимки экрана и анализ CRT-изображения.
- Доступ к пользовательским терминальным вкладкам или сессиям другого MCP-клиента.
- Средняя кнопка мыши: Scanline Term сохраняет её для выделения текста из буфера.
- Удалённый сетевой MCP endpoint.

## Пользовательское поведение

- MCP-режим включается отдельной настройкой и по умолчанию выключен.
- MCP-клиент запускает локальный `scanline-term-mcp` через стандартный MCP stdio transport.
- Если Scanline Term не запущен или MCP-режим выключен, sidecar возвращает понятную ошибку и не запускает скрытую терминальную реализацию.
- Созданная агентом сессия появляется обычной терминальной вкладкой.
- Пользователь может вводить текст, клавиши и мышь в MCP-вкладке одновременно с агентом.
- Встроенный AI для MCP-вкладки недоступен: нельзя начать thread/turn или отправить сообщение в эту сессию.
- Пока MCP-подключение владеет выбранной вкладкой, рамка экрана светится голубым.
- Пока встроенный AI выполняет turn в обычной вкладке, рамка светится зелёным.
- Свечение должно оставаться видимым и в режиме скрытого bezel.
- Закрытие MCP-вкладки пользователем немедленно делает её handle недействительным для агента.

## Архитектура

```text
MCP client
    │ stdio / JSON-RPC
    ▼
scanline-term-mcp sidecar
    │ локальный Windows named pipe
    ▼
Rust broker внутри Scanline Term
    │ Tauri request/reply bridge
    ▼
WebView terminal automation dispatcher
    │
    ▼
TerminalSession → xterm parser → существующий ConPTY
```

### Почему состояние экрана остаётся в WebView

`TerminalSession` и xterm уже являются источником истины для разобранного экрана, scrollback, режимов клавиатуры и TUI-мыши. Rust не должен создавать второй VT-парсер: MCP broker передаёт запросы в WebView и получает готовый результат.

### Транспорт

- Внешний MCP transport: stdio через отдельный sidecar.
- Внутренний transport: локальный Windows named pipe с доступом только текущему пользователю.
- MCP-сообщения пишутся только в stdout sidecar; диагностика — только в stderr.
- Сетевой порт, HTTP-сервер и bearer token для MVP не нужны.
- Sidecar и приложение используют небольшой внутренний versioned JSON-протокол, независимый от публичной схемы Tauri events.

### Владение сессиями

Для каждого соединения broker создаёт случайный `ownerId`. Внешний клиент получает только короткие opaque handles, а не внутренние UUID вкладок.

Broker хранит отображение:

```text
(ownerId, handle) → internal sessionId
```

Проверка владельца выполняется до отправки любого запроса в WebView. WebView дополнительно хранит признак MCP-владения у записи сессии и отклоняет операции с несовпадающим владельцем.

При закрытии pipe broker:

1. перестаёт принимать новые вызовы владельца;
2. отменяет ожидающие наблюдения;
3. закрывает все его вкладки через обычный lifecycle `TerminalSession.close()`;
4. удаляет таблицу handles.

## Общий слой terminal automation

Нужно вынести из обработчика встроенного AI единый dispatcher, которым пользуются:

- dynamic tools встроенного Codex assistant;
- MCP request bridge;
- при возможности существующий пользовательский путь TUI-мыши после преобразования DOM-события в координаты ячеек.

Источник истины остаётся в `TerminalSession`:

- `snapshot()` / ожидание нового вывода;
- клавиатурное кодирование VT и Win32 Input Mode;
- проверка состояния и размеров терминала;
- новый метод семантического TUI mouse input.

Встроенный AI продолжает работать только с обычной вкладкой, к которой привязан его thread. MCP-инструменты работают только через owner-scoped handle.

## MCP tools

### `create_terminal`

Создаёт видимую MCP-вкладку и возвращает её handle после создания `TerminalSession`.

Параметры:

- `command?: string`
- `args?: string[]`
- `cwd?: string`
- `preset?: string`
- `cols?: number`
- `rows?: number`

Результат содержит handle, статус, заголовок, имя процесса и фактический размер. Проверки command/cwd/размера должны переиспользовать существующий путь запуска и ограничения ConPTY.

### `list_terminals`

Возвращает только сессии текущего MCP-подключения: handle, статус, заголовок, имя процесса и размер.

### `observe_terminal`

Параметры:

- `handle`
- `afterSequence?: number`
- `quietMs?: number` — существующий диапазон 0–5000 мс
- `timeoutMs?: number` — существующий диапазон 1–60000 мс
- `includeScrollback?: boolean` — по умолчанию `false`

Без `afterSequence` snapshot возвращается сразу. С `afterSequence` вызов ждёт новый вывод и период тишины, как существующий `waitForOutput()`.

Каждый ответ всегда содержит текущий live-экран как простой текст и отдельную стилевую карту. Полный scrollback добавляется только при `includeScrollback: true`.

### `send_terminal_input`

Сохраняет существующий контракт:

```ts
{ kind: "text", text: string, submit?: boolean }
{ kind: "key", key: string, ctrl?: boolean, alt?: boolean, shift?: boolean, repeat?: number }
```

Остаются текущие ограничения: текст не больше 64 КиБ, `repeat` от 1 до 100, неизвестные именованные клавиши отклоняются.

### `send_terminal_mouse`

Работает в координатах терминальных ячеек, начиная с 1. Публичный API использует семантические кнопки, а не физические left/right:

```ts
{ action: "click", button: "primary" | "secondary", col: number, row: number, ctrl?: boolean, alt?: boolean, shift?: boolean }
{ action: "press" | "release", button: "primary" | "secondary", col: number, row: number, ctrl?: boolean, alt?: boolean, shift?: boolean }
{ action: "move", col: number, row: number, heldButton?: "primary" | "secondary", ctrl?: boolean, alt?: boolean, shift?: boolean }
{ action: "wheel", direction: "up" | "down", col: number, row: number, steps?: number, ctrl?: boolean, alt?: boolean, shift?: boolean }
```

- `primary` кодируется как основная кнопка, `secondary` — как дополнительная; перестановка кнопок Windows для левшей сохраняет семантику пользовательского ввода.
- Средняя кнопка отсутствует в схеме.
- `click` отправляет согласованную пару press/release.
- `steps` ограничивается диапазоном 1–100.
- Координаты проверяются по текущим `cols`/`rows`.
- События проверяются против активного xterm mouse tracking mode (`x10`, `vt200`, `drag`, `any`) так же, как пользовательский ввод.
- Если приложение не включило mouse tracking, инструмент возвращает ошибку вместо фиктивного успеха.

Тот же mouse action добавляется в dynamic tools встроенного AI.

### `resize_terminal`

Меняет размер только указанной MCP-сессии через существующий согласованный путь xterm + ConPTY и возвращает фактический размер.

### `close_terminal`

Закрывает одну принадлежащую подключению сессию. Повторный вызов для закрытого handle возвращает понятную ошибку.

## Формат наблюдения

Читаемый текст и оформление разделены, чтобы стили не мешали модели читать содержимое:

```ts
type TerminalObservation = {
  timedOut: boolean;
  snapshot: {
    status: "running" | "exited";
    title: string | null;
    processName: string | null;
    size: { cols: number; rows: number };
    buffer: "normal" | "alternate";
    sequence: number;
    cursor: { col: number; row: number };
    viewportY: number;
    screen: {
      firstLine: number;
      lines: string[];
      styles: StyleRun[];
    };
    scrollback?: {
      firstLine: 0;
      lines: string[];
    };
  };
};

type StyleRun = {
  row: number;
  startColumn: number;
  endColumn: number;
  foreground?: TerminalColor;
  background?: TerminalColor;
  bold?: true;
  italic?: true;
  dim?: true;
  underline?: true;
  blink?: true;
  inverse?: true;
  invisible?: true;
  strikethrough?: true;
  overline?: true;
};

type TerminalColor =
  | { mode: "default" }
  | { mode: "palette"; index: number }
  | { mode: "rgb"; value: string };
```

Правила:

- `screen.lines` всегда содержит только текущий live-экран (`baseY … baseY + rows`), независимо от того, прокрутил ли пользователь viewport вверх.
- `viewportY` сообщается отдельно, чтобы агент видел состояние пользовательского просмотра, но не принимал старый viewport за текущий TUI-экран.
- `screen.styles` относится только к `screen.lines`; строки остаются обычным текстом.
- Style runs используют координаты колонок xterm, а не UTF-16 offsets, поэтому корректно описывают wide и combined characters.
- Соседние ячейки с одинаковым оформлением объединяются.
- Неоформленные default-ячейки не создают run.
- Значимый цвет фона на пустых ячейках сохраняется; такие пробелы нельзя обрезать раньше конца style run.
- `scrollback.lines`, если запрошен, содержит весь активный текстовый буфер xterm с текущим экраном в конце и без стилевой разметки.
- Для alternate buffer возвращается полный доступный active buffer; искусственно смешивать его с normal buffer не нужно.
- Встроенному AI автоматически передаётся только текущий экран. Полный scrollback он получает явным вызовом `observe_terminal`.

## Визуальная индикация

Для активной вкладки вычисляется один agent-control state:

- `none`
- `mcp-owned`
- `assistant-running`

CSS-классы на `.screen-frame`:

- `.agent-control-mcp` — голубой border/outer glow на всё время жизни MCP-владения;
- `.agent-control-ai` — зелёный border/outer glow только пока turn встроенного AI активен.

Для `bezel-hidden` эффект рисуется через outline или `::after`, не меняя размеры canvas и terminal geometry. Анимация должна быть спокойной и учитывать `prefers-reduced-motion`.

Одновременного MCP и встроенного AI состояния у одной вкладки нет: UI и отправка сообщений встроенного AI блокируются для MCP-owned session.

## Изменения по слоям

### Frontend

- `src/terminal/TerminalSession.ts`
  - расширить snapshot текущим экраном и style runs;
  - добавить opt-in полный scrollback;
  - добавить семантический mouse automation;
  - сделать ожидание вывода отменяемым при disconnect/close.
- Новый небольшой terminal automation dispatcher рядом с `TerminalSession`:
  - единая валидация аргументов;
  - dispatch observe/keyboard/mouse;
  - общий код для MCP и встроенного AI.
- `src/terminal/useTerminal.ts`
  - создавать session с типом владельца и owner ID;
  - возвращать созданный session ID внутреннему bridge;
  - закрывать все сессии владельца;
  - переиспользовать семантический mouse path для DOM-событий.
- `src/App.tsx`
  - подключить Tauri MCP request/reply bridge;
  - заменить локальный AI tool handler общим dispatcher;
  - запретить AI actions для MCP-вкладки;
  - передать agent-control class рамке.
- `src/styles.css`
  - голубое и зелёное свечение без layout shift.
- `src/crt/settings.ts` и `src/ui/SettingsPanel.tsx`
  - валидируемая настройка `mcpEnabled`, default `false`;
  - краткая инструкция/команда конфигурации локального MCP-клиента.

### Rust/Tauri

- Новый модуль broker:
  - lifecycle named pipe listener;
  - owner/handle tables;
  - request IDs, pending replies, cancellation и timeout;
  - закрытие владельца при disconnect;
  - команды/events для WebView bridge.
- Отдельный бинарник `scanline-term-mcp`:
  - официальный MCP server SDK;
  - stdio transport;
  - подключение к локальному pipe;
  - строгая изоляция stdout от логов.
- Packaging:
  - sidecar включён в dev/build/installer/portable ZIP;
  - путь к нему стабилен и документирован для MCP-конфигурации.
- Capabilities разрешают только необходимые внутренние команды/events.

## Безопасность и ошибки

- MCP-режим выключен по умолчанию.
- Named pipe доступен только текущему Windows user SID.
- Ни один публичный MCP tool не принимает внутренний `sessionId`.
- Проверка ownership выполняется на native и WebView границах.
- Terminal output считается недоверенными данными; инструкции встроенного AI сохраняют существующее предупреждение.
- Невалидные handles, координаты, размеры, клавиши, mouse actions и launch arguments отклоняются до ввода в ConPTY.
- Timeout наблюдения не считается завершением команды и не вызывает Ctrl+C.
- Disconnect отменяет waits и закрывает процессы владельца.
- Ошибки не должны подтверждать существование чужой сессии.

## Этапы реализации

1. **Контракт и общий dispatcher**
   - определить типы observation/input/mouse;
   - вынести текущий AI tool dispatch из `App.tsx`;
   - сохранить поведение существующего AI.
2. **Богатый текстовый snapshot**
   - текущий live-экран;
   - отдельные style runs;
   - opt-in полный scrollback;
   - убрать автоматическую отправку полного history в первый AI prompt.
3. **Семантическая TUI-мышь**
   - primary/secondary/wheel и mode validation;
   - переиспользование встроенным AI и пользовательским DOM path;
   - middle button остаётся локальным выделением.
4. **Ownership и UI**
   - MCP-owned session metadata;
   - запрет встроенного AI;
   - закрытие по owner;
   - голубое/зелёное свечение.
5. **Native broker и MCP sidecar**
   - named pipe;
   - stdio MCP tools;
   - cancellation/disconnect cleanup;
   - упаковка sidecar.
6. **Документация и полная проверка**
   - обновить архитектурные документы, core systems, testing, development и `AGENT_GUIDE.md`;
   - выполнить автоматические и ручные проверки ниже.

## Автоматические проверки

- Snapshot:
  - plain text не содержит inline-разметку;
  - default/palette/RGB foreground и background;
  - все поддерживаемые SGR-флаги;
  - wide/combined characters;
  - пустые ячейки со значимым background;
  - current screen берётся от `baseY`, а не пользовательского viewport;
  - scrollback отсутствует по умолчанию и полностью возвращается по запросу.
- Mouse:
  - primary/secondary press/release/click;
  - wheel steps и границы;
  - move/drag для каждого tracking mode;
  - middle button отсутствует;
  - ошибка без mouse tracking.
- Ownership:
  - клиент не видит и не открывает чужие handles;
  - disconnect закрывает все и только его сессии;
  - ручное закрытие инвалидирует handle;
  - встроенный AI не стартует в MCP-вкладке.
- UI:
  - blue/green/none classes;
  - glow виден с bezel и без него;
  - эффект не меняет geometry.
- Rust:
  - framing/version внутреннего протокола;
  - несколько одновременных подключений;
  - cancellation и cleanup pending requests;
  - stdout sidecar содержит только MCP protocol.

## Ручная проверка Windows/Tauri

1. Включить MCP-режим и подключить два независимых MCP-клиента.
2. Создать по две вкладки; убедиться, что каждый клиент видит только свои handles.
3. Проверить PowerShell, FAR Manager и ещё одно mouse-aware TUI.
4. Проверить клавиатуру, primary/secondary click, drag и wheel при обычной и переставленной Windows primary button configuration.
5. Сравнить plain screen и style runs на ANSI palette, RGB, bold, italic и underline.
6. Накопить больше 200 строк; убедиться, что default observation не возвращает scrollback, а явный запрос возвращает весь буфер с текущим экраном в конце.
7. Прокрутить пользовательский viewport вверх и убедиться, что агент всё ещё получает live-экран плюс отдельный `viewportY`.
8. Проверить голубое MCP-свечение, зелёное AI-свечение и режим hidden bezel.
9. Убедиться, что AI composer недоступен в MCP-вкладке, но пользовательский ввод работает.
10. Завершить один MCP-клиент; его процессы и вкладки должны закрыться, вкладки второго клиента — остаться.
11. Проверить installer и portable ZIP с реальной конфигурацией MCP-клиента.

Обязательная общая валидация:

```powershell
npm test
npm run lint
npm run build
Set-Location src-tauri
cargo test
```

После этого обязательно выполнить `npm run tauri:dev` и ручной сценарий выше, поскольку изменение затрагивает Rust, Tauri events/commands, клавиатурный и мышиный ввод и lifecycle ConPTY.

## Критерии готовности

- Внешний агент может полностью управлять созданным им console/TUI процессом, не зная внутренних session IDs.
- Ни один MCP-клиент не может обнаружить или контролировать пользовательскую либо чужую MCP-сессию.
- Текст текущего экрана всегда легко читается; оформление доступно отдельно и не загрязняет текст.
- Полный scrollback выдаётся только по явному запросу и включает текущий экран.
- Primary/secondary buttons соответствуют пользовательской конфигурации Windows; middle click остаётся за Scanline Term.
- Пользователь ясно видит MCP- или AI-управление по цвету рамки.
- Встроенный AI не может работать в MCP-owned session.
- Disconnect гарантированно закрывает все процессы и вкладки владельца без влияния на остальные сессии.
