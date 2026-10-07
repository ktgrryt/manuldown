const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const importModule = name => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'media', 'modules', name), 'utf8');
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
};
const modules = Promise.all([importModule('CursorManager.js'), importModule('DOMUtils.js')]);
const math = '<span class="mdw-math" data-mdw-math="inline" contenteditable="false">E=mc^2</span>';
const indexOf = node => Array.prototype.indexOf.call(node.parentNode.childNodes, node);

function comparePoints(a, aOffset, b, bOffset) {
    if (a === b) return Math.sign(aOffset - bOffset);
    if (a.contains(b)) {
        let child = b;
        while (child.parentNode !== a) child = child.parentNode;
        return aOffset <= indexOf(child) ? -1 : 1;
    }
    if (b.contains(a)) return -comparePoints(b, bOffset, a, aOffset);
    let ancestor = a.parentNode;
    while (!ancestor.contains(b)) ancestor = ancestor.parentNode;
    let aChild = a;
    let bChild = b;
    while (aChild.parentNode !== ancestor) aChild = aChild.parentNode;
    while (bChild.parentNode !== ancestor) bChild = bChild.parentNode;
    return Math.sign(indexOf(aChild) - indexOf(bChild));
}

class CaretRange {
    static START_TO_START = 0;
    get collapsed() {
        return this.startContainer === this.endContainer && this.startOffset === this.endOffset;
    }
    setStart(node, offset) { this.startContainer = node; this.startOffset = offset; }
    setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; }
    setStartBefore(node) { this.setStart(node.parentNode, indexOf(node)); }
    setStartAfter(node) { this.setStart(node.parentNode, indexOf(node) + 1); }
    selectNode(node) {
        this.setStartBefore(node);
        this.setEnd(node.parentNode, indexOf(node) + 1);
    }
    collapse(atStart) {
        if (atStart) this.setEnd(this.startContainer, this.startOffset);
        else this.setStart(this.endContainer, this.endOffset);
    }
    cloneRange() { return Object.assign(new CaretRange(), this); }
    compareBoundaryPoints(how, other) {
        assert.equal(how, CaretRange.START_TO_START);
        return comparePoints(this.startContainer, this.startOffset, other.startContainer, other.startOffset);
    }
}

async function fixture(t, html) {
    const [{ CursorManager }, { DOMUtils }] = await modules;
    const window = domino.createWindow(`<div id="editor"><p>above</p>${html}<p>below</p></div>`);
    const document = window.document;
    const editor = document.getElementById('editor');
    const formula = editor.querySelector('span[data-mdw-math]');
    let range;
    const selection = {
        get rangeCount() { return range ? 1 : 0; },
        get isCollapsed() { return range?.collapsed; },
        getRangeAt: () => range,
        removeAllRanges() { range = null; },
        addRange(next) { range = next; },
    };
    window.getSelection = () => selection;
    document.createRange = () => new CaretRange();
    const originals = new Map();
    for (const [name, value] of Object.entries({ window, document, Node: window.Node, Range: CaretRange })) {
        originals.set(name, Object.getOwnPropertyDescriptor(global, name));
        Object.defineProperty(global, name, { configurable: true, writable: true, value });
    }
    t.after(() => {
        for (const [name, descriptor] of originals) {
            if (descriptor) Object.defineProperty(global, name, descriptor);
            else delete global[name];
        }
    });
    return {
        editor, formula, manager: new CursorManager(editor, new DOMUtils(editor)), selection,
        get range() { return range; },
        select(position) {
            range = new CaretRange();
            if (position === 'selected') range.selectNode(formula);
            else {
                if (position === 'before') range.setStartBefore(formula);
                else range.setStartAfter(formula);
                range.collapse(true);
            }
        },
    };
}

for (const [name, html, start, end] of [
    ['middle', `<p id="target">before ${math} after</p>`, e => [e.firstChild, 0], e => [e.lastChild, 6]],
    ['leading', `<p id="target">${math} after</p>`, e => [e, 0], e => [e.lastChild, 6]],
    ['trailing', `<p id="target">before ${math}</p>`, e => [e.firstChild, 0], e => [e, 2]],
    ['only', `<p id="target">${math}</p>`, e => [e, 0], e => [e, 1]],
    ['formatted', `<p id="target"><strong>${math}</strong> after</p>`, e => [e.firstChild, 0], e => [e.lastChild, 6]],
    ['line break', `<p id="target">previous<br>${math} after<br>next</p>`, e => [e, 2], e => [e.childNodes[3], 6]],
    ['nested list', `<ul><li id="target">${math} after<ul><li>child</li></ul></li></ul>`, e => [e, 0], e => [e.childNodes[1], 6]],
]) {
    test(`line commands reach the logical endpoints around ${name} math`, async t => {
        const f = await fixture(t, html);
        const block = f.editor.querySelector('#target');
        const before = f.editor.innerHTML;
        for (const position of ['before', 'after', 'selected']) {
            for (const [method, endpoint] of [['moveCursorToLineStart', start], ['moveCursorToLineEnd', end]]) {
                f.select(position);
                f.manager[method]();
                const [node, offset] = endpoint(block);
                assert.ok(f.range.startContainer === node, `${method} from ${position}: editable endpoint`);
                assert.equal(f.range.startOffset, offset);
                assert.equal(f.range.collapsed, true);
                assert.equal(f.formula.contains(f.range.startContainer), false);
                // Repeating the command must stay on the current line.
                f.manager[method]();
                assert.ok(f.range.startContainer === node);
                assert.equal(f.range.startOffset, offset);
            }
        }
        assert.equal(f.editor.innerHTML, before);
    });
}

test('line commands use normal text endpoints on other lines of a math paragraph', async t => {
    const f = await fixture(t, `<p id="target">previous<br>${math} after<br>next</p>`);
    const block = f.editor.querySelector('#target');
    for (const text of [block.firstChild, block.lastChild]) {
        const range = new CaretRange();
        range.setStart(text, 2);
        range.collapse(true);
        f.selection.addRange(range);
        f.manager.moveCursorToLineStart();
        assert.ok(f.range.startContainer === text);
        assert.equal(f.range.startOffset, 0);
        f.manager.moveCursorToLineEnd();
        assert.ok(f.range.startContainer === text);
        assert.equal(f.range.startOffset, text.textContent.length);
    }
});

test('math line endpoints ignore temporary caret anchors while preserving user text', async t => {
    const f = await fixture(t, `<p id="target">\u200B${math}\u200B</p>`);
    const block = f.editor.querySelector('#target');
    block.firstChild.mdwCaretAnchor = { character: '\u200B', text: '\u200B', offset: 0 };
    block.lastChild.mdwCaretAnchor = { character: '\u200B', text: '\u200B', offset: 0 };
    f.select('after');
    f.manager.moveCursorToLineStart();
    assert.ok(f.range.startContainer === block);
    assert.equal(f.range.startOffset, 1);
    f.manager.moveCursorToLineEnd();
    assert.ok(f.range.startContainer === block);
    assert.equal(f.range.startOffset, 2);
    assert.equal(block.textContent, '\u200BE=mc^2\u200B');
});

test('line navigation does not treat fenced source or another document as inline math', async t => {
    const f = await fixture(t, `<pre>${math}</pre>`);
    f.select('after');
    assert.equal(f.manager._moveToMathLineBoundary(f.selection, true), false);
    const outside = document.createElement('p');
    outside.innerHTML = math;
    const range = new CaretRange();
    range.setStart(outside, 1);
    range.collapse(true);
    f.selection.addRange(range);
    assert.equal(f.manager._moveToMathLineBoundary(f.selection, false), false);
});
