//! macOS: the WKWebView's own print operation, told to save to a file and show no panels. `createPDF` is not used
//! because it makes one tall page with no page breaks. Compiled by the macOS workflow but not yet run on a Mac
//! (backlog PRINT-MAC).
use super::{Done, PdfOptions};
use objc2::runtime::AnyObject;
use objc2_app_kit::{NSPaperOrientation, NSPrintHeaderAndFooter, NSPrintInfo, NSPrintJobSavingURL, NSPrintSaveJob, NSPrintingPaginationMode};
use objc2_foundation::{NSNumber, NSSize, NSString, NSURL};
use objc2_web_kit::WKWebView;
use std::path::Path;

/// Points per inch.
const POINTS: f64 = 72.0;

/// Print on the main thread; the operation runs to the end before `done` hears the result.
pub(super) fn start(platform: tauri::webview::PlatformWebview, out: &Path, options: &PdfOptions, done: Done) {
    let _ = done.send(print(&platform, out, options));
}

fn print(platform: &tauri::webview::PlatformWebview, out: &Path, options: &PdfOptions) -> Result<(), String> {
    // SAFETY: `inner` is the window's WKWebView, alive for this call, which runs on the main thread.
    let webview: &WKWebView = unsafe { &*platform.inner().cast() };
    let info = NSPrintInfo::init(NSPrintInfo::alloc());
    let (width, height) = options.page_in;
    let [top, right, bottom, left] = options.margins_in;
    info.setPaperSize(NSSize::new(width * POINTS, height * POINTS));
    info.setOrientation(if options.landscape { NSPaperOrientation::Landscape } else { NSPaperOrientation::Portrait });
    info.setTopMargin(top * POINTS);
    info.setRightMargin(right * POINTS);
    info.setBottomMargin(bottom * POINTS);
    info.setLeftMargin(left * POINTS);
    info.setHorizontalPagination(NSPrintingPaginationMode::Fit);
    info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
    let url = NSURL::fileURLWithPath(&NSString::from_str(&out.to_string_lossy()));
    let header_footer = NSNumber::new_bool(options.header_footer);
    // SAFETY: the keys are AppKit's print info keys and the values have the types AppKit documents for them.
    unsafe {
        info.setJobDisposition(NSPrintSaveJob);
        let attributes = info.dictionary();
        let url: &AnyObject = &url;
        attributes.insert(NSPrintJobSavingURL, url);
        let header_footer: &AnyObject = &header_footer;
        attributes.insert(NSPrintHeaderAndFooter, header_footer);
        webview.configuration().preferences().setShouldPrintBackgrounds(options.backgrounds);
    }
    // SAFETY: the print info is fully set up and the webview is on the main thread.
    let operation = unsafe { webview.printOperationWithPrintInfo(&info) };
    operation.setShowsPrintPanel(false);
    operation.setShowsProgressPanel(false);
    // WebKit prints blank pages when the operation's view has no frame.
    if let Some(view) = operation.view() {
        view.setFrame(webview.bounds());
    }
    if operation.runOperation() { Ok(()) } else { Err("macOS could not write the PDF".into()) }
}
