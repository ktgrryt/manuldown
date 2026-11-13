const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const editorSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'editor.js'), 'utf8');
const importModule = name => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'media', 'modules', name), 'utf8');
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
};
const modules = Promise.all([importModule('DOMUtils.js'), importModule('StateManager.js')]);

function extractFunction(name) {
    const start = editorSource.indexOf(`    function ${name}(`);
    assert.notEqual(start, -1, `editor.js must define ${name}`);
    const end = editorSource.indexOf('\n    }\n', start);
    return editorSource.slice(start, end + '\n    }'.length);
}

// Domino has no Range implementation. Native character deletion below supplies
// its resulting caret; the editor's structural edits and deferred work are real.
class TestRange {
    setStart(node, offset) {
        this.startContainer = this.endContainer = node;
        this.startOffset = this.endOffset = offset;
    }
    setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; }
    collapse() { this.endContainer = this.startContainer; this.endOffset = this.startOffset; }
    get collapsed() { return this.startContainer === this.endContainer && this.startOffset === this.endOffset; }
    get commonAncestorContainer() { return this.startContainer; }
    cloneRange() { return Object.assign(new TestRange(), this); }
    selectNodeContents(node) { this.root = node; }
    toString() {
        const prefix = node => {
            if (node === this.endContainer) {
                return node.nodeType === 3 ? node.data.slice(0, this.endOffset)
                    : Array.from(node.childNodes).slice(0, this.endOffset).map(child => child.textContent).join('');
            }
            let text = '';
            for (const child of Array.from(node.childNodes)) {
                if (child === this.endContainer || child.contains(this.endContainer)) return text + prefix(child);
                text += child.textContent;
            }
            return text;
        };
        return prefix(this.root);
    }
}

async function createFixture(html) {
    const [{ DOMUtils }, { StateManager }] = await modules;
    const window = domino.createWindow(`<div id="editor">${html}</div>`);
    const document = window.document;
    const editor = document.getElementById('editor');
    const nodeListPrototype = Object.getPrototypeOf(editor.querySelectorAll('li'));
    const previousForEach = nodeListPrototype.forEach;
    nodeListPrototype.forEach = Array.prototype.forEach;
    const previous = { window: global.window, document: global.document, Node: global.Node, NodeFilter: global.NodeFilter };
    Object.assign(global, { window, document, Node: window.Node, NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 } });
    document.createRange = () => new TestRange();
    editor.focus = () => {};
    let range = null;
    const selection = {
        get rangeCount() { return range ? 1 : 0; },
        get isCollapsed() { return !range || range.collapsed; },
        getRangeAt: () => range,
        removeAllRanges() { range = null; },
        addRange(next) { range = next; },
    };
    window.getSelection = () => selection;
    const stateManager = new StateManager(editor, {});
    const frames = new Map();
    let nextFrame = 1;
    const requestAnimationFrame = callback => { const id = nextFrame++; frames.set(id, callback); return id; };
    const cancelAnimationFrame = id => frames.delete(id);
    document.execCommand = command => {
        assert.equal(command, 'delete');
        assert.equal(range.startContainer.nodeType, 3);
        assert.ok(range.startOffset > 0);
        const node = range.startContainer;
        const offset = range.startOffset - 1;
        node.deleteData(offset, 1);
        range.setStart(node, offset);
        return true;
    };
    const names = [
        'handleBackspace', 'handleBackspaceAfterMathBlock', 'placeCollapsedCaret',
        'hasDirectTextContent', 'getDirectTextContent', 'isRangeAtListItemStart',
        'hasCheckboxAtStart', 'hasCheckbox', 'getCheckboxInListItemDirectContent',
        'listItemHasDirectImage', 'hasNestedListChild', 'getFirstDirectTextNode',
        'unwrapListItemContent', 'isIgnorableEditorTextValue', 'isEditorEffectivelyEmpty',
        'isRenderableEditorNode', 'isEffectivelyEmptyBlock', 'getClosestBlockElement',
        'isAtBlockStartForRange', 'performEditorHistoryCommand',
    ];
    const deferredStart = editorSource.indexOf('    const pendingCaretPlacements = new Set();');
    const deferredEnd = editorSource.indexOf('    function getCodeBlockCursorOffset(', deferredStart);
    const keyFlushStart = editorSource.indexOf("        editor.addEventListener('keydown', (e) => {\n            if (!e.isComposing && !isComposing)");
    assert.notEqual(keyFlushStart, -1);
    const keyFlushEnd = editorSource.indexOf('        document.addEventListener(\'pointerdown\'', keyFlushStart);
    const helpers = new Function('window', 'document', 'editor', 'domUtils', 'stateManager',
        'requestAnimationFrame', 'cancelAnimationFrame',
        `let historyCaretViewportOffsetPending = null;
        const performAuxiliaryHistoryCommand = () => false;
        const stopManualPointerSelection = () => {};
        const typingUndoGroup = { break() {} };
        const captureHistoryCaretViewportOffset = () => {};
        const syncUiAfterHistoryRestore = () => {};
        const revealCaretAfterHistoryRestore = () => {};
        const normalizeListRenderingAfterStructureChange = () => {};
        const notifyChange = () => {};
        const isComposing = false;
        ${editorSource.slice(deferredStart, deferredEnd)}
        ${editorSource.slice(keyFlushStart, keyFlushEnd)}
        ${names.map(extractFunction).join('\n')}
        return { backspace: handleBackspace, history: performEditorHistoryCommand,
            flushPendingCaretPlacement };`
    )(window, document, editor, new DOMUtils(editor), stateManager, requestAnimationFrame, cancelAnimationFrame);
    return {
        editor, selection, stateManager, ...helpers,
        select(node, offset) { range = new TestRange(); range.setStart(node, offset); },
        keydown(key) {
            const event = document.createEvent('Event');
            event.initEvent('keydown', true, true);
            event.key = key;
            event.isComposing = false;
            editor.dispatchEvent(event);
        },
        runFrame() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); },
        dispose() {
            stateManager.clearHistory();
            if (previousForEach === undefined) delete nodeListPrototype.forEach;
            else nodeListPrototype.forEach = previousForEach;
            Object.assign(global, previous);
        },
    };
}

