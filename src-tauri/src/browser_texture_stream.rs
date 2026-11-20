#![cfg(windows)]

use serde::Serialize;
use std::{
    os::windows::ffi::OsStrExt,
    path::PathBuf,
    sync::{OnceLock, mpsc},
    time::Duration,
};
use tauri::{AppHandle, Manager, Webview};
use tauri::State;
use windows::{core::Interface, Win32::Foundation::HWND};

const ORIGIN: &str = "http://localhost:5173";
const BUNDLED_ORIGIN: &str = "http://tauri.localhost";
const BENCHMARK_URL: &str = "http://localhost:5173/texture-stream-benchmark.html";
const MAX_STREAM_ID: usize = 64;
const TEXTURE_STREAM_FEATURE: &str = "msWebView2TextureStream";

type StartFn = unsafe extern "system" fn(
    *mut std::ffi::c_void,
    *mut std::ffi::c_void,
    *const u16,
    *const u16,
    u32,
    u32,
    *mut f64,
) -> i32;
type StopFn = unsafe extern "system" fn(*const u16) -> i32;
type StopAllFn = unsafe extern "system" fn();
type BrowserTabCreateFn = unsafe extern "C" fn(
    *mut std::ffi::c_void,
    HWND,
    *const u16,
    u32,
    u32,
    *mut std::ffi::c_void,
    unsafe extern "C" fn(*mut std::ffi::c_void, i32, u64, *mut std::ffi::c_void, *mut std::ffi::c_void),
) -> i32;
type BrowserTabSetBoundsFn = unsafe extern "C" fn(u64, i32, i32, u32, u32, i32) -> i32;
type BrowserTabCloseFn = unsafe extern "C" fn(u64) -> i32;
type BrowserTabAvailableFn = unsafe extern "C" fn() -> i32;
type StartForTabFn = unsafe extern "C" fn(u64, *const u16, *const u16, u32, u32, *mut f64) -> i32;

struct NativeDll {
    start: StartFn,
    stop: StopFn,
    stop_all: StopAllFn,
    browser_tab_create: Option<BrowserTabCreateFn>,
    browser_tab_set_bounds: Option<BrowserTabSetBoundsFn>,
    browser_tab_close: Option<BrowserTabCloseFn>,
    browser_tab_available: Option<BrowserTabAvailableFn>,
    start_for_tab: Option<StartForTabFn>,
}

unsafe impl Send for NativeDll {}
unsafe impl Sync for NativeDll {}

static NATIVE_DLL: OnceLock<Result<NativeDll, String>> = OnceLock::new();

unsafe fn optional_symbol<T: Copy>(module: windows_sys::Win32::Foundation::HMODULE, name: &'static [u8]) -> Option<T> {
    use windows_sys::Win32::System::LibraryLoader::GetProcAddress;
    unsafe { GetProcAddress(module, name.as_ptr()).map(|address| std::mem::transmute_copy(&address)) }
}

pub struct BrowserTabController {
    pub handle: u64,
    pub core: usize,
    pub controller: usize,
}

struct CreateContext(std::sync::mpsc::SyncSender<Result<(u64, usize, usize), String>>);

unsafe extern "C" fn browser_tab_created(
    context: *mut std::ffi::c_void,
    status: i32,
    handle: u64,
    core: *mut std::ffi::c_void,
    controller: *mut std::ffi::c_void,
) {
    let context = unsafe { Box::from_raw(context.cast::<CreateContext>()) };
    let result = if status < 0 {
        Err(format!("native browser tab creation failed: 0x{:08x}", status as u32))
    } else if core.is_null() || controller.is_null() || handle == 0 {
        Err("native browser tab returned an invalid controller".into())
    } else {
        let mut core_raw = core;
        let core = unsafe {
            webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2::from_raw_borrowed(
                &mut core_raw,
            )
        }
        .map(|core| Interface::into_raw(core.clone()) as usize);
        let mut controller_raw = controller;
        let controller = unsafe {
            webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller::from_raw_borrowed(
                &mut controller_raw,
            )
        }
        .map(|controller| Interface::into_raw(controller.clone()) as usize);
        match (core, controller) {
            (Some(core), Some(controller)) => Ok((handle, core, controller)),
            _ => Err("native browser tab returned an invalid controller".into()),
        }
    };
    let _ = context.0.send(result);
}

