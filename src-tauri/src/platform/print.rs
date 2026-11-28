//! Printing a webview to a PDF file (DOCOS-1A): WebView2 `PrintToPdf` on Windows, a WKWebView print operation that saves
//! to a file on macOS. The webview prints what its `@media print` rules show, so the caller arranges the page first.
use std::path::Path;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::time::Duration;

#[cfg(target_os = "macos")]
mod mac;
#[cfg(windows)]
mod win;

/// How long a print may take before the caller stops waiting.
const WAIT: Duration = Duration::from_secs(60);

/// What the native call reports when it is done.
type Done = Sender<Result<(), String>>;

/// Page layout for a PDF, in inches.
#[derive(Clone, Debug, PartialEq)]
pub struct PdfOptions {
    pub landscape: bool,
    /// Width and height of the paper.
    pub page_in: (f64, f64),
    /// Top, right, bottom, left.
    pub margins_in: [f64; 4],
    pub backgrounds: bool,
    /// The browser's own header and footer (title, date, page numbers).
    pub header_footer: bool,
}

impl Default for PdfOptions {
    /// A4 portrait with 0.4 inch margins, backgrounds on, no browser header or footer.
    fn default() -> Self {
        PdfOptions { landscape: false, page_in: (8.27, 11.69), margins_in: [0.4; 4], backgrounds: true, header_footer: false }
    }
}

impl PdfOptions {
    /// Refuse a page size or margins that leave nothing to print on.
    pub fn check(&self) -> Result<(), String> {
        let (width, height) = self.page_in;
        let [top, right, bottom, left] = self.margins_in;
        if ![width, height, top, right, bottom, left].iter().all(|value| value.is_finite()) || width <= 0.0 || height <= 0.0 {
            return Err("The page size must be a positive number of inches".into());
        }
        if self.margins_in.iter().any(|margin| *margin < 0.0) {
            return Err("Page margins cannot be negative".into());
        }
        let (across, down) = if self.landscape { (height, width) } else { (width, height) };
        if left + right >= across || top + bottom >= down {
            return Err("The margins leave no room on the page".into());
        }
        Ok(())
    }
}

/// Writes what a webview shows for print to a PDF file.
pub trait PrintBackend {
    /// Write `webview` to `out` as a PDF. Blocks until the file is written, while the native call runs on the main
    /// thread, so it must never be called on the main thread.
    fn print_to_pdf(&self, webview: &tauri::Webview, out: &Path, options: &PdfOptions) -> Result<(), String>;
}

/// The print service of the system Hivemind runs on.
pub struct Native;

impl PrintBackend for Native {
    fn print_to_pdf(&self, webview: &tauri::Webview, out: &Path, options: &PdfOptions) -> Result<(), String> {
        options.check()?;
        let (done, result) = mpsc::channel();
        let (out, options) = (out.to_path_buf(), options.clone());
        webview
            .with_webview(move |platform| start(platform, &out, &options, done))
            .map_err(|e| format!("Hivemind could not reach the page to print it: {e}"))?;
        match result.recv_timeout(WAIT) {
            Ok(printed) => printed,
            Err(RecvTimeoutError::Timeout) => Err("Printing to PDF did not finish within a minute".into()),
            Err(RecvTimeoutError::Disconnected) => Err("Printing to PDF stopped without saying why".into()),
        }
    }
}

#[cfg(windows)]
use win::start;

#[cfg(target_os = "macos")]
use mac::start;

#[cfg(not(any(windows, target_os = "macos")))]
fn start(_: tauri::webview::PlatformWebview, _: &Path, _: &PdfOptions, done: Done) {
    let _ = done.send(Err("Printing to PDF is not supported on this system yet".into()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_page_is_a4_portrait_and_passes_the_check() {
        let options = PdfOptions::default();
        assert_eq!(options.page_in, (8.27, 11.69));
        assert!(!options.landscape);
        assert_eq!(options.check(), Ok(()));
    }

    #[test]
    fn a_page_without_size_is_refused() {
        for page_in in [(0.0, 11.0), (8.0, -1.0), (f64::NAN, 11.0), (8.0, f64::INFINITY)] {
            let options = PdfOptions { page_in, ..PdfOptions::default() };
            assert!(options.check().is_err(), "{page_in:?}");
        }
    }

    #[test]
    fn negative_margins_are_refused() {
        let options = PdfOptions { margins_in: [0.4, -0.1, 0.4, 0.4], ..PdfOptions::default() };
        assert_eq!(options.check(), Err("Page margins cannot be negative".into()));
    }

    #[test]
    fn margins_that_fill_the_page_are_refused_in_the_direction_they_print() {
        // 4 + 4 inches across fills a portrait A4 page (8.27 wide) but not a landscape one (11.69 across).
        let wide = PdfOptions { margins_in: [0.4, 4.0, 0.4, 4.3], ..PdfOptions::default() };
        assert_eq!(wide.check(), Err("The margins leave no room on the page".into()));
        assert_eq!(PdfOptions { landscape: true, ..wide }.check(), Ok(()));
    }
}
