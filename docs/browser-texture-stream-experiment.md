# JPEG/CDP и TextureStream в Scanline Term

Windows dev-эксперимент сравнивает два тракта до **одного итогового canvas SVS с включённым CRT**. Он запускается на фиксированной локальной сцене при явно включённом benchmark.

Интерактивный режим запускается командой `npm run tauri:dev:texture-stream`. В нём оба захвата работают с одной вкладкой. Этот отчёт описывает отдельный benchmark с прямым видео-входом экспериментального SVS. Запуск с закреплённым SVS использует оверлей для видео и может давать другие показатели. [Запуск и переключение захвата](../scripts/browser-texture-stream/README.md).

## Результат

**TextureStream снизил загрузку CPU и хвост задержки в обеих парах. Устойчивого роста FPS не было.** В более стабильной паре JPEG передал 40,0 новых кадров/с, TextureStream — 35,5. При этом медиана CPU снизилась с 26% до 6%, а p95 от захвата до отправки SVS draw — с 61,0 до 17,7 мс.

Обе пары использовали одну сцену 1280×720, виртуальный растр 1024×768 и `benchmark-default` с CRT. Размер canvas внутри каждой пары был одинаковым. Система — Windows 10 LTSC 1809 (17763.5936), GeForce GTX 750 Ti (драйвер 32.0.15.6094), WebView2 Evergreen 157.0.4341.60. WebGL на обеих ветках сообщил аппаратный ANGLE D3D11.

| Пара и размер canvas | Тракт | Новые кадры/с | Все SVS draw/с | p50 / p95, мс | CPU, медиана | GPU 3D, медиана |
|---|---|---:|---:|---:|---:|---:|
| 30 с, 886×665 | JPEG/CDP | 6,1 | 8,4 | 58,2 / 1693,0 | 4% | 1% |
| 30 с, 886×665 | TextureStream | 6,9 | 10,6 | 56,0 / 467,2 | 1% | 3% |
| 25 с, 948×712 | TextureStream | 35,5 | 60,0 | 5,8 / 17,7 | 6% | 29% |
| 25 с, 948×712 | JPEG/CDP | 40,0 | 59,9 | 43,3 / 61,0 | 26% | 45% |

Условия заметно различались между парами, поэтому сравнение сделано внутри каждой пары. Прогон, в котором canvas вырос посреди измерения, исключён. Обратный порядок замерен заново. Данные первой пары хранятся в `output/texture-stream-benchmark/scanline-abba-720p.json` (использованы только записи `pair: 1`), обратная пара — в `output/texture-stream-benchmark/scanline-reverse-720p.json`.

Отдельные снимки итогового canvas `jpeg.png` и `texture.png` в той же папке подтвердили, что анимация и мелкие цветные строки читаются в обоих трактах. Это визуальная проверка. Пиксельное соответствие и точность передачи цвета не измерялись.

Результат обосновывает TextureStream как опцию снижения CPU и задержки. Обычная сборка использует закреплённый пакет SVS и JPEG/CDP.

## Тракты

- **JPEG/CDP** использует текущий Wry child, `Page.startScreencast` (JPEG 65, каждый кадр), событие Tauri, декодирование изображения, существующий кэш Gallery и композицию оверлея SVS.
- **TextureStream** открывает ту же страницу в отдельном offscreen WebView2 CompositionController. На Windows 10 1809 его `ContainerVisual` захватывается WGC `CreateFromVisual`. DLL преобразует BGRA8 в shared NV12 на совпадающем D3D11-адаптере. Основная WebView2 получает `MediaStream`, а экспериментальная сборка SVS загружает `HTMLVideoElement` в WebGL напрямую. [WGC CreateFromVisual](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscaptureitem.createfromvisual?view=winrt-26100) · [WGC CreateForWindow](https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow).

В этом benchmark на Windows 1809 TextureStream использует отдельный хост источника. Gallery и маршрутизация пользовательского ввода остались за рамками замера. Проверенный Evergreen Runtime поддерживает API с флагом. Статус API экспериментальный и поддержка может измениться после обновления. [Контракт TextureStream](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2experimentaltexturestream?view=webview2-1.0.4071-prerelease).

## Воспроизведение

Нужен локальный SVS worktree на закреплённом коммите `8f7fc6558389385ba78f866911d4a9d2775f53f9` с реализацией `VirtualScreenRenderer.renderVideo` и установленными npm-зависимостями. В эксперименте он расположен рядом с Scanline Term как `SVS-TextureStream-Experiment`. Companion DLL использует Windows SDK с C++/WinRT и WebView2 SDK 1.0.4365-prerelease из самостоятельного PoC.

```powershell
$env:WEBVIEW2_SDK_DIR = (Resolve-Path ..\WebView2TextureStreamPoC\sdk).Path
cmd /d /c scripts\browser-texture-stream\build.cmd
$env:SCANLINE_BROWSER_TEXTURE_STREAM_DLL = Join-Path $env:TEMP 'ScanlineTerm\browser-texture-stream\browser_texture_stream.dll'
$env:SCANLINE_SVS_EXPERIMENT = (Resolve-Path ..\SVS-TextureStream-Experiment).Path
$env:VITE_SCANLINE_BROWSER_BENCHMARK = '1'
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9223 --enable-features=msWebView2TextureStream'
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $env:TEMP 'ScanlineTerm-TextureStream-Experiment-WebView'
npm run tauri:dev:wry -- --no-watch
```

Дождитесь первой вкладки в окне `Scanline Term  [dev]`. Оставьте окно видимым и запустите из второго PowerShell.

```powershell
node scripts/texture-stream-benchmark.mjs --pairs 2 --warmup-ms 8000 --measure-ms 30000 --out output/texture-stream-benchmark/scanline-abba-720p.json
```

`--texture-first --pairs 1` меняет порядок одной пары. Скрипт прерывает замер при изменении размеров источника, итогового canvas, виртуального растра или пресета.

Счётчик новых кадров увеличивается только когда последний принятый JPEG или video timestamp фактически передан текущему draw SVS. Кадры, заменённые до draw, пропускаются. Такой счётчик отличает повторные CRT draw от поступления нового кадра. Физическая частота смены кадров на экране и пиксельные повторы не измеряются. Задержка начинается с CDP capture timestamp или WGC SystemRelativeTime и заканчивается после JS-вызова рендера. Точки отсчёта в двух захватах приблизительно соответствуют друг другу. Завершение GPU-работы и scanout в замер не входят.

CPU — доля общего времени всех логических процессоров для дерева dev-приложения. GPU — сумма выборок 3D engine по PID того же дерева. Скрипт сохраняет выборки по процессам и сырые задержки. Чтение GPU-пикселей для статистики не используется. Внутренний способ загрузки видео в браузере этим тестом не устанавливается.

На этой системе WGC выдавал кадры с новыми временными метками даже когда полностью скрытый HWND показывал чёрное изображение. CDP подтвердил, что страница была скрыта и её `requestAnimationFrame` не выполнялся. Исправленный вариант использует видимый HWND за пределами экрана и ждёт сообщения о первом draw сцены перед отправкой захвата. Предварительный прогон с чёрным источником исключён из сравнения.