fn browser_arguments_with_texture_stream(arguments: &str) -> String {
    const ENABLE: &str = "--enable-features=";
    if let Some((index, _)) = arguments
        .rmatch_indices(ENABLE)
        .find(|(index, _)| *index == 0 || arguments.as_bytes()[index - 1].is_ascii_whitespace())
    {
        let value = &arguments[index + ENABLE.len()..];
        let start = usize::from(value.starts_with('"'));
        let end = start + value[start..]
            .find(|character: char| character.is_ascii_whitespace() || character == '"')
            .unwrap_or(value.len() - start);
        let features = &value[start..end];
        if features.split(',').any(|feature| feature == TEXTURE_STREAM_FEATURE) {
            return arguments.to_owned();
        }
        let separator = if features.is_empty() { "" } else { "," };
        let end = index + ENABLE.len() + end;
        return format!(
            "{}{separator}{TEXTURE_STREAM_FEATURE}{}",
            &arguments[..end], &arguments[end..],
        );
    }
    let separator = if arguments.is_empty() { "" } else { " " };
    format!("{arguments}{separator}{ENABLE}{TEXTURE_STREAM_FEATURE}")
}

pub fn enable_webview2_feature() {
    const KEY: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
    let arguments = std::env::var(KEY).unwrap_or_default();
    // Called before starting Tauri or any application threads.
    unsafe { std::env::set_var(KEY, browser_arguments_with_texture_stream(&arguments)) };
}

fn native_dll(app: &AppHandle) -> Result<&'static NativeDll, String> {
    NATIVE_DLL
        .get_or_init(|| unsafe {
            use windows_sys::Win32::System::LibraryLoader::{
                GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32,
            };

            let override_path = if cfg!(debug_assertions) {
                std::env::var_os("SCANLINE_BROWSER_TEXTURE_STREAM_DLL").map(PathBuf::from)
            } else {
                None
            };
            let path = match override_path {
                Some(path) => path,
                None => app.path().resource_dir()
                    .map_err(|error| error.to_string())?
                    .join("browser_texture_stream.dll"),
            };
            if !path.is_absolute()
                || path
                    .extension()
                    .and_then(std::ffi::OsStr::to_str)
                    .is_none_or(|ext| !ext.eq_ignore_ascii_case("dll"))
            {
                return Err("texture stream DLL path must be an absolute .dll path".into());
            }
            let path_wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            let module = LoadLibraryExW(
                path_wide.as_ptr(),
                std::ptr::null_mut(),
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
            );
            if module.is_null() {
                return Err(format!(
                    "failed to load texture stream DLL: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let symbol = |name: &'static [u8]| {
                GetProcAddress(module, name.as_ptr()).ok_or_else(|| {
                    format!(
                        "texture stream DLL lacks export {}",
                        String::from_utf8_lossy(name)
                    )
                })
            };
            Ok(NativeDll {
                start: std::mem::transmute(symbol(b"ScanlineTextureStreamStart\0")?),
                stop: std::mem::transmute(symbol(b"ScanlineTextureStreamStop\0")?),
                stop_all: std::mem::transmute(symbol(b"ScanlineTextureStreamStopAll\0")?),
                browser_tab_create: optional_symbol(module, b"ScanlineBrowserTabCreate\0"),
                browser_tab_set_bounds: optional_symbol(module, b"ScanlineBrowserTabSetBounds\0"),
                browser_tab_close: optional_symbol(module, b"ScanlineBrowserTabClose\0"),
                browser_tab_available: optional_symbol(module, b"ScanlineBrowserTabAvailable\0"),
                start_for_tab: optional_symbol(module, b"ScanlineTextureStreamStartForTabWithOrigin\0"),
            })
        })
        .as_ref()
        .map_err(Clone::clone)
}

pub(crate) fn set_browser_tab_bounds_on_ui(app: &AppHandle, handle: u64, width: u32, height: u32, mode: i32) -> Result<(), String> {
    let set_bounds = native_dll(app)?.browser_tab_set_bounds.ok_or("native browser bounds are unavailable")?;
    let result = unsafe { set_bounds(handle, 0, 0, width, height, mode) };
    if result < 0 { Err(format!("native browser bounds failed: 0x{:08x}", result as u32)) } else { Ok(()) }
}

pub fn browser_tab_enabled(app: &AppHandle) -> bool {
    if cfg!(debug_assertions) && std::env::var("SCANLINE_BROWSER_TEXTURE_STREAM_TABS").is_ok_and(|value| value == "0") {
        return false;
    }
    native_dll(app).is_ok_and(|dll| {
        dll.browser_tab_create.is_some()
            && dll.browser_tab_set_bounds.is_some()
            && dll.browser_tab_close.is_some()
            && dll.start_for_tab.is_some()
            && dll.browser_tab_available.is_some_and(|probe| unsafe { probe() != 0 })
    })
}

pub fn create_browser_tab(
    app: &AppHandle,
    parent: isize,
    tab_id: &str,
    width: u32,
    height: u32,
) -> Result<BrowserTabController, String> {
    if !browser_tab_enabled(app) {
        return Err("native browser tabs are unavailable".into());
    }
    let create = native_dll(app)?.browser_tab_create.ok_or("native browser tab creation is unavailable")?;
    let tab_id_wide: Vec<u16> = tab_id.encode_utf16().chain(Some(0)).collect();
    let context_id = tab_id.to_owned();
    let parent = parent as usize;
    let (sender, receiver) = mpsc::sync_channel(1);
    let status = tauri::async_runtime::block_on(async {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let context = Box::into_raw(Box::new(CreateContext(sender))) as usize;
            let tab_id_wide = tab_id_wide;
            let result = with_main_webview(&app, move |environment, _| unsafe {
                create(
                    environment,
                    HWND(parent as *mut _),
                    tab_id_wide.as_ptr(),
                    width,
                    height,
                    context as *mut _,
                    browser_tab_created,
                )
            });
            result
        })
        .await
        .map_err(|error| error.to_string())?
    })?;
    if status < 0 {
        return Err(format!("native browser tab request failed: 0x{:08x}", status as u32));
    }
    let (handle, core, controller) = receiver
        .recv_timeout(Duration::from_secs(20))
        .map_err(|_| format!("native browser tab {context_id} creation timed out"))??;
    Ok(BrowserTabController { handle, core, controller })
}

