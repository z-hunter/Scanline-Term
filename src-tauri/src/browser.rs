use std::{collections::HashMap, sync::Mutex};

use tauri::{webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder}, Emitter, LogicalPosition, LogicalSize, Manager, State, Webview, WebviewUrl};

type BrowserId = String;

fn trace(app: &tauri::AppHandle, stage: &str, session_id: &str, detail: impl serde::Serialize) { let _ = app.emit("browser-trace", serde_json::json!({ "stage": stage, "sessionId": session_id, "detail": detail })); }

#[derive(Default)]
pub struct BrowserState(pub Mutex<BrowserStore>);

#[derive(Default)]
pub struct BrowserStore { webviews: HashMap<BrowserId, Webview>, active: Option<BrowserId>, bounds: Option<BrowserBounds> }

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBounds { pub x: f64, pub y: f64, pub width: f64, pub height: f64 }

fn valid_id(id: &str) -> Result<(), String> {
    if id.len() == 36 && id.chars().enumerate().all(|(i, c)| matches!(i, 8 | 13 | 18 | 23) && c == '-' || !matches!(i, 8 | 13 | 18 | 23) && c.is_ascii_hexdigit()) { Ok(()) } else { Err("browser id is invalid".into()) }
}

pub fn browser_url(value: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(value).map_err(|_| "browser URL is invalid")?;
    if matches!(url.scheme(), "http" | "https") { Ok(url) } else { Err("browser URL must use http or https".into()) }
}

const NAVIGATION_SCRIPT: &str = r#"(() => {
  let mode = 'normal', pendingG = false, hint = null, menu = false;
  const shortcut = code => { location.href = '__SCANLINE_SHORTCUT_URL__' + code; };
  const editable = e => e && (e.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName));
  const labels = 'asdfghjkl';
  const labelAt = n => n < labels.length ? labels[n] : labels[Math.floor(n / labels.length) - 1] + labels[n % labels.length];
  const clearHints = () => { hint?.nodes.forEach(n => n.remove()); hint = null; };
  const showHints = () => { clearHints(); const items = [...document.querySelectorAll('a[href],button,input,textarea,select,[role=button]')].filter(e => { const r=e.getBoundingClientRect(); return r.width && r.height && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; }); const entries=items.map((element,index)=>({element,label:labelAt(index)})); const nodes=entries.map(({element,label})=>{ const r=element.getBoundingClientRect(), node=document.createElement('i'); node.textContent=label; node.style.cssText=`position:fixed;z-index:2147483647;left:${r.left}px;top:${r.top}px;background:#ffe66d;color:#111;padding:1px 3px;font:12px monospace;font-style:normal;pointer-events:none`; document.documentElement.append(node); return node; }); hint={entries,nodes,typed:''}; };
  const address = () => { document.querySelector('[data-scanline-address]')?.remove(); const box = document.createElement('form'); box.dataset.scanlineAddress=''; box.style.cssText = 'position:fixed;z-index:2147483647;left:4%;top:12px;width:92%;display:flex;gap:6px;padding:8px;background:#101510;border:1px solid #6a8;color:#dfe;font:16px monospace;box-sizing:border-box'; box.innerHTML = '<button type="button" data-back aria-label="Back">←</button><button type="button" data-forward aria-label="Forward">→</button><input aria-label="Address" style="min-width:0;flex:1;background:#020;color:#dfe;border:1px solid #6a8;padding:8px" />'; const input = box.querySelector('input'); const close=()=>{ document.removeEventListener('pointerdown', outside, true); box.remove(); }; const outside=e=>{ if(!box.contains(e.target)) close(); }; input.value = location.href; box.querySelector('[data-back]').onclick=()=>history.back(); box.querySelector('[data-forward]').onclick=()=>history.forward(); box.onsubmit = e => { e.preventDefault(); const v=input.value.trim(); close(); if(v) location.href=/^https?:\/\//i.test(v)?v:`https://${v}`; }; input.onkeydown = e => { if(e.key==='Escape') { e.preventDefault(); close(); } }; document.documentElement.append(box); requestAnimationFrame(()=>document.addEventListener('pointerdown', outside, true)); input.focus(); input.select(); };
  addEventListener('keydown', e => {
    if (e.key === 'ContextMenu') { menu = true; return; }
    if (menu) { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) shortcut(e.code); return; }
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
  addEventListener('keyup', e => { if (e.key === 'ContextMenu') { menu = false; return; } if (menu) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
})()"#;

fn browser_shortcut(url: &url::Url, session_id: &str) -> Option<String> {
    let mut segments = url.path_segments()?;
    let id = segments.next()?; let code = segments.next()?;
    if url.scheme() != "scanline-term" || url.host_str() != Some("shortcut") || id != session_id || segments.next().is_some() { return None; }
    matches!(code, "KeyS" | "KeyA" | "KeyB" | "KeyV" | "KeyC" | "KeyN" | "KeyW" | "PageUp" | "PageDown" | "Digit1" | "Digit2" | "Digit3" | "Digit4" | "Digit5" | "Digit6" | "Digit7" | "Digit8" | "Digit9").then(|| code.to_owned())
}

fn create_browser_impl(app: tauri::AppHandle, session_id: BrowserId, url: Option<String>) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    valid_id(&session_id)?;
    let initial = url.as_deref().map(browser_url).transpose()?.unwrap_or_else(|| url::Url::parse("about:blank").unwrap());
    let window = app.get_window("main").ok_or("main window is unavailable")?;
    trace(&app, "create", &session_id, initial.as_str());
    let id = session_id.clone(); let app_for_title = app.clone(); let page_app = app.clone(); let page_id = session_id.clone(); let app_for_navigation = app.clone(); let navigation_id = session_id.clone();
    let navigation_script = NAVIGATION_SCRIPT.replace("__SCANLINE_SHORTCUT_URL__", &format!("scanline-term://shortcut/{session_id}/"));
    let browser = window.add_child(
        WebviewBuilder::new(format!("browser-{session_id}"), WebviewUrl::External(initial))
            .devtools(cfg!(debug_assertions))
            .on_navigation(move |url| { if let Some(code) = browser_shortcut(url, &navigation_id) { let _ = app_for_navigation.emit("browser-shortcut", serde_json::json!({ "sessionId": navigation_id, "code": code })); return false; } matches!(url.scheme(), "http" | "https" | "about") })
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_download(|_, event| !matches!(event, DownloadEvent::Requested { .. }))
            .on_page_load(move |webview, payload| { let event = payload.event(); trace(&page_app, match event { PageLoadEvent::Started => "load-start", PageLoadEvent::Finished => "load-finished" }, &page_id, payload.url().as_str()); if event == PageLoadEvent::Finished { match webview.eval(&navigation_script) { Ok(()) => trace(&page_app, "script-installed", &page_id, payload.url().as_str()), Err(error) => trace(&page_app, "script-failed", &page_id, error.to_string()) } } })
            .on_document_title_changed(move |_, title| { let _ = app_for_title.emit("browser-title", serde_json::json!({ "sessionId": id, "title": title })); }),
        LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0)
    ).map_err(|e| e.to_string())?;
    browser.hide().map_err(|e| e.to_string())?;
    let mut state = state.0.lock().map_err(|_| "browser state is unavailable")?;
    if state.active.as_deref() == Some(&session_id) {
        if let Some(bounds) = &state.bounds { browser.set_bounds(tauri::Rect { position: LogicalPosition::new(bounds.x, bounds.y).into(), size: LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)).into() }).map_err(|e| e.to_string())?; }
        browser.show().map_err(|e| e.to_string())?; trace(&app, "show-after-create", &session_id, state.bounds.as_ref().map(|b| (b.x, b.y, b.width, b.height)));
    }
    state.webviews.insert(session_id, browser);
    Ok(())
}

