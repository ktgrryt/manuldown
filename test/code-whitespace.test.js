const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const path = require('node:path');
const { marked } = require('marked');

const vscodeMockState = {
    errors: [],
    information: [],
    writes: [],
    reads: [],
    stats: new Map(),
    fileData: new Map(),
    documentChangeListeners: [],
    configurationChangeListeners: [],
};

function resetVscodeMockState() {
    vscodeMockState.errors.length = 0;
    vscodeMockState.information.length = 0;
    vscodeMockState.writes.length = 0;
    vscodeMockState.reads.length = 0;
    vscodeMockState.stats.clear();
    vscodeMockState.fileData.clear();
    vscodeMockState.documentChangeListeners.length = 0;
    vscodeMockState.configurationChangeListeners.length = 0;
}

function addMockListener(listeners, listener) {
    listeners.push(listener);
    return {
        dispose: () => {
            const index = listeners.indexOf(listener);
            if (index >= 0) {
                listeners.splice(index, 1);
            }
        },
    };
}

function createMockUri(uriPath, scheme = 'file', authority = '') {
    const fsPath = scheme === 'file' ? uriPath : '';
    return {
        fsPath,
        path: uriPath,
        scheme,
        authority,
        toString: () => scheme === 'file'
            ? `file://${uriPath}`
            : `${scheme}://${authority}${uriPath}`,
        with: (changes) => createMockUri(
            changes.path ?? uriPath,
            changes.scheme ?? scheme,
            changes.authority ?? authority
        ),
    };
}

