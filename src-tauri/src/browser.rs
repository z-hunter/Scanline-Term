use std::{collections::HashMap, path::Path, sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex}};

use tauri::{webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder}, Emitter, LogicalPosition, LogicalSize, Manager, State, Webview, WebviewUrl};
use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, DevToolsProtocolEventReceivedEventHandler, Microsoft::Web::WebView2::Win32::ICoreWebView2, take_pwstr};
use windows::core::{HSTRING, PWSTR};
#[cfg(windows)]
use windows::core::Interface;
#[cfg(windows)]
use webview2_com::{ContainsFullScreenElementChangedEventHandler, DocumentTitleChangedEventHandler, ExecuteScriptCompletedHandler, NavigationCompletedEventHandler, NavigationStartingEventHandler, NewWindowRequestedEventHandler};
#[cfg(windows)]
use crate::browser_texture_stream;

type BrowserId = String;

fn trace(app: &tauri::AppHandle, stage: &str, session_id: &str, detail: impl serde::Serialize) { let _ = app.emit("browser-trace", serde_json::json!({ "stage": stage, "sessionId": session_id, "detail": detail })); }

#[derive(Default)]
pub struct BrowserState(pub Mutex<BrowserStore>);

impl BrowserState {
    pub fn active_id(&self) -> Result<Option<String>, ()> {
        self.0.try_lock().map(|state| state.active.clone()).map_err(|_| ())
    }
    pub fn has_active_browser(&self) -> bool {
        self.0.lock().map(|state| state.active.is_some()).unwrap_or(true)
    }
}

#[derive(Default)]
pub struct BrowserStore { webviews: HashMap<BrowserId, Webview>, #[cfg(windows)] native_tabs: HashMap<BrowserId, NativeBrowserTab>, screencast_active: HashMap<BrowserId, Arc<AtomicBool>>, active: Option<BrowserId>, bounds: Option<BrowserBounds>, visibility_mode: i32, fullscreen: bool, host_fullscreen: bool }

#[cfg(windows)]
#[derive(Clone, Copy)]
struct NativeBrowserTab { handle: u64, core: usize, controller: usize }

#[cfg(windows)]
impl BrowserState {
    pub fn bounds_handle_if_current(&self, session_id: &str, visibility_mode: i32) -> Result<Option<(u64, usize)>, String> {
        let store = self.0.lock().map_err(|_| "browser state is unavailable")?;
        let Some(tab) = store.native_tabs.get(session_id) else { return Ok(None); };
        let is_active = store.active.as_deref() == Some(session_id);
        if (visibility_mode == 0 && is_active) || (visibility_mode != 0 && !is_active) { return Ok(None); }
        Ok(Some((tab.handle, tab.controller)))
    }

    pub fn texture_stream_tab_handle(&self, session_id: &str) -> Result<u64, String> {
        valid_id(session_id)?;
        let store = self.0.lock().map_err(|_| "browser state is unavailable")?;
        if store.active.as_deref() != Some(session_id) { return Err("browser tab is not active".into()); }
        store.native_tabs.get(session_id).map(|tab| tab.handle).ok_or_else(|| "native browser tab is unavailable".into())
    }

