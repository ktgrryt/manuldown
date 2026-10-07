const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const domUtilsSource = fs.readFileSync(path.join(__dirname, '..', 'media/modules/DOMUtils.js'), 'utf8');
const domUtilsModule = import(`data:text/javascript;base64,${Buffer.from(domUtilsSource).toString('base64')}`);
const cursorManagerSource = fs.readFileSync(path.join(__dirname, '..', 'media/modules/CursorManager.js'), 'utf8');
const cursorManagerModule = import(`data:text/javascript;base64,${Buffer.from(cursorManagerSource).toString('base64')}`);
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
    const originals = { window: global.window, document: global.document, Node: global.Node, NodeFilter: global.NodeFilter };
    Object.assign(global, { window, document, Node: window.Node,
        NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 } });
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
    return {
        editor, code, strip, domUtils,
        placeCaret(node, offset) {
            const next = document.createRange();
            next.setStart(node, offset);
            next.collapse(true);
            window.getSelection().removeAllRanges();
            window.getSelection().addRange(next);
        },
        get range() { return range; },
    };
}

test('the active empty toolbar code retains its text anchor before typing', async (t) => {
    const f = await fixture(t, '<p><code data-is-new="true">\u200B</code></p>', 1);
    assert.equal(f.strip(), false);
    assert.equal(f.code.textContent, '\u200B');
    assert.equal(f.range.startOffset, 1);
});

