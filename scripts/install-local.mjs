// Build Hivemind from main and install it on this machine, with a desktop shortcut.
// Run it again to update. Windows and macOS only. App data is never touched.
//
//   node scripts/install-local.mjs

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundleDir = join(root, "src-tauri", "target", "release", "bundle");

function fail(message) {
  console.error(`install-local: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(" ")} exited with ${result.status}`);
}

function output(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  return { status: result.status, text: (result.stdout || "").trim() };
}

// npm is npm.cmd on Windows, which needs a shell. The commands are fixed strings.
function npm(args) {
  const result = spawnSync(`npm ${args}`, { cwd: root, stdio: "inherit", shell: true });
  if (result.status !== 0) fail(`npm ${args} exited with ${result.status}`);
}

const platforms = {
  win32: {
    bundle: "nsis",
    isRunning() {
      const { text } = output("tasklist", ["/FI", "IMAGENAME eq agentic-hivemind.exe", "/NH"]);
      return text.toLowerCase().includes("agentic-hivemind.exe");
    },
    install(version) {
      const setup = join(bundleDir, "nsis", `Hivemind_${version}_x64-setup.exe`);
      if (!existsSync(setup)) fail(`the build did not produce ${setup}`);
      run(setup, ["/S"]);
      const exe = join(process.env.LOCALAPPDATA, "Hivemind", "agentic-hivemind.exe");
      if (!existsSync(exe)) fail(`the installer finished but ${exe} is missing`);
      return exe;
    },
    shortcut(exe) {
      // Paths go in through the environment so nothing needs quoting.
      const script = [
        "$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Hivemind.lnk'",
        "if (Test-Path $lnk) { \"Desktop shortcut already there: $lnk\" } else {",
        "  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)",
        "  $s.TargetPath = $env:HM_EXE",
        "  $s.WorkingDirectory = Split-Path $env:HM_EXE",
        "  $s.IconLocation = \"$env:HM_EXE,0\"",
        "  $s.Save()",
        "  \"Created desktop shortcut: $lnk\" }",
      ].join("\n");
      run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
        env: { ...process.env, HM_EXE: exe },
      });
    },
  },
  darwin: {
    bundle: "app",
    isRunning() {
      return output("pgrep", ["-f", "Hivemind.app/Contents/MacOS"]).status === 0;
    },
    install() {
      const built = join(bundleDir, "macos", "Hivemind.app");
      if (!existsSync(built)) fail(`the build did not produce ${built}`);
      try {
        accessSync("/Applications", constants.W_OK);
      } catch {
        fail("/Applications is not writable by this user");
      }
      const app = "/Applications/Hivemind.app";
      rmSync(app, { recursive: true, force: true });
      run("ditto", [built, app]);
      return app;
    },
    shortcut(app) {
      const link = join(homedir(), "Desktop", "Hivemind");
      let exists = true;
      try {
        lstatSync(link);
      } catch {
        exists = false;
      }
      if (exists) {
        console.log(`Desktop shortcut already there: ${link}`);
      } else {
        symlinkSync(app, link);
        console.log(`Created desktop shortcut: ${link}`);
      }
    },
  },
};

const platform = platforms[process.platform];
if (!platform) fail(`${process.platform} is not supported yet (Windows and macOS only)`);

if (output("git", ["status", "--porcelain"]).text) {
  fail("the working tree has uncommitted changes; commit or stash them first");
}
const branch = output("git", ["rev-parse", "--abbrev-ref", "HEAD"]).text;
if (branch !== "main") fail(`on branch ${branch}; switch to main first`);

run("git", ["pull", "--ff-only"]);
npm("ci");
npm(`run tauri build -- --bundles ${platform.bundle}`);

if (platform.isRunning()) fail("Hivemind is running; close it and run this script again");

const { version } = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const installed = platform.install(version);
platform.shortcut(installed);

const commit = output("git", ["rev-parse", "--short", "HEAD"]).text;
console.log(`Installed Hivemind ${version} (commit ${commit}) at ${installed}`);