    pub fn texture_stream_available(&self, session_id: &str) -> bool {
        valid_id(session_id).is_ok()
            && self.0.lock().is_ok_and(|store| store.native_tabs.contains_key(session_id))
    }
}

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBounds { pub x: f64, pub y: f64, pub width: f64, pub height: f64 }

fn fit_browser_bounds(viewport: &BrowserBounds, window: &BrowserBounds) -> BrowserBounds {
    if viewport.width <= 0.0 || viewport.height <= 0.0 || window.width <= 0.0 || window.height <= 0.0 {
        return window.clone();
    }
    let ratio = viewport.width / viewport.height;
    let (width, height) = if window.width / window.height > ratio {
        (window.height * ratio, window.height)
    } else {
        (window.width, window.width / ratio)
    };
    BrowserBounds { x: window.x + (window.width - width) / 2.0, y: window.y + (window.height - height) / 2.0, width, height }
}

fn must_exit_page_fullscreen(page_fullscreen: bool, host_fullscreen: bool, window_fullscreen: bool) -> bool {
    page_fullscreen && host_fullscreen && !window_fullscreen
}

#[cfg(windows)]
fn native_browser_rect(bounds: Option<&BrowserBounds>, scale: f64) -> (i32, i32, u32, u32) {
    let bounds = bounds.cloned().unwrap_or(BrowserBounds { x: 0.0, y: 0.0, width: 1280.0, height: 720.0 });
    ((bounds.x * scale).round() as i32, (bounds.y * scale).round() as i32, (bounds.width * scale).ceil().max(2.0) as u32, (bounds.height * scale).ceil().max(2.0) as u32)
}

fn valid_id(id: &str) -> Result<(), String> {
    if id.len() == 36 && id.chars().enumerate().all(|(i, c)| matches!(i, 8 | 13 | 18 | 23) && c == '-' || !matches!(i, 8 | 13 | 18 | 23) && c.is_ascii_hexdigit()) { Ok(()) } else { Err("browser id is invalid".into()) }
}

pub fn browser_url(value: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(value).map_err(|_| "browser URL is invalid")?;
    if matches!(url.scheme(), "http" | "https") { Ok(url) } else { Err("browser URL must use http or https".into()) }
}

pub fn local_file_url(path: &Path) -> Option<url::Url> {
    let path = path.canonicalize().ok()?;
    if !path.is_file() { return None; }
    url::Url::from_file_path(path).ok()
}

pub fn browser_target_url(value: &str) -> Result<url::Url, String> {
    if let Ok(url) = browser_url(value) { return Ok(url); }
    let url = url::Url::parse(value).map_err(|_| "browser URL is invalid")?;
    if url.scheme() == "file" && url.to_file_path().ok().and_then(|path| local_file_url(&path)).is_some() { Ok(url) } else { Err("browser URL must use http, https, or an existing local file".into()) }
}

const NAVIGATION_SCRIPT: &str = r#"(() => {
  let mode = 'normal', pendingG = false, hint = null;
  const open = window.open; window.open = (url, ...args) => typeof url === 'string' && /^(?:https?|file):/i.test(url) ? (location.href = url, window) : open.call(window, url, ...args);
  addEventListener('click', e => { const link = e.target.closest('a[target="_blank"]'); if (link?.href) { e.preventDefault(); location.href = link.href; } }, true);
  const editable = e => e && (e.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName));
  const labels = 'asdfghjkl';
  const parseColor = value => { const hex=value?.match(/^#([\da-f]{3,6})$/i); if (hex) { const raw=hex[1].length===3 ? hex[1].split('').map(c=>c+c).join('') : hex[1]; return raw.toLowerCase(); } const rgb=value?.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i); return rgb && (rgb[4] === undefined || Number(rgb[4]) > 0) ? [rgb[1],rgb[2],rgb[3]].map(c=>Number(c).toString(16).padStart(2,'0')).join('') : null; };
  const reportColor = () => { const body=document.body, root=document.documentElement; const meta=document.querySelector('meta[name="theme-color"]')?.content; const background=parseColor(meta) || parseColor(getComputedStyle(body || root).backgroundColor) || parseColor(getComputedStyle(root).backgroundColor) || 'f5f5f5'; const title=document.title; document.title=title+'\u2063'+background; setTimeout(() => { if (document.title === title+'\u2063'+background) document.title=title; }, 0); };
  const labelAt = (n, total = 0) => { let w = 1, c = labels.length; while (total > c) { w++; c *= labels.length; } let s = ''; for (let i = w - 1; i >= 0; i--) s += labels[Math.floor(n / Math.pow(labels.length, i)) % labels.length]; return s; };
  const clearHints = () => { hint?.nodes.forEach(n => n.remove()); hint = null; };
  const showHints = () => { clearHints(); const items = [...document.querySelectorAll('a[href],button,input,textarea,select,[role=button]')].filter(e => { const r=e.getBoundingClientRect(); return r.width && r.height && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; }); const entries=items.map((element,index)=>({element,label:labelAt(index, items.length)})); const nodes=entries.map(({element,label})=>{ const r=element.getBoundingClientRect(), node=document.createElement('i'); node.textContent=label; node.style.cssText=`position:fixed;z-index:2147483647;left:${r.left}px;top:${r.top}px;background:#ffe66d;color:#111;padding:1px 3px;font:12px monospace;font-style:normal;pointer-events:none`; document.documentElement.append(node); return node; }); hint={entries,nodes,typed:''}; };
  const address = () => { document.querySelector('[data-scanline-address]')?.remove(); const box = document.createElement('form'); box.dataset.scanlineAddress=''; box.style.cssText = 'position:fixed;z-index:2147483647;left:4%;top:12px;width:92%;display:flex;gap:6px;padding:8px;background:#101510;border:1px solid #6a8;color:#dfe;font:16px monospace;box-sizing:border-box'; box.innerHTML = '<button type="button" data-back aria-label="Back">←</button><button type="button" data-forward aria-label="Forward">→</button><input aria-label="Address" style="min-width:0;flex:1;background:#020;color:#dfe;border:1px solid #6a8;padding:8px" />'; const input = box.querySelector('input'); const close=()=>{ document.removeEventListener('pointerdown', outside, true); box.remove(); }; const outside=e=>{ if(!box.contains(e.target)) close(); }; input.value = location.href; box.querySelector('[data-back]').onclick=()=>history.back(); box.querySelector('[data-forward]').onclick=()=>history.forward(); box.onsubmit = e => { e.preventDefault(); const v=input.value.trim(); close(); if(v) location.href=/^(?:https?|file):\/\//i.test(v)?v:`https://${v}`; }; input.onkeydown = e => { if(e.key==='Escape') { e.preventDefault(); close(); } else if(e.key==='Enter') { e.preventDefault(); box.requestSubmit(); } }; document.documentElement.append(box); requestAnimationFrame(()=>document.addEventListener('pointerdown', outside, true)); input.focus(); input.select(); };
  addEventListener('keydown', e => {
    if (hint) { const key=e.key.toLowerCase(); if (e.key === 'Escape') { e.preventDefault(); clearHints(); return; } if (!labels.includes(key)) return; e.preventDefault(); hint.typed += key; const matches=hint.entries.filter(item=>item.label.startsWith(hint.typed)); if (matches.length === 1 && matches[0].label === hint.typed) { const element=matches[0].element; clearHints(); element.focus?.(); element.click(); } else if (!matches.length) clearHints(); return; }
    if (e.key === 'F6') { e.preventDefault(); address(); return; }
    if (mode === 'insert') { if (e.key === 'Escape') { e.preventDefault(); e.target.blur(); mode = 'normal'; } return; }
    if (mode === 'pass') { if (e.key === 'Escape') { e.preventDefault(); mode = 'normal'; } return; }
    if (editable(e.target)) return;
    if (e.key === 'i') { mode = 'pass'; return; }
    if (e.code === 'KeyO') { e.preventDefault(); address(); return; }
    if (e.code === 'Backspace') { e.preventDefault(); history.back(); return; }
    if (e.code === 'KeyJ') { e.preventDefault(); scrollBy(0, 64); }
    else if (e.code === 'KeyK') { e.preventDefault(); scrollBy(0, -64); }
    else if (e.code === 'KeyD') { e.preventDefault(); scrollBy(0, innerHeight / 2); }
    else if (e.code === 'KeyU') { e.preventDefault(); scrollBy(0, -innerHeight / 2); }
    else if (e.key === 'G') { e.preventDefault(); scrollTo(0, document.body.scrollHeight); }
    else if (e.key === 'g' && pendingG) { e.preventDefault(); scrollTo(0, 0); pendingG = false; }
    else if (e.key === 'g') { pendingG = true; setTimeout(() => pendingG = false, 500); }
    else if (e.code === 'KeyH') { e.preventDefault(); history.back(); }
    else if (e.code === 'KeyL') { e.preventDefault(); history.forward(); }
    else if (e.key.toLowerCase() === 'f') { e.preventDefault(); showHints(); }
    else if (e.key === '/') { e.preventDefault(); const text=prompt('Find'); if(text) window.find(text); }
    else if (e.key === 'r') { e.preventDefault(); location.reload(); }
  }, true);
  setTimeout(reportColor, 0);
})()"#;

fn browser_color_value(value: &str) -> Option<String> {
    if value.len() == 6 && value.chars().all(|character| character.is_ascii_hexdigit()) {
        Some(format!("#{value}"))
    } else {
        None
    }
}

#[cfg(windows)]
fn install_browser_fullscreen_handler(app: &tauri::AppHandle, session_id: &str, core: &ICoreWebView2) -> Result<(), String> {
    let app = app.clone();
    let id = session_id.to_owned();
    let handler = ContainsFullScreenElementChangedEventHandler::create(Box::new(move |webview, _| {
        if let Some(webview) = webview {
            let mut contains_fullscreen = windows::core::BOOL::default();
            unsafe { webview.ContainsFullScreenElement(&mut contains_fullscreen)?; }
            let active = app.state::<BrowserState>().0.lock().is_ok_and(|mut state| {
                if state.active.as_deref() != Some(&id) { return false; }
                state.fullscreen = contains_fullscreen.as_bool();
                true
            });
            if active {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_fullscreen(contains_fullscreen.as_bool());
                }
            }
        }
        Ok(())
    }));
    let mut token = 0;
    unsafe { core.add_ContainsFullScreenElementChanged(&handler, &mut token) }.map_err(|error| error.to_string())
}

#[cfg(windows)]
fn install_native_browser_tab(app: &tauri::AppHandle, session_id: &str, tab: NativeBrowserTab, initial_url: &str, script: &str, screencast_active: Arc<AtomicBool>) -> Result<(), String> {
    let app = app.clone();
    let app_for_dispatch = app.clone();
    let id = session_id.to_owned();
    let script = script.to_owned();
    let initial = HSTRING::from(initial_url);
    browser_texture_stream::with_main_webview(&app_for_dispatch, move |_, _| unsafe {
        let mut raw = tab.core as *mut std::ffi::c_void;
        let Some(core) = ICoreWebView2::from_raw_borrowed(&mut raw) else { return Err("native browser core is unavailable".to_owned()); };
        install_browser_fullscreen_handler(&app, &id, core)?;

        let navigation = NavigationStartingEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()); };
            let mut uri = PWSTR::null();
            args.Uri(&mut uri)?;
            let target = take_pwstr(uri);
            if url::Url::parse(&target).is_ok() {
                if target != "about:blank" && browser_target_url(&target).is_err() {
                    args.SetCancel(true)?;
                }
            } else {
                args.SetCancel(true)?;
            }
            Ok(())
        }));
        let mut token = 0;
        core.add_NavigationStarting(&navigation, &mut token).map_err(|error| error.to_string())?;

        let page_app = app.clone();
        let page_id = id.clone();
        let page_script = script.clone();
        let completed = NavigationCompletedEventHandler::create(Box::new(move |webview, _| {
            if let Some(webview) = webview {
                let callback = ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(())));
                let _ = webview.ExecuteScript(&HSTRING::from(page_script.as_str()), &callback);
                trace(&page_app, "script-installed", &page_id, "navigation-finished");
            }
            Ok(())
        }));
        core.add_NavigationCompleted(&completed, &mut token).map_err(|error| error.to_string())?;

        let title_app = app.clone();
        let title_id = id.clone();
        let title = DocumentTitleChangedEventHandler::create(Box::new(move |webview, _| {
            if let Some(webview) = webview {
                let mut title = PWSTR::null();
                if webview.DocumentTitle(&mut title).is_ok() {
                    let title = take_pwstr(title);
                    if let Some((_, raw_color)) = title.rsplit_once('\u{2063}') {
                        if let Some(color) = browser_color_value(raw_color) {
                            let _ = title_app.emit("browser-color", serde_json::json!({ "sessionId": title_id, "background": color }));
                            return Ok(());
                        }
                    }
                    let _ = title_app.emit("browser-title", serde_json::json!({ "sessionId": title_id, "title": title }));
                }
            }
            Ok(())
        }));
        core.add_DocumentTitleChanged(&title, &mut token).map_err(|error| error.to_string())?;

        let deny_new_windows = NewWindowRequestedEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args { args.SetHandled(true)?; }
            Ok(())
        }));
        core.add_NewWindowRequested(&deny_new_windows, &mut token).map_err(|error| error.to_string())?;

        let event_app = app.clone();
        let event_id = id.clone();
        let event_active = screencast_active;
        let receiver = core.GetDevToolsProtocolEventReceiver(&HSTRING::from("Page.screencastFrame")).map_err(|error| error.to_string())?;
        let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
            if !event_active.load(Ordering::Relaxed) { return Ok(()); }
            let Some(args) = args else { return Ok(()); };
            let mut json = PWSTR::null();
            args.ParameterObjectAsJson(&mut json)?;
            let payload = serde_json::from_str::<serde_json::Value>(&take_pwstr(json)).unwrap_or_default();
            if let (Some(data), Some(screencast_session_id)) = (payload.get("data").and_then(serde_json::Value::as_str), payload.get("sessionId").and_then(serde_json::Value::as_i64)) {
                let timestamp = payload.pointer("/metadata/timestamp").and_then(serde_json::Value::as_f64);
                let _ = event_app.emit("browser-experiment-frame", serde_json::json!({ "sessionId": event_id, "screencastSessionId": screencast_session_id, "timestamp": timestamp, "data": data }));
            }
            Ok(())
        }));
        receiver.add_DevToolsProtocolEventReceived(&handler, &mut token).map_err(|error| error.to_string())?;
        core.Navigate(&initial).map_err(|error| error.to_string())?;
        Ok::<(), String>(())
    })??;
    Ok(())
}

