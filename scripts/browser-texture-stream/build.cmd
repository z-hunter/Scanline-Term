@echo off
setlocal
cd /d "%~dp0"
if not defined WEBVIEW2_SDK_DIR (
  echo Set WEBVIEW2_SDK_DIR to a WebView2 SDK folder containing build\native\include.
  exit /b 2
)
if not exist "%WEBVIEW2_SDK_DIR%\build\native\include\WebView2Experimental.h" (
  echo WebView2Experimental.h was not found under WEBVIEW2_SDK_DIR.
  exit /b 2
)
if not defined VCToolsInstallDir (
  for /f "usebackq delims=" %%I in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do call "%%I\VC\Auxiliary\Build\vcvars64.bat"
)
if not defined VCToolsInstallDir (
  echo Run this from a VS 2022 x64 Native Tools prompt.
  exit /b 2
)
if not defined SCANLINE_TEXTURE_OUT set "SCANLINE_TEXTURE_OUT=%TEMP%\ScanlineTerm\browser-texture-stream"
if not exist "%SCANLINE_TEXTURE_OUT%" mkdir "%SCANLINE_TEXTURE_OUT%"
cl /nologo /std:c++17 /EHsc /W4 /LD /MT /Fo"%SCANLINE_TEXTURE_OUT%\bridge.obj" /I "%WindowsSdkDir%Include\%WindowsSDKVersion%cppwinrt" /I "%WEBVIEW2_SDK_DIR%\build\native\include" bridge.cpp /link /MACHINE:X64 /IMPLIB:"%SCANLINE_TEXTURE_OUT%\browser_texture_stream.lib" ole32.lib oleaut32.lib user32.lib d3d11.lib dxgi.lib runtimeobject.lib windowsapp.lib CoreMessaging.lib /OUT:"%SCANLINE_TEXTURE_OUT%\browser_texture_stream.dll"
exit /b %ERRORLEVEL%
