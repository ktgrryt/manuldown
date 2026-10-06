// Copies the KaTeX files the Webview loads into media/vendor/katex, so the
// VSIX does not have to ship node_modules/katex (about 10 MB with every build
// and font format) for about 600 KB of script, styles and fonts.
//
// The Webview runs in Chromium, which always picks WOFF2. Only those fonts are
// copied, and the stylesheet stops referring to the WOFF/TTF fallbacks.
const fs = require('node:fs');
const path = require('node:path');

const katexRoot = path.dirname(require.resolve('katex/package.json'));
const outputDirectory = path.join(__dirname, '..', 'media', 'vendor', 'katex');
const fontDirectory = path.join(outputDirectory, 'fonts');

function readKatexFile(...segments) {
    return fs.readFileSync(path.join(katexRoot, ...segments), 'utf8').trim();
}

function licenseComment() {
    const { version } = JSON.parse(readKatexFile('package.json'));
    const license = readKatexFile('LICENSE').replace(/\*\//g, '* /');
    return `/*! KaTeX ${version} | https://katex.org\n${license}\n*/\n`;
}

const stylesheet = readKatexFile('dist', 'katex.min.css').replace(
    /src:(url\(fonts\/[^)]+\.woff2\) format\("woff2"\))(?:,url\([^)]+\) format\("[^"]+"\))*/g,
    'src:$1'
);
if (/\.woff\)|\.ttf\)/.test(stylesheet)) {
    throw new Error('katex.min.css still refers to WOFF or TTF fonts; update scripts/bundle-katex.js');
}

fs.rmSync(outputDirectory, { recursive: true, force: true });
fs.mkdirSync(fontDirectory, { recursive: true });
fs.writeFileSync(
    path.join(outputDirectory, 'katex.min.js'),
    `${licenseComment()}${readKatexFile('dist', 'katex.min.js')}\n`
);
fs.writeFileSync(path.join(outputDirectory, 'katex.min.css'), `${licenseComment()}${stylesheet}\n`);
for (const fileName of fs.readdirSync(path.join(katexRoot, 'dist', 'fonts'))) {
    if (fileName.endsWith('.woff2')) {
        fs.copyFileSync(path.join(katexRoot, 'dist', 'fonts', fileName), path.join(fontDirectory, fileName));
    }
}