function loadExtensionModules() {
    const originalLoad = Module._load;
    const vscodeMock = {
        Uri: {
            file: (fsPath) => createMockUri(fsPath),
            parse: (value) => {
                const parsed = new URL(value);
                return createMockUri(parsed.pathname, parsed.protocol.slice(0, -1), parsed.host);
            },
            joinPath: (base, ...segments) => createMockUri(
                path.posix.join(base.path, ...segments),
                base.scheme,
                base.authority
            ),
        },
        workspace: {
            getConfiguration: () => ({
                get: (_key, defaultValue) => defaultValue,
            }),
            onDidChangeTextDocument: (listener) => addMockListener(
                vscodeMockState.documentChangeListeners,
                listener
            ),
            onDidChangeConfiguration: (listener) => addMockListener(
                vscodeMockState.configurationChangeListeners,
                listener
            ),
            fs: {
                stat: async (uri) => {
                    const stat = vscodeMockState.stats.get(uri.path);
                    if (!stat) {
                        throw new Error('File not found');
                    }
                    return stat;
                },
                createDirectory: async (uri) => {
                    vscodeMockState.stats.set(uri.path, { size: 0, type: 2 });
                },
                writeFile: async (uri, bytes) => {
                    const copy = Uint8Array.from(bytes);
                    vscodeMockState.writes.push({ uri, bytes: copy });
                    vscodeMockState.stats.set(uri.path, { size: copy.byteLength, type: 1 });
                    vscodeMockState.fileData.set(uri.path, copy);
                },
                readFile: async (uri) => {
                    vscodeMockState.reads.push(uri);
                    const bytes = vscodeMockState.fileData.get(uri.path);
                    if (!bytes) {
                        throw new Error('File not found');
                    }
                    return bytes;
                },
            },
        },
        window: {
            showErrorMessage: async (message) => {
                vscodeMockState.errors.push(message);
            },
            showInformationMessage: async (message) => {
                vscodeMockState.information.push(message);
            },
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
        uri: createMockUri('/workspace/document.md'),
    };
}

function fireDocumentChange(document) {
    for (const listener of [...vscodeMockState.documentChangeListeners]) {
        listener({ document });
    }
}

function createMutableTextDocument(initialText) {
    let text = initialText;
    const savedTexts = [];
    const document = {
        getText: () => text,
        setText: (nextText) => {
            text = nextText;
        },
        save: async () => {
            savedTexts.push(text);
            fireDocumentChange(document);
            return true;
        },
        uri: createMockUri('/workspace/sync-test.md'),
        savedTexts,
    };
    return document;
}

function createWebviewPanelHarness() {
    const postedMessages = [];
    let messageListener = null;
    let disposeListener = null;
    const webview = {
        options: {},
        html: '',
        onDidReceiveMessage: (listener) => {
            messageListener = listener;
            return { dispose: () => {} };
        },
        postMessage: async (message) => {
            postedMessages.push(message);
            return true;
        },
    };
    const panel = {
        webview,
        active: true,
        visible: true,
        viewColumn: 1,
        onDidChangeViewState: () => ({ dispose: () => {} }),
        onDidDispose: (listener) => {
            disposeListener = listener;
            return { dispose: () => {} };
        },
    };

    return {
        panel,
        postedMessages,
        sendMessage: async (message) => {
            assert.ok(messageListener, 'Webview message listener was not registered');
            await messageListener(message);
        },
        dispose: () => {
            if (disposeListener) {
                disposeListener();
            }
        },
    };
}

async function createEditorSyncHarness(initialText = 'before') {
    resetVscodeMockState();
    const provider = new MarkdownEditorProvider({});
    const document = createMutableTextDocument(initialText);
    const webview = createWebviewPanelHarness();

    provider.explicitlyRequested = true;
    provider.getWebviewLocalResourceRoots = () => [];
    provider.getHtmlForWebview = () => '<html></html>';
    provider.keepEditorTabOpenOnExplorerClick = () => {};
    provider.htmlToMarkdown = (html) => String(html);

    await provider.resolveCustomTextEditor(document, webview.panel, {});
    return { provider, document, webview };
}

async function waitFor(condition, message) {
    for (let attempt = 0; attempt < 50; attempt++) {
        if (condition()) {
            return;
        }
        await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail(message);
}

test('a ManulDown edit is not reported back as an external document change', async () => {
    const { provider, document, webview } = await createEditorSyncHarness();
    provider.updateTextDocument = async (_document, markdown) => {
        document.setText(markdown);
        return true;
    };

    try {
        await webview.sendMessage({ type: 'update', content: 'after', revision: 1 });
        await waitFor(
            () => webview.postedMessages.some((message) => message.type === 'updateApplied'),
            'The Webview update was not applied'
        );

        // VS Code may deliver this event after applyEdit has already resolved.
        fireDocumentChange(document);
        assert.equal(document.getText(), 'after');
        assert.deepEqual(
            webview.postedMessages.filter((message) => message.external === true),
            []
        );
        assert.deepEqual(
            webview.postedMessages.filter((message) => message.type === 'updateApplied'),
            [{ type: 'updateApplied', revision: 1 }]
        );
    } finally {
        webview.dispose();
    }
});

test('a racing external edit produces only one unresolved external update', async () => {
    const { provider, document, webview } = await createEditorSyncHarness();
    provider.updateTextDocument = async () => {
        document.setText('external');
        fireDocumentChange(document);
        return true;
    };

    try {
        await webview.sendMessage({ type: 'update', content: 'ManulDown edit', revision: 2 });
        await waitFor(
            () => webview.postedMessages.some((message) => message.external === true),
            'The external edit was not reported'
        );

        const externalUpdates = webview.postedMessages.filter(
            (message) => message.external === true
        );
        assert.equal(externalUpdates.length, 1);
        assert.equal(externalUpdates[0].type, 'update');
        assert.equal(externalUpdates[0].changeId, 1);
        assert.equal(
            webview.postedMessages.some((message) => message.type === 'updateApplied'),
            false
        );
    } finally {
        webview.dispose();
    }
});

test('saving from the Webview waits until its latest edit reaches the document', async () => {
    const { provider, document, webview } = await createEditorSyncHarness();
    let releaseUpdate;
    let markUpdateStarted;
    const updateStarted = new Promise((resolve) => {
        markUpdateStarted = resolve;
    });
    const updateMayFinish = new Promise((resolve) => {
        releaseUpdate = resolve;
    });
    provider.updateTextDocument = async (_document, markdown) => {
        markUpdateStarted();
        await updateMayFinish;
        document.setText(markdown);
        fireDocumentChange(document);
        return true;
    };

    try {
        const saveRequest = webview.sendMessage({
            type: 'saveDocument',
            content: 'latest edit',
            revision: 3,
        });
        await updateStarted;
        assert.deepEqual(document.savedTexts, []);

        releaseUpdate();
        await saveRequest;

        assert.equal(document.getText(), 'latest edit');
        assert.deepEqual(document.savedTexts, ['latest edit']);
        assert.deepEqual(
            webview.postedMessages.filter((message) => message.type === 'updateApplied'),
            [{ type: 'updateApplied', revision: 3 }]
        );
        assert.deepEqual(
            webview.postedMessages.filter((message) => message.external === true),
            []
        );
    } finally {
        webview.dispose();
    }
});

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

test('soft and hard line break syntax survives a Markdown HTML round trip', () => {
    const source = [
        'soft',
        'one-space ',
        'two-spaces  ',
        'backslash\\',
        'end',
        '',
    ].join('\n');
    const textDocument = createTextDocument(source);
    const html = new MarkdownDocument(textDocument).toHtml();
    const markdown = new MarkdownEditorProvider({}).htmlToMarkdown(html, textDocument);

    assert.match(html, /<br data-mdw-soft-break="true" data-mdw-break-prefix="">/);
    assert.match(html, /<br data-mdw-soft-break="true" data-mdw-break-prefix="20">/);
    assert.match(html, /<br data-mdw-break-prefix="2020">/);
    assert.match(html, /<br data-mdw-break-prefix="5c">/);
    assert.equal(markdown, source);
});

test('line break syntax after an image survives a Markdown HTML round trip', () => {
    for (const source of [
        '![diagram](images/diagram.png)\ncaption\n',
        '![diagram](images/diagram.png)  \ncaption\n',
        '![diagram](images/diagram.png)\\\ncaption\n',
    ]) {
        const textDocument = createTextDocument(source);
        const html = new MarkdownDocument(textDocument).toHtml();
        const markdown = new MarkdownEditorProvider({}).htmlToMarkdown(html, textDocument);
        assert.equal(markdown, source);
    }
});

test('Setext headings are recognized and retain their heading style', () => {
    const source = 'Primary\n===\n\nSecondary\n----\n';
    const textDocument = createTextDocument(source);
    const html = new MarkdownDocument(textDocument).toHtml();
    const markdown = new MarkdownEditorProvider({}).htmlToMarkdown(html, textDocument);

    assert.match(html, /<h1 data-mdw-heading-style="setext" data-mdw-heading-marker-length="3">Primary<\/h1>/);
    assert.match(html, /<h2 data-mdw-heading-style="setext" data-mdw-heading-marker-length="4">Secondary<\/h2>/);
    assert.equal(markdown, source);
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

test('post-processing preserves blank lines inside a longer fenced code block', () => {
    const provider = new MarkdownEditorProvider({});
    const markdown = provider.htmlToMarkdown(
        '<pre><code>```\n*   first\n\n* second\n[ ] literal task\nEMPTYLISTITEM\nMDWIMAGEHARDBREAKENDMARKER\n</code></pre>',
        createTextDocument('')
    );

    assert.match(
        markdown,
        /````\n```\n\* {3}first\n\n\* second\n\[ \] literal task\nEMPTYLISTITEM\nMDWIMAGEHARDBREAKENDMARKER\n````/
    );
});

test('legacy placeholder-like document text is never consumed by conversion', () => {
    const provider = new MarkdownEditorProvider({});
    const markdown = provider.htmlToMarkdown(
        [
            '<p>EMPTYLINE</p>',
            '<p>EMPTYLISTITEM</p>',
            '<p>MDWIMAGEHARDBREAKENDMARKER</p>',
            '<pre><code>EMPTYCODE_js_EMPTYCODE\n</code></pre>',
        ].join(''),
        createTextDocument('')
    );

    assert.match(markdown, /^EMPTYLINE$/m);
    assert.match(markdown, /^EMPTYLISTITEM$/m);
    assert.match(markdown, /^MDWIMAGEHARDBREAKENDMARKER$/m);
    assert.match(markdown, /```\nEMPTYCODE_js_EMPTYCODE\n```/);
});

test('conversion-specific placeholders preserve actual empty structures without leaking', () => {
    const provider = new MarkdownEditorProvider({});
    const markdown = provider.htmlToMarkdown(
        '<p>before</p><p><br></p><p>after</p>' +
        '<ul><li>&nbsp;<ul><li>child</li></ul></li></ul>' +
        '<pre><code></code></pre>',
        createTextDocument('')
    );

    assert.match(markdown, /before\n\n\nafter/);
    assert.match(markdown, /[*+-] &nbsp;\n\s+[*+-] child/);
    assert.match(markdown, /```\n\n```/);
    assert.doesNotMatch(markdown, /MDW(?:CONVERSION|FENCEDCODE|PROTECTEDFENCE)[A-Za-z0-9]{32}/);
});

test('literal legacy blockquote marker text remains visible', () => {
    const source = [
        '> before',
        '>',
        '> MDW-BLOCKQUOTE-EMPTYLINE-MARKER',
        '>',
        '> after',
        '',
    ].join('\n');
    const html = new MarkdownDocument(createTextDocument(source)).toHtml();

    assert.match(html, /<p>MDW-BLOCKQUOTE-EMPTYLINE-MARKER<\/p>/);
});

test('HTML to Markdown conversion errors are propagated without a lossy fallback', () => {
    const provider = new MarkdownEditorProvider({});
    const originalTurndown = provider.turndownService.turndown;
    const originalConsoleError = console.error;
    provider.turndownService.turndown = () => {
        throw new Error('synthetic conversion failure');
    };
    console.error = () => {};

    try {
        assert.throws(
            () => provider.htmlToMarkdown('<h1>Keep me</h1>', createTextDocument('# Keep me\n')),
            /synthetic conversion failure/
        );
    } finally {
        provider.turndownService.turndown = originalTurndown;
        console.error = originalConsoleError;
    }
});

test('Markdown rendering errors are propagated instead of returning editable error content', () => {
    const originalParse = marked.parse;
    const originalConsoleError = console.error;
    marked.parse = () => {
        throw new Error('synthetic render failure');
    };
    console.error = () => {};

    try {
        assert.throws(
            () => new MarkdownDocument(createTextDocument('# Keep me\n')).toHtml(),
            /synthetic render failure/
        );
    } finally {
        marked.parse = originalParse;
        console.error = originalConsoleError;
    }
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

test('oversized data URL images are rejected before any file is created', async () => {
    const provider = new MarkdownEditorProvider({});
    const originalLimit = MarkdownEditorProvider.maxImportedImageBytes;
    const originalConsoleError = console.error;
    const webviewMessages = [];
    const webview = {
        postMessage: async (message) => webviewMessages.push(message),
        asWebviewUri: (uri) => ({ toString: () => `webview-resource:${uri.path}` }),
    };
    resetVscodeMockState();
    MarkdownEditorProvider.maxImportedImageBytes = 4;
    console.error = () => {};

    try {
        const saved = await provider.saveImageFromDataUrl(
            `data:image/png;base64,${Buffer.alloc(5).toString('base64')}`,
            'image/png',
            createTextDocument(''),
            webview
        );

        assert.equal(saved, false);
        assert.equal(vscodeMockState.writes.length, 0);
        assert.equal(webviewMessages.length, 0);
        assert.match(vscodeMockState.errors.at(-1), /Image is too large/);
    } finally {
        MarkdownEditorProvider.maxImportedImageBytes = originalLimit;
        console.error = originalConsoleError;
    }
});

test('a valid data URL image is saved and inserted normally', async () => {
    const provider = new MarkdownEditorProvider({});
    const webviewMessages = [];
    const webview = {
        postMessage: async (message) => {
            webviewMessages.push(message);
            return true;
        },
        asWebviewUri: (uri) => ({ toString: () => `webview-resource:${uri.path}` }),
    };
    resetVscodeMockState();

    const saved = await provider.saveImageFromDataUrl(
        `data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`,
        'image/png',
        createTextDocument(''),
        webview,
        { altText: 'diagram' }
    );

    assert.equal(saved, true);
    assert.equal(vscodeMockState.errors.length, 0);
    assert.equal(vscodeMockState.writes.length, 1);
    assert.deepEqual(Array.from(vscodeMockState.writes[0].bytes), [1, 2, 3]);
    assert.equal(webviewMessages[0].type, 'insertImage');
    assert.match(webviewMessages[0].markdown, /^!\[diagram\]\(images\/document\/document\.png\)$/);
    assert.equal(webviewMessages[1].type, 'requestSync');
});

test('oversized local images are rejected before their contents are read', async () => {
    const provider = new MarkdownEditorProvider({});
    const originalLimit = MarkdownEditorProvider.maxImportedImageBytes;
    const originalConsoleError = console.error;
    const sourcePath = '/outside/large.png';
    resetVscodeMockState();
    vscodeMockState.stats.set(sourcePath, { size: 5, type: 1 });
    MarkdownEditorProvider.maxImportedImageBytes = 4;
    console.error = () => {};

    try {
        await provider.saveImageFromUri(
            sourcePath,
            createTextDocument(''),
            { postMessage: async () => {}, asWebviewUri: (uri) => uri },
            { source: 'drop' }
        );

        assert.equal(vscodeMockState.reads.length, 0);
        assert.equal(vscodeMockState.writes.length, 0);
        assert.match(vscodeMockState.errors.at(-1), /Image is too large/);
    } finally {
        MarkdownEditorProvider.maxImportedImageBytes = originalLimit;
        console.error = originalConsoleError;
    }
});

test('remote image downloads enforce declared, streamed, and time limits', async () => {
    const provider = new MarkdownEditorProvider({});
    const originalFetch = globalThis.fetch;
    const originalLimit = MarkdownEditorProvider.maxImportedImageBytes;
    const originalTimeout = MarkdownEditorProvider.remoteImageTimeoutMs;
    const sourceUri = { toString: () => 'https://example.com/image.png' };
    const createHeaders = (values) => ({
        get: (name) => values[String(name).toLowerCase()] ?? null,
    });
    MarkdownEditorProvider.maxImportedImageBytes = 4;

    try {
        let arrayBufferCalled = false;
        globalThis.fetch = async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: createHeaders({
                'content-type': 'image/png',
                'content-length': '5',
            }),
            arrayBuffer: async () => {
                arrayBufferCalled = true;
                return new ArrayBuffer(0);
            },
        });
        await assert.rejects(provider.fetchRemoteImage(sourceUri), /Image is too large/);
        assert.equal(arrayBufferCalled, false);

        let readIndex = 0;
        let readerCancelled = false;
        globalThis.fetch = async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: createHeaders({ 'content-type': 'image/png' }),
            body: {
                getReader: () => ({
                    read: async () => {
                        const chunks = [new Uint8Array(3), new Uint8Array(2)];
                        return readIndex < chunks.length
                            ? { done: false, value: chunks[readIndex++] }
                            : { done: true };
                    },
                    cancel: async () => {
                        readerCancelled = true;
                    },
                }),
            },
            arrayBuffer: async () => new ArrayBuffer(0),
        });
        await assert.rejects(provider.fetchRemoteImage(sourceUri), /Image is too large/);
        assert.equal(readerCancelled, true);

        readIndex = 0;
        globalThis.fetch = async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: createHeaders({ 'content-type': 'image/png' }),
            body: {
                getReader: () => ({
                    read: async () => {
                        const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
                        return readIndex < chunks.length
                            ? { done: false, value: chunks[readIndex++] }
                            : { done: true };
                    },
                    cancel: async () => {},
                }),
            },
        });
        const downloaded = await provider.fetchRemoteImage(sourceUri);
        assert.deepEqual(Array.from(downloaded.bytes), [1, 2, 3, 4]);
        assert.equal(downloaded.mimeType, 'image/png');

        MarkdownEditorProvider.remoteImageTimeoutMs = 10;
        globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
            }, { once: true });
        });
        await assert.rejects(provider.fetchRemoteImage(sourceUri), /timed out/);
    } finally {
        globalThis.fetch = originalFetch;
        MarkdownEditorProvider.maxImportedImageBytes = originalLimit;
        MarkdownEditorProvider.remoteImageTimeoutMs = originalTimeout;
    }
});