fn create_browser_impl(app: tauri::AppHandle, session_id: BrowserId, url: Option<String>) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    valid_id(&session_id)?;
    let initial = url.as_deref().map(browser_target_url).transpose()?.unwrap_or_else(|| url::Url::parse("about:blank").unwrap());
    let window = app.get_window("main").ok_or("main window is unavailable")?;
    trace(&app, "create", &session_id, initial.as_str());
    let id = session_id.clone(); let app_for_title = app.clone(); let page_app = app.clone(); let page_id = session_id.clone();
    let navigation_script = NAVIGATION_SCRIPT.replace("__SCANLINE_SHORTCUT_URL__", &format!("scanline-term://shortcut/{session_id}/"));
    let screencast_active = Arc::new(AtomicBool::new(false));
    let store_session_id = session_id.clone();
    #[cfg(windows)]
    if browser_texture_stream::browser_tab_enabled(&app) {
        let native_tab = (|| -> Result<NativeBrowserTab, String> {
            let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
            let (size, active) = { let store = state.0.lock().map_err(|_| "browser state is unavailable")?; (store.bounds.clone(), store.active.as_deref() == Some(&session_id)) };
            let scale = window.scale_factor().unwrap_or(1.0);
            let (_, _, width, height) = native_browser_rect(size.as_ref(), scale);
            let tab = browser_texture_stream::create_browser_tab(&app, hwnd, &session_id, width, height)?;
            let native = NativeBrowserTab { handle: tab.handle, core: tab.core, controller: tab.controller };
            if let Err(error) = install_native_browser_tab(&app, &session_id, native, initial.as_str(), &navigation_script, screencast_active.clone()) {
                let _ = browser_texture_stream::close_browser_tab(&app, tab.handle, tab.core, tab.controller);
                return Err(error);
            }
            let (x, y, bounds_width, bounds_height) = native_browser_rect(size.as_ref(), scale);
            if let Err(error) = browser_texture_stream::set_browser_tab_bounds(&app, tab.handle, x, y, bounds_width, bounds_height, i32::from(active)) {
                let _ = browser_texture_stream::close_browser_tab(&app, tab.handle, tab.core, tab.controller);
                return Err(error);
            }
            Ok(native)
        })();
        match native_tab {
            Ok(native) => {
                let mut state = state.0.lock().map_err(|_| "browser state is unavailable")?;
                state.native_tabs.insert(session_id, native);
                state.screencast_active.insert(store_session_id, screencast_active);
                return Ok(());
            }
            Err(error) => trace(&app, "native-tab-fallback", &session_id, error),
        }
    }
    let browser = window.add_child(
        WebviewBuilder::new(format!("browser-{session_id}"), WebviewUrl::External(initial))
            .devtools(cfg!(debug_assertions))
            .on_navigation(move |url| { matches!(url.scheme(), "http" | "https" | "about") || (url.scheme() == "file" && browser_target_url(url.as_str()).is_ok()) })
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_download(|_, _| true)
            .on_page_load(move |webview, payload| { let event = payload.event(); trace(&page_app, match event { PageLoadEvent::Started => "load-start", PageLoadEvent::Finished => "load-finished" }, &page_id, payload.url().as_str()); if event == PageLoadEvent::Finished { match webview.eval(&navigation_script) { Ok(()) => trace(&page_app, "script-installed", &page_id, payload.url().as_str()), Err(error) => trace(&page_app, "script-failed", &page_id, error.to_string()) } } })
            .on_document_title_changed(move |_, title| { if let Some((_, raw_color)) = title.rsplit_once('\u{2063}') { if let Some(color) = browser_color_value(raw_color) { let _ = app_for_title.emit("browser-color", serde_json::json!({ "sessionId": id, "background": color })); return; } } let _ = app_for_title.emit("browser-title", serde_json::json!({ "sessionId": id, "title": title })); }),
        LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0)
    ).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        let fullscreen_app = app.clone();
        let fullscreen_id = session_id.clone();
        browser.with_webview(move |platform| unsafe {
            match platform.controller().CoreWebView2() {
                Ok(core) => if let Err(error) = install_browser_fullscreen_handler(&fullscreen_app, &fullscreen_id, &core) {
                    trace(&fullscreen_app, "fullscreen-handler-failed", &fullscreen_id, error);
                },
                Err(error) => trace(&fullscreen_app, "fullscreen-handler-failed", &fullscreen_id, error.to_string()),
            }
        }).map_err(|error| error.to_string())?;
    }
    let event_active = screencast_active.clone();
    let app_for_frames = app.clone();
    let frame_session_id = session_id.clone();
    let event_error_session_id = session_id.clone();
    let app_for_event_setup_error = app.clone();
    browser.with_webview(move |platform| unsafe {
        let result = (|| -> windows::core::Result<()> {
            let core: ICoreWebView2 = platform.controller().CoreWebView2()?;
            let receiver = core.GetDevToolsProtocolEventReceiver(&HSTRING::from("Page.screencastFrame"))?;
            let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
                if !event_active.load(Ordering::Relaxed) { return Ok(()); }
                let Some(args) = args else { return Ok(()); };
                let mut json = PWSTR::null();
                args.ParameterObjectAsJson(&mut json)?;
                let payload = serde_json::from_str::<serde_json::Value>(&take_pwstr(json)).unwrap_or_default();
                let data = payload.get("data").and_then(serde_json::Value::as_str);
                let screencast_session_id = payload.get("sessionId").and_then(serde_json::Value::as_i64);
                if let (Some(data), Some(screencast_session_id)) = (data, screencast_session_id) {
                    let timestamp = payload.pointer("/metadata/timestamp").and_then(serde_json::Value::as_f64);
                    let _ = app_for_frames.emit("browser-experiment-frame", serde_json::json!({ "sessionId": frame_session_id, "screencastSessionId": screencast_session_id, "timestamp": timestamp, "data": data }));
                }
                Ok(())
            }));
            let mut token = 0;
            receiver.add_DevToolsProtocolEventReceived(&handler, &mut token)
        })();
        if let Err(error) = result { let _ = app_for_event_setup_error.emit("browser-experiment-frame", serde_json::json!({ "sessionId": event_error_session_id, "error": error.to_string() })); }
    }).map_err(|e| e.to_string())?;
    browser.hide().map_err(|e| e.to_string())?;
    let mut state = state.0.lock().map_err(|_| "browser state is unavailable")?;
    if state.active.as_deref() == Some(&session_id) {
        if let Some(bounds) = &state.bounds { browser.set_bounds(tauri::Rect { position: LogicalPosition::new(bounds.x, bounds.y).into(), size: LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)).into() }).map_err(|e| e.to_string())?; }
        browser.show().map_err(|e| e.to_string())?; trace(&app, "show-after-create", &session_id, state.bounds.as_ref().map(|b| (b.x, b.y, b.width, b.height)));
    }
    state.webviews.insert(session_id, browser);
    state.screencast_active.insert(store_session_id, screencast_active);
    Ok(())
}

