#pragma once

#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <DispatcherQueue.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <windows.ui.composition.interop.h>
#include <wrl.h>
#include <WebView2.h>

#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <winrt/Windows.UI.Composition.h>
#include <winrt/Windows.UI.Composition.Desktop.h>
#include <winrt/Windows.System.h>

#include <functional>
#include <cwchar>
#include <unordered_map>
#include <string>
#include <utility>

using Microsoft::WRL::ComPtr;

// WGC-backed WebView2 source. Start/Pull/Stop and the HWND message pump must
// run on the same STA thread. Pull returns an AddRef'd texture and the raw
// WGC SystemRelativeTime value in 100 ns units (QPC-derived).
class SourceCapture {
public:
    ~SourceCapture() {
        Stop();
        if (queueController_) { queueController_->Release(); queueController_ = nullptr; }
    }

    bool Start(ICoreWebView2Environment* environment, ID3D11Device* device,
               UINT width, UINT height, const wchar_t* url, std::function<void()> onFrame) {
        Stop();
        if (!environment || !device || !width || !height) return false;
        width_ = width;
        height_ = height;
        onFrame_ = std::move(onFrame);
        device_ = device;
        if (!queueController_) {
            DispatcherQueueOptions options{sizeof(options), DQTYPE_THREAD_CURRENT, DQTAT_COM_STA};
            static ABI::Windows::System::IDispatcherQueueController* sharedQueueController = nullptr;
            if (!sharedQueueController && FAILED(CreateDispatcherQueueController(options, &sharedQueueController))) {
                if (!winrt::Windows::System::DispatcherQueue::GetForCurrentThread()) return false;
            }
            queueController_ = sharedQueueController;
            if (queueController_) queueController_->AddRef();
        }
        if (!window_) {
            WNDCLASSW wc{};
            wc.lpfnWndProc = WindowProc;
            wc.hInstance = GetModuleHandleW(nullptr);
            wc.lpszClassName = L"WebView2WgcSourceWindow";
            RegisterClassW(&wc);
            const auto right = GetSystemMetrics(SM_XVIRTUALSCREEN) + GetSystemMetrics(SM_CXVIRTUALSCREEN);
            window_ = CreateWindowExW(WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                wc.lpszClassName, L"WebView2 WGC source", WS_POPUP | WS_VISIBLE,
                right + 16, GetSystemMetrics(SM_YVIRTUALSCREEN), static_cast<int>(width), static_cast<int>(height),
                nullptr, nullptr, wc.hInstance, this);
            if (!window_) return false;
        }
        compositor_ = winrt::Windows::UI::Composition::Compositor();
        winrt::com_ptr<ABI::Windows::UI::Composition::Desktop::ICompositorDesktopInterop> desktopInterop;
        winrt::check_hresult(winrt::get_unknown(compositor_)->QueryInterface(IID_PPV_ARGS(desktopInterop.put())));
        winrt::check_hresult(desktopInterop->CreateDesktopWindowTarget(window_, TRUE,
            reinterpret_cast<ABI::Windows::UI::Composition::Desktop::IDesktopWindowTarget**>(winrt::put_abi(target_))));
        root_ = compositor_.CreateContainerVisual();
        webVisual_ = compositor_.CreateContainerVisual();
        root_.Children().InsertAtTop(webVisual_);
        target_.Root(root_);

        ComPtr<ICoreWebView2Environment3> environment3;
        if (FAILED(environment->QueryInterface(IID_PPV_ARGS(&environment3)))) return false;
        auto callback = Microsoft::WRL::Callback<ICoreWebView2CreateCoreWebView2CompositionControllerCompletedHandler>(
            [this, url = std::wstring(url ? url : L"")](HRESULT hr, ICoreWebView2CompositionController* composition) -> HRESULT {
              try {
                if (FAILED(hr) || !composition) return hr;
                composition_ = composition;
                if (FAILED(composition_.As(&controller_))) return S_OK;
                if (FAILED(controller_->get_CoreWebView2(&view_))) return S_OK;
                if (FAILED(composition_->put_RootVisualTarget(winrt::get_unknown(webVisual_)))) return S_OK;
                UpdateBounds();
                if (FAILED(controller_->put_IsVisible(TRUE))) return E_FAIL;
                if (!StartCapture()) return S_OK;
                const auto registration = view_->add_WebMessageReceived(
                        Microsoft::WRL::Callback<ICoreWebView2WebMessageReceivedEventHandler>(
                            [this, url](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
                                LPWSTR source = nullptr;
                                LPWSTR message = nullptr;
                                if (SUCCEEDED(args->get_Source(&source)) && source && url == source &&
                                    SUCCEEDED(args->TryGetWebMessageAsString(&message)) && message &&
                                    std::wcscmp(message, L"scanline-texture-benchmark-first-paint") == 0) ready_ = true;
                                CoTaskMemFree(message);
                                CoTaskMemFree(source);
                                return S_OK;
                            }).Get(), &webMessageToken_);
                if (FAILED(registration)) return registration;
                hasWebMessageHandler_ = true;
                return view_->Navigate(url.c_str());
              } catch (const winrt::hresult_error& e) { return e.code(); }
                catch (...) { return E_FAIL; }
            });
        const auto result = environment3->CreateCoreWebView2CompositionController(window_, callback.Get());
        if (SUCCEEDED(result)) SetTimer(window_, 2, 16, nullptr);
        return SUCCEEDED(result);
    }

