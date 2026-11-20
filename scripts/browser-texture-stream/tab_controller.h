#pragma once
#include <windowsx.h>
#include "source_capture.h"

#include <atomic>
#include <memory>
#include <unordered_map>

struct BrowserTab {
    HWND window{};
    HWND owner{};
    std::wstring id;
    UINT width{}, height{};
    INT visibilityMode{2};
    ComPtr<ICoreWebView2Environment> environment;
    ComPtr<ICoreWebView2CompositionController> composition;
    ComPtr<ICoreWebView2Controller> controller;
    ComPtr<ICoreWebView2> view;
    winrt::Windows::UI::Composition::Compositor compositor{nullptr};
    winrt::Windows::UI::Composition::Desktop::DesktopWindowTarget target{nullptr};
    winrt::Windows::UI::Composition::ContainerVisual root{nullptr};
    winrt::Windows::UI::Composition::ContainerVisual webVisual{nullptr};

    static LRESULT CALLBACK WindowProc(HWND hwnd, UINT message, WPARAM wp, LPARAM lp) {
        auto tab = reinterpret_cast<BrowserTab*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
        if (message == WM_NCCREATE) {
            tab = static_cast<BrowserTab*>(reinterpret_cast<CREATESTRUCTW*>(lp)->lpCreateParams);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(tab));
        }
        if (!tab || !tab->composition) return DefWindowProcW(hwnd, message, wp, lp);
        auto keys = static_cast<COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS>(0);
        if (wp & MK_LBUTTON) keys = static_cast<COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS>(keys | COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_LEFT_BUTTON);
        if (wp & MK_RBUTTON) keys = static_cast<COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS>(keys | COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_RIGHT_BUTTON);
        if (wp & MK_MBUTTON) keys = static_cast<COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS>(keys | COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_MIDDLE_BUTTON);
        if (wp & MK_CONTROL) keys = static_cast<COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS>(keys | COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_CONTROL);
        if (wp & MK_SHIFT) keys = static_cast<COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS>(keys | COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_SHIFT);
        POINT point{GET_X_LPARAM(lp), GET_Y_LPARAM(lp)};
        COREWEBVIEW2_MOUSE_EVENT_KIND kind{};
        bool mouse = true;
        switch (message) {
        case WM_MOUSEMOVE: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_MOVE; break;
        case WM_LBUTTONDOWN: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOWN; break;
        case WM_LBUTTONUP: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_UP; break;
        case WM_RBUTTONDOWN: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_DOWN; break;
        case WM_RBUTTONUP: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_UP; break;
        case WM_MBUTTONDOWN: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_DOWN; break;
        case WM_MBUTTONUP: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_UP; break;
        case WM_MOUSEWHEEL: {
            kind = COREWEBVIEW2_MOUSE_EVENT_KIND_WHEEL;
            POINT screen{GET_X_LPARAM(lp), GET_Y_LPARAM(lp)}; ScreenToClient(hwnd, &screen);
            point = screen;
            break;
        }
        default: mouse = false; break;
        }
        if (mouse) {
            if (message == WM_LBUTTONDOWN || message == WM_RBUTTONDOWN || message == WM_MBUTTONDOWN) {
                SetForegroundWindow(hwnd);
                tab->controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
                SetCapture(hwnd);
            } else if (message == WM_LBUTTONUP || message == WM_RBUTTONUP || message == WM_MBUTTONUP) ReleaseCapture();
            tab->composition->SendMouseInput(kind, keys,
                message == WM_MOUSEWHEEL ? GET_WHEEL_DELTA_WPARAM(wp) : 0, point);
            return 0;
        }
        return DefWindowProcW(hwnd, message, wp, lp);
    }

    void Close() {
        if (controller) controller->put_IsVisible(FALSE);
        if (composition) composition->put_RootVisualTarget(nullptr);
        if (controller) controller->Close();
        view.Reset(); controller.Reset(); composition.Reset(); environment.Reset();
        webVisual = nullptr; root = nullptr; target = nullptr; compositor = nullptr;
        if (window) { DestroyWindow(window); window = nullptr; }
    }
    ~BrowserTab() { Close(); }
};