#[tauri::command]
pub async fn create_browser(app: tauri::AppHandle, session_id: BrowserId, url: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || create_browser_impl(app, session_id, url))
        .await.map_err(|error| error.to_string())?
}

#[cfg(windows)]
#[tauri::command]
pub fn browser_texture_stream_available(state: State<BrowserState>, session_id: BrowserId) -> bool {
    state.texture_stream_available(&session_id)
}

#[tauri::command]
pub async fn navigate_browser(app: tauri::AppHandle, state: State<'_, BrowserState>, session_id: BrowserId, url: String) -> Result<(), String> {
    valid_id(&session_id)?; let url = browser_target_url(&url)?;
    trace(&app, "navigate", &session_id, url.as_str());
    #[cfg(windows)]
    let native = { state.0.lock().map_err(|_| "browser state is unavailable")?.native_tabs.get(&session_id).copied() };
    #[cfg(windows)]
    if native.is_some() {
        let app = app.clone();
        let state_app = app.clone();
        let session_id_for_callback = session_id.clone();
        let uri = HSTRING::from(url.as_str());
        return tauri::async_runtime::spawn_blocking(move || browser_texture_stream::with_main_webview(&app, move |_, _| unsafe {
            let state = state_app.state::<BrowserState>();
            let store = state.0.lock().map_err(|_| "browser state is unavailable".to_string())?;
            let native = store.native_tabs.get(&session_id_for_callback).copied().ok_or_else(|| "native browser tab is unavailable".to_string())?;
            let mut core_raw = native.core as *mut std::ffi::c_void;
            let core = ICoreWebView2::from_raw_borrowed(&mut core_raw).ok_or_else(|| "native browser core is unavailable".to_string())?;
            core.Navigate(&uri).map_err(|error| error.to_string())
        })).await.map_err(|error| error.to_string())??;
    }
    let browser_state = state.0.lock().map_err(|_| "browser state is unavailable")?;
    browser_state.webviews.get(&session_id).ok_or("browser is not running")?.navigate(url).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_devtools(app: tauri::AppHandle, state: State<'_, BrowserState>, session_id: BrowserId, method: String, params: serde_json::Value) -> Result<(), String> {
    valid_id(&session_id)?;
    if !matches!(method.as_str(), "Input.dispatchMouseEvent" | "Input.dispatchKeyEvent"
        // Legacy CDP capture. Keep input routing when changing the capture transport.
        /* | "Page.startScreencast" | "Page.stopScreencast" | "Page.screencastFrameAck" */
    ) { return Err("unsupported browser DevTools command".into()); }
    let params = serde_json::to_string(&params).map_err(|error| error.to_string())?;
    let capture = method == "Page.startScreencast";
    let native_exists = {
        let browser_state = state.0.lock().map_err(|_| "browser state is unavailable")?;
        let screencast_active = browser_state.screencast_active.get(&session_id).cloned().ok_or("browser screencast is unavailable")?;
        if method == "Page.startScreencast" { screencast_active.store(true, Ordering::Relaxed); }
        if method == "Page.stopScreencast" { screencast_active.store(false, Ordering::Relaxed); }
        if let Some(browser) = browser_state.webviews.get(&session_id) {
            let app_for_callback = app.clone();
            let app_for_error = app.clone();
            let id_for_callback = session_id.clone();
            let id_for_error = session_id.clone();
            return browser.with_webview(move |platform| unsafe {
                let result = (|| -> windows::core::Result<()> {
                    let core: ICoreWebView2 = platform.controller().CoreWebView2()?;
                    let method = HSTRING::from(method);
                    let params = HSTRING::from(params);
                    let callback = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |status, response| {
                        if let Err(error) = status { if capture { let _ = app_for_callback.emit("browser-experiment-frame", serde_json::json!({ "sessionId": id_for_callback, "error": error.to_string() })); } }
                        else { let _ = response; }
                        Ok(())
                    }));
                    core.CallDevToolsProtocolMethod(&method, &params, &callback)
                })();
                if let Err(error) = result { if capture { let _ = app_for_error.emit("browser-experiment-frame", serde_json::json!({ "sessionId": id_for_error, "error": error.to_string() })); } }
            }).map_err(|error| error.to_string());
        }
        #[cfg(windows)]
        { browser_state.native_tabs.contains_key(&session_id) }
        #[cfg(not(windows))]
        { false }
    };
    if !native_exists { return Err("browser is not running".into()); }
    #[cfg(windows)]
    {
        let app_for_callback = app.clone();
        let app_for_state = app.clone();
        let id_for_state = session_id.clone();
        let id_for_callback = session_id.clone();
        tauri::async_runtime::spawn_blocking(move || browser_texture_stream::with_main_webview(&app, move |_, _| unsafe {
            let state = app_for_state.state::<BrowserState>();
            let store = state.0.lock().map_err(|_| "browser state is unavailable".to_string())?;
            let native = store.native_tabs.get(&id_for_state).copied().ok_or_else(|| "native browser tab is unavailable".to_string())?;
            let mut core_raw = native.core as *mut std::ffi::c_void;
            let core = ICoreWebView2::from_raw_borrowed(&mut core_raw).ok_or_else(|| "native browser core is unavailable".to_string())?;
            let method = HSTRING::from(method);
            let params = HSTRING::from(params);
            let callback = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |status, response| {
                if let Err(error) = status { if capture { let _ = app_for_callback.emit("browser-experiment-frame", serde_json::json!({ "sessionId": id_for_callback, "error": error.to_string() })); } }
                else { let _ = response; }
                Ok(())
            }));
            core.CallDevToolsProtocolMethod(&method, &params, &callback).map_err(|error| error.to_string())
        })).await.map_err(|error| error.to_string())??
    }
    #[cfg(not(windows))]
    {
        Err("browser is not running".into())
    }
}