    bool StartForVisual(ID3D11Device* device, winrt::Windows::UI::Composition::Visual visual,
                        UINT width, UINT height, std::function<void()> onFrame) {
        Stop();
        if (!device || !visual || !width || !height) return false;
        width_ = width;
        height_ = height;
        onFrame_ = std::move(onFrame);
        device_ = device;
        if (!queueController_) {
            DispatcherQueueOptions options{sizeof(options), DQTYPE_THREAD_CURRENT, DQTAT_COM_STA};
            static ABI::Windows::System::IDispatcherQueueController* sharedQueueController = nullptr;
            if (!sharedQueueController && FAILED(CreateDispatcherQueueController(options, &sharedQueueController)) &&
                !winrt::Windows::System::DispatcherQueue::GetForCurrentThread()) return false;
            queueController_ = sharedQueueController;
            if (queueController_) queueController_->AddRef();
        }
        if (!CreateWgcDevice() || !StartWgc(visual)) return false;
        ready_ = true;
        timer_ = SetTimer(nullptr, 0, 16, TimerProc);
        if (timer_) timers_[timer_] = this;
        return timer_ != 0;
    }

    bool Pull(ID3D11Texture2D** texture, INT64* timestampUs = nullptr) {
        if (!texture) return false;
        *texture = nullptr;
        if (!pool_) return false;
        try {
            winrt::Windows::Graphics::Capture::Direct3D11CaptureFrame next{nullptr};
            while ((next = pool_.TryGetNextFrame())) currentFrame_ = std::move(next);
            if (!currentFrame_) return false;
            const auto contentSize = currentFrame_.ContentSize();
            if (contentSize.Width != frameWidth_ || contentSize.Height != frameHeight_) {
                currentFrame_ = nullptr;
                pool_.Recreate(winrtDevice_, winrt::Windows::Graphics::DirectX::DirectXPixelFormat::B8G8R8A8UIntNormalized,
                    3, contentSize);
                frameWidth_ = contentSize.Width;
                frameHeight_ = contentSize.Height;
                return false;
            }
            if (timestampUs) *timestampUs = currentFrame_.SystemRelativeTime().count();
            auto surface = currentFrame_.Surface();
            auto access = surface.as<Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
            return SUCCEEDED(access->GetInterface(IID_PPV_ARGS(texture)));
        } catch (...) { return false; }
    }

    void Stop() {
        if (timer_) { KillTimer(nullptr, timer_); timers_.erase(timer_); timer_ = 0; }
        ready_ = false;
        currentFrame_ = nullptr;
        if (session_) session_.Close();
        if (pool_) pool_.Close();
        session_ = nullptr;
        pool_ = nullptr;
        item_ = nullptr;
        if (hasWebMessageHandler_ && view_) view_->remove_WebMessageReceived(webMessageToken_);
        hasWebMessageHandler_ = false;
        if (controller_) controller_->Close();
        view_.Reset();
        controller_.Reset();
        composition_.Reset();
        webVisual_ = nullptr;
        root_ = nullptr;
        target_ = nullptr;
        compositor_ = nullptr;
        winrtDevice_ = nullptr;
        device_.Reset();
        if (window_) { KillTimer(window_, 2); DestroyWindow(window_); window_ = nullptr; }
        onFrame_ = {};
        if (queueController_) { queueController_->Release(); queueController_ = nullptr; }
    }