test('editing a list below empty code preserves its editable anchor without saving the anchor', async (t) => {
    const f = await fixture(t, '<p><code data-is-new="true">\u200B</code></p><ul><li>item</li></ul>', 1);
    const listText = f.editor.querySelector('li').firstChild;
    f.placeCaret(listText, 1);
    assert.equal(f.strip(), false);
    assert.equal(f.code.textContent, '\u200B');
    assert.equal(f.range.startContainer, listText);
    assert.equal(f.range.startOffset, 1);
    assert.doesNotMatch(f.domUtils.getCleanedHTML(), /\u200B/);
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

test('IME re-editing at the code start uses a temporary anchor that is not saved', async (t) => {
    const f = await fixture(t, '<p>before <code>value</code> after</p>', 0);
    const { CursorManager } = await cursorManagerModule;
    const manager = new CursorManager(f.editor, f.domUtils);
    assert.equal(manager.prepareInlineCodeComposition(), true);
    assert.equal(f.code.textContent, '\u200Bvalue');
    assert.equal(f.range.startContainer, f.code.firstChild);
    assert.equal(f.range.startOffset, 1);
    assert.equal(f.domUtils.getCleanedHTML(), '<p>before <code>value</code> after</p>');
    assert.equal(manager.prepareInlineCodeComposition(), false);

    f.domUtils.recordCaretAnchorInput(f.range, 'insertCompositionText', '日本語');
    f.code.firstChild.insertData(1, '日本語');
    f.domUtils.commitCaretAnchorInput();
    f.placeCaret(f.code.firstChild, 4);
    assert.equal(f.strip(), true);
    assert.equal(f.code.textContent, '日本語value');
    assert.equal(f.range.startOffset, 3);
});

test('IME preparation preserves source zero-width characters at the code start', async (t) => {
    const f = await fixture(t, '<p>before <code>\u200Bvalue</code></p>', 0);
    const { CursorManager } = await cursorManagerModule;
    const manager = new CursorManager(f.editor, f.domUtils);
    assert.equal(manager.prepareInlineCodeComposition(), true);
    assert.equal(f.code.textContent, '\u200B\u200Bvalue');
    assert.equal(f.strip(), true);
    assert.equal(f.code.textContent, '\u200Bvalue');
});

test('IME preparation leaves other caret positions and selections untouched', async (t) => {
    const f = await fixture(t, '<p>before <code>value</code> after</p>', 2);
    const { CursorManager } = await cursorManagerModule;
    const manager = new CursorManager(f.editor, f.domUtils);
    for (const [node, offset] of [[f.code.firstChild, 2], [f.code.previousSibling, 7]]) {
        f.placeCaret(node, offset);
        assert.equal(manager.prepareInlineCodeComposition(), false);
        assert.equal(f.range.startContainer, node);
        assert.equal(f.range.startOffset, offset);
    }
    f.placeCaret(f.code.firstChild, 0);
    window.getSelection = () => ({ rangeCount: 1, isCollapsed: false, getRangeAt: () => f.range });
    assert.equal(manager.prepareInlineCodeComposition(), false);
    assert.equal(f.code.textContent, 'value');
});

for (const html of ['<pre><code>value</code></pre>', '<p><code contenteditable="false">value</code></p>']) {
    test(`IME preparation leaves fenced and read-only code unchanged: ${html}`, async (t) => {
        const f = await fixture(t, html, 0);
        const { CursorManager } = await cursorManagerModule;
        const manager = new CursorManager(f.editor, f.domUtils);
        assert.equal(manager.prepareInlineCodeComposition(), false);
        assert.equal(f.code.textContent, 'value');
    });
}

async function editingFixture(t, html, offset = 0) {
    const f = await fixture(t, html, offset);
    const { CursorManager } = await cursorManagerModule;
    const cursorManager = new CursorManager(f.editor, f.domUtils);
    const start = editorSource.indexOf('    function handleInlineCodeDelete(');
    const end = editorSource.indexOf('    function handleBackspaceKeydown(', start);
    const checkpoints = [];
    const commands = [];
    let notifications = 0;
    document.execCommand = command => {
        commands.push({ command, node: f.range.startContainer, offset: f.range.startOffset });
        return true;
    };
    const handleDelete = new Function('domUtils', 'cursorManager', 'stateManager', 'placeCollapsedCaret', 'notifyChangeImmediate',
        `${editorSource.slice(start, end)}\nreturn handleInlineCodeDelete;`
    )(f.domUtils, cursorManager, { saveState: () => checkpoints.push(f.editor.innerHTML) },
        (_selection, node, offset) => f.placeCaret(node, offset), () => notifications++);
    return { ...f, get range() { return f.range; }, cursorManager, checkpoints, commands,
        handleDelete: direction => handleDelete(window.getSelection(), f.range, direction),
        get notifications() { return notifications; } };
}

const leftMarker = '<span data-inline-code-left-caret-anchor="true" data-exclude-from-markdown="true" contenteditable="false"></span>';

test('Backspace at inside-left removes the caret marker before deleting real text', async (t) => {
    const f = await editingFixture(t, `<p>a<code>${leftMarker}bc</code>d</p>`);
    f.placeCaret(f.code, 1);
    const text = f.code.lastChild;
    assert.equal(f.handleDelete('backward'), true);
    assert.deepEqual(f.commands, [{ command: 'delete', node: text, offset: 0 }]);
    assert.equal(f.code.firstChild, text);
    assert.match(f.checkpoints[0], /data-inline-code-left-caret-anchor/);
    assert.equal(f.notifications, 1);
});

test('Backspace outside-right starts at the final code character instead of deleting the anchor', async (t) => {
    const f = await editingFixture(t, `<p>a<code>${leftMarker}bc</code>\u200Bd</p>`);
    const anchor = f.code.nextSibling.splitText(1);
    const caretAnchor = anchor.previousSibling;
    caretAnchor.mdwCaretAnchor = '\u200B';
    f.placeCaret(caretAnchor, 1);
    const text = f.code.lastChild;
    assert.equal(f.handleDelete('backward'), true);
    assert.deepEqual(f.commands, [{ command: 'delete', node: text, offset: 2 }]);
    assert.equal(caretAnchor.parentNode, null);
    assert.equal(anchor.textContent, 'd');
});

test('Backspace skips a caret anchor merged with following user text without removing that text', async (t) => {
    const f = await editingFixture(t, `<p>a<code>${leftMarker}bc</code>\u200Bd</p>`);
    const after = f.code.nextSibling;
    after.mdwCaretAnchor = '\u200B';
    f.placeCaret(after, 1);
    const text = f.code.lastChild;
    assert.equal(f.handleDelete('backward'), true);
    assert.deepEqual(f.commands, [{ command: 'delete', node: text, offset: 2 }]);
    assert.equal(after.textContent, 'd');
    assert.equal(after.parentElement, f.code.parentElement);
});

test('Delete before code skips a retained atomic marker', async (t) => {
    const f = await editingFixture(t, `<p>a<code>${leftMarker}bc</code>d</p>`);
    const before = f.code.previousSibling;
    f.placeCaret(before, 1);
    assert.equal(f.handleDelete('forward'), true);
    assert.deepEqual(f.commands, [{ command: 'forwardDelete', node: before, offset: 1 }]);
    assert.equal(f.code.childNodes.length, 1);
    assert.equal(f.code.textContent, 'bc');
});

for (const direction of ['backward', 'forward']) {
    test(`${direction} deletion inside empty toolbar code removes only the empty code`, async (t) => {
        const f = await editingFixture(t, '<p>a<code data-is-new="true">\u200B</code>d</p>', 1);
        assert.equal(f.handleDelete(direction), true);
        assert.equal(f.editor.textContent, 'ad');
        assert.ok(!f.editor.querySelector('code'));
        assert.equal(f.range.startContainer.nodeType, Node.TEXT_NODE);
        assert.equal(f.range.startContainer.textContent, '');
        assert.deepEqual(f.commands, []);
    });
}

test('inline deletion ignores selections, fenced code and unmarked zero-width user text', async (t) => {
    for (const html of ['<p>a<code>\u200B</code>d</p>', '<pre><code>bc</code></pre>']) {
        const f = await editingFixture(t, html, 0);
        const original = f.editor.innerHTML;
        assert.equal(f.handleDelete('backward'), false);
        assert.equal(f.editor.innerHTML, original);
        assert.deepEqual(f.commands, []);
    }
    const f = await editingFixture(t, '<p>a<code>bc</code>d</p>');
    f.range.collapsed = false;
    assert.equal(f.handleDelete('forward'), false);
});

test('typing consumes the new-code flag and deleting all content removes the code shell', async (t) => {
    const f = await fixture(t, '<p>a<code data-is-new="true">value</code>d</p>', 5);
    f.domUtils.normalizeInlineCodeAfterInput();
    assert.equal(f.code.hasAttribute('data-is-new'), false);
    f.code.textContent = '';
    f.placeCaret(f.code, 0);
    f.domUtils.normalizeInlineCodeAfterInput();
    assert.ok(!f.editor.querySelector('code'));
    assert.equal(f.editor.textContent, 'ad');
    assert.equal(f.range.startContainer.textContent, '');
});

test('input cleanup removes split empty code shells while preserving pending code and source characters', async (t) => {
    const f = await fixture(t, `<p>a<code>${leftMarker}<br></code>d</p><p><code data-is-new="true">\u200B</code><code>\u200B</code></p>`, 0);
    const pending = f.editor.querySelectorAll('code')[1];
    const source = f.editor.querySelectorAll('code')[2];
    pending.firstChild.mdwCaretAnchor = '\u200B';
    f.domUtils.normalizeInlineCodeAfterInput();
    const codes = Array.from(f.editor.querySelectorAll('code'));
    assert.deepEqual(codes, [pending, source]);
    assert.equal(codes.length, 2);
    assert.equal(codes[0].getAttribute('data-is-new'), 'true');
    assert.equal(codes[1].textContent, '\u200B');
});

test('Shift+Left outside code selects from its visible end and keeps the stable inside-left marker', async (t) => {
    const f = await editingFixture(t, `<p>a<code>${leftMarker}bc</code>\u200Bd</p>`);
    const after = f.code.nextSibling;
    after.mdwCaretAnchor = '\u200B';
    f.placeCaret(after, 1);
    const start = editorSource.indexOf('    function prepareInlineCodeSelectionArrow(');
    const end = editorSource.indexOf('    function handleArrowKeydown(', start);
    const prepare = new Function('domUtils', 'cursorManager', 'placeCollapsedCaret',
        `${editorSource.slice(start, end)}\nreturn prepareInlineCodeSelectionArrow;`
    )(f.domUtils, f.cursorManager, (_selection, node, offset) => f.placeCaret(node, offset));
    const marker = f.code.firstChild;
    prepare({ key: 'ArrowLeft', shiftKey: true });
    assert.equal(f.range.startContainer, f.code.lastChild);
    assert.equal(f.range.startOffset, 2);
    assert.equal(after.textContent, 'd');
    assert.equal(f.code.firstChild, marker);
});

for (const before of ['text', '\uFEFF']) {
    test(`entering empty code after ${before === 'text' ? 'text' : 'an outside caret anchor'} starts input after its editable anchor`, async (t) => {
        const f = await fixture(t, `<p>${before}<code data-is-new="true">\u200B</code></p>`, 1);
        const { CursorManager } = await cursorManagerModule;
        const manager = new CursorManager(f.editor, f.domUtils);
        const text = f.code.firstChild;
        assert.equal(manager._placeCursorInsideInlineCodeStart(f.code, window.getSelection()), true);
        assert.equal(f.range.startContainer, text);
        assert.equal(f.range.startOffset, 1);
        assert.equal(f.domUtils.getCaretAnchorOffset(text), 0);
        assert.equal(f.code.textContent, '\u200B');
        assert.equal(manager.hasActiveInlineCodeBoundaryState(), true);
    });
}