#[cfg(windows)]
#[tauri::command]
pub async fn capture_gallery_browser(app: tauri::AppHandle, session_id: BrowserId) -> Result<String, String> {
    valid_id(&session_id)?;
    static CAPTURE_LOCK: Mutex<()> = Mutex::new(());
    tauri::async_runtime::spawn_blocking(move || {
        use std::{sync::mpsc, time::Duration};
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller;
        use windows::Win32::Foundation::RECT;

        let _guard = CAPTURE_LOCK.lock().map_err(|_| "browser capture is unavailable")?;
        let app_on_ui = app.clone();
        let id_on_ui = session_id.clone();
        let (handle, width, height) = browser_texture_stream::with_main_webview(&app, move |_, _| {
            let tab = {
                let state = app_on_ui.state::<BrowserState>();
                let store = state.0.lock().map_err(|_| "browser state is unavailable")?;
                if store.active.is_some() { return Err("gallery browser capture is inactive".to_string()); }
                *store.native_tabs.get(&id_on_ui).ok_or("native browser tab is unavailable")?
            };
            unsafe {
                let mut raw = tab.controller as *mut std::ffi::c_void;
                let controller = ICoreWebView2Controller::from_raw_borrowed(&mut raw).ok_or("browser controller is unavailable")?;
                let mut bounds = RECT::default();
                controller.Bounds(&mut bounds).map_err(|error| error.to_string())?;
                let width = (bounds.right - bounds.left).max(2) as u32;
                let height = (bounds.bottom - bounds.top).max(2) as u32;
                browser_texture_stream::set_browser_tab_bounds_on_ui(&app_on_ui, tab.handle, width, height, 2)?;
                Ok::<_, String>((tab.handle, width, height))
            }
        })??;

        // Let the offscreen compositor produce a fresh frame after the tab becomes visible.
        std::thread::sleep(Duration::from_millis(400));
        let (sender, receiver) = mpsc::sync_channel(1);
        let app_on_ui = app.clone();
        let id_on_ui = session_id.clone();
        let started = browser_texture_stream::with_main_webview(&app, move |_, _| {
            let tab = {
                let state = app_on_ui.state::<BrowserState>();
                let store = state.0.lock().map_err(|_| "browser state is unavailable")?;
                if store.active.is_some() { return Err("gallery browser capture was cancelled".to_string()); }
                *store.native_tabs.get(&id_on_ui).filter(|tab| tab.handle == handle).ok_or("browser tab is closed")?
            };
            unsafe {
                let mut raw = tab.core as *mut std::ffi::c_void;
                let core = ICoreWebView2::from_raw_borrowed(&mut raw).ok_or("native browser core is unavailable")?;
                let callback = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |status, response| {
                    let result = status.map_err(|error| error.to_string()).and_then(|_| {
                        let parsed: serde_json::Value = serde_json::from_str(&response).map_err(|error| error.to_string())?;
                        parsed.get("data").and_then(|value| value.as_str()).map(str::to_owned).ok_or_else(|| "browser snapshot is empty".to_string())
                    });
                    let _ = sender.send(result);
                    Ok(())
                }));
                core.CallDevToolsProtocolMethod(
                    &HSTRING::from("Page.captureScreenshot"),
                    &HSTRING::from(r#"{"format":"jpeg","quality":65,"fromSurface":true}"#),
                    &callback,
                ).map_err(|error| error.to_string())
            }
        }).and_then(|result| result);
        let result = match started {
            Ok(()) => receiver.recv_timeout(Duration::from_secs(5)).map_err(|_| "browser snapshot timed out".to_string()).and_then(|result| result),
            Err(error) => Err(error),
        };
        let app_on_ui = app.clone();
        let _ = browser_texture_stream::with_main_webview(&app, move |_, _| {
            let should_hide = app_on_ui.state::<BrowserState>().0.lock().is_ok_and(|store| {
                store.active.as_deref() != Some(session_id.as_str()) &&
                    store.native_tabs.get(&session_id).is_some_and(|tab| tab.handle == handle)
            });
            if should_hide { let _ = browser_texture_stream::set_browser_tab_bounds_on_ui(&app_on_ui, handle, width, height, 0); }
        });
        result
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn set_active_browser(app: tauri::AppHandle, state: State<'_, BrowserState>, session_id: Option<BrowserId>, bounds: Option<BrowserBounds>, fullscreen_bounds: Option<BrowserBounds>, visibility_mode: Option<i32>) -> Result<(), String> {
    if visibility_mode.is_some_and(|mode| !(0..=2).contains(&mode)) { return Err("invalid browser visibility mode".into()); }
    trace(&app, "set-active", session_id.as_deref().unwrap_or("none"), bounds.as_ref().map(|b| (b.x, b.y, b.width, b.height)));
    let window_bounds = app.get_webview_window("main").and_then(|window| {
        let scale = window.scale_factor().ok()?;
        let size = window.inner_size().ok()?;
        Some(BrowserBounds { x: 0.0, y: 0.0, width: f64::from(size.width) / scale, height: f64::from(size.height) / scale })
    });
    let window_fullscreen = app.get_webview_window("main").and_then(|window| window.is_fullscreen().ok()).unwrap_or(false);
    #[cfg(windows)]
    let native_scale = app.get_webview_window("main").and_then(|window| window.scale_factor().ok()).unwrap_or(1.0);
    let (return_to_terminal, restore_fullscreen, exit_page_fullscreen, exit_webview_fullscreen, native_ops) = {
        let mut state = state.0.lock().map_err(|_| "browser state is unavailable")?;
        let return_to_terminal = state.active.is_some() && session_id.is_none();
        let became_active = state.active != session_id;
        #[cfg(windows)]
        if became_active { crate::browser_keymap::set_browser_focus_identity(0); }
        let restore_fullscreen = became_active && state.fullscreen;
        if restore_fullscreen { state.fullscreen = false; }
        let force_exit_page_fullscreen = must_exit_page_fullscreen(state.fullscreen, state.host_fullscreen, window_fullscreen);
        let exit_webview_fullscreen = if force_exit_page_fullscreen {
            state.fullscreen = false;
            state.host_fullscreen = false;
            state.active.as_ref().and_then(|id| state.webviews.get(id).cloned())
        } else { None };
        #[cfg(windows)]
        let exit_page_fullscreen = if force_exit_page_fullscreen {
            state.active.as_ref().and_then(|id| state.native_tabs.get(id).map(|tab| tab.core))
        } else { None };
        #[cfg(not(windows))]
        let exit_page_fullscreen: Option<usize> = None;
        if window_fullscreen { state.host_fullscreen = true; }
        else if !state.fullscreen { state.host_fullscreen = false; }
        state.active = session_id.clone(); state.bounds = bounds.clone();
        state.visibility_mode = if session_id.is_some() { visibility_mode.unwrap_or_else(|| if bounds.as_ref().is_some_and(|b| b.x < 0.0 || b.y < 0.0) { 2 } else { 1 }) } else { 0 };
        let mut fullscreen_rect = if state.fullscreen {
            fullscreen_bounds.as_ref().or(window_bounds.as_ref()).and_then(|area| bounds.as_ref().or(state.bounds.as_ref()).map(|viewport| fit_browser_bounds(viewport, area)))
        } else { None };
        if state.visibility_mode == 2 {
            if let (Some(rect), Some(viewport)) = (fullscreen_rect.as_mut(), bounds.as_ref().or(state.bounds.as_ref())) {
                rect.x = viewport.x;
                rect.y = viewport.y;
            }
        }
        let active_bounds = fullscreen_rect.as_ref().or(bounds.as_ref());
        for (id, browser) in state.webviews.iter() {
            if let Some(rect) = active_bounds { browser.set_bounds(tauri::Rect { position: LogicalPosition::new(rect.x, rect.y).into(), size: LogicalSize::new(rect.width.max(1.0), rect.height.max(1.0)).into() }).map_err(|e| e.to_string())?; }
            if Some(id) == session_id.as_ref() {
                browser.show().map_err(|e| e.to_string())?; trace(&app, "show", id, bounds.as_ref().map(|b| (b.x, b.y, b.width, b.height)));
                if became_active { let _ = browser.set_focus(); }
            } else { let _ = browser.hide(); }
        }
        #[cfg(windows)]
        let native_ops = state.native_tabs.iter().map(|(id, _tab)| {
            let rect = active_bounds.or(state.bounds.as_ref());
            let mode = if Some(id) == session_id.as_ref() { state.visibility_mode } else { 0 };
            let (x, y, width, height) = native_browser_rect(rect, native_scale);
            (id.clone(), x, y, width, height, mode, became_active && mode == 1)
        }).collect::<Vec<_>>();
        #[cfg(not(windows))]
        let native_ops: Vec<(String, i32, i32, u32, u32, i32, bool)> = Vec::new();
        (return_to_terminal, restore_fullscreen, exit_page_fullscreen, exit_webview_fullscreen, native_ops)
    };
    if restore_fullscreen {
        if let Some(window) = app.get_webview_window("main") { let _ = window.set_fullscreen(false); }
    }
    if let Some(browser) = exit_webview_fullscreen { let _ = browser.eval("document.exitFullscreen?.()"); }
    #[cfg(windows)]
    if let Some(core_ptr) = exit_page_fullscreen {
        let script_app = app.clone();
        tauri::async_runtime::spawn_blocking(move || browser_texture_stream::with_main_webview(&script_app, move |_, _| unsafe {
            let mut raw = core_ptr as *mut std::ffi::c_void;
            if let Some(core) = ICoreWebView2::from_raw_borrowed(&mut raw) {
                let callback = ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(())));
                core.ExecuteScript(&HSTRING::from("document.exitFullscreen?.()"), &callback).map_err(|error| error.to_string())
            } else { Err("active browser core is unavailable".to_owned()) }
        })).await.map_err(|error| error.to_string())???;
    }
    #[cfg(not(windows))]
    let _ = native_ops;
    #[cfg(windows)]
    {
        let handle = state.0.lock().ok().and_then(|store| {
            session_id.as_ref().and_then(|id| store.native_tabs.get(id).map(|tab| tab.handle))
        });
        let app_for_identity = app.clone();
        let hwnd = if let Some(handle) = handle {
            tauri::async_runtime::spawn_blocking(move || browser_texture_stream::browser_tab_window(&app_for_identity, handle)).await.ok().and_then(Result::ok).unwrap_or(0)
        } else { 0 };
        if (hwnd != 0 || session_id.is_none()) && state.0.lock().is_ok_and(|store| store.active == session_id) {
            crate::browser_keymap::set_browser_focus_identity(hwnd);
        }
        if hwnd == 0 {
            let child = state.0.lock().ok().and_then(|store| session_id.as_ref().and_then(|id| store.webviews.get(id).cloned()));
            if let Some(child) = child {
                let app_for_focus = app.clone();
                let expected = session_id.clone();
                let _ = child.with_webview(move |_| {
                    let focus = unsafe { windows_sys::Win32::UI::Input::KeyboardAndMouse::GetFocus() };
                    if !focus.is_null() && !crate::caps_hook::native_focus_is_valid()
                        && app_for_focus.state::<BrowserState>().0.lock().is_ok_and(|store| store.active == expected)
                    {
                        crate::browser_keymap::set_browser_focus_identity(focus as isize);
                    }
                });
            }
        }
    }
    #[cfg(windows)]
    if !native_ops.is_empty() {
        let app_for_bounds = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            for (session_id, x, y, width, height, mode, focus) in native_ops {
                browser_texture_stream::set_browser_tab_bounds_for_session(&app_for_bounds, session_id, x, y, width, height, mode, focus)?;
            }
            Ok::<(), String>(())
        }).await.map_err(|error| error.to_string())??;
    }
    if return_to_terminal {
        let _ = app.get_webview("main").ok_or("main webview is unavailable")?.set_focus();
    }
    Ok(())
}

