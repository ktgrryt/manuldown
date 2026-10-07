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
const editorSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'editor.js'), 'utf8');
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
    getBoundingClientRect() { return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }; }
    getClientRects() { return []; }
    compareBoundaryPoints(how, other) {
        assert.equal(how, CaretRange.START_TO_START);
        return comparePoints(this.startContainer, this.startOffset, other.startContainer, other.startOffset);
    }
}

const rect = (left, top, width, height = 16) => ({
    left, right: left + width, top, bottom: top + height, width, height, x: left, y: top,
});

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

test('a caret at either formula boundary uses the formula edge instead of the paragraph bounds', async t => {
    const f = await fixture(t, `<p id="target">${math}</p>`);
    const block = f.editor.querySelector('#target');
    block.getBoundingClientRect = () => rect(20, 40, 400, 60);
    f.formula.getBoundingClientRect = () => rect(60, 52, 80);
    for (const [position, expectedX] of [['before', 60], ['after', 140]]) {
        f.select(position);
        const caret = f.manager._getCaretRect(f.range);
        assert.equal(caret.left, expectedX, position);
        assert.equal(caret.width, 0);
        assert.equal(caret.top, 52);
        assert.equal(caret.height, 16);
    }
});

async function verticalFixture(t, html = `<p id="target">${math}</p>`) {
    const f = await fixture(t, html);
    const block = f.editor.querySelector('#target');
    const above = f.editor.firstChild;
    const below = f.editor.lastChild;
    above.textContent = below.textContent = 'abcdefghijklmnopqrstuv';
    f.formula.getBoundingClientRect = () => rect(60, 40, 80);
    f.manager._getVisualLinesForBlock = node => [rect(20, node === above ? 10 : node === below ? 70 : 40, 300)];
    const originalGetCaretRect = f.manager._getCaretRect.bind(f.manager);
    f.manager._getCaretRect = range => {
        if (range.startContainer === above.firstChild) return rect(20 + range.startOffset * 10, 10, 0);
        if (range.startContainer === below.firstChild) return rect(20 + range.startOffset * 10, 70, 0);
        return originalGetCaretRect(range);
    };
    // Chromium skips an atomic-only line when probing its center. Text lines
    // return the nearest text caret, as a native point probe would.
    document.caretRangeFromPoint = (x, y) => {
        const range = new CaretRange();
        const target = y < 30 ? above : below;
        range.setStart(target.firstChild, Math.round((x - 20) / 10));
        range.collapse(true);
        return range;
    };
    return { ...f, block, above, below };
}

for (const [direction, startBlock, nextBlock] of [['down', 'above', 'below'], ['up', 'below', 'above']]) {
    test(`${direction} stops on a formula-only line and keeps the original column on the next step`, async t => {
        const f = await verticalFixture(t);
        const original = f.editor.innerHTML;
        const start = new CaretRange();
        start.setStart(f[startBlock].firstChild, 10);
        start.collapse(true);
        f.selection.addRange(start);

        const move = direction === 'up' ? 'moveCursorUp' : 'moveCursorDown';
        f.manager[move](() => assert.fail('cursor movement must not edit the document'));
        let range = f.selection.getRangeAt(0);
        assert.ok(range.startContainer === f.block);
        assert.equal(range.startOffset, 1, 'the nearest formula edge is its right side');
        assert.equal(range.collapsed, true);
        assert.equal(f.formula.contains(range.startContainer), false);

        f.manager[move](() => assert.fail('cursor movement must not edit the document'));
        range = f.selection.getRangeAt(0);
        assert.ok(range.startContainer === f[nextBlock].firstChild);
        assert.equal(range.startOffset, 10, 'the formula width must not change the preferred column');
        assert.equal(f.editor.innerHTML, original);
    });
}

