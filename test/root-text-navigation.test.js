const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

function importModule(name) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'media/modules', name), 'utf8');
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
const modules = Promise.all([importModule('DOMUtils.js'), importModule('CursorManager.js')]);
const editorSource = fs.readFileSync(path.join(__dirname, '..', 'media/editor.js'), 'utf8');

function extractEditorFunction(name) {
    const start = editorSource.indexOf(`    function ${name}(`);
    const end = editorSource.indexOf('\n    }', start);
    assert.ok(start >= 0 && end > start, `${name} exists`);
    return editorSource.slice(start, end + '\n    }'.length);
}

function childIndex(node) {
    return Array.from(node.parentNode.childNodes).indexOf(node);
}

// Preserve DOM boundary ordering, including a parent boundary before its text.
// Equality-only comparators would incorrectly report every earlier caret as end.
function comparePoints(aNode, aOffset, bNode, bOffset) {
    if (aNode === bNode) return Math.sign(aOffset - bOffset);
    if (aNode.contains(bNode)) {
        let child = bNode;
        while (child.parentNode !== aNode) child = child.parentNode;
        return aOffset <= childIndex(child) ? -1 : 1;
    }
    if (bNode.contains(aNode)) return -comparePoints(bNode, bOffset, aNode, aOffset);
    const ancestors = [];
    for (let node = aNode; node; node = node.parentNode) ancestors.push(node);
    let bChild = bNode;
    while (!ancestors.includes(bChild.parentNode)) bChild = bChild.parentNode;
    let aChild = aNode;
    while (aChild.parentNode !== bChild.parentNode) aChild = aChild.parentNode;
    return Math.sign(childIndex(aChild) - childIndex(bChild));
}

class TestRange {
    constructor() { this.collapsed = true; }
    setStart(node, offset) {
        this.startContainer = node;
        this.startOffset = offset;
        if (this.collapsed || !this.endContainer) this.setEnd(node, offset);
    }
    setEnd(node, offset) {
        this.endContainer = node;
        this.endOffset = offset;
        this.collapsed = this.startContainer === node && this.startOffset === offset;
    }
    collapse(toStart) {
        if (toStart) this.setEnd(this.startContainer, this.startOffset);
        else { this.startContainer = this.endContainer; this.startOffset = this.endOffset; }
        this.collapsed = true;
    }
    setStartBefore(node) { this.setStart(node.parentNode, childIndex(node)); }
    setStartAfter(node) { this.setStart(node.parentNode, childIndex(node) + 1); }
    selectNode(node) {
        this.setStartBefore(node);
        this.setEnd(node.parentNode, childIndex(node) + 1);
    }
    selectNodeContents(node) {
        this.setStart(node, 0);
        this.setEnd(node, node.nodeType === 3 ? node.data.length : node.childNodes.length);
    }
    cloneRange() { return Object.assign(new TestRange(), this); }
    compareBoundaryPoints(how, other) {
        assert.ok(how === TestRange.START_TO_START || how === TestRange.END_TO_END);
        return how === TestRange.START_TO_START
            ? comparePoints(this.startContainer, this.startOffset, other.startContainer, other.startOffset)
            : comparePoints(this.endContainer, this.endOffset, other.endContainer, other.endOffset);
    }
    get commonAncestorContainer() { return this.startContainer; }
}
TestRange.START_TO_START = 0;
TestRange.END_TO_END = 2;

async function fixture(t, textHtml = 'あああああ') {
    const [{ DOMUtils }, { CursorManager }] = await modules;
    const window = domino.createWindow(`<div id="editor">${textHtml}` +
        '<div class="md-table-insert-line vertical" data-exclude-from-markdown="true" contenteditable="false" aria-hidden="true" style="display:none"></div>' +
        '<div class="md-table-insert-line horizontal" data-exclude-from-markdown="true" contenteditable="false" aria-hidden="true" style="display:none"></div></div>');
    const document = window.document;
    const editor = document.getElementById('editor');
    let range = null;
    const selection = {
        get rangeCount() { return range ? 1 : 0; },
        get isCollapsed() { return !!range?.collapsed; },
        getRangeAt: () => range,
        removeAllRanges: () => { range = null; },
        addRange: next => { range = next; },
    };
    window.getSelection = () => selection;
    document.createRange = () => new TestRange();
    const globals = { window, document, Node: window.Node, Range: TestRange,
        NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 } };
    const originals = Object.fromEntries(Object.keys(globals).map(key => [key, global[key]]));
    Object.assign(global, globals);
    t.after(() => {
        for (const [key, value] of Object.entries(originals)) {
            if (value === undefined) delete global[key];
            else global[key] = value;
        }
    });
    const cursorManager = new CursorManager(editor, new DOMUtils(editor));
    return {
        editor, selection, cursorManager,
        placeCaret(node, offset) {
            range = new TestRange();
            range.setStart(node, offset);
            range.collapse(true);
            return range;
        },
    };
}

