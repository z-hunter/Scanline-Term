#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <d3d11_4.h>
#include <dxgi1_2.h>
#include <wrl.h>
#include <WebView2.h>
#include <WebView2Experimental.h>
#include <cstdio>
#include <memory>
#include <string>
#include <unordered_map>

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;

void Require(const char* label, HRESULT hr) {
    if (FAILED(hr)) {
        char text[160];
        sprintf_s(text, "Scanline TextureStream: %s failed: 0x%08lx\n", label, static_cast<unsigned long>(hr));
        OutputDebugStringA(text);
        throw hr;
    }
}

#include "gpu_frames.h"
#include "source_capture.h"
#include "tab_controller.h"

namespace {
constexpr wchar_t kOrigin[] = L"http://localhost:5173";
constexpr wchar_t kBundledOrigin[] = L"http://tauri.localhost";
constexpr wchar_t kBenchmarkUrl[] = L"http://localhost:5173/texture-stream-benchmark.html";
constexpr UINT kPoolLimit = 8;

UINT64 qpc_now() {
    LARGE_INTEGER value{};
    QueryPerformanceCounter(&value);
    return static_cast<UINT64>(value.QuadPart);
}

double epoch_at_qpc_zero_ms(UINT64 frequency) {
    const auto before = qpc_now();
    FILETIME filetime{};
    GetSystemTimePreciseAsFileTime(&filetime);
    const auto after = qpc_now();
    const auto ticks = (UINT64(filetime.dwHighDateTime) << 32) | filetime.dwLowDateTime;
    return (ticks - 116444736000000000ULL) / 10000.0 - (before + after) * 500.0 / frequency;
}

class Session {
public:
    Session(ICoreWebView2Environment* environment, std::wstring id, UINT width, UINT height,
            winrt::Windows::UI::Composition::Visual sourceVisual = nullptr, UINT64 tabHandle = 0)
        : environment_(environment), id_(std::move(id)), width_(width), height_(height), sourceVisual_(sourceVisual), tabHandle_(tabHandle) {}

    ~Session() { Stop(); }

    HRESULT Start(double* epoch, const wchar_t* origin) {
        const HRESULT com = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
        if (FAILED(com) && com != RPC_E_CHANGED_MODE) return com;
        uninitializeCom_ = SUCCEEDED(com);
        if (com == RPC_E_CHANGED_MODE) return com;

        HRESULT hr = environment_.As(&environment12_);
        if (FAILED(hr)) return hr;
        UINT64 adapterLuid = 0;
        hr = environment12_->get_RenderAdapterLUID(&adapterLuid);
        if (FAILED(hr) || !adapterLuid) return FAILED(hr) ? hr : E_PENDING;

        ComPtr<IDXGIFactory1> factory;
        hr = CreateDXGIFactory1(IID_PPV_ARGS(&factory));
        if (FAILED(hr)) return hr;
        ComPtr<IDXGIAdapter1> adapter;
        for (UINT index = 0; ; ++index) {
            ComPtr<IDXGIAdapter1> candidate;
            if (factory->EnumAdapters1(index, &candidate) != S_OK) break;
            DXGI_ADAPTER_DESC1 desc{};
            if (FAILED(candidate->GetDesc1(&desc))) continue;
            const UINT64 candidateLuid = (UINT64(static_cast<UINT32>(desc.AdapterLuid.HighPart)) << 32) |
                static_cast<UINT32>(desc.AdapterLuid.LowPart);
            if (candidateLuid == adapterLuid) { adapter = candidate; break; }
        }
        if (!adapter) return DXGI_ERROR_NOT_FOUND;
        hr = D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
            nullptr, 0, D3D11_SDK_VERSION, &device_, nullptr, nullptr);
        if (FAILED(hr)) return hr;
        ComPtr<ID3D11Multithread> multithread;
        if (SUCCEEDED(device_.As(&multithread))) multithread->SetMultithreadProtected(TRUE);

