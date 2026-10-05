const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const domUtilsSource = fs.readFileSync(path.join(__dirname, '..', 'media/modules/DOMUtils.js'), 'utf8');
const domUtilsModule = import(`data:text/javascript;base64,${Buffer.from(domUtilsSource).toString('base64')}`);
const editorSource = fs.readFileSync(path.join(__dirname, '..', 'media/editor.js'), 'utf8');
const stripStart = editorSource.indexOf('    function stripEditorControlCharacters(');
const stripEnd = editorSource.indexOf('    function stripListPlaceholderCharactersFromTextNode(', stripStart);

async function fixture(t, html, offset) {
    const window = domino.createWindow(`<div id="editor">${html}</div>`);
    const document = window.document;
    const editor = document.getElementById('editor');
    const code = editor.querySelector('code');
    if (code.hasAttribute('data-is-new') && code.firstChild?.textContent.startsWith('\u200B')) {
        code.firstChild.mdwCaretAnchor = '\u200B';
    }
    let range = {
        startContainer: code.firstChild || code, endContainer: code.firstChild || code,
        startOffset: offset, endOffset: offset, collapsed: true,
        commonAncestorContainer: code.firstChild || code,
    };
    window.getSelection = () => ({
        rangeCount: range ? 1 : 0, isCollapsed: true,
        getRangeAt: () => range,
        removeAllRanges: () => { range = null; },
        addRange: next => { range = next; },
    });
    document.createRange = () => ({
        get commonAncestorContainer() { return this.startContainer; },
        setStart(node, offset) { this.startContainer = node; this.startOffset = offset; },
        setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; },
        collapse() {
            this.endContainer = this.startContainer;
            this.endOffset = this.startOffset;
            this.collapsed = true;
        },
        selectNodeContents(node) { this.root = node; },
        toString() { return this.root.textContent.slice(0, this.endOffset); },
    });
    const originals = { window: global.window, document: global.document, Node: global.Node };
    Object.assign(global, { window, document, Node: window.Node });
    const prototype = Object.getPrototypeOf(editor.querySelectorAll('code'));
    const originalForEach = prototype.forEach;
    prototype.forEach = Array.prototype.forEach;
    t.after(() => {
        for (const [key, value] of Object.entries(originals)) {
            if (value === undefined) delete global[key];
            else global[key] = value;
        }
        if (originalForEach === undefined) delete prototype.forEach;
        else prototype.forEach = originalForEach;
    });
    const { DOMUtils } = await domUtilsModule;
    const domUtils = new DOMUtils(editor);
    const strip = new Function('editor', 'window', 'document', 'Node', 'NodeFilter', 'domUtils',
        `${editorSource.slice(stripStart, stripEnd)}\nreturn stripEditorControlCharacters;`
    )(editor, window, document, window.Node, window.NodeFilter, domUtils);
    return { code, strip, domUtils, get range() { return range; } };
}

test('the active empty toolbar code retains its text anchor before typing', async (t) => {
    const f = await fixture(t, '<p><code data-is-new="true">\u200B</code></p>', 1);
    assert.equal(f.strip(), false);
    assert.equal(f.code.textContent, '\u200B');
    assert.equal(f.range.startOffset, 1);
});

test('normalizing a new empty inline code restores an editable text anchor', async (t) => {
    const f = await fixture(t, '<p><code data-is-new="true"></code></p>', 0);
    f.domUtils.ensureInlineCodeSpaces();
    assert.equal(f.code.textContent, '\u200B');
    assert.equal(f.code.getAttribute('data-is-new'), 'true');
});

test('the first typed text removes the placeholder and keeps the caret after the text', async (t) => {
    const f = await fixture(t, '<p><code data-is-new="true">\u200Bvalue</code></p>', 6);
    assert.equal(f.strip(), true);
    assert.equal(f.code.textContent, 'value');
    assert.equal(f.range.startOffset, 5);
    f.domUtils.ensureInlineCodeSpaces();
    assert.equal(f.code.hasAttribute('data-is-new'), false);
});

test('inline code preserves newly pasted zero-width text without source attributes', async (t) => {
    const f = await fixture(t, '<p><code>\u200Bvalue</code></p>', 6);
    assert.equal(f.strip(), false);
    f.domUtils.ensureInlineCodeSpaces();
    assert.equal(f.code.textContent, '\u200Bvalue');
    assert.equal(f.range.startOffset, 6);
});

test('loading and input cleanup preserve source zero-width characters in text and code', async (t) => {
    const text = 'a\u200bb\u2060c\ufeffd';
    const f = await fixture(t, `<p><span data-mdw-source-zero-width="true">${text}</span><code data-mdw-source-zero-width="true">${text}</code></p>`, 3);
    f.domUtils.cleanupGhostStyles();
    assert.equal(f.strip(), false);
    f.domUtils.ensureInlineCodeSpaces();
    assert.equal(f.code.textContent, text);
    assert.equal(f.code.previousSibling.textContent, text);
    assert.equal(f.range.startOffset, 3);
});
