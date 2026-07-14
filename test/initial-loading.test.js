const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const providerSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'editor', 'MarkdownEditorProvider.ts'),
    'utf8'
);
const editorSource = fs.readFileSync(
    path.join(__dirname, '..', 'media', 'editor.js'),
    'utf8'
);

test('critical loading styles hide editor UI before the external stylesheet loads', () => {
    const criticalStyleStart = providerSource.indexOf('<style nonce="${nonce}">');
    const externalStyleStart = providerSource.indexOf(
        '<link id="manuldown-editor-styles"'
    );
    const criticalStyleEnd = providerSource.indexOf('</style>', criticalStyleStart);

    assert.ok(criticalStyleStart >= 0, 'The critical loading stylesheet must exist');
    assert.ok(criticalStyleEnd > criticalStyleStart);
    assert.ok(
        externalStyleStart > criticalStyleEnd,
        'Critical loading styles must precede the external editor stylesheet'
    );

    const criticalStyles = providerSource.slice(criticalStyleStart, criticalStyleEnd);
    assert.match(
        criticalStyles,
        /body\[data-editor-state="loading"\] > \[data-editor-content\],[\s\S]*body\[data-editor-state="style-error"\] > \[data-editor-content\][\s\S]*visibility: hidden !important;/
    );
    assert.match(criticalStyles, /#editor-loading[\s\S]*position: fixed;/);
    assert.match(
        criticalStyles,
        /body\[data-editor-state="style-error"\] \.editor-loading-spinner[\s\S]*display: none;/
    );
    assert.match(criticalStyles, /@media \(prefers-reduced-motion: reduce\)/);
});

test('the webview starts busy with an accessible, non-interactive loading gate', () => {
    assert.match(
        providerSource,
        /<body[^>]*data-editor-state="loading"/
    );
    assert.doesNotMatch(providerSource, /<body[^>]*aria-busy="true"/);
    assert.match(
        providerSource,
        /<div id="editor-loading" role="status" aria-live="polite" aria-atomic="true">/
    );
    assert.match(
        providerSource,
        /<div class="toolbar" data-editor-content inert aria-hidden="true" aria-busy="true">/
    );
    assert.match(
        providerSource,
        /<div class="editor-container" data-editor-content inert aria-hidden="true" aria-busy="true">/
    );
});

test('editor assets use a stable release cache key and refresh during development', () => {
    const methodStart = providerSource.indexOf('private getHtmlForWebview');
    const methodSource = providerSource.slice(methodStart);

    assert.match(methodSource, /const assetVersion = encodeURIComponent/);
    assert.match(
        methodSource,
        /this\.context\.extensionMode === vscode\.ExtensionMode\.Development/
    );
    assert.match(methodSource, /`\$\{versionCacheKey\}-\$\{Date\.now\(\)\}`/);
    assert.match(methodSource, /\?v=\$\{assetVersion\}/);
    assert.doesNotMatch(methodSource, /\?t=\$\{timestamp\}/);
});

test('the ready message handler is registered before cached Webview assets start', () => {
    const resolveStart = providerSource.indexOf('public async resolveCustomTextEditor');
    const settingsStart = providerSource.indexOf('private getWebviewSettings', resolveStart);
    const resolveSource = providerSource.slice(resolveStart, settingsStart);
    const listenerIndex = resolveSource.indexOf(
        'webviewPanel.webview.onDidReceiveMessage('
    );
    const htmlAssignmentIndex = resolveSource.indexOf(
        'webviewPanel.webview.html = this.getHtmlForWebview'
    );

    assert.ok(listenerIndex >= 0, 'The Webview message listener must be registered');
    assert.ok(htmlAssignmentIndex >= 0, 'The Webview HTML must be assigned');
    assert.ok(
        listenerIndex < htmlAssignmentIndex,
        'The ready message must not race listener registration'
    );
});

test('the loading gate opens only after initial content is ready, including load errors', () => {
    const revealStart = editorSource.indexOf('function revealEditorAfterInitialLoad()');
    const initCaseStart = editorSource.indexOf("case 'init':", revealStart);
    const loadErrorCaseStart = editorSource.indexOf("case 'loadError':", initCaseStart);
    const nextCaseStart = editorSource.indexOf("case 'updateApplied':", loadErrorCaseStart);

    assert.ok(revealStart >= 0, 'The initial reveal helper must exist');
    const revealSource = editorSource.slice(revealStart, initCaseStart);
    assert.match(revealSource, /requestAnimationFrame/);
    assert.match(revealSource, /!editorStylesheet\.sheet/);
    assert.match(revealSource, /document\.body\.dataset\.editorState = 'style-error'/);
    assert.match(revealSource, /document\.body\.dataset\.editorState = 'ready'/);
    assert.match(revealSource, /element\.removeAttribute\('inert'\)/);
    assert.match(revealSource, /element\.removeAttribute\('aria-hidden'\)/);
    assert.match(revealSource, /element\.setAttribute\('aria-busy', 'false'\)/);

    const initCase = editorSource.slice(initCaseStart, loadErrorCaseStart);
    const seedIndex = initCase.indexOf('stateManager.seedState()');
    const highlightIndex = initCase.indexOf('codeBlockManager.highlightCodeBlocks()');
    const revealIndex = initCase.indexOf('revealEditorAfterInitialLoad()');
    assert.ok(seedIndex >= 0);
    assert.ok(highlightIndex > seedIndex);
    assert.ok(revealIndex > seedIndex, 'Initial history must be seeded before reveal');
    assert.ok(
        revealIndex > highlightIndex,
        'Delayed document decoration must finish before reveal'
    );

    const loadErrorCase = editorSource.slice(loadErrorCaseStart, nextCaseStart);
    assert.match(loadErrorCase, /editor\.textContent = 'ManulDown could not render this document/);
    assert.match(loadErrorCase, /revealEditorAfterInitialLoad\(\)/);
});