#[tauri::command]
pub async fn create_browser(app: tauri::AppHandle, session_id: BrowserId, url: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || create_browser_impl(app, session_id, url))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn navigate_browser(app: tauri::AppHandle, state: State<BrowserState>, session_id: BrowserId, url: String) -> Result<(), String> {
    valid_id(&session_id)?; let url = browser_url(&url)?;
    trace(&app, "navigate", &session_id, url.as_str());
    state.0.lock().map_err(|_| "browser state is unavailable")?.webviews.get(&session_id).ok_or("browser is not running")?.navigate(url).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_active_browser(app: tauri::AppHandle, state: State<BrowserState>, session_id: Option<BrowserId>, bounds: Option<BrowserBounds>) -> Result<(), String> {
    trace(&app, "set-active", session_id.as_deref().unwrap_or("none"), bounds.as_ref().map(|b| (b.x, b.y, b.width, b.height)));
    let mut state = state.0.lock().map_err(|_| "browser state is unavailable")?;
    state.active = session_id.clone(); state.bounds = bounds.clone();
    for (id, browser) in state.webviews.iter() {
        if Some(id) == session_id.as_ref() {
            if let Some(rect) = &bounds { browser.set_bounds(tauri::Rect { position: LogicalPosition::new(rect.x, rect.y).into(), size: LogicalSize::new(rect.width.max(1.0), rect.height.max(1.0)).into() }).map_err(|e| e.to_string())?; }
            browser.show().map_err(|e| e.to_string())?; trace(&app, "show", id, bounds.as_ref().map(|b| (b.x, b.y, b.width, b.height)));
        } else { let _ = browser.hide(); }
    }
    Ok(())
}

#[tauri::command]
pub fn close_browser(state: State<BrowserState>, session_id: BrowserId) -> Result<(), String> {
    valid_id(&session_id)?;
    let mut state = state.0.lock().map_err(|_| "browser state is unavailable")?;
    if state.active.as_deref() == Some(&session_id) { state.active = None; }
    if let Some(browser) = state.webviews.remove(&session_id) { browser.close().map_err(|e| e.to_string())?; }
    Ok(())
}

#[cfg(test)]
mod tests { use super::{browser_shortcut, browser_url}; #[test] fn accepts_only_http_urls() { assert!(browser_url("https://example.com").is_ok()); assert!(browser_url("file:///C:/x").is_err()); } #[test] fn accepts_only_its_supported_browser_shortcuts() { let id = "11111111-1111-1111-1111-111111111111"; let url = url::Url::parse(&format!("scanline-term://shortcut/{id}/KeyW")).unwrap(); assert_eq!(browser_shortcut(&url, id), Some("KeyW".into())); assert_eq!(browser_shortcut(&url, "22222222-2222-2222-2222-222222222222"), None); let unsupported = url::Url::parse(&format!("scanline-term://shortcut/{id}/KeyX")).unwrap(); assert_eq!(browser_shortcut(&unsupported, id), None); } }