test('vertical movement chooses the nearest edge even when the point probe reports the other formula boundary', async t => {
    const f = await verticalFixture(t);
    const start = new CaretRange();
    start.setStart(f.above.firstChild, 10);
    start.collapse(true);
    f.selection.addRange(start);
    document.caretRangeFromPoint = () => {
        const probe = new CaretRange();
        probe.setStart(f.block, 0);
        probe.collapse(true);
        return probe;
    };
    assert.equal(f.manager._moveVerticallyAcrossInlineMath(f.selection, 'down'), true);
    const range = f.selection.getRangeAt(0);
    assert.ok(range.startContainer === f.block);
    assert.equal(range.startOffset, 1);
});

test('math navigation leaves ordinary text on the target line to normal vertical movement', async t => {
    const f = await verticalFixture(t, `<p id="target">${math} after</p>`);
    f.manager._getVisualCaretRectForRange = range => rect(180, range.startContainer === f.above.firstChild ? 10 : 40, 0);
    const start = new CaretRange();
    start.setStart(f.above.firstChild, 3);
    start.collapse(true);
    f.selection.addRange(start);
    document.caretRangeFromPoint = () => {
        const probe = new CaretRange();
        probe.setStart(f.block.lastChild, 3);
        probe.collapse(true);
        return probe;
    };
    assert.equal(f.manager._moveVerticallyAcrossInlineMath(f.selection, 'down'), false);
    assert.ok(f.selection.getRangeAt(0) === start);
});

test('a formula on a wrapped line is reached before the following line', async t => {
    const f = await verticalFixture(t, `<p id="target">before<br>${math}<br>after</p>`);
    f.manager._getVisualLinesForBlock = () => [rect(20, 10, 300), rect(20, 40, 300), rect(20, 70, 300)];
    f.manager._getVisualCaretRectForRange = range => rect(120,
        range.startContainer === f.block.firstChild ? 10 : range.startContainer === f.block.lastChild ? 70 : 40, 0);
    const start = new CaretRange();
    start.setStart(f.block.firstChild, 3);
    start.collapse(true);
    f.selection.addRange(start);
    document.caretRangeFromPoint = () => {
        const probe = new CaretRange();
        probe.setStart(f.block.lastChild, 3);
        probe.collapse(true);
        return probe;
    };
    assert.equal(f.manager._moveVerticallyAcrossInlineMath(f.selection, 'down'), true);
    const range = f.selection.getRangeAt(0);
    assert.ok(range.startContainer === f.block);
    assert.equal(range.startOffset, 3, 'caret stops after the formula on the middle line');
});

test('pressing Control again between Ctrl+N steps preserves the column while pointer input resets it', async t => {
    const f = await verticalFixture(t);
    const start = editorSource.indexOf("        // キーボードイベント\n        editor.addEventListener('keydown',");
    const end = editorSource.indexOf('        // mousedownイベント', start);
    assert.ok(start >= 0 && end > start);
    new Function('editor', 'cursorManager', 'window', 'handleKeydown', `
        const isMac = true, isComposing = false;
        const compositionUpdateGate = { composing: false };
        const isImeInteractionKeydown = () => false;
        const handleVerticalNavigation = navigate => navigate();
        const footnoteManager = { normalizeCaret() {} };
        const mathManager = { normalizeCaret() {} };
        const codeBlockGapManager = { reconcile() {} };
        const syncCheckboxCaretIndicatorNow = () => {};
        const revealCaretAfterKeyboardNavigation = () => {};
        ${editorSource.slice(start, end)}
    `)(f.editor, f.manager, window, event => {
        if (event.key === 'n') f.manager.moveCursorDown(() => assert.fail('navigation must not change the document'));
    });
    const range = new CaretRange();
    range.setStart(f.above.firstChild, 10);
    range.collapse(true);
    f.selection.addRange(range);
    const press = key => {
        const event = new window.Event('keydown', { bubbles: true, cancelable: true });
        Object.assign(event, { key, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false });
        f.editor.dispatchEvent(event);
    };
    press('Control');
    press('n');
    press('Control');
    press('n');
    assert.ok(f.selection.getRangeAt(0).startContainer === f.below.firstChild);
    assert.equal(f.selection.getRangeAt(0).startOffset, 10);
    f.editor.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    assert.equal(f.manager._inlineMathVerticalCaret, null);
});
