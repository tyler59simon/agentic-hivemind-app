//! Windows: WebView2 `PrintToPdf`, which needs `ICoreWebView2_7` (WebView2 runtime 1.0.1020 or later).
use super::{Done, PdfOptions};
use std::path::Path;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2_7, ICoreWebView2Environment6, COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE, COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
};
use webview2_com::PrintToPdfCompletedHandler;
use windows::core::{Interface, HSTRING};

/// Start printing on the main thread; `done` hears the result when WebView2 has written the file.
pub(super) fn start(platform: tauri::webview::PlatformWebview, out: &Path, options: &PdfOptions, done: Done) {
    if let Err(e) = print(&platform, out, options, done.clone()) {
        let _ = done.send(Err(e));
    }
}

fn print(platform: &tauri::webview::PlatformWebview, out: &Path, options: &PdfOptions, done: Done) -> Result<(), String> {
    let failed = |e: windows::core::Error| format!("WebView2 could not print the page: {}", e.message());
    let too_old = |_| "This WebView2 runtime cannot print to PDF; update Microsoft Edge WebView2 and try again".to_string();
    // SAFETY: plain COM calls on the main thread that owns the webview, which is where `with_webview` runs this.
    unsafe {
        let webview: ICoreWebView2_7 = platform.controller().CoreWebView2().map_err(failed)?.cast().map_err(too_old)?;
        let environment: ICoreWebView2Environment6 = platform.environment().cast().map_err(too_old)?;
        let settings = environment.CreatePrintSettings().map_err(failed)?;
        let orientation = if options.landscape { COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE } else { COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT };
        let (width, height) = options.page_in;
        let [top, right, bottom, left] = options.margins_in;
        settings.SetOrientation(orientation).map_err(failed)?;
        settings.SetPageWidth(width).map_err(failed)?;
        settings.SetPageHeight(height).map_err(failed)?;
        settings.SetMarginTop(top).map_err(failed)?;
        settings.SetMarginRight(right).map_err(failed)?;
        settings.SetMarginBottom(bottom).map_err(failed)?;
        settings.SetMarginLeft(left).map_err(failed)?;
        settings.SetShouldPrintBackgrounds(options.backgrounds).map_err(failed)?;
        settings.SetShouldPrintHeaderAndFooter(options.header_footer).map_err(failed)?;
        let handler = PrintToPdfCompletedHandler::create(Box::new(move |called, written| {
            let _ = done.send(match called {
                Err(e) => Err(failed(e)),
                Ok(()) if written => Ok(()),
                Ok(()) => Err("WebView2 could not write the PDF".into()),
            });
            Ok(())
        }));
        webview.PrintToPdf(&HSTRING::from(out), &settings, &handler).map_err(failed)?;
    }
    Ok(())
}
