const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const moduleSource = name => fs.readFileSync(path.join(__dirname, '..', 'media', 'modules', name), 'utf8');
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const clipboardModule = import(moduleUrl(moduleSource('MarkdownClipboard.js')
    .replace("'./DOMUtils.js'", JSON.stringify(moduleUrl(moduleSource('DOMUtils.js'))))));
const footnoteModule = import(moduleUrl(moduleSource('FootnoteManager.js')));
const editorSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'editor.js'), 'utf8');

function extractEditorFunction(name) {
    const start = editorSource.indexOf(`    function ${name}(`);
    const end = editorSource.indexOf('\n    }\n', start);
    assert.ok(start >= 0 && end > start, `${name} exists`);
    return editorSource.slice(start, end + 6);
}

function shortcutFixture({ editor, document, window, copy }, isMac = true) {
    let activeElement = editor;
    let windowFocused = true;
    let selection = null;
    const messages = [];
    Object.defineProperty(document, 'activeElement', { get: () => activeElement });
    document.hasFocus = () => windowFocused;
    window.getSelection = () => selection;
    const caseStart = editorSource.indexOf("            case 'copyAsMarkdown':");
    const caseEnd = editorSource.indexOf("            case 'workspaceLinkSuggestions':", caseStart);
    const functions = ['isMarkdownCopyEditorFocused', 'syncMarkdownCopyFocus', 'handleMarkdownCopyShortcutKeydown']
        .map(extractEditorFunction).join('\n');
    const helpers = new Function('editor', 'document', 'window', 'vscode', 'createMarkdownClipboardHtml', `
        const isMac = ${isMac};
        let isComposing = false;
        const compositionUpdateGate = { composing: false, finalizing: false };
        const isUpdating = false;
        const editorLoadFailed = false;
        const footnoteManager = null;
        let markdownCopyEditorFocused = null;
        let markdownCopyContextHtml = '';
        let clipboardCopySequence = 0;
        ${functions}
        return {
            isMarkdownCopyEditorFocused, syncMarkdownCopyFocus, handleMarkdownCopyShortcutKeydown,
            receive(message) { switch(message.type) { ${editorSource.slice(caseStart, caseEnd)} } },
            setComposing(value) { isComposing = value; },
            getCopySequence() { return clipboardCopySequence; }
        };
    `)(editor, document, window, { postMessage: message => messages.push(message) }, (_editor, range) => copy(range));
    return {
        ...helpers, messages,
        focus(element, focused = true) { activeElement = element; windowFocused = focused; },
        select(range) { selection = range ? { rangeCount: 1, getRangeAt: () => range } : null; },
        key(properties) {
            let prevented = false;
            const handled = helpers.handleMarkdownCopyShortcutKeydown({
                ...properties, preventDefault() { prevented = true; },
                stopPropagation() { assert.fail('the key must reach the VS Code dispatcher'); }
            });
            return { handled, prevented };
        }
    };
}

// Domino has no DOM Range implementation. These fixtures use text selections or
// whole child-node selections; browser QA also exercises native spanning ranges.
class FixtureRange {
    setStart(node, offset) { this.startContainer = node; this.startOffset = offset; }
    setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; }
    get collapsed() { return this.startContainer === this.endContainer && this.startOffset === this.endOffset; }
    get commonAncestorContainer() { return this.startContainer; }
    toString() { return this.cloneContents().textContent; }
    cloneContents() {
        assert.equal(this.startContainer, this.endContainer);
        const node = this.startContainer;
        const fragment = node.ownerDocument.createDocumentFragment();
        if (node.nodeType === 3) {
            fragment.appendChild(node.ownerDocument.createTextNode(node.textContent.slice(this.startOffset, this.endOffset)));
        } else {
            Array.from(node.childNodes).slice(this.startOffset, this.endOffset).forEach(child => fragment.appendChild(child.cloneNode(true)));
        }
        return fragment;
    }
}