pub fn set_browser_tab_bounds(
    app: &AppHandle,
    handle: u64,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    visibility_mode: i32,
) -> Result<(), String> {
    let set_bounds = native_dll(app)?
        .browser_tab_set_bounds
        .ok_or("native browser bounds are unavailable")?;
    let app = app.clone();
    let result = tauri::async_runtime::block_on(async move {
        tauri::async_runtime::spawn_blocking(move || {
            with_main_webview(&app, move |_, _| unsafe {
                set_bounds(handle, x, y, width, height, visibility_mode)
            })
        })
        .await
        .map_err(|error| error.to_string())?
    })?;
    if result < 0 {
        Err(format!("native browser bounds failed: 0x{:08x}", result as u32))
    } else {
        Ok(())
    }
}

pub fn set_browser_tab_bounds_for_session(
    app: &AppHandle,
    session_id: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    visibility_mode: i32,
) -> Result<(), String> {
    let set_bounds = native_dll(app)?.browser_tab_set_bounds.ok_or("native browser bounds are unavailable")?;
    let app_for_callback = app.clone();
    let app = app.clone();
    let result = tauri::async_runtime::block_on(async move {
        tauri::async_runtime::spawn_blocking(move || with_main_webview(&app, move |_, _| {
            let state = app_for_callback.state::<crate::browser::BrowserState>();
            let Some(handle) = state.bounds_handle_if_current(&session_id, visibility_mode)? else { return Ok(()); };
            let result = unsafe { set_bounds(handle, x, y, width, height, visibility_mode) };
            if result < 0 { Err(format!("native browser bounds failed: 0x{:08x}", result as u32)) } else { Ok(()) }
        })).await.map_err(|error| error.to_string())?
    })?;
    result
}

pub fn close_browser_tab(app: &AppHandle, handle: u64, core: usize, controller: usize) -> Result<(), String> {
    let close = native_dll(app)?
        .browser_tab_close
        .ok_or("native browser close is unavailable")?;
    let app = app.clone();
    let result = tauri::async_runtime::block_on(async move {
        tauri::async_runtime::spawn_blocking(move || {
            with_main_webview(&app, move |_, _| unsafe {
                let result = close(handle);
                drop(webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2::from_raw(core as *mut _));
                drop(webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller::from_raw(controller as *mut _));
                result
            })
        })
        .await
        .map_err(|error| error.to_string())?
    })?;
    if result < 0 {
        Err(format!("native browser close failed: 0x{:08x}", result as u32))
    } else {
        Ok(())
    }
}

