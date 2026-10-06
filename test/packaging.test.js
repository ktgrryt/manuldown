const assert = require('node:assert/strict');
const fs = require('node:fs');
const { builtinModules } = require('node:module');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.join(__dirname, '..');

function readRepositoryFile(...segments) {
    return fs.readFileSync(path.join(repositoryRoot, ...segments), 'utf8');
}

const providerSource = readRepositoryFile('src', 'editor', 'MarkdownEditorProvider.ts');
const codeBlockManagerSource = readRepositoryFile('media', 'modules', 'CodeBlockManager.js');
const codeBlockManagerModulePromise = import(
    `data:text/javascript;base64,${Buffer.from(codeBlockManagerSource).toString('base64')}`
);

test('the bundled extension host needs nothing from node_modules', () => {
    const bundle = readRepositoryFile('out', 'extension.js');
    const requiredModules = new Set(
        [...bundle.matchAll(/\brequire\("([^"]+)"\)/g)].map((match) => match[1])
    );

    assert.ok(requiredModules.has('vscode'));
    for (const name of requiredModules) {
        assert.ok(
            name === 'vscode' || builtinModules.includes(name.replace(/^node:/, '')),
            `${name} must be bundled into out/extension.js (run npm run compile)`
        );
    }
    for (const packageName of ['@mixmark-io/domino', 'marked', 'turndown', 'turndown-plugin-gfm']) {
        assert.ok(bundle.includes(`\n${packageName} `), `${packageName} license notice is kept`);
    }
});

test('the VSIX ships the bundles instead of node_modules', () => {
    const ignorePatterns = readRepositoryFile('.vscodeignore')
        .split(/\r?\n/)
        .map((line) => line.trim());
    for (const pattern of ['node_modules/**', 'out/**', '!out/extension.js']) {
        assert.ok(ignorePatterns.includes(pattern), pattern);
    }

    assert.doesNotMatch(providerSource, /'node_modules'/);
    for (const asset of ['prism.bundle.js', 'prism-tomorrow.css', 'mermaid.bundle.js']) {
        assert.ok(fs.existsSync(path.join(repositoryRoot, 'media', 'vendor', asset)), asset);
    }
    assert.match(readRepositoryFile('media', 'vendor', 'prism.bundle.js'), /^\/\*! Prism /);
});

test('the Webview page does not load Mermaid up front', () => {
    assert.doesNotMatch(providerSource, /<script[^>]*src="\$\{mermaidUri\}"/);
    assert.match(providerSource, /data-mermaid-script-src="\$\{mermaidUri\}"/);
});

test('KaTeX ships as WOFF2 fonts and loads only for documents with formulas', () => {
    assert.doesNotMatch(providerSource, /<script[^>]*src="\$\{katexScriptUri\}"/);
    assert.doesNotMatch(providerSource, /<link[^>]*href="\$\{katexStyleUri\}"/);
    assert.match(providerSource, /data-katex-script-src="\$\{katexScriptUri\}"/);
    assert.match(providerSource, /data-katex-style-href="\$\{katexStyleUri\}"/);
    const katexDirectory = path.join(repositoryRoot, 'media', 'vendor', 'katex');
    assert.match(readRepositoryFile('media', 'vendor', 'katex', 'katex.min.js'), /^\/\*! KaTeX /);
    const stylesheet = readRepositoryFile('media', 'vendor', 'katex', 'katex.min.css');
    const fonts = [...stylesheet.matchAll(/url\((fonts\/[^)]+)\)/g)].map((match) => match[1]);
    assert.ok(fonts.length > 0);
    for (const font of fonts) {
        assert.match(font, /\.woff2$/);
        assert.ok(fs.existsSync(path.join(katexDirectory, font)), font);
    }
});

function withFakeDocument(callback) {
    const appendedScripts = [];
    global.window = {};
    global.document = {
        body: { dataset: { mermaidScriptSrc: 'https://example.vscode-cdn.net/media/vendor/mermaid.bundle.js' } },
        head: { appendChild: (script) => appendedScripts.push(script) },
        querySelector: (selector) => selector === 'body > script[nonce]' ? { nonce: 'page-nonce' } : null,
        createElement: (tagName) => {
            const listeners = {};
            return {
                tagName,
                listeners,
                addEventListener: (type, listener) => {
                    listeners[type] = listener;
                },
            };
        },
    };
    return Promise.resolve()
        .then(() => callback(appendedScripts))
        .finally(() => {
            delete global.window;
            delete global.document;
        });
}

async function createManager() {
    const { CodeBlockManager } = await codeBlockManagerModulePromise;
    const manager = Object.create(CodeBlockManager.prototype);
    manager.mermaidLoadState = 'idle';
    manager.rerenderCount = 0;
    manager._rerenderMermaidBlocks = () => {
        manager.rerenderCount++;
    };
    return manager;
}

test('Mermaid is requested once with the page nonce and rerenders on load', async () => {
    const manager = await createManager();
    await withFakeDocument((appendedScripts) => {
        assert.equal(manager._requestMermaidLibrary(), true);
        assert.equal(manager._requestMermaidLibrary(), true);
        assert.equal(appendedScripts.length, 1);
        assert.equal(appendedScripts[0].nonce, 'page-nonce');
        assert.equal(appendedScripts[0].src, 'https://example.vscode-cdn.net/media/vendor/mermaid.bundle.js');

        window.mermaid = {};
        appendedScripts[0].listeners.load();
        assert.equal(manager.mermaidLoadState, 'loaded');
        assert.equal(manager.rerenderCount, 1);
    });
});

test('a Mermaid load failure is reported instead of retried', async () => {
    const manager = await createManager();
    await withFakeDocument((appendedScripts) => {
        assert.equal(manager._requestMermaidLibrary(), true);
        appendedScripts[0].listeners.error();
        assert.equal(manager.mermaidLoadState, 'failed');
        assert.equal(manager.rerenderCount, 1);

        assert.equal(manager._requestMermaidLibrary(), false);
        assert.equal(appendedScripts.length, 1);
    });
});