#[cfg(windows)]
pub fn refresh_native_browser_bounds(app: &tauri::AppHandle) {
    let Some((bounds, active, mode, tabs)) = app.try_state::<BrowserState>().and_then(|state| {
        state.0.lock().ok().map(|store| (store.bounds.clone(), store.active.clone(), store.visibility_mode, store.native_tabs.keys().cloned().collect::<Vec<_>>()))
    }) else { return; };
    let scale = app.get_webview_window("main").and_then(|window| window.scale_factor().ok()).unwrap_or(1.0);
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        for id in tabs {
            let visible_mode = if active.as_deref() == Some(&id) { mode } else { 0 };
            let (x, y, width, height) = native_browser_rect(bounds.as_ref(), scale);
            let _ = browser_texture_stream::set_browser_tab_bounds_for_session(&app, id, x, y, width, height, visible_mode, false);
        }
    });
}

#[tauri::command]
pub async fn close_browser(app: tauri::AppHandle, state: State<'_, BrowserState>, session_id: BrowserId) -> Result<(), String> {
    #[cfg(not(windows))]
    let _ = app;
    valid_id(&session_id)?;
    #[cfg(windows)]
    let native = {
        let mut state = state.0.lock().map_err(|_| "browser state is unavailable")?;
        if state.active.as_deref() == Some(&session_id) { state.active = None; }
        if let Some(active) = state.screencast_active.remove(&session_id) { active.store(false, Ordering::Relaxed); }
        if let Some(browser) = state.webviews.remove(&session_id) { browser.close().map_err(|e| e.to_string())?; }
        state.native_tabs.remove(&session_id)
    };
    #[cfg(windows)]
    if let Some(tab) = native {
        tauri::async_runtime::spawn_blocking(move || browser_texture_stream::close_browser_tab(&app, tab.handle, tab.core, tab.controller))
            .await.map_err(|error| error.to_string())??;
    }
    #[cfg(not(windows))]
    {
        let mut state = state.0.lock().map_err(|_| "browser state is unavailable")?;
        if state.active.as_deref() == Some(&session_id) { state.active = None; }
        if let Some(active) = state.screencast_active.remove(&session_id) { active.store(false, Ordering::Relaxed); }
        if let Some(browser) = state.webviews.remove(&session_id) { browser.close().map_err(|e| e.to_string())?; }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{browser_color_value, browser_target_url, browser_url, fit_browser_bounds, must_exit_page_fullscreen, BrowserBounds};

    #[test]
    fn fullscreen_bounds_preserve_form_factor_and_center_in_window() {
        let window = BrowserBounds { x: 0.0, y: 0.0, width: 1920.0, height: 1080.0 };
        let four_three = fit_browser_bounds(&BrowserBounds { x: 50.0, y: 20.0, width: 800.0, height: 600.0 }, &window);
        assert_eq!((four_three.x, four_three.y, four_three.width, four_three.height), (240.0, 0.0, 1440.0, 1080.0));
        let eight_five = fit_browser_bounds(&BrowserBounds { x: 0.0, y: 0.0, width: 800.0, height: 500.0 }, &window);
        assert_eq!((eight_five.x, eight_five.y, eight_five.width, eight_five.height), (96.0, 0.0, 1728.0, 1080.0));
        let beside_settings = fit_browser_bounds(&BrowserBounds { x: 0.0, y: 0.0, width: 800.0, height: 600.0 }, &BrowserBounds { x: 0.0, y: 0.0, width: 1200.0, height: 1080.0 });
        assert_eq!((beside_settings.x, beside_settings.y, beside_settings.width, beside_settings.height), (0.0, 90.0, 1200.0, 900.0));
    }

    #[test]
    fn exits_page_fullscreen_only_after_the_host_was_fullscreen() {
        assert!(!must_exit_page_fullscreen(true, false, false));
        assert!(must_exit_page_fullscreen(true, true, false));
        assert!(!must_exit_page_fullscreen(true, true, true));
    }

    #[test]
    fn accepts_only_http_urls() {
        assert!(browser_url("https://example.com").is_ok());
        assert!(browser_url("file:///C:/x").is_err());
    }

    #[test]
    fn accepts_only_existing_local_files() {
        assert!(browser_target_url("file:///C:/definitely-missing-scanline-term.html").is_err());
    }

    #[test]
    fn accepts_only_valid_browser_colors() {
        assert_eq!(browser_color_value("aBc123"), Some("#aBc123".into()));
        assert_eq!(browser_color_value("fff"), None);
    }
}
