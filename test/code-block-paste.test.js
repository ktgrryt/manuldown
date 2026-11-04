const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const source = fs.readFileSync(path.join(__dirname, '..', 'media', 'editor.js'), 'utf8');
function slice(startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start);
    return source.slice(start, end);
}

function pasteIntoSelection(html, pastedText) {
    const window = domino.createWindow(`<div id="editor">${html}</div>`);
    const document = window.document;
    const editor = document.getElementById('editor');
    const container = editor.querySelector('code, p');
    const text = container.firstChild;
    const selectedText = text.data.slice(5);
    const range = {
        startContainer: text, endContainer: text, commonAncestorContainer: text,
        startOffset: 5, endOffset: text.length, collapsed: false,
        deleteContents() { text.data = text.data.slice(0, 5); this.collapsed = true; },
        insertNode(node) { container.appendChild(node); },
    };
    const selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => range, toString: () => selectedText };
    const domUtils = {
        getParentElement(node, tag) {
            for (let current = node.nodeType === 3 ? node.parentElement : node; current && current !== editor; current = current.parentElement) {
                if (current.tagName === tag) return current;
            }
            return null;
        },
        ensureInlineCodeSpaces() {}, cleanupGhostStyles() {},
    };
    const env = {
        document, editor, window: { getSelection: () => selection }, domUtils,
        Node: window.Node, isUpdating: false,
        INTERNAL_EDITOR_HTML_CLIPBOARD_TYPE: 'application/x-manuldown-editor-html',
        INTERNAL_EDITOR_PLAIN_TEXT_CLIPBOARD_TYPE: 'application/x-manuldown-editor-plain-text',
        finalizePendingPastedPathLinks() {},
        tableManager: { handleEdgePaste: () => false, handlePaste: () => false, wrapTables() {} },
        extractInternalHtmlFromMarkedClipboardHtml: () => '', normalizeExternalClipboardPlainText: text => text,
        getPastedAbsolutePathCandidate: () => null, pastedTextLooksLikeList: () => false,
        createOfficeClipboardHtml: () => '', replaceListBoundarySelectionWithDirectLink: () => false,
        placeCollapsedCaretAfter() {}, setCaretAfterNode() {},
        stateManager: { saveState() {}, saveStateDebounced() {} }, notifyChange() {},
        cleanupEmptyStrikeAtSelection() {}, cleanupEmptyStrikes() {}, unwrapStrikeAtSelection() {},
        normalizeLineBreakMode: () => 'hard', createLineBreakNode: () => document.createElement('br'),
        normalizeCheckboxListItems() {}, applyImageRenderSizes() {},
        // Markdown conversion paths all decline a range inside PRE/CODE.
        ...Object.fromEntries([
            'tryInsertHorizontalRuleFromPastedText', 'tryInsertFencedCodeBlockFromPastedText',
            'tryInsertMarkdownTableFromPastedText', 'tryInsertMarkdownBlockquoteFromPastedText',
            'tryInsertMarkdownHeadingsFromPastedText', 'tryInsertMarkdownListFromPastedText',
            'tryInsertMixedMarkdownFromPastedText', 'tryInsertInlineMarkdownFromPastedText',
            'tryInsertAutoLinkedTextFromPastedText',
        ].map(name => [name, () => false])),
    };
    let handler;
    editor.addEventListener = (_type, callback) => { handler = callback; };
    const declarations = [
        slice('const absoluteUrlPattern =', 'const hasLinkLikeText ='),
        slice('const isRangeInsideCodeBlock =', 'const findMarkdownClosingBracket ='),
        slice('const hasVisibleLinkText =', 'const getSingleListItemSelectedAtListBoundary ='),
        slice('const insertPlainTextPreservingLineBreaks =', '// Footnote numbers and formulas'),
        slice('const insertTextWithPasteBehavior =', 'applyTextInsertionWithPasteRules ='),
        slice("editor.addEventListener('paste', (e) => {", '// Snapshot the selection before the native context menu'),
    ].join('\n');
    new Function(...Object.keys(env), declarations)(...Object.values(env));
    let prevented = false;
    handler({ clipboardData: { items: [], getData: type => type === 'text/plain' ? pastedText : '' },
        preventDefault() { prevented = true; } });
    return { container, prevented };
}

test('pasting URLs and email addresses replaces selected code with literal text', () => {
    for (const value of ['https://example.com', 'user@example.com', 'https://example.com\nnext line']) {
        const { container, prevented } = pasteIntoSelection('<pre><code>curl PLACEHOLDER</code></pre>', value);
        assert.equal(prevented, true);
        assert.ok(!container.querySelector('a'));
        const renderedText = container.innerHTML.replace(/<br>/g, '\n');
        assert.equal(renderedText, `curl ${value}`);
    }
});

test('pasting a URL over prose still keeps the selected text as its link label', () => {
    const { container } = pasteIntoSelection('<p>text LABEL</p>', 'https://example.com');
    assert.equal(container.querySelector('a').textContent, 'LABEL');
    assert.equal(container.querySelector('a').getAttribute('href'), 'https://example.com');
});