function clipboardPasteFixture({ editor, document, window, range }) {
    const slice = (startMarker, endMarker) => {
        const start = editorSource.indexOf(startMarker);
        const end = editorSource.indexOf(endMarker, start);
        assert.ok(start >= 0 && end > start, startMarker);
        return editorSource.slice(start, end);
    };
    let currentRange = range(editor);
    const selection = {
        rangeCount: 1,
        get isCollapsed() { return currentRange.collapsed; },
        getRangeAt: () => currentRange,
        toString: () => currentRange.toString(),
    };
    window.getSelection = () => selection;
    const imagePolicyCalls = [];
    const messages = [];
    const env = {
        editor, document, window, Node: window.Node, NodeFilter: window.NodeFilter,
        isUpdating: false,
        domUtils: {
            getParentElement(node, tag) {
                const element = node.nodeType === 3 ? node.parentElement : node;
                return element.closest(tag);
            },
            ensureInlineCodeSpaces() {}, cleanupGhostStyles() {},
        },
        stateManager: { saveState() {}, saveStateDebounced() {} },
        footnoteManager: {
            appendClipboardDefinitions() {},
            prepareClipboardImport: html => ({ html }),
            restoreClipboardImport: () => [],
        },
        mathManager: {
            prepareClipboardImport: html => ({ html }), restoreClipboardImport() {},
        },
        tableManager: {
            handleEdgePaste: () => false, handlePaste: () => false, wrapTables() {},
            _insertNodeAsBlock(_range, fragment) {
                editor.innerHTML = '';
                editor.appendChild(fragment);
            },
        },
        getCheckboxInListItemDirectContent: item => Array.from(item.children)
            .find(node => node.tagName === 'INPUT' && node.type === 'checkbox'),
        classifyImageSourceForEditor: src => /^https?:|^data:/i.test(src)
            ? { kind: 'direct' } : { kind: 'resolve-local' },
        applyImageSourcePolicy: (_image, src) => imagePolicyCalls.push(src),
        applyImageRenderSizeFromAlt() {},
        applyImageRenderSizes() {}, normalizeCheckboxListItems() {}, updateListItemClasses() {},
        setCaretToEndOfInsertedNode() {}, notifyChange() {}, finalizePendingPastedPathLinks() {},
        getPastedAbsolutePathCandidate: () => null,
        pastedTextLooksLikeList: text => /^[-*] /.test(text),
        internalHtmlIsListlessPlainText: html => !/<(?:ul|ol|li|strong|a|code)\b/i.test(html),
        insertTextWithPasteBehavior(text, { allowPlainTextFallback }) {
            if (!allowPlainTextFallback) return false;
            editor.textContent = text;
            return true;
        },
        vscode: { postMessage: message => messages.push(message) },
    };
    const rootFunctions = [
        'hasExplicitScheme', 'sanitizeLinkHref', 'unwrapElement', 'sanitizeFragmentForEditor',
        'createSanitizedContainerFromHtml', 'isBlockElement',
        'selectionContainsImage', 'selectionContainsListStructure', 'fragmentToClipboardPlainText',
        'createClipboardPayloadFromRange', 'createClipboardPayloadFromSelection',
    ].map(extractEditorFunction).join('\n');
    const declarations = [
        slice('const INTERNAL_EDITOR_PLAIN_TEXT_CLIPBOARD_TYPE =', 'const SOFT_LINE_BREAK_ATTRIBUTE ='),
        slice('const SAFE_EDITOR_TAGS =', 'function isLikelyAbsoluteFsPath('),
        rootFunctions,
        slice('function normalizeClipboardPlainText(', 'function focusEditorWithoutScroll('),
        slice('const absoluteUrlPattern =', 'const isImageFile ='),
        slice('const getSelectionRangeForPaste =', 'const hasVisibleLinkText ='),
        slice('const tryInsertInternalHtmlFromClipboard =', 'const tryInsertInlineMarkdownFromPastedText ='),
        slice('const handleEditorCopy =', '// カットを補助:'),
        slice("editor.addEventListener('paste', (e) => {", '// Snapshot the selection before the native context menu'),
    ].join('\n');
    new Function(...Object.keys(env), `let trustedClipboardPayload = null; let clipboardCopySequence = 0;\n${declarations}\n//# sourceURL=clipboard-paste-fixture.js`)(...Object.values(env));
    const data = new Map();
    const clipboardData = {
        items: [], getData: type => data.get(type) || '', setData: (type, value) => data.set(type, value),
    };
    const dispatch = type => {
        const event = document.createEvent('Event');
        event.initEvent(type, true, true);
        event.clipboardData = clipboardData;
        editor.dispatchEvent(event);
        return event;
    };
    return {
        data, imagePolicyCalls, messages,
        copy() { currentRange = range(editor); return dispatch('copy'); },
        paste() { currentRange = range(editor, 0, 0); return dispatch('paste'); },
        forgetCustomTypes() {
            data.delete('application/x-manuldown-editor-html');
            data.delete('application/x-manuldown-editor-plain-text');
        },
    };
}