function hostNavigation(f) {
    const dependencies = {
        editor: f.editor, cursorManager: f.cursorManager, isMac: true,
        settingsState: { useVsCodeCtrlP: false },
        tableManager: { handleCtrlNavKeydown: () => false },
        footnoteManager: { handleKeydown: () => false },
        // Native ArrowRight owns plain first-line text. Host Ctrl+F continues
        // through the logical-end check and the custom forward movement path.
        handleArrowKeydown: () => false,
        recordCtrlNavHandled() {},
        getSelectedCodeBlockLanguageLabel: () => null,
        isHRSelected: () => false,
        isCursorOnCheckbox: () => false,
        moveCursorOutOfInlineCodeRight: () => false,
        handleEmptyLineAboveCodeBlockNav: () => false,
        exitCodeBlockDownIfAtEnd: () => false,
        getSelectedImageNodeFromRange: () => null,
        getCtrlKTargetImageAtLeftEdge: () => null,
        isAtBlockquoteEnd: () => false,
        notifyChange: () => assert.fail('Navigation must not edit the document'),
        syncImageCaretEdgeIndicatorsNow() {},
        correctCheckboxCursorPosition() {},
        setTimeout: callback => callback(),
    };
    return new Function(...Object.keys(dependencies),
        `${extractEditorFunction('createArrowNavEventFromDirection')}
        ${extractEditorFunction('handleEmacsNavKeydown')}
        return handleEmacsNavKeydown;`
    )(...Object.values(dependencies));
}

test('committed root text sets the logical document end after its last character', async t => {
    const f = await fixture(t);
    const text = f.editor.firstChild;
    const end = f.cursorManager._buildLogicalEditorEndRange();
    assert.ok(end.startContainer === text, 'logical end stays in the committed text');
    assert.equal(end.startOffset, 5);
    for (let offset = 0; offset <= 5; offset++) {
        f.placeCaret(text, offset);
        assert.equal(f.cursorManager.isAtLogicalEditorEnd(), offset === 5, `text offset ${offset}`);
    }
    f.placeCaret(f.editor, 0);
    assert.equal(f.cursorManager.isAtLogicalEditorEnd(), false, 'the boundary before root text is not the end');
});

test('an empty block after committed root text remains part of the logical document', async t => {
    const f = await fixture(t, 'あああああ<div><br></div>');
    const text = f.editor.firstChild;
    const emptyBlock = text.nextSibling;
    const end = f.cursorManager._buildLogicalEditorEndRange();
    assert.ok(end.startContainer === emptyBlock, 'logical end includes the empty block after root text');
    assert.equal(end.startOffset, emptyBlock.childNodes.length);
    f.placeCaret(text, 5);
    assert.equal(f.cursorManager.isAtLogicalEditorEnd(), false);
    f.placeCaret(emptyBlock, emptyBlock.childNodes.length);
    assert.equal(f.cursorManager.isAtLogicalEditorEnd(), true);
});

for (const html of ['あああああ', '<p>あああああ</p>']) {
    test(`host Control+F advances through committed text without editing: ${html}`, async t => {
        const f = await fixture(t, html);
        const text = f.editor.querySelector('p')?.firstChild || f.editor.firstChild;
        f.placeCaret(text, 0);
        const navigate = hostNavigation(f);
        const original = f.editor.innerHTML;
        for (let step = 1; step <= 6; step++) {
            const event = { key: 'f', code: 'KeyF', keyCode: 70, ctrlKey: true, __fromCommand: true,
                preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
            assert.equal(navigate(event), true);
            assert.equal(event.defaultPrevented, true);
            assert.ok(f.selection.getRangeAt(0).startContainer === text, 'Control+F stays in the committed text');
            assert.equal(f.selection.getRangeAt(0).startOffset, Math.min(step, 5));
            assert.equal(f.editor.innerHTML, original);
        }
    });
}

for (const whitespace of ['', '\n  ', '\u200B\u2060\uFEFF', '\u00A0']) {
    test(`root formatting whitespace remains ignorable: ${JSON.stringify(whitespace)}`, async t => {
        const f = await fixture(t, `${whitespace}<p>既存の段落</p>\n `);
        const paragraphText = f.editor.querySelector('p').firstChild;
        const rootWhitespace = Array.from(f.editor.childNodes).filter(node => node.nodeType === 3);
        for (const text of rootWhitespace) assert.equal(f.cursorManager._isIgnorableTextNode(text), true);
        assert.equal(f.cursorManager._isIgnorableTextNode(paragraphText), false);
        const end = f.cursorManager._buildLogicalEditorEndRange();
        assert.ok(end.startContainer === paragraphText, 'formatting whitespace does not replace the paragraph end');
        assert.equal(end.startOffset, paragraphText.data.length);
    });
}
