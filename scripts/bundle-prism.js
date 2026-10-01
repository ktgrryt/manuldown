// Builds the Prism files the Webview loads, so the VSIX does not have to ship
// node_modules/prismjs (3.7 MB) for about 150 KB of scripts.
//
// The output is a plain concatenation of Prism's own minified files, in the
// order the Webview used to load them as separate <script> tags.
const fs = require('node:fs');
const path = require('node:path');

const prismRoot = path.dirname(require.resolve('prismjs/package.json'));
const vendorDirectory = path.join(__dirname, '..', 'media', 'vendor');

// prism.js is prism-core plus these default grammars and the file-highlight
// plugin. That plugin fetches files, which the Webview CSP (connect-src 'none')
// refuses anyway, so it is left out.
const defaultLanguages = ['markup', 'css', 'clike', 'javascript'];

// The grammars exposed in the code-block language picker. Keep dependency
// order: shared helpers first, then languages that extend them.
const pickerLanguages = [
    'markup-templating',
    'c',
    'cpp',
    'csharp',
    'python',
    'typescript',
    'java',
    'php',
    'ruby',
    'go',
    'rust',
    'swift',
    'kotlin',
    'scala',
    'scss',
    'sass',
    'less',
    'json',
    'yaml',
    'toml',
    'markdown',
    'latex',
    'sql',
    'graphql',
    'bash',
    'powershell',
    'docker',
    'makefile',
    'r',
    'matlab',
    'julia',
    'perl',
    'lua',
    'haskell',
    'elixir',
    'erlang',
    'clojure',
    'scheme',
    'lisp',
    'dart',
    'objectivec',
];

function readPrismFile(...segments) {
    return fs.readFileSync(path.join(prismRoot, ...segments), 'utf8').trim();
}

function licenseComment() {
    const { version } = JSON.parse(readPrismFile('package.json'));
    const license = readPrismFile('LICENSE').replace(/\*\//g, '* /');
    return `/*! Prism ${version} | https://prismjs.com\n${license}\n*/\n`;
}

const scriptFiles = [
    ['components', 'prism-core.min.js'],
    ...[...defaultLanguages, ...pickerLanguages].map((language) =>
        ['components', `prism-${language}.min.js`]
    ),
];
// Each file was a separate classic script; the leading semicolon keeps one
// file's last expression from running into the next.
const script = scriptFiles.map((segments) => `;${readPrismFile(...segments)}`).join('\n');

fs.mkdirSync(vendorDirectory, { recursive: true });
fs.writeFileSync(
    path.join(vendorDirectory, 'prism.bundle.js'),
    `${licenseComment()}${script}\n`
);
fs.writeFileSync(
    path.join(vendorDirectory, 'prism-tomorrow.css'),
    `${licenseComment()}${readPrismFile('themes', 'prism-tomorrow.css')}\n`
);
