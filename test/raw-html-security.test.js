const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { createWindow } = require('@mixmark-io/domino');

function createUri(uriPath) {
    return {
        scheme: 'file', authority: '', path: uriPath, fsPath: uriPath,
        toString: () => `file://${uriPath}`,
        with: changes => createUri(changes.path ?? uriPath),
    };
}

function loadModules() {
    const originalLoad = Module._load;
    const vscodeMock = {
        Uri: {
            file: createUri,
            joinPath: (base, ...segments) => createUri(path.posix.join(base.path, ...segments)),
        },
        workspace: {
            getWorkspaceFolder: () => null,
            getConfiguration: () => ({ get: (_key, fallback) => fallback }),
        },
    };
    Module._load = function (request, ...args) {
        return request === 'vscode' ? vscodeMock : originalLoad.call(this, request, ...args);
    };
    try {
        return {
            MarkdownDocument: require('../out/editor/MarkdownDocument').MarkdownDocument,
            MarkdownEditorProvider: require('../out/editor/MarkdownEditorProvider').MarkdownEditorProvider,
        };
    } finally {
        Module._load = originalLoad;
    }
}

const { MarkdownDocument, MarkdownEditorProvider } = loadModules();

function render(source) {
    const document = { getText: () => source, uri: createUri('/workspace/document.md') };
    const html = new MarkdownDocument(document).toHtml();
    const dom = createWindow(html).document;
    const blocks = Array.from(dom.querySelectorAll('[data-mdw-opaque-kind="raw-html-block"]'), node =>
        Buffer.from(node.getAttribute('data-mdw-opaque-source'), 'base64').toString('utf8'));
    assert.equal(new MarkdownEditorProvider({}).htmlToMarkdown(html, document), source.replace(/\r\n?/g, '\n'));
    // Raw HTML remains inert source, including when the input is malformed.
    assert.equal(dom.querySelectorAll('div, section, box, div\\:item, div-other').length, 0);
    return { html, blocks };
}

test('raw HTML pairing preserves nesting, case, and trailing blank lines', () => {
    for (const source of [
        '<DiV>\n<dIv>\ninner\n</DIV>\n\nafter\n</div>\n\n',
        '<div>\r\n\r\ninner\r\n</div>\r\n\r\n\r\n',
    ]) {
        assert.deepEqual(render(source).blocks, [source]);
    }
});

test('crossed tags and an unmatched parent retain their original raw block boundaries', () => {
    assert.deepEqual(render('<div>\n<section>\ninner\n</div>\n</section>\n').blocks, [
        '<div>\n<section>\ninner\n</div>\n', '</section>\n',
    ]);
    assert.deepEqual(render('<div>\n<div>\ninner\n</div>\n').blocks, [
        '<div>\n\n', '<div>\ninner\n</div>\n',
    ]);
});

test('hyphen and colon tag prefixes retain the existing word-boundary pairing', () => {
    for (const child of ['div-other', 'div:item']) {
        const source = `<div>\n<${child}>\ninner\n</div>\n</div>\n`;
        assert.deepEqual(render(source).blocks, [source]);
        assert.deepEqual(render(`<div>\n<${child}>\ninner\n</${child}>\n</div>\n`).blocks, [
            '<div>\n\n', `<${child}>\ninner\n</${child}>\n`, '</div>\n',
        ]);
    }
});

test('raw HTML includes fence-like contents while a fenced HTML example stays code', () => {
    const source = '<div>\n\n```html\n<div>\n```\n\n</div>\n</div>\n';
    assert.deepEqual(render(source).blocks, [source]);
    const example = render('```html\n<div>\ninner\n</div>\n```\n');
    assert.deepEqual(example.blocks, []);
    assert.match(example.html, /<code class="language-html">/);
});

test('large unmatched HTML inputs finish rendering in a bounded child process', () => {
    // An external process can be terminated even if a synchronous renderer blocks
    // its event loop. The old suffix scan grows quadratically with this input;
    // the generous deadline avoids asserting timing ratios on shared CI hosts.
    const worker = `
        const assert = require('node:assert/strict');
        const Module = require('node:module');
        const originalLoad = Module._load;
        Module._load = function (request, ...args) {
            return request === 'vscode' ? {} : originalLoad.call(this, request, ...args);
        };
        const { MarkdownDocument } = require('./out/editor/MarkdownDocument');
        const sources = [
            '<div>\\n'.repeat(32000),
            Array.from({ length: 8000 }, (_, i) => '<tag' + i + '>\\n').join(''),
            ('<a' + '-branch:leaf'.repeat(300) + '>\\n').repeat(50),
        ];
        for (const [index, source] of sources.entries()) {
            const html = new MarkdownDocument({
                getText: () => source, uri: { fsPath: '/workspace/document.md' },
            }).toHtml();
            if (index === 0) {
                assert.ok(html.includes('data-mdw-opaque-kind="raw-html-block"'));
            }
            assert.ok(html.length >= source.length);
            assert.doesNotMatch(html, /<(?:div|tag[0-9]+|a-branch)\\b/i);
        }
        process.stdout.write('rendered');
    `;
    const result = spawnSync(process.execPath, ['-e', worker], {
        cwd: path.join(__dirname, '..'), timeout: 10000, encoding: 'utf8', maxBuffer: 64 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'rendered');
});
