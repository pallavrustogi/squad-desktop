// build-copy.js — copies runtime dependencies into dist/ for standalone exe packaging
// CJS format (package.json is type:module but this runs via `node scripts/build-copy.js`)

const fs = require('fs');
const path = require('path');

const dist = path.resolve(__dirname, '..', 'dist');
const nm = path.resolve(__dirname, '..', 'node_modules');

function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

// --- PWA static files ---
copyDir(path.join(__dirname, '..', 'public'), path.join(dist, 'public'));

// --- @github/copilot CLI (needed as child process at runtime) ---
copyDir(path.join(nm, '@github', 'copilot'), path.join(dist, 'node_modules', '@github', 'copilot'));

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
