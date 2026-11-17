// PDF.js runs in the preview Webview, not the extension host. Ship its legacy
// browser build (including worker/polyfills) independently of the host's Node.
const fs = require('node:fs');
const path = require('node:path');

const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
const destination = path.join(__dirname, '..', 'media', 'vendor', 'pdfjs');
fs.mkdirSync(destination, { recursive: true });
for (const name of ['pdf', 'pdf.worker', 'pdf.renderer']) {
    fs.copyFileSync(path.join(root, 'legacy', 'build', `${name}.min.mjs`), path.join(destination, `${name}.mjs`));
}
for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
    fs.cpSync(path.join(root, directory), path.join(destination, directory), { recursive: true });
}
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(destination, 'LICENSE'));
