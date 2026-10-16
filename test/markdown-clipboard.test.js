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

// Domino has no DOM Range implementation. These fixtures use text selections or
// whole child-node selections; browser QA also exercises native spanning ranges.
class FixtureRange {
    setStart(node, offset) { this.startContainer = node; this.startOffset = offset; }
    setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; }
    get collapsed() { return this.startContainer === this.endContainer && this.startOffset === this.endOffset; }
    get commonAncestorContainer() { return this.startContainer; }
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