namespace browser_tabs {
inline std::unordered_map<UINT64, std::unique_ptr<BrowserTab>> tabs;
inline UINT64 next_handle = 1;
inline constexpr wchar_t kWindowClass[] = L"ScanlineCompositionBrowserTab";
inline ABI::Windows::System::IDispatcherQueueController* dispatcher_queue_controller{};

inline HRESULT EnsureDispatcherQueue() {
    if (dispatcher_queue_controller || winrt::Windows::System::DispatcherQueue::GetForCurrentThread()) return S_OK;
    DispatcherQueueOptions options{sizeof(options), DQTYPE_THREAD_CURRENT, DQTAT_COM_STA};
    return CreateDispatcherQueueController(options, &dispatcher_queue_controller);
}

inline bool RegisterWindowClass() {
    WNDCLASSW wc{};
    wc.lpfnWndProc = BrowserTab::WindowProc;
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.lpszClassName = kWindowClass;
    return RegisterClassW(&wc) || GetLastError() == ERROR_CLASS_ALREADY_EXISTS;
}

inline HRESULT InitializeVisuals(BrowserTab& tab) {
    try {
        const HRESULT queueHr = EnsureDispatcherQueue();
        if (FAILED(queueHr) && !winrt::Windows::System::DispatcherQueue::GetForCurrentThread()) return queueHr;
        tab.compositor = winrt::Windows::UI::Composition::Compositor();
        winrt::com_ptr<ABI::Windows::UI::Composition::Desktop::ICompositorDesktopInterop> desktop;
        winrt::check_hresult(winrt::get_unknown(tab.compositor)->QueryInterface(IID_PPV_ARGS(desktop.put())));
        winrt::check_hresult(desktop->CreateDesktopWindowTarget(tab.window, TRUE,
            reinterpret_cast<ABI::Windows::UI::Composition::Desktop::IDesktopWindowTarget**>(winrt::put_abi(tab.target))));
        tab.root = tab.compositor.CreateContainerVisual();
        tab.webVisual = tab.compositor.CreateContainerVisual();
        tab.root.Children().InsertAtTop(tab.webVisual);
        tab.root.Size({static_cast<float>(tab.width), static_cast<float>(tab.height)});
        tab.webVisual.Size({static_cast<float>(tab.width), static_cast<float>(tab.height)});
        tab.target.Root(tab.root);
        return S_OK;
    } catch (const winrt::hresult_error& e) { return e.code(); }
      catch (...) { return E_FAIL; }
}

inline HRESULT SetBounds(BrowserTab& tab, INT x, INT y, UINT width, UINT height, INT visibilityMode) {
    if (!width || !height || width > 4096 || height > 4096 || visibilityMode < 0 || visibilityMode > 2) return E_INVALIDARG;
    tab.width = width; tab.height = height; tab.visibilityMode = visibilityMode;
    if (tab.controller) {
        RECT bounds{0, 0, static_cast<LONG>(width), static_cast<LONG>(height)};
        HRESULT hr = tab.controller->put_Bounds(bounds);
        if (FAILED(hr)) return hr;
        hr = tab.controller->put_IsVisible(visibilityMode != 0);
        if (FAILED(hr)) return hr;
    }
    if (tab.webVisual) tab.webVisual.Size({static_cast<float>(width), static_cast<float>(height)});
    if (tab.root) tab.root.Size({static_cast<float>(width), static_cast<float>(height)});
    if (visibilityMode == 0) {
        ShowWindow(tab.window, SW_HIDE);
        return IsWindowVisible(tab.window) ? E_FAIL : S_OK;
    }
    if (visibilityMode == 1) {
        POINT point{x, y};
        if (!ClientToScreen(tab.owner, &point)) return HRESULT_FROM_WIN32(GetLastError());
        return SetWindowPos(tab.window, HWND_TOP, point.x, point.y, static_cast<int>(width), static_cast<int>(height),
                            SWP_SHOWWINDOW) ? S_OK : HRESULT_FROM_WIN32(GetLastError());
    }
    const int offscreen = GetSystemMetrics(SM_XVIRTUALSCREEN) + GetSystemMetrics(SM_CXVIRTUALSCREEN) + 32;
    return SetWindowPos(tab.window, HWND_TOP, offscreen, GetSystemMetrics(SM_YVIRTUALSCREEN),
                        static_cast<int>(width), static_cast<int>(height), SWP_NOACTIVATE | SWP_SHOWWINDOW)
        ? S_OK : HRESULT_FROM_WIN32(GetLastError());
}
}