async function withFixture(html, callback) {
    const { createMarkdownClipboardHtml } = await clipboardModule;
    const { FootnoteManager } = await footnoteModule;
    const window = domino.createWindow(`<div id="editor">${html}</div><p id="outside">outside</p>`);
    const document = window.document;
    const editor = document.getElementById('editor');
    editor.dataset = {};
    Object.getPrototypeOf(editor.querySelectorAll('a')).forEach = Array.prototype.forEach;
    document.createRange = () => new FixtureRange();
    window.getSelection = () => null;
    const previous = { Node: global.Node, NodeFilter: global.NodeFilter, document: global.document, window: global.window };
    Object.assign(global, { Node: window.Node, NodeFilter: window.NodeFilter, document, window });
    const footnoteManager = new FootnoteManager(editor, {});
    const range = (node, start = 0, end = node.nodeType === 3 ? node.length : node.childNodes.length) => {
        const selection = new FixtureRange();
        selection.setStart(node, start);
        selection.setEnd(node, end);
        return selection;
    };
    try {
        await callback({ editor, document, window, range, copy: selection => createMarkdownClipboardHtml(editor, selection, footnoteManager) });
    } finally {
        Object.assign(global, previous);
    }
}

test('copying part of a formatted link preserves its formatting and URL without unselected text', async () => {
    await withFixture('<p>before <a href="./note.md"><strong>selected text</strong></a> after</p>', ({ editor, range, copy }) => {
        const original = editor.innerHTML;
        const html = copy(range(editor.querySelector('strong').firstChild, 0, 8));
        assert.equal(html, '<p><a href="./note.md"><strong>selected</strong></a></p>');
        assert.equal(editor.innerHTML, original);
    });
});

test('whole headings keep their level while a word inside a heading stays an inline selection', async () => {
    await withFixture('<h2>A heading</h2>', ({ editor, range, copy }) => {
        const text = editor.querySelector('h2').firstChild;
        assert.equal(copy(range(text)), '<h2>A heading</h2>');
        assert.equal(copy(range(text, 2, 9)), 'heading');
    });
});

test('copying a nested ordered item keeps its number without adding empty parent items', async () => {
    await withFixture('<ul><li>parent<ol start="3"><li>first</li><li>second</li></ol></li></ul>', ({ editor, range, copy }) => {
        const html = copy(range(editor.querySelectorAll('ol li')[1].firstChild));
        assert.equal(html, '<ol start="4"><li>second</li></ol>');
    });
});

test('task-list copies use the live checkbox state and preserve inline formatting', async () => {
    await withFixture('<ul><li><input type="checkbox"><strong>done</strong></li></ul>', ({ editor, range, copy }) => {
        // Domino reflects checked to the attribute; browsers keep a live state.
        Object.defineProperty(editor.querySelector('input'), 'checked', { value: true, writable: true });
        const html = copy(range(editor.querySelector('strong').firstChild));
        assert.match(html, /<input type="checkbox" checked="">/);
        assert.match(html, /<strong>done<\/strong>/);
        assert.equal(editor.querySelector('input').hasAttribute('checked'), false);
    });
});

test('copies exclude code toolbars, retain code source and keep math and tables', async () => {
    await withFixture('<pre><div class="code-block-toolbar">Copy</div><code class="language-js">a\n  b</code></pre><p><span data-mdw-math="inline">x^2</span></p><table><thead><tr><th>H</th></tr></thead><tbody><tr><td>V</td></tr></tbody></table>', ({ editor, range, copy }) => {
        const html = copy(range(editor));
        assert.doesNotMatch(html, /toolbar|Copy/);
        assert.match(html, /<code class="language-js">a\n  b<\/code>/);
        assert.match(html, /data-mdw-math="inline">x\^2/);
        assert.match(html, /<table>/);
        assert.equal(copy(range(editor.querySelector('td').firstChild)), 'V');
    });
});

test('footnote references include their definition without editor controls', async () => {
    await withFixture('<p>text<sup data-mdw-footnote-ref="a">1</sup></p><div data-mdw-footnote-definition="a"><button data-exclude-from-markdown="true">delete</button><div class="mdw-footnote-content"><p>note</p></div></div>', ({ editor, range, copy }) => {
        const html = copy(range(editor.querySelector('p')));
        assert.match(html, /data-mdw-footnote-ref="a"/);
        assert.match(html, /data-mdw-footnote-definition="a"/);
        assert.match(html, /<p>note<\/p>/);
        assert.doesNotMatch(html, /delete|<button/);
    });
});