        hr = environment12_->CreateTextureStream(id_.c_str(), device_.Get(), &stream_);
        if (FAILED(hr)) return hr;
        hr = stream_->AddAllowedOrigin(origin, FALSE);
        if (FAILED(hr)) return hr;
        hr = stream_->add_ErrorReceived(
            Callback<ICoreWebView2ExperimentalTextureStreamErrorReceivedEventHandler>(
                [](ICoreWebView2ExperimentalTextureStream*, ICoreWebView2ExperimentalTextureStreamErrorReceivedEventArgs* args) -> HRESULT {
                    COREWEBVIEW2_TEXTURE_STREAM_ERROR_KIND kind{};
                    if (SUCCEEDED(args->get_Kind(&kind))) {
                        char text[96]; sprintf_s(text, "Scanline TextureStream async error kind %d\n", int(kind));
                        OutputDebugStringA(text);
                    }
                    return S_OK;
                }).Get(), &errorToken_);
        if (FAILED(hr)) return hr;
        hr = stream_->add_Stopped(
            Callback<ICoreWebView2ExperimentalTextureStreamStoppedEventHandler>(
                [this](ICoreWebView2ExperimentalTextureStream*, IUnknown*) -> HRESULT {
                    capture_.Stop();
                    allocated_ = 0;
                    lastCapture_ = 0;
                    return S_OK;
                }).Get(), &stoppedToken_);
        if (FAILED(hr)) return hr;
        hr = stream_->add_StartRequested(
            Callback<ICoreWebView2ExperimentalTextureStreamStartRequestedEventHandler>(
                [this](ICoreWebView2ExperimentalTextureStream*, IUnknown*) -> HRESULT {
                    return StartCapture();
                }).Get(), &startToken_);
        if (FAILED(hr)) return hr;

        LARGE_INTEGER qpcFrequency{};
        if (!QueryPerformanceFrequency(&qpcFrequency) || qpcFrequency.QuadPart <= 0) return E_FAIL;
        *epoch = epoch_at_qpc_zero_ms(static_cast<UINT64>(qpcFrequency.QuadPart));
        return S_OK;
    }

    HRESULT Stop() {
        capture_.Stop();
        if (stream_) {
            if (startToken_.value) stream_->remove_StartRequested(startToken_);
            if (stoppedToken_.value) stream_->remove_Stopped(stoppedToken_);
            if (errorToken_.value) stream_->remove_ErrorReceived(errorToken_);
            stream_->Stop();
        }
        stream_.Reset();
        device_.Reset();
        environment12_.Reset();
        environment_.Reset();
        if (uninitializeCom_) { CoUninitialize(); uninitializeCom_ = false; }
        return S_OK;
    }

    UINT64 tab_handle() const { return tabHandle_; }

private:
    HRESULT StartCapture() {
        try {
            gpu_.Init(device_.Get(), width_, height_);
            allocated_ = 0;
            lastCapture_ = 0;
            const bool started = sourceVisual_
                ? capture_.StartForVisual(device_.Get(), sourceVisual_, width_, height_, [this] { Produce(); })
                : capture_.Start(environment_.Get(), device_.Get(), width_, height_, kBenchmarkUrl, [this] { Produce(); });
            if (!started) return E_FAIL;
            return S_OK;
        } catch (HRESULT hr) { return hr; }
          catch (...) { return E_FAIL; }
    }

    void Produce() {
        if (!capture_.ready()) return;
        ComPtr<ID3D11Texture2D> captured;
        INT64 timestamp100ns = 0;
        if (!capture_.Pull(&captured, &timestamp100ns) || timestamp100ns <= lastCapture_) return;
        lastCapture_ = timestamp100ns;
        D3D11_TEXTURE2D_DESC input{};
        captured->GetDesc(&input);
        ComPtr<ICoreWebView2ExperimentalTexture> texture;
        HRESULT hr = stream_->GetAvailableTexture(&texture);
        if (hr == HRESULT_FROM_WIN32(ERROR_NO_MORE_ITEMS) || (SUCCEEDED(hr) && !texture)) {
            if (allocated_ >= kPoolLimit) return;
            hr = stream_->CreateTexture(width_, height_, &texture);
            if (FAILED(hr)) return FailFrame("CreateTexture", hr);
            ++allocated_;
        } else if (FAILED(hr)) return FailFrame("GetAvailableTexture", hr);
        try {
            gpu_.Write(captured.Get(), input.Width, input.Height, texture.Get());
        } catch (HRESULT error) { return FailFrame("GPU conversion", error); }
        hr = texture->put_Timestamp(static_cast<UINT64>(timestamp100ns / 10));
        if (FAILED(hr)) return FailFrame("put_Timestamp", hr);
        hr = stream_->PresentTexture(texture.Get());
        if (FAILED(hr)) FailFrame("PresentTexture", hr);
    }

    void FailFrame(const char* operation, HRESULT hr) {
        char text[160];
        sprintf_s(text, "Scanline TextureStream stopped at %s: 0x%08lx\n", operation, static_cast<unsigned long>(hr));
        OutputDebugStringA(text);
        capture_.Stop();
    }