extern "C" __declspec(dllexport) BOOL __cdecl ScanlineBrowserTabAvailable() { return TRUE; }

extern "C" __declspec(dllexport) HRESULT __cdecl ScanlineBrowserTabCreate(
    ICoreWebView2Environment* environment, HWND owner, const wchar_t* tabId, UINT width, UINT height,
    void* context, void (__cdecl* completed)(void*, HRESULT, UINT64, ICoreWebView2*, ICoreWebView2Controller*)) {
    if (!environment || !owner || !tabId || !*tabId || wcslen(tabId) > 128 || !completed ||
        !width || !height || width > 4096 || height > 4096) return E_INVALIDARG;
    for (const auto& entry : browser_tabs::tabs)
        if (entry.second->id == tabId) return HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS);
    const auto handle = browser_tabs::next_handle++;
    auto tab = std::make_unique<BrowserTab>();
    tab->owner = owner; tab->id = tabId; tab->width = width; tab->height = height;
    tab->environment = environment;
    if (!browser_tabs::RegisterWindowClass()) return HRESULT_FROM_WIN32(GetLastError());
    const int offscreen = GetSystemMetrics(SM_XVIRTUALSCREEN) + GetSystemMetrics(SM_CXVIRTUALSCREEN) + 32;
    tab->window = CreateWindowExW(WS_EX_TOOLWINDOW, browser_tabs::kWindowClass,
        L"Scanline browser tab", WS_POPUP | WS_VISIBLE, offscreen, GetSystemMetrics(SM_YVIRTUALSCREEN),
        static_cast<int>(width), static_cast<int>(height), owner, nullptr, GetModuleHandleW(nullptr), tab.get());
    if (!tab->window) return HRESULT_FROM_WIN32(GetLastError());
    const HRESULT visualHr = browser_tabs::InitializeVisuals(*tab);
    if (FAILED(visualHr)) return visualHr;
    const auto raw = tab.get();
    browser_tabs::tabs.emplace(handle, std::move(tab));
    ComPtr<ICoreWebView2Environment3> environment3;
    HRESULT hr = environment->QueryInterface(IID_PPV_ARGS(&environment3));
    if (FAILED(hr)) { browser_tabs::tabs.erase(handle); return hr; }
    auto callback = Microsoft::WRL::Callback<ICoreWebView2CreateCoreWebView2CompositionControllerCompletedHandler>(
        [raw, context, completed, handle](HRESULT result, ICoreWebView2CompositionController* composition) -> HRESULT {
            if (SUCCEEDED(result) && composition) {
                raw->composition = composition;
                result = raw->composition.As(&raw->controller);
                if (SUCCEEDED(result)) result = raw->controller->get_CoreWebView2(&raw->view);
                if (SUCCEEDED(result)) result = raw->composition->put_RootVisualTarget(winrt::get_unknown(raw->webVisual));
                if (SUCCEEDED(result)) {
                    RECT bounds{0, 0, static_cast<LONG>(raw->width), static_cast<LONG>(raw->height)};
                    result = raw->controller->put_Bounds(bounds);
                }
                if (SUCCEEDED(result)) result = raw->controller->put_IsVisible(raw->visibilityMode != 0);
                completed(context, result, SUCCEEDED(result) ? handle : 0,
                    SUCCEEDED(result) ? raw->view.Get() : nullptr,
                    SUCCEEDED(result) ? raw->controller.Get() : nullptr);
            } else completed(context, FAILED(result) ? result : E_FAIL, 0, nullptr, nullptr);
            if (FAILED(result)) browser_tabs::tabs.erase(handle);
            return S_OK;
        });
    hr = environment3->CreateCoreWebView2CompositionController(raw->window, callback.Get());
    if (FAILED(hr)) browser_tabs::tabs.erase(handle);
    return hr;
}

extern "C" __declspec(dllexport) HRESULT __cdecl ScanlineBrowserTabSetBounds(
    UINT64 handle, INT x, INT y, UINT width, UINT height, INT visibilityMode) {
    auto found = browser_tabs::tabs.find(handle);
    return found == browser_tabs::tabs.end() ? HRESULT_FROM_WIN32(ERROR_NOT_FOUND)
        : browser_tabs::SetBounds(*found->second, x, y, width, height, visibilityMode);
}

extern "C" __declspec(dllexport) HRESULT __cdecl ScanlineBrowserTabClose(UINT64 handle);
