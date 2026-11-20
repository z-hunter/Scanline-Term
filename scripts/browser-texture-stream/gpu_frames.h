#pragma once
#include <d3d11_1.h>
#include <dxgi1_2.h>

struct GpuFrames {
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    ComPtr<ID3D11VideoDevice> videoDevice;
    ComPtr<ID3D11VideoContext> videoContext;
    ComPtr<ID3D11VideoProcessorEnumerator> enumerator;
    ComPtr<ID3D11VideoProcessor> processor;
    ComPtr<ID3D11Texture2D> converted;
    UINT width = 0, height = 0, inputWidth = 0, inputHeight = 0;

    void Init(ID3D11Device* value, UINT w, UINT h) {
        device = value;
        width = w;
        height = h;
        device->GetImmediateContext(&context);
        Require("ID3D11VideoDevice", device.As(&videoDevice));
        Require("ID3D11VideoContext", context.As(&videoContext));
    }

    void Write(ID3D11Texture2D* input, UINT w, UINT h, ICoreWebView2ExperimentalTexture* output) {
        ComPtr<IUnknown> resource;
        ComPtr<ID3D11Texture2D> shared;
        Require("get_Resource", output->get_Resource(&resource));
        Require("Query ID3D11Texture2D", resource.As(&shared));
        D3D11_TEXTURE2D_DESC desc{};
        shared->GetDesc(&desc);
        if (desc.Format != DXGI_FORMAT_NV12 || desc.Width != width || desc.Height != height ||
            desc.Usage != D3D11_USAGE_DEFAULT || desc.CPUAccessFlags) throw E_UNEXPECTED;
        if (!processor || w != inputWidth || h != inputHeight) {
            inputWidth = w;
            inputHeight = h;
            D3D11_VIDEO_PROCESSOR_CONTENT_DESC content{D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                {60, 1}, w, h, {60, 1}, width, height, D3D11_VIDEO_USAGE_PLAYBACK_NORMAL};
            processor.Reset();
            enumerator.Reset();
            Require("Create VP enumerator", videoDevice->CreateVideoProcessorEnumerator(&content, &enumerator));
            Require("Create VP", videoDevice->CreateVideoProcessor(enumerator.Get(), 0, &processor));
            videoContext->VideoProcessorSetStreamAutoProcessingMode(processor.Get(), 0, FALSE);
        }

        D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC inDesc{};
        inDesc.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
        ComPtr<ID3D11VideoProcessorInputView> inView;
        Require("Create BGRA VP input view", videoDevice->CreateVideoProcessorInputView(input,
            enumerator.Get(), &inDesc, &inView));
        D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC outDesc{};
        outDesc.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
        ComPtr<ID3D11VideoProcessorOutputView> outView;
        bool usesIntermediate = false;

        // Some stream textures cannot be video-processor render targets.
        if (FAILED(videoDevice->CreateVideoProcessorOutputView(shared.Get(), enumerator.Get(), &outDesc, &outView))) {
            usesIntermediate = true;
            if (!converted) {
                desc.BindFlags = D3D11_BIND_RENDER_TARGET;
                desc.MiscFlags = 0;
                Require("Create intermediate NV12", device->CreateTexture2D(&desc, nullptr, &converted));
            }
            Require("Create NV12 VP output view", videoDevice->CreateVideoProcessorOutputView(
                converted.Get(), enumerator.Get(), &outDesc, &outView));
        }

        RECT src{0, 0, LONG(w), LONG(h)}, dest{0, 0, LONG(width), LONG(height)};
        videoContext->VideoProcessorSetStreamSourceRect(processor.Get(), 0, TRUE, &src);
        videoContext->VideoProcessorSetStreamDestRect(processor.Get(), 0, TRUE, &dest);
        videoContext->VideoProcessorSetOutputTargetRect(processor.Get(), TRUE, &dest);
        D3D11_VIDEO_PROCESSOR_COLOR_SPACE inputColor{}, outputColor{};
        inputColor.RGB_Range = 0;
        outputColor.YCbCr_Matrix = 1;
        outputColor.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235;
        videoContext->VideoProcessorSetStreamColorSpace(processor.Get(), 0, &inputColor);
        videoContext->VideoProcessorSetOutputColorSpace(processor.Get(), &outputColor);

        ComPtr<IDXGIKeyedMutex> mutex;
        Require("Query keyed mutex", shared.As(&mutex));
        const auto lock = mutex->AcquireSync(0, 0);
        if (lock != S_OK) throw lock;
        D3D11_VIDEO_PROCESSOR_STREAM frame{};
        frame.Enable = TRUE;
        frame.pInputSurface = inView.Get();
        const auto blit = videoContext->VideoProcessorBlt(processor.Get(), outView.Get(), 0, 1, &frame);
        if (SUCCEEDED(blit) && usesIntermediate) context->CopyResource(shared.Get(), converted.Get());
        context->Flush();
        const auto released = mutex->ReleaseSync(0);
        Require("VideoProcessorBlt", blit);
        Require("ReleaseSync", released);
    }
};