    ComPtr<ICoreWebView2Environment> environment_;
    ComPtr<ICoreWebView2ExperimentalEnvironment12> environment12_;
    ComPtr<ICoreWebView2ExperimentalTextureStream> stream_;
    ComPtr<ID3D11Device> device_;
    SourceCapture capture_;
    GpuFrames gpu_;
    std::wstring id_;
    winrt::Windows::UI::Composition::Visual sourceVisual_{nullptr};
    UINT64 tabHandle_{};
    UINT width_, height_, allocated_{};
    INT64 lastCapture_{};
    EventRegistrationToken startToken_{}, stoppedToken_{}, errorToken_{};
    bool uninitializeCom_{};
};

std::unordered_map<std::wstring, std::unique_ptr<Session>> sessions;
}

extern "C" __declspec(dllexport) HRESULT __cdecl ScanlineTextureStreamStart(
    ICoreWebView2Environment* environment, ICoreWebView2Controller*,
    const wchar_t* streamId, const wchar_t* sourceUrl, UINT width, UINT height, double* epochAtQpcZeroMs) {
    if (!environment || !streamId || !sourceUrl || !epochAtQpcZeroMs) return E_INVALIDARG;
    if (std::wstring(sourceUrl) != kBenchmarkUrl) return E_ACCESSDENIED;
    if (!*streamId || wcslen(streamId) > 64 || width < 320 || width > 1920 || height < 240 || height > 1080 ||
        (width & 1) || (height & 1)) return E_INVALIDARG;
    if (sessions.find(streamId) != sessions.end()) return HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS);
    auto session = std::make_unique<Session>(environment, streamId, width, height);
    const HRESULT hr = session->Start(epochAtQpcZeroMs, kOrigin);
    if (FAILED(hr)) return hr;
    sessions.emplace(streamId, std::move(session));
    return S_OK;
}

extern "C" __declspec(dllexport) HRESULT __cdecl ScanlineTextureStreamStop(const wchar_t* streamId) {
    if (!streamId) return E_INVALIDARG;
    const auto it = sessions.find(streamId);
    if (it == sessions.end()) return S_OK;
    it->second->Stop();
    sessions.erase(it);
    return S_OK;
}

extern "C" __declspec(dllexport) void __cdecl ScanlineTextureStreamStopAll() {
    sessions.clear();
}

extern "C" __declspec(dllexport) HRESULT __cdecl ScanlineTextureStreamStartForTabWithOrigin(
    UINT64 tabHandle, const wchar_t* streamId, const wchar_t* origin, UINT width, UINT height, double* epochAtQpcZeroMs) {
    if (!streamId || !origin || !epochAtQpcZeroMs || !*streamId || wcslen(streamId) > 64 ||
        width < 2 || width > 1920 || height < 2 || height > 1080 || (width & 1) || (height & 1)) return E_INVALIDARG;
    if (wcscmp(origin, kOrigin) != 0 && wcscmp(origin, kBundledOrigin) != 0) return E_ACCESSDENIED;
    const auto tab = browser_tabs::tabs.find(tabHandle);
    if (tab == browser_tabs::tabs.end() || !tab->second->view || !tab->second->environment) return HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
    if (sessions.find(streamId) != sessions.end()) return HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS);
    auto session = std::make_unique<Session>(tab->second->environment.Get(), streamId, width, height,
        tab->second->webVisual, tabHandle);
    const HRESULT hr = session->Start(epochAtQpcZeroMs, origin);
    if (FAILED(hr)) return hr;
    sessions.emplace(streamId, std::move(session));
    return S_OK;
}

extern "C" __declspec(dllexport) HRESULT __cdecl ScanlineTextureStreamStopForTab(
    UINT64 tabHandle, const wchar_t* streamId) {
    if (browser_tabs::tabs.find(tabHandle) == browser_tabs::tabs.end()) return HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
    return ScanlineTextureStreamStop(streamId);
}

extern "C" __declspec(dllexport) HRESULT __cdecl ScanlineBrowserTabClose(UINT64 handle) {
    for (auto it = sessions.begin(); it != sessions.end();) {
        if (it->second->tab_handle() == handle) {
            it->second->Stop();
            it = sessions.erase(it);
        } else ++it;
    }
    const auto found = browser_tabs::tabs.find(handle);
    if (found == browser_tabs::tabs.end()) return S_OK;
    found->second->Close(); browser_tabs::tabs.erase(found); return S_OK;
}