pub fn start_for_browser_tab(
    app: &AppHandle,
    session_id: String,
    stream_id: String,
    origin: &'static str,
    width: u32,
    height: u32,
) -> Result<BrowserTextureStreamInfo, String> {
    if !browser_tab_enabled(app) {
        return Err("native browser tabs are unavailable".into());
    }
    if stream_id.is_empty()
        || stream_id.len() > MAX_STREAM_ID
        || !stream_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("invalid texture stream ID".into());
    }
    validate_tab_dimensions(width, height)?;
    let start = native_dll(app)?
        .start_for_tab
        .ok_or("native browser texture capture is unavailable")?;
    let stream_wide: Vec<u16> = stream_id.encode_utf16().chain(Some(0)).collect();
    let origin_wide: Vec<u16> = origin.encode_utf16().chain(Some(0)).collect();
    let app = app.clone();
    let state_app = app.clone();
    let epoch = tauri::async_runtime::block_on(async move {
        tauri::async_runtime::spawn_blocking(move || {
            let session_id = session_id.clone();
            with_main_webview(&app, move |_, _| unsafe {
                let state = state_app.state::<crate::browser::BrowserState>();
                let tab_handle = state.texture_stream_tab_handle(&session_id)?;
                let mut epoch = 0.0;
                let result = start(tab_handle, stream_wide.as_ptr(), origin_wide.as_ptr(), width, height, &mut epoch);
                Ok::<_, String>((result, epoch))
            })
        })
        .await
        .map_err(|error| error.to_string())?
    })??;
    if epoch.0 < 0 {
        return Err(format!("native texture stream failed: 0x{:08x}", epoch.0 as u32));
    }
    Ok(BrowserTextureStreamInfo { stream_id, epoch_at_qpc_zero_ms: epoch.1 })
}

fn validate(stream_id: &str, source_url: &str, width: u32, height: u32) -> Result<(), String> {
    if stream_id.is_empty()
        || stream_id.len() > MAX_STREAM_ID
        || !stream_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("invalid texture stream ID".into());
    }
    if source_url != BENCHMARK_URL || !source_url.starts_with(ORIGIN) {
        return Err("texture stream source must be the local benchmark page".into());
    }
    validate_stream_dimensions(width, height)
}

fn validate_stream_dimensions(width: u32, height: u32) -> Result<(), String> {
    if !(320..=1920).contains(&width)
        || !(240..=1080).contains(&height)
        || width % 2 != 0
        || height % 2 != 0
    {
        return Err("texture stream dimensions must be even and within 320x240–1920x1080".into());
    }
    Ok(())
}

fn validate_tab_dimensions(width: u32, height: u32) -> Result<(), String> {
    if !(2..=1920).contains(&width) || !(2..=1080).contains(&height) || width % 2 != 0 || height % 2 != 0 {
        return Err("texture stream dimensions must be even and within 2x2–1920x1080".into());
    }
    Ok(())
}

