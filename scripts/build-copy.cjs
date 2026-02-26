// build-copy.js — copies runtime dependencies into dist/ for standalone exe packaging
// CJS format (package.json is type:module but this runs via `node scripts/build-copy.js`)

const fs = require('fs');
const path = require('path');

const dist = path.resolve(__dirname, '..', 'dist');
const nm = path.resolve(__dirname, '..', 'node_modules');

function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// --- PWA static files ---
copyDir(path.join(__dirname, '..', 'public'), path.join(dist, 'public'));

// --- @github/copilot CLI (needed as child process at runtime) ---
copyDir(path.join(nm, '@github', 'copilot'), path.join(dist, 'node_modules', '@github', 'copilot'));

// --- webview-nodejs (externalized, full package) ---
copyDir(path.join(nm, 'webview-nodejs'), path.join(dist, 'node_modules', 'webview-nodejs'));

// --- libwebview-nodejs ---
const libDest = path.join(dist, 'node_modules', 'libwebview-nodejs');
copyFile(path.join(nm, 'libwebview-nodejs', 'index.js'), path.join(libDest, 'index.js'));
copyFile(path.join(nm, 'libwebview-nodejs', 'package.json'), path.join(libDest, 'package.json'));
// Native addon path varies by platform: cmake-js outputs to build/Release/ on macOS, build/ on Windows
const libwebviewCandidates = [
  path.join(nm, 'libwebview-nodejs', 'build', 'Release', 'libwebview.node'),
  path.join(nm, 'libwebview-nodejs', 'build', 'libwebview.node'),
];
const libwebviewSrc = libwebviewCandidates.find(p => fs.existsSync(p));
if (!libwebviewSrc) {
  console.error('build-copy: ERROR — libwebview.node not found in any candidate path');
  process.exit(1);
}
copyFile(libwebviewSrc, path.join(libDest, 'build', 'libwebview.node'));

// --- bindings + file-uri-to-path ---
copyDir(path.join(nm, 'bindings'), path.join(dist, 'node_modules', 'bindings'));
if (fs.existsSync(path.join(nm, 'file-uri-to-path'))) {
  copyDir(path.join(nm, 'file-uri-to-path'), path.join(dist, 'node_modules', 'file-uri-to-path'));
}

// --- Patch: skip getBundledCliPath() when cliUrl is provided ---
// esbuild replaces import.meta with `var import_meta = {}` in CJS format.
// The copilot-sdk calls getBundledCliPath() which uses import_meta.resolve()
// (undefined in CJS). Since we always use cliUrl mode, skip the call entirely.
const serverCjs = path.join(dist, 'server.cjs');
if (fs.existsSync(serverCjs)) {
  let code = fs.readFileSync(serverCjs, 'utf8');
  code = code.replace(
    'cliPath: options.cliPath || getBundledCliPath(),',
    'cliPath: options.cliPath || (options.cliUrl ? "" : getBundledCliPath()),'
  );
  fs.writeFileSync(serverCjs, code);
  console.log('build-copy: patched getBundledCliPath bypass in server.cjs');
}

console.log('build-copy: dist/ populated with runtime dependencies');