    bool ready() const { return ready_; }

private:
    static LRESULT CALLBACK WindowProc(HWND hwnd, UINT message, WPARAM wp, LPARAM lp) {
        auto self = reinterpret_cast<SourceCapture*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
        if (message == WM_NCCREATE) {
            self = static_cast<SourceCapture*>(reinterpret_cast<CREATESTRUCTW*>(lp)->lpCreateParams);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
        }
        if (!self) return DefWindowProcW(hwnd, message, wp, lp);
        switch (message) {
        case WM_TIMER: if (self->onFrame_) self->onFrame_(); return 0;
        case WM_DESTROY: if (self->window_ == hwnd) self->window_ = nullptr; return 0;
        }
        return DefWindowProcW(hwnd, message, wp, lp);
    }

    static VOID CALLBACK TimerProc(HWND, UINT, UINT_PTR id, DWORD) {
        const auto found = timers_.find(id);
        if (found != timers_.end() && found->second->onFrame_) found->second->onFrame_();
    }

    void UpdateBounds() {
        if (!controller_ || !window_) return;
        RECT bounds{}; GetClientRect(window_, &bounds); controller_->put_Bounds(bounds);
        if (webVisual_) webVisual_.Size({static_cast<float>(width_), static_cast<float>(height_)});
        if (root_) root_.Size({static_cast<float>(width_), static_cast<float>(height_)});
    }

    bool StartCapture() {
        if (!CreateWgcDevice()) return false;
        return StartWgc(webVisual_);
    }

    bool CreateWgcDevice() {
        ComPtr<IDXGIDevice> dxgiDevice;
        if (FAILED(device_.As(&dxgiDevice))) return false;
        winrt::com_ptr<IInspectable> inspectable;
        if (FAILED(CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.Get(), inspectable.put()))) return false;
        winrtDevice_ = inspectable.as<winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice>();
        return true;
    }

    bool StartWgc(winrt::Windows::UI::Composition::Visual visual) {
        item_ = winrt::Windows::Graphics::Capture::GraphicsCaptureItem::CreateFromVisual(visual);
        const auto sourceSize = item_.Size();
        frameWidth_ = sourceSize.Width;
        frameHeight_ = sourceSize.Height;
        pool_ = winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool::Create(
            winrtDevice_, winrt::Windows::Graphics::DirectX::DirectXPixelFormat::B8G8R8A8UIntNormalized,
            3, sourceSize);
        session_ = pool_.CreateCaptureSession(item_);
        session_.StartCapture();
        return true;
    }

    inline static std::unordered_map<UINT_PTR, SourceCapture*> timers_{};
    UINT_PTR timer_{};

    HWND window_{};
    UINT width_{}, height_{};
    int32_t frameWidth_{}, frameHeight_{};
    bool ready_{};
    std::function<void()> onFrame_;
    ComPtr<ID3D11Device> device_;
    ComPtr<ICoreWebView2CompositionController> composition_;
    ComPtr<ICoreWebView2Controller> controller_;
    ComPtr<ICoreWebView2> view_;
    EventRegistrationToken webMessageToken_{};
    bool hasWebMessageHandler_{};
    ABI::Windows::System::IDispatcherQueueController* queueController_{};
    winrt::Windows::UI::Composition::Compositor compositor_{nullptr};
    winrt::Windows::UI::Composition::Desktop::DesktopWindowTarget target_{nullptr};
    winrt::Windows::UI::Composition::ContainerVisual root_{nullptr}, webVisual_{nullptr};
    winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice winrtDevice_{nullptr};
    winrt::Windows::Graphics::Capture::GraphicsCaptureItem item_{nullptr};
    winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool pool_{nullptr};
    winrt::Windows::Graphics::Capture::GraphicsCaptureSession session_{nullptr};
    winrt::Windows::Graphics::Capture::Direct3D11CaptureFrame currentFrame_{nullptr};
};