test('copies remove only editor caret anchors and keep user zero-width characters', async () => {
    await withFixture('<p>\u200bA\u200bB\u2060C</p>', ({ editor, range, copy }) => {
        const text = editor.querySelector('p').firstChild;
        text.mdwCaretAnchor = { character: '\u200b', text: text.textContent, offset: 0 };
        assert.equal(copy(range(text)), '<p>A\u200bB\u2060C</p>');
        assert.equal(copy(range(text, 1, 4)), '<p>A\u200bB</p>');
    });
});

test('copying prose from a footnote body does not add its enclosing definition', async () => {
    await withFixture('<div data-mdw-footnote-definition="a"><div class="mdw-footnote-content"><p>note <strong>body</strong></p></div></div>', ({ editor, range, copy }) => {
        assert.equal(copy(range(editor.querySelector('strong').firstChild)), '<p><strong>body</strong></p>');
    });
});

test('empty and outside selections do not produce a clipboard payload', async () => {
    await withFixture('<p>text</p>', ({ editor, document, range, copy }) => {
        assert.equal(copy(null), '');
        assert.equal(copy(range(editor.firstChild.firstChild, 1, 1)), '');
        assert.equal(copy(range(document.getElementById('outside').firstChild)), '');
    });
});

test('the context command copies its snapshot even after the native menu clears the selection', () => {
    const start = editorSource.indexOf("            case 'copyAsMarkdown':");
    const end = editorSource.indexOf("            case 'workspaceLinkSuggestions':", start);
    assert.ok(start >= 0 && end > start);
    const messages = [];
    const receive = new Function('message', 'window', 'vscode', 'editor', 'footnoteManager', `
        const isUpdating = false;
        const editorLoadFailed = false;
        let markdownCopyContextHtml = '<p><strong>snapshot</strong></p>';
        let clipboardCopySequence = 0;
        switch (message.type) { ${editorSource.slice(start, end)} }
        return markdownCopyContextHtml;
    `);
    assert.equal(receive({ type: 'copyAsMarkdown', fromContextMenu: true }, { getSelection: () => null }, { postMessage: message => messages.push(message) }), '');
    assert.deepEqual(messages, [{ type: 'copyMarkdown', html: '<p><strong>snapshot</strong></p>' }]);
});

test('opening the native menu captures the selection and clears it for inputs or an empty selection', async () => {
    await withFixture('<p><strong>selected</strong><input></p>', async ({ editor, document, window, range }) => {
        const { createMarkdownClipboardHtml } = await clipboardModule;
        const { FootnoteManager } = await footnoteModule;
        const start = editorSource.indexOf('        // Snapshot the selection before the native context menu takes focus.');
        const end = editorSource.indexOf('        // 複数行選択のコピー時', start);
        assert.ok(start >= 0 && end > start);
        const snapshot = new Function('editor', 'window', 'document', 'footnoteManager', 'createMarkdownClipboardHtml', `
            const isUpdating = false;
            const editorLoadFailed = false;
            let markdownCopyContextHtml = '';
            ${editorSource.slice(start, end)}
            return () => markdownCopyContextHtml;
        `)(editor, window, document, new FootnoteManager(editor, {}), createMarkdownClipboardHtml);
        const text = editor.querySelector('strong').firstChild;
        window.getSelection = () => ({ rangeCount: 1, getRangeAt: () => range(text) });
        const openMenu = target => {
            const event = document.createEvent('Event');
            event.initEvent('contextmenu', true, true);
            target.dispatchEvent(event);
            return JSON.parse(editor.dataset.vscodeContext);
        };
        assert.equal(openMenu(editor.querySelector('strong')).manulDownHasMarkdownSelection, true);
        assert.match(snapshot(), /<strong>selected<\/strong>/);
        assert.equal(openMenu(editor.querySelector('input')).manulDownHasMarkdownSelection, false);
        assert.equal(snapshot(), '');
        window.getSelection = () => null;
        assert.equal(openMenu(editor).manulDownHasMarkdownSelection, false);
    });
});

