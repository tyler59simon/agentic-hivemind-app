"""Drive the running Hivemind dev window over the Chrome DevTools Protocol and save page screenshots.

Start the app with remote debugging first (PowerShell):
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
    $env:WEBVIEW2_USER_DATA_FOLDER = "<a scratch folder>"   # keeps the real app's saved state untouched
    npm run tauri dev

Then, with a Python that has Playwright installed:
    python scripts/drive_ui.py --out <folder> nav:Memory wait:1 shot:memory "click:Decisions" "eval:document.title"

Steps: nav:<sidebar label>  click:<button text>  dbl:<text>  ctrl:<text>  sel:<css>  key:Ctrl+p  type:<css>=<text>
       eval:<js>  css:<selector>  text  wait:<seconds>  size:<w>x<h>  shot:<name>
Screenshots come from the page itself, not from the screen, and clicks are element.click() calls
(simulated mouse clicks are intercepted in the WebView).
"""
import sys, time, pathlib
from playwright.sync_api import sync_playwright

OUT = pathlib.Path(".")
W, H = 1487, 1058

# A click is element.click() via evaluate: simulated mouse clicks get intercepted in the WebView.
JS = {
    "nav": "(label) => { const b=[...document.querySelectorAll('.nav-item')].find(x=>x.textContent.trim().startsWith(label)); if(!b) return 'no nav '+label; b.click(); return 'ok'; }",
    "click": "(text) => { const b=[...document.querySelectorAll('button,a,[role=tab]')].find(x=>x.textContent.trim()===text) || [...document.querySelectorAll('button,a,[role=tab]')].find(x=>x.textContent.trim().startsWith(text)); if(!b) return 'no button '+text; b.click(); return 'ok'; }",
    "dbl": "(text) => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(text)); if(!b) return 'no row '+text; b.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); return 'ok'; }",
    "ctrl": "(text) => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(text)); if(!b) return 'no row '+text; b.dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true})); return 'ok'; }",
    "sel": "(sel) => { const b=document.querySelector(sel); if(!b) return 'no '+sel; b.click(); return 'ok'; }",
    "text": "() => document.body.innerText.slice(0, 3000)",
    "errors": "() => (window.__errs||[]).join('\\n')",
    "css": "(sel) => { const e=document.querySelector(sel); if(!e) return 'no '+sel; const s=getComputedStyle(e); return JSON.stringify({bg:s.backgroundColor,font:s.fontFamily,size:s.fontSize,w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height}); }",
    "eval": "(code) => { try { return String(eval(code)); } catch (e) { return 'ERR '+e; } }",
    "key": "(combo) => { const p=combo.split('+'); const key=p.pop(); window.dispatchEvent(new KeyboardEvent('keydown',{key,ctrlKey:p.includes('Ctrl'),shiftKey:p.includes('Shift'),altKey:p.includes('Alt'),bubbles:true})); return 'ok'; }",
}

def main(steps):
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp("http://127.0.0.1:9222")
        page = next(pg for ctx in browser.contexts for pg in ctx.pages if "capture" not in pg.url)
        page.set_viewport_size({"width": W, "height": H})
        for step in steps:
            name, _, arg = step.partition(":")
            if name == "shot":
                time.sleep(0.6)
                page.screenshot(path=str(OUT / f"{arg}.png"))
                print("shot", arg)
            elif name == "wait":
                time.sleep(float(arg))
            elif name == "size":
                w, h = arg.split("x"); page.set_viewport_size({"width": int(w), "height": int(h)})
            elif name == "type":
                sel, _, value = arg.partition("=")
                page.fill(sel, value)
            elif name in JS:
                out = page.evaluate(JS[name], arg) if arg or name not in ("text", "errors") else page.evaluate(JS[name])
                print(f"{name}:{arg} ->", out)
                time.sleep(0.5)
            else:
                print("unknown step", step)
        browser.close()

if __name__ == "__main__":
    argv = sys.argv[1:]
    if argv[:1] == ["--out"]:
        OUT = pathlib.Path(argv[1]); OUT.mkdir(parents=True, exist_ok=True); argv = argv[2:]
    main(argv)