test('repeated character Backspace keeps its caret ahead of unrelated nested lists and mixed blocks', async () => {
    for (const content of ['abcdef', '<strong>abcdef</strong>', '<em>abcdef</em>', '<a href="file.md">abcdef</a>']) {
        const f = await createFixture(`<h2>Heading</h2><p id="active">${content}</p>` +
            '<blockquote><p>quoted</p></blockquote><pre><code>code</code></pre>' +
            '<ul><li data-preserve-empty="true">&nbsp;<ul><li>nested</li></ul></li></ul><p>last</p>');
        try {
            const active = f.editor.querySelector('#active');
            const text = active.firstChild.nodeType === 3 ? active.firstChild : active.firstChild.firstChild;
            const last = f.editor.lastChild;
            f.select(text, 6);
            for (let remaining = 5; remaining > 0; remaining--) {
                f.flushPendingCaretPlacement();
                assert.equal(f.backspace(), true);
                f.runFrame();
                assert.equal(text.data, 'abcdef'.slice(0, remaining));
                assert.equal(f.selection.getRangeAt(0).startContainer, text);
                assert.equal(f.selection.getRangeAt(0).startOffset, remaining);
                assert.equal(f.editor.lastChild, last);
                assert.equal(f.editor.querySelector('li li').textContent, 'nested');
            }
        } finally { f.dispose(); }
    }
});

test('Undo before the Backspace caret frame cannot replay a selection on detached content', async () => {
    const f = await createFixture('<ul><li>draft</li></ul><p>last</p>');
    try {
        f.select(f.editor.querySelector('li').firstChild, 0);
        f.stateManager.seedState();
        f.stateManager.saveState();
        assert.equal(f.backspace(), true);
        assert.equal(f.editor.firstChild.tagName, 'P');
        // VS Code can deliver its history command before the next paint.
        assert.equal(f.history('undo'), true);
        f.stateManager.flushPendingHistoryRestore();
        const restored = f.selection.getRangeAt(0);
        assert.ok(f.editor.contains(restored.startContainer));
        f.runFrame();
        assert.ok(f.editor.contains(f.selection.getRangeAt(0).startContainer),
            'the deferred Backspace caret must finish before Undo replaces its paragraph');
        assert.equal(f.selection.getRangeAt(0).startContainer, restored.startContainer);
        assert.equal(f.editor.firstChild.tagName, 'UL');
    } finally { f.dispose(); }
});

test('a subsequent Backspace flushes pending deletion cleanup before it edits again', async () => {
    const f = await createFixture('<p>abcdef</p><ul><li data-preserve-empty="true">&nbsp;<ul><li>nested</li></ul></li></ul><p>last</p>');
    try {
        const text = f.editor.firstChild.firstChild;
        f.select(text, 6);
        f.keydown('Backspace');
        f.backspace();
        // The browser has not painted the first edit when the next key arrives.
        f.keydown('Backspace');
        f.backspace();
        const latestRange = f.selection.getRangeAt(0);
        assert.equal(text.data, 'abcd');
        assert.equal(latestRange.startOffset, 4);
        f.runFrame();
        assert.equal(f.selection.getRangeAt(0), latestRange);
        assert.equal(f.selection.getRangeAt(0).startContainer, text);
        assert.equal(f.editor.querySelector('li li').textContent, 'nested');
    } finally { f.dispose(); }
});

test('rapid Undo and Redo after Backspace leave the next character deletion in the restored paragraph', async () => {
    const f = await createFixture('<ul><li>draft</li></ul><p>last</p>');
    try {
        f.select(f.editor.querySelector('li').firstChild, 0);
        f.stateManager.seedState();
        f.stateManager.saveState();
        f.backspace();
        assert.equal(f.history('undo'), true);
        assert.equal(f.history('redo'), true);
        f.keydown('Backspace');
        f.runFrame();
        const paragraph = f.editor.firstChild;
        assert.equal(paragraph.tagName, 'P');
        assert.ok(paragraph.contains(f.selection.getRangeAt(0).startContainer));
        f.select(paragraph.firstChild, 5);
        f.keydown('Backspace');
        f.backspace();
        f.runFrame();
        assert.equal(paragraph.textContent, 'draf');
        assert.equal(f.selection.getRangeAt(0).startContainer, paragraph.firstChild);
        assert.equal(f.selection.getRangeAt(0).startOffset, 4);
        assert.equal(f.editor.lastChild.textContent, 'last');
    } finally { f.dispose(); }
});