test('the native context menu is scoped to selected ManulDown content', () => {
    const manifest = require('../package.json');
    const entry = manifest.contributes.menus['webview/context'].find(item => item.command === 'manulDown.copyAsMarkdown');
    assert.ok(entry);
    assert.match(entry.when, /webviewId == 'manulDown.editor'/);
    assert.match(entry.when, /webviewSection == 'editor'/);
    assert.match(entry.when, /manulDownHasMarkdownSelection/);
});

test('Markdown copy focus excludes search fields, controls, other panels and an unfocused window', async () => {
    await withFixture('<p>text</p><input><textarea></textarea><button>Copy</button><span contenteditable="false">formula</span>', f => {
        const shortcut = shortcutFixture(f);
        assert.equal(shortcut.isMarkdownCopyEditorFocused(), true);
        shortcut.syncMarkdownCopyFocus();
        shortcut.syncMarkdownCopyFocus();
        assert.deepEqual(shortcut.messages, [{ type: 'markdownCopyFocus', focused: true }]);
        for (const target of [...f.editor.querySelectorAll('input, textarea, button, span'), f.document.getElementById('outside')]) {
            shortcut.focus(target);
            assert.equal(shortcut.isMarkdownCopyEditorFocused(), false);
            assert.deepEqual(shortcut.key({ key: 'C', metaKey: true, shiftKey: true }), { handled: false, prevented: false });
        }
        shortcut.focus(f.editor, false);
        assert.equal(shortcut.isMarkdownCopyEditorFocused(), false);
        shortcut.syncMarkdownCopyFocus();
        assert.deepEqual(shortcut.messages.at(-1), { type: 'markdownCopyFocus', focused: false });
        shortcut.receive({ type: 'requestMarkdownCopyFocus' });
        assert.equal(shortcut.messages.length, 3, 'panel reactivation can force a fresh focus report');
    });
});

for (const isMac of [true, false]) {
    test(`${isMac ? 'Cmd' : 'Ctrl'}+Shift+C copies Markdown exactly once through the contributed command`, async () => {
        await withFixture('<p><strong>selected</strong></p>', f => {
            const shortcut = shortcutFixture(f, isMac);
            shortcut.select(f.range(f.editor.querySelector('strong').firstChild));
            const modifier = isMac ? { metaKey: true } : { ctrlKey: true };
            assert.deepEqual(shortcut.key({ key: 'C', shiftKey: true, ...modifier }), { handled: true, prevented: true });
            assert.deepEqual(shortcut.messages, [], 'DOM handling only suppresses native behavior');

            const binding = require('../package.json').contributes.keybindings.find(item => item.command === 'manulDown.copyAsMarkdown');
            assert.equal(binding.key, 'ctrl+shift+c');
            assert.equal(binding.mac, 'cmd+shift+c');
            assert.equal(binding.when, "activeCustomEditorId == 'manulDown.editor' && manulDown.editorTextFocus");
            const extensionSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
            const start = extensionSource.indexOf('    const copyAsMarkdownCommand =');
            const end = extensionSource.indexOf('    context.subscriptions.push(copyAsMarkdownCommand);', start);
            const source = require('typescript').transpileModule(extensionSource.slice(start, end), {}).outputText;
            let executeCommand;
            new Function('vscode', 'provider', source)({
                commands: { registerCommand(id, callback) { assert.equal(id, binding.command); executeCommand = callback; } }
            }, { postMessageToActiveEditor: message => shortcut.receive(message) });
            executeCommand(binding.args);
            assert.deepEqual(shortcut.messages, [{ type: 'copyMarkdown', html: '<p><strong>selected</strong></p>' }]);
            assert.equal(shortcut.getCopySequence(), 1, 'Markdown copy cancels an older pending image copy');

            for (const properties of [
                { key: 'c', ...modifier },
                { key: 'c', shiftKey: true, ...(isMac ? { ctrlKey: true } : { metaKey: true }) },
                { key: 'c', shiftKey: true, altKey: true, ...modifier },
                { key: 'c', shiftKey: true, metaKey: true, ctrlKey: true },
                { key: 'x', shiftKey: true, ...modifier }
            ]) assert.deepEqual(shortcut.key(properties), { handled: false, prevented: false });
        });
    });
}