pub(crate) fn with_main_webview<T: Send + 'static>(
    app: &AppHandle,
    operation: impl FnOnce(*mut std::ffi::c_void, *mut std::ffi::c_void) -> T + Send + 'static,
) -> Result<T, String> {
    let webview = app
        .get_webview("main")
        .ok_or("main WebView is unavailable")?;
    let (sender, receiver) = mpsc::sync_channel(1);
    webview
        .with_webview(move |platform| {
            let environment = platform.environment();
            let controller = platform.controller();
            let result = operation(
                environment.as_raw() as *mut _,
                controller.as_raw() as *mut _,
            );
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| "main WebView did not service the texture stream request".to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTextureStreamInfo {
    pub stream_id: String,
    pub epoch_at_qpc_zero_ms: f64,
}

fn receiver_origin(webview: &Webview) -> Result<&'static str, String> {
    let expected = if tauri::is_dev() { ORIGIN } else { BUNDLED_ORIGIN };
    if webview.label() == "main" && webview.url().is_ok_and(|url| url.origin().ascii_serialization() == expected) {
        Ok(expected)
    } else {
        Err("TextureStream requires the main application WebView".into())
    }
}

#[tauri::command]
pub async fn start_browser_texture_stream(
    app: AppHandle,
    webview: Webview,
    state: State<'_, crate::browser::BrowserState>,
    session_id: Option<String>,
    stream_id: String,
    source_url: Option<String>,
    width: u32,
    height: u32,
) -> Result<BrowserTextureStreamInfo, String> {
    let origin = receiver_origin(&webview)?;
    if let Some(session_id) = session_id {
        if source_url.is_some() { return Err("provide either a browser tab or a benchmark source".into()); }
        state.texture_stream_tab_handle(&session_id)?;
        return tauri::async_runtime::spawn_blocking(move || start_for_browser_tab(&app, session_id, stream_id, origin, width, height))
            .await
            .map_err(|error| error.to_string())?;
    }
    if !cfg!(debug_assertions) || !tauri::is_dev() {
        return Err("browser texture stream benchmark requires the dev app".into());
    }
    let source_url = source_url.ok_or("texture stream source is missing")?;
    validate(&stream_id, &source_url, width, height)?;
    let start = native_dll(&app)?.start;
    let command_stream_id = stream_id.clone();
    let epoch = tauri::async_runtime::spawn_blocking(move || {
        let stream_id_wide: Vec<u16> = command_stream_id.encode_utf16().chain(Some(0)).collect();
        let source_url_wide: Vec<u16> = source_url.encode_utf16().chain(Some(0)).collect();
        with_main_webview(&app, move |environment, controller| unsafe {
            let mut epoch = 0.0;
            let result = start(
                environment,
                controller,
                stream_id_wide.as_ptr(),
                source_url_wide.as_ptr(),
                width,
                height,
                &mut epoch,
            );
            (result, epoch)
        })
    })
    .await
    .map_err(|error| error.to_string())??;
    if epoch.0 < 0 {
        return Err(format!(
            "native texture stream failed: 0x{:08x}",
            epoch.0 as u32
        ));
    }
    Ok(BrowserTextureStreamInfo {
        stream_id,
        epoch_at_qpc_zero_ms: epoch.1,
    })
}

#[tauri::command]
pub async fn stop_browser_texture_stream(app: AppHandle, webview: Webview, stream_id: String) -> Result<(), String> {
    receiver_origin(&webview)?;
    validate(&stream_id, BENCHMARK_URL, 320, 240)?;
    let stop = native_dll(&app)?.stop;
    let stream_id_wide: Vec<u16> = stream_id.encode_utf16().chain(Some(0)).collect();
    let result = tauri::async_runtime::spawn_blocking(move || {
        with_main_webview(&app, move |_, _| unsafe { stop(stream_id_wide.as_ptr()) })
    })
    .await
    .map_err(|error| error.to_string())??;
    if result < 0 {
        Err(format!(
            "native texture stream stop failed: 0x{:08x}",
            result as u32
        ))
    } else {
        Ok(())
    }
}

pub fn stop_all_browser_texture_streams() {
    if let Some(Ok(dll)) = NATIVE_DLL.get() {
        unsafe { (dll.stop_all)() };
    }
}

#[cfg(test)]
mod tests {
    use super::{browser_arguments_with_texture_stream, validate};

    #[test]
    fn enables_texture_stream_without_replacing_other_webview_arguments() {
        assert_eq!(browser_arguments_with_texture_stream(""), "--enable-features=msWebView2TextureStream");
        assert_eq!(
            browser_arguments_with_texture_stream("--enable-features=Other --remote-debugging-port=9223"),
            "--enable-features=Other,msWebView2TextureStream --remote-debugging-port=9223",
        );
        assert_eq!(
            browser_arguments_with_texture_stream("--enable-features=\"Other,msWebView2TextureStream\" --flag"),
            "--enable-features=\"Other,msWebView2TextureStream\" --flag",
        );
    }

    #[test]
    fn accepts_only_the_local_benchmark_and_bounded_even_sizes() {
        assert!(
            validate(
                "benchmark_1",
                "http://localhost:5173/texture-stream-benchmark.html",
                1280,
                720
            )
            .is_ok()
        );
        assert!(
            validate(
                "bad/id",
                "http://localhost:5173/texture-stream-benchmark.html",
                1280,
                720
            )
            .is_err()
        );
        assert!(validate("benchmark", "https://example.com/", 1280, 720).is_err());
        assert!(
            validate(
                "benchmark",
                "http://localhost:5173/texture-stream-benchmark.html",
                1279,
                720
            )
            .is_err()
        );
    }
}
