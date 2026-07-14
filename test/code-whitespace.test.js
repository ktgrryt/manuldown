const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

function loadExtensionModules() {
    const originalLoad = Module._load;
    const vscodeMock = {
        Uri: {
            file: (fsPath) => ({
                fsPath,
                path: fsPath,
                scheme: 'file',
                authority: '',
                toString: () => `file://${fsPath}`,
            }),
        },
        workspace: {
            getConfiguration: () => ({
                get: (_key, defaultValue) => defaultValue,
            }),
        },
    };

    Module._load = function (request, parent, isMain) {
        if (request === 'vscode') {
            return vscodeMock;
        }
        return originalLoad.call(this, request, parent, isMain);
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

const { MarkdownDocument, MarkdownEditorProvider } = loadExtensionModules();

function createTextDocument(text) {
    return {
        getText: () => text,
        uri: {
            fsPath: '/workspace/document.md',
            path: '/workspace/document.md',
        },
    };
}

test('Markdown to HTML preserves leading whitespace in fenced and inline code', () => {
    const source = [
        '```text',
        '  indented',
        'next',
        '```',
        '',
        '` foo`',
    ].join('\n');
    const html = new MarkdownDocument(createTextDocument(source)).toHtml();

    assert.match(html, /<code class="language-text">  indented\nnext\n<\/code>/);
    assert.match(html, /<code> foo<\/code>/);
});

test('HTML to Markdown preserves leading and whitespace-only code content', () => {
    const provider = new MarkdownEditorProvider({});
    const textDocument = createTextDocument('');

    const indented = provider.htmlToMarkdown(
        '<pre><code class="language-text">  indented\nnext\n</code></pre>',
        textDocument
    );
    const whitespaceOnly = provider.htmlToMarkdown(
        '<pre><code>  \n</code></pre>',
        textDocument
    );
    const inline = provider.htmlToMarkdown('<p><code> foo</code></p>', textDocument);

    assert.match(indented, /```text\n  indented\nnext\n```/);
    assert.match(whitespaceOnly, /```\n  \n```/);
    assert.match(inline, /` foo`/);
});

test('fenced code uses a longer fence when content contains backticks', () => {
    const provider = new MarkdownEditorProvider({});
    const markdown = provider.htmlToMarkdown(
        '<pre><code>```\n</code></pre>',
        createTextDocument('')
    );

    assert.match(markdown, /````\n```\n````/);
});

test('document HTML cannot spoof internal code-whitespace metadata', () => {
    const provider = new MarkdownEditorProvider({});
    const markdown = provider.htmlToMarkdown(
        '<p><code data-mdw-code-leading="2020">value</code></p>',
        createTextDocument('')
    );

    assert.match(markdown, /`value`/);
    assert.doesNotMatch(markdown, /` {2}value`/);
});

test('local images retain their original Markdown path in Webview HTML', () => {
    const webview = {
        asWebviewUri: (uri) => `webview-resource:${uri.fsPath}`,
    };
    const html = new MarkdownDocument(
        createTextDocument('![diagram](images/diagram.png)'),
        webview
    ).toHtml();

    assert.match(html, /src="webview-resource:\/workspace\/images\/diagram\.png"/);
    assert.match(html, /data-md-path="images\/diagram\.png"/);
});

test('raw Markdown HTML cannot spoof the internal image path marker', () => {
    const webview = {
        asWebviewUri: (uri) => `webview-resource:${uri.fsPath}`,
    };
    const html = new MarkdownDocument(
        createTextDocument('<img src="https://example.com/image.png" data-md-path="/private/secret.png">'),
        webview
    ).toHtml();

    assert.doesNotMatch(html, /data-md-path/);
    assert.match(html, /src="https:\/\/example\.com\/image\.png"/);
});