test('shortcut commands do nothing without a selection, during composition or after focus leaves the body', async () => {
    await withFixture('<p>text</p><input>', f => {
        const shortcut = shortcutFixture(f);
        const command = { type: 'copyAsMarkdown', fromShortcut: true };
        assert.deepEqual(shortcut.key({ key: 'C', metaKey: true, shiftKey: true }), { handled: true, prevented: true });
        shortcut.receive(command);
        shortcut.select(f.range(f.editor.firstChild.firstChild, 1, 1));
        shortcut.receive(command);
        shortcut.select(f.range(f.editor.firstChild.firstChild));
        shortcut.focus(f.editor.querySelector('input'));
        shortcut.receive(command);
        shortcut.focus(f.editor, false);
        shortcut.receive(command);
        shortcut.focus(f.editor);
        shortcut.setComposing(true);
        shortcut.receive(command);
        assert.deepEqual(shortcut.messages, []);
    });
});

for (const markersOnly of [false, true]) {
    test(`copy and paste keeps rendered literal Markdown${markersOnly ? ' with only HTML clipboard markers' : ' with custom clipboard types'}`, async () => {
        const html = '<ul><li><strong>bold</strong> [x](u) `hello` ![literal](../secret.png) https://example.test ' +
            '<a href="real.md">real link</a> <code>real code</code></li></ul>';
        await withFixture(html, f => {
            const clipboard = clipboardPasteFixture(f);
            const expectedText = f.editor.textContent;
            assert.equal(clipboard.copy().defaultPrevented, true);
            assert.equal(clipboard.data.get('application/x-manuldown-editor-html'), html);
            if (markersOnly) clipboard.forgetCustomTypes();
            f.editor.innerHTML = '<p><br></p>';

            assert.equal(clipboard.paste().defaultPrevented, true);

            assert.equal(f.editor.textContent, expectedText);
            assert.equal(f.editor.querySelector('strong').textContent, 'bold');
            assert.equal(f.editor.querySelectorAll('a').length, 1);
            assert.equal(f.editor.querySelector('a').getAttribute('href'), 'real.md');
            assert.equal(f.editor.querySelectorAll('code').length, 1);
            assert.equal(f.editor.querySelector('code').textContent, 'real code');
            assert.ok(!f.editor.querySelector('img'));
            assert.deepEqual(clipboard.imagePolicyCalls, []);
            assert.deepEqual(clipboard.messages, []);
        });
    });
}

test('an altered internal clipboard payload still follows untrusted Markdown conversion', async () => {
    await withFixture('<ul><li><strong>bold</strong> [x](u) `hello`</li></ul>', f => {
        const clipboard = clipboardPasteFixture(f);
        clipboard.copy();
        // Exact local provenance requires matching both HTML and plain text.
        const changed = clipboard.data.get('text/plain') + ' changed';
        clipboard.data.set('text/plain', changed);
        clipboard.data.set('application/x-manuldown-editor-plain-text', changed);
        f.editor.innerHTML = '<p><br></p>';

        assert.equal(clipboard.paste().defaultPrevented, true);

        assert.equal(f.editor.querySelector('a').getAttribute('href'), 'u');
        assert.equal(f.editor.querySelector('code').textContent, 'hello');
        assert.equal(f.editor.querySelector('strong').textContent, 'bold');
    });
});

test('external Office rich text retains its Markdown conversion and URL linking', async () => {
    await withFixture('<p><br></p>', f => {
        const clipboard = clipboardPasteFixture(f);
        clipboard.data.set('text/html', '<p class="MsoNormal"><strong>bold</strong> [x](u) `hello` https://example.test</p>');
        clipboard.data.set('text/plain', 'bold [x](u) `hello` https://example.test');

        assert.equal(clipboard.paste().defaultPrevented, true);

        assert.equal(f.editor.querySelector('strong').textContent, 'bold');
        assert.equal(f.editor.querySelector('code').textContent, 'hello');
        assert.deepEqual(Array.from(f.editor.querySelectorAll('a'), link => link.getAttribute('href')),
            ['u', 'https://example.test']);
    });
});

test('forged internal image HTML cannot gain provenance from the literal-preserving path', async () => {
    await withFixture('<p><br></p>', f => {
        const clipboard = clipboardPasteFixture(f);
        clipboard.data.set('application/x-manuldown-editor-html', '<p><img src="file:///private/secret.png"></p>');
        clipboard.data.set('text/plain', 'image copy');

        assert.equal(clipboard.paste().defaultPrevented, true);

        assert.equal(f.editor.textContent, 'image copy');
        assert.ok(!f.editor.querySelector('img'));
        assert.deepEqual(clipboard.imagePolicyCalls, []);
        assert.deepEqual(clipboard.messages, []);
    });
});
