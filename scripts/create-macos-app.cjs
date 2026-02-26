// create-macos-app.cjs — Creates a minimal macOS .app bundle from the pkg binary
// so Squad Desktop can be launched from Finder without opening Terminal.

const fs = require('fs');
const path = require('path');

if (process.platform !== 'darwin') {
  console.log('create-macos-app: skipping on non-macOS platform');
  process.exit(0);
}

const dist = path.resolve(__dirname, '..', 'dist');
const appName = 'Squad Desktop';
const appBundle = path.join(dist, `${appName}.app`);
const contentsDir = path.join(appBundle, 'Contents');
const macosDir = path.join(contentsDir, 'MacOS');
const resourcesDir = path.join(contentsDir, 'Resources');

// Clean previous bundle
if (fs.existsSync(appBundle)) {
  fs.rmSync(appBundle, { recursive: true });
}

// Create directory structure
fs.mkdirSync(macosDir, { recursive: true });
fs.mkdirSync(resourcesDir, { recursive: true });

// Info.plist
const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>${appName}</string>
    <key>CFBundleDisplayName</key>
    <string>${appName}</string>
    <key>CFBundleIdentifier</key>
    <string>com.squad-desktop.app</string>
    <key>CFBundleVersion</key>
    <string>1.0.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>CFBundleExecutable</key>
    <string>squad-desktop-launcher</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSMinimumSystemVersion</key>
    <string>11.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>LSUIElement</key>
    <false/>
</dict>
</plist>`;

fs.writeFileSync(path.join(contentsDir, 'Info.plist'), infoPlist);

// Launcher shell script — sources user's shell environment (so `which node` finds
// Homebrew/nvm/fnm Node.js) then runs the pkg binary from inside the .app bundle.
const launcher = `#!/bin/bash
# Source user's shell profile so PATH includes Homebrew, nvm, fnm, etc.
# macOS .app bundles launch with a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin)
if [ -f "$HOME/.zprofile" ]; then source "$HOME/.zprofile" 2>/dev/null; fi
if [ -f "$HOME/.zshrc" ]; then source "$HOME/.zshrc" 2>/dev/null; fi
if [ -f "$HOME/.bash_profile" ]; then source "$HOME/.bash_profile" 2>/dev/null; fi
# Common Homebrew paths as fallback
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/squad-desktop"
`;

const launcherPath = path.join(macosDir, 'squad-desktop-launcher');
fs.writeFileSync(launcherPath, launcher);
fs.chmodSync(launcherPath, 0o755);

// Copy the pkg binary into the .app bundle
const binarySrc = path.join(dist, 'squad-desktop');
if (!fs.existsSync(binarySrc)) {
  console.error('create-macos-app: ERROR — dist/squad-desktop binary not found. Run build:exe:macos first.');
  process.exit(1);
}
fs.copyFileSync(binarySrc, path.join(macosDir, 'squad-desktop'));
fs.chmodSync(path.join(macosDir, 'squad-desktop'), 0o755);

// Copy public/ into MacOS/ (next to the binary, where appDir resolves)
fs.cpSync(path.join(dist, 'public'), path.join(macosDir, 'public'), { recursive: true });

// Copy node_modules/ runtime deps (webview, copilot CLI) into MacOS/
const nmSrc = path.join(dist, 'node_modules');
if (fs.existsSync(nmSrc)) {
  fs.cpSync(nmSrc, path.join(macosDir, 'node_modules'), { recursive: true });
}

console.log(`create-macos-app: created ${appBundle}`);
console.log('create-macos-app: you can now open "dist/Squad Desktop.app" or drag it to /Applications');
