const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const source = fs.readFileSync(path.join(__dirname, '..', 'media/modules/TableManager.js'), 'utf8');
const modulePromise = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

// Preserve DOM boundary order, including empty/atomic nodes and the difference
// between a parent offset before a child and offset zero inside that child.
// Flattening textContent would hide precisely the table-boundary bugs below.
function comparePoints(nodeA, offsetA, nodeB, offsetB) {
    if (nodeA === nodeB) return Math.sign(offsetA - offsetB);
    const pathA = [], pathB = [];
    for (let node = nodeA; node; node = node.parentNode) pathA.unshift(node);
    for (let node = nodeB; node; node = node.parentNode) pathB.unshift(node);
    assert.equal(pathA[0], pathB[0], 'boundary points must share a document');
    let index = 0;
    while (pathA[index] === pathB[index]) index++;
    if (index === pathA.length) {
        const childIndex = Array.from(nodeA.childNodes).indexOf(pathB[index]);
        return offsetA <= childIndex ? -1 : 1;
    }
    if (index === pathB.length) return -comparePoints(nodeB, offsetB, nodeA, offsetA);
    const siblings = Array.from(pathA[index - 1].childNodes);
    return Math.sign(siblings.indexOf(pathA[index]) - siblings.indexOf(pathB[index]));
}

class TestRange {
    static START_TO_START = 0;
    static START_TO_END = 1;
    static END_TO_END = 2;
    static END_TO_START = 3;

    setStart(node, offset) {
        this.startContainer = node;
        this.startOffset = offset;
        if (!this.endContainer || comparePoints(node, offset, this.endContainer, this.endOffset) > 0) {
            this.endContainer = node;
            this.endOffset = offset;
        }
    }

    setEnd(node, offset) {
        this.endContainer = node;
        this.endOffset = offset;
        if (!this.startContainer || comparePoints(this.startContainer, this.startOffset, node, offset) > 0) {
            this.startContainer = node;
            this.startOffset = offset;
        }
    }

    setStartBefore(node) { this.setStart(node.parentNode, Array.from(node.parentNode.childNodes).indexOf(node)); }
    setStartAfter(node) { this.setStart(node.parentNode, Array.from(node.parentNode.childNodes).indexOf(node) + 1); }
    setEndBefore(node) { this.setEnd(node.parentNode, Array.from(node.parentNode.childNodes).indexOf(node)); }
    setEndAfter(node) { this.setEnd(node.parentNode, Array.from(node.parentNode.childNodes).indexOf(node) + 1); }
    selectNode(node) { this.setStartBefore(node); this.setEndAfter(node); }
    selectNodeContents(node) {
        this.setStart(node, 0);
        this.setEnd(node, node.nodeType === 3 ? node.length : node.childNodes.length);
    }
    collapse(toStart = false) {
        if (toStart) this.setEnd(this.startContainer, this.startOffset);
        else this.setStart(this.endContainer, this.endOffset);
    }
    cloneRange() { return Object.assign(new TestRange(), this); }
    get collapsed() { return this.startContainer === this.endContainer && this.startOffset === this.endOffset; }
    get commonAncestorContainer() {
        let node = this.startContainer;
        while (node && node !== this.endContainer && !node.contains(this.endContainer)) node = node.parentNode;
        return node;
    }
    isPointInRange(node, offset) { return this.comparePoint(node, offset) === 0; }
    comparePoint(node, offset) {
        if (comparePoints(node, offset, this.startContainer, this.startOffset) < 0) return -1;
        if (comparePoints(node, offset, this.endContainer, this.endOffset) > 0) return 1;
        return 0;
    }
    compareBoundaryPoints(how, other) {
        const thisEnd = how === TestRange.START_TO_END || how === TestRange.END_TO_END;
        const otherEnd = how === TestRange.END_TO_START || how === TestRange.END_TO_END;
        return comparePoints(thisEnd ? this.endContainer : this.startContainer,
            thisEnd ? this.endOffset : this.startOffset,
            otherEnd ? other.endContainer : other.startContainer,
            otherEnd ? other.endOffset : other.startOffset);
    }
    intersectsNode(node) {
        const parent = node.parentNode;
        if (!parent) return true;
        const index = Array.from(parent.childNodes).indexOf(node);
        return comparePoints(parent, index + 1, this.startContainer, this.startOffset) > 0 &&
            comparePoints(parent, index, this.endContainer, this.endOffset) < 0;
    }
}

async function fixture(t, html) {
    const { TableManager } = await modulePromise;
    const window = domino.createWindow(`<div id="editor" contenteditable="true">${html}</div><p id="elsewhere">Elsewhere</p>`);
    const document = window.document;
    const editor = document.getElementById('editor');
    const originals = { window: global.window, document: global.document, Node: global.Node,
        NodeFilter: global.NodeFilter, Range: global.Range };
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(global, 'navigator');
    const nodeListPrototype = Object.getPrototypeOf(editor.querySelectorAll('table'));
    const previousForEach = nodeListPrototype.forEach;
    nodeListPrototype.forEach = Array.prototype.forEach;
    Object.assign(global, { window, document, Node: window.Node, NodeFilter: window.NodeFilter, Range: TestRange });
    Object.defineProperty(global, 'navigator', { configurable: true, value: { platform: 'MacIntel' } });
    document.createRange = () => new TestRange();
    t.after(() => {
        for (const [key, value] of Object.entries(originals)) {
            if (value === undefined) delete global[key];
            else global[key] = value;
        }
        if (previousForEach === undefined) delete nodeListPrototype.forEach;
        else nodeListPrototype.forEach = previousForEach;
        if (navigatorDescriptor) Object.defineProperty(global, 'navigator', navigatorDescriptor);
        else delete global.navigator;
    });
    let currentRange = null;
    const selection = {
        get rangeCount() { return currentRange ? 1 : 0; },
        get isCollapsed() { return !currentRange || currentRange.collapsed; },
        getRangeAt(index) { assert.equal(index, 0); return currentRange; },
        removeAllRanges() {
            currentRange = null;
            this.anchorNode = this.focusNode = null;
            this.anchorOffset = this.focusOffset = 0;
        },
        setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) {
            const range = new TestRange();
            if (comparePoints(anchorNode, anchorOffset, focusNode, focusOffset) <= 0) {
                range.setStart(anchorNode, anchorOffset); range.setEnd(focusNode, focusOffset);
            } else {
                range.setStart(focusNode, focusOffset); range.setEnd(anchorNode, anchorOffset);
            }
            currentRange = range;
            Object.assign(this, { anchorNode, anchorOffset, focusNode, focusOffset });
        },
        addRange(range) {
            currentRange = range;
            Object.assign(this, { anchorNode: range.startContainer, anchorOffset: range.startOffset,
                focusNode: range.endContainer, focusOffset: range.endOffset });
        },
    };
    window.getSelection = () => selection;
    const manager = new TableManager(editor, {}, {
        saveState() { assert.fail('visual selection must not save history'); },
        commitStateAfterChange() { assert.fail('visual selection must not commit history'); },
    });
    manager.notifyChange = () => assert.fail('visual selection must not notify a document change');
    const tables = Array.from(editor.querySelectorAll('table'));
    const cells = Array.from(editor.querySelectorAll('td, th'));
    return {
        manager, window, document, editor, tables, cells, selection,
        text: selector => editor.querySelector(selector).firstChild,
        select(startNode, startOffset, endNode, endOffset, backward = false) {
            if (backward) selection.setBaseAndExtent(endNode, endOffset, startNode, startOffset);
            else selection.setBaseAndExtent(startNode, startOffset, endNode, endOffset);
        },
        update() { manager.updateWholeTableSelection(); },
        selected: table => table.classList.contains('md-table-whole-selected'),
    };
}

test('range fixture distinguishes text starts from parent boundaries and orders empty atomic nodes', async t => {
    const f = await fixture(t, '<table><tr><td>A<img></td><td><br></td></tr></table>');
    assert.equal(comparePoints(f.cells[0], 0, f.cells[0].firstChild, 0), -1);
    assert.equal(comparePoints(f.cells[0], 1, f.cells[0], 2), -1);
    const range = f.document.createRange();
    range.selectNode(f.cells[0].lastChild);
    assert.equal(range.isPointInRange(f.cells[0], 1), true);
    assert.equal(range.isPointInRange(f.cells[0], 2), true);
    assert.equal(range.isPointInRange(f.cells[0].firstChild, 1), false);
});

test('all explicit cell highlights select the table while a partial rectangle and stale cell references do not', async t => {
    const f = await fixture(t, '<table><tr><th>A</th><th>B</th></tr><tr><td>C</td><td>D</td></tr></table>');
    f.manager.selectedCells = [...f.cells];
    f.cells.slice(0, 2).forEach(cell => cell.classList.add('md-table-cell-selected'));
    f.update();
    assert.equal(f.selected(f.tables[0]), false);
    f.cells.forEach(cell => cell.classList.add('md-table-cell-selected'));
    f.update();
    assert.equal(f.selected(f.tables[0]), true);
    f.cells[3].classList.remove('md-table-cell-selected');
    f.update();
    assert.equal(f.selected(f.tables[0]), false);
});

test('a structure selection covering every cell gets the whole-table visual without changing its row mode', async t => {
    const f = await fixture(t, '<table><tr><th>A</th><th>B</th></tr></table>');
    const structure = { type: 'row', table: f.tables[0], index: 0 };
    f.manager.structureSelection = structure;
    f.cells.forEach(cell => cell.classList.add('md-table-structure-selected-cell'));
    f.update();
    assert.equal(f.selected(f.tables[0]), true);
    assert.equal(f.manager.structureSelection, structure);
    f.manager.structureSelection = null;
    f.update();
    assert.equal(f.selected(f.tables[0]), false, 'stale structure highlights must not select a table');
});

for (const backward of [false, true]) {
    test(`all cell text selects a table with a ${backward ? 'backward' : 'forward'} native range`, async t => {
        const f = await fixture(t, '<table><tr><th>First</th><th>Second</th></tr><tr><td>Third</td><td>Last</td></tr></table>');
        const first = f.cells[0].firstChild, last = f.cells[3].firstChild;
        f.select(first, 0, last, last.length, backward);
        f.update();
        assert.equal(f.selected(f.tables[0]), true);
        assert.equal(f.selection.anchorNode, backward ? last : first);
        assert.equal(f.selection.focusNode, backward ? first : last);
    });
}

test('missing the first or last character keeps a native selection partial', async t => {
    const f = await fixture(t, '<table><tr><td>First</td><td>Last</td></tr></table>');
    const first = f.cells[0].firstChild, last = f.cells[1].firstChild;
    f.select(first, 1, last, last.length);
    f.update();
    assert.equal(f.selected(f.tables[0]), false);
    f.select(first, 0, last, last.length - 1);
    f.update();
    assert.equal(f.selected(f.tables[0]), false);
});

test('rich text endpoints ignore injected controls and zero-width caret anchors', async t => {
    const f = await fixture(t, '<table><tr><th>\u200B<strong id="first">First</strong>' +
        '<span data-exclude-from-markdown="true" contenteditable="false">row control</span></th>' +
        '<td><code>Middle</code> <em id="last">Last</em>\u2060\uFEFF' +
        '<span class="md-table-structure-handle" data-exclude-from-markdown="true">column control</span></td></tr></table>');
    const first = f.text('#first'), last = f.text('#last');
    f.select(first, 0, last, last.length);
    f.update();
    assert.equal(f.selected(f.tables[0]), true);
    f.select(first, 0, last, last.length - 1);
    f.update();
    assert.equal(f.selected(f.tables[0]), false);
});

test('placeholder-only leading and trailing cells do not block complete text coverage', async t => {
    const f = await fixture(t, '<table><tr><td><br>\u200B</td><td id="first">First</td></tr>' +
        '<tr><td id="last">Last</td><td> \u00A0\u2060<br>' +
        '<span data-exclude-from-markdown="true">control</span></td></tr></table>');
    const first = f.text('#first'), last = f.text('#last');
    f.select(first, 0, last, last.length);
    f.update();
    assert.equal(f.selected(f.tables[0]), true);
});

test('an entirely empty table requires actual table containment or all explicit cell highlights', async t => {
    const f = await fixture(t, '<table><tr><td><br></td><td>\u200B<br></td></tr></table>');
    f.select(f.cells[0], 0, f.cells[1], f.cells[1].childNodes.length);
    f.update();
    assert.equal(f.selected(f.tables[0]), false);
    const range = f.document.createRange();
    range.selectNode(f.tables[0]);
    f.selection.addRange(range);
    f.update();
    assert.equal(f.selected(f.tables[0]), true);
    f.selection.removeAllRanges();
    f.cells.forEach(cell => cell.classList.add('md-table-cell-selected'));
    f.update();
    assert.equal(f.selected(f.tables[0]), true);
});

test('image and inline math boundaries are selected as atomic objects', async t => {
    const f = await fixture(t, '<table><tr><td><span data-mdw-math="inline" contenteditable="false">' +
        '<span id="rendered">rendered equation</span><span>E=mc^2</span></span></td>' +
        '<td><img src="example.png"></td></tr></table>');
    f.select(f.cells[0], 0, f.cells[1], 1);
    f.update();
    assert.equal(f.selected(f.tables[0]), true);
    f.select(f.text('#rendered'), 0, f.cells[1], 1);
    f.update();
    assert.equal(f.selected(f.tables[0]), false, 'a range starting inside math does not contain that object');
    f.select(f.cells[0], 0, f.cells[1], 0);
    f.update();
    assert.equal(f.selected(f.tables[0]), false, 'ending before an image leaves the table incomplete');
});

test('inline math at the last endpoint must be fully covered', async t => {
    const f = await fixture(t, '<table><tr><td id="first">First</td><td>' +
        '<span data-mdw-math="inline" contenteditable="false"><span id="formula">x+y</span></span></td></tr></table>');
    f.select(f.text('#first'), 0, f.cells[1], 1);
    f.update();
    assert.equal(f.selected(f.tables[0]), true);
    f.select(f.text('#first'), 0, f.text('#formula'), 3);
    f.update();
    assert.equal(f.selected(f.tables[0]), false, 'an internal math text end is before the atomic node end');
});

test('outside text and select-all ranges can fully select multiple tables independently', async t => {
    const f = await fixture(t, '<p id="before">Before</p><table><tr><td id="first">First</td></tr></table>' +
        '<p>Between</p><table><tr><td id="second">Second</td></tr></table><p id="after">After</p>');
    f.select(f.text('#before'), 2, f.text('#after'), 3, true);
    f.update();
    assert.deepEqual(f.tables.map(f.selected), [true, true]);
    f.select(f.text('#first'), 1, f.text('#after'), 3);
    f.update();
    assert.deepEqual(f.tables.map(f.selected), [false, true]);
    const range = f.document.createRange();
    range.selectNodeContents(f.editor);
    f.selection.addRange(range);
    f.update();
    assert.deepEqual(f.tables.map(f.selected), [true, true]);
});

test('collapsed, cleared, and unrelated native selections clear the whole-table visual', async t => {
    const f = await fixture(t, '<table><tr><td>First</td><td>Last</td></tr></table>');
    const first = f.cells[0].firstChild, last = f.cells[1].firstChild;
    for (const clear of [
        () => f.select(last, last.length, last, last.length),
        () => f.selection.removeAllRanges(),
        () => f.select(f.document.getElementById('elsewhere').firstChild, 0,
            f.document.getElementById('elsewhere').firstChild, 3),
    ]) {
        f.select(first, 0, last, last.length);
        f.update();
        assert.equal(f.selected(f.tables[0]), true);
        clear();
        f.update();
        assert.equal(f.selected(f.tables[0]), false);
    }
});

test('whole-table feedback preserves the native selection, table modes, drag state, and document content', async t => {
    const f = await fixture(t, '<table><tr><td>First</td><td>Last</td></tr></table>');
    const first = f.cells[0].firstChild, last = f.cells[1].firstChild;
    f.select(first, 0, last, last.length, true);
    const nativeRange = f.selection.getRangeAt(0);
    const selectedCells = [f.cells[0]];
    const selectionRange = { table: f.tables[0], minRow: 0, maxRow: 0, minCol: 0, maxCol: 0 };
    const dragStart = { x: 20, y: 30 };
    Object.assign(f.manager, { selectedCells, selectionRange, isMouseDown: true, isDragging: true,
        anchorCell: f.cells[0], focusCell: f.cells[1], cellDragStart: dragStart });
    const html = f.tables[0].innerHTML;
    f.update();
    assert.equal(f.selected(f.tables[0]), true);
    assert.equal(f.selection.getRangeAt(0), nativeRange);
    assert.equal(f.selection.anchorNode, last);
    assert.equal(f.selection.anchorOffset, last.length);
    assert.equal(f.selection.focusNode, first);
    assert.equal(f.selection.focusOffset, 0);
    assert.equal(f.manager.selectedCells, selectedCells);
    assert.equal(f.manager.selectionRange, selectionRange);
    assert.equal(f.manager.structureSelection, null);
    assert.equal(f.manager.isMouseDown, true);
    assert.equal(f.manager.isDragging, true);
    assert.equal(f.manager.anchorCell, f.cells[0]);
    assert.equal(f.manager.focusCell, f.cells[1]);
    assert.equal(f.manager.cellDragStart, dragStart);
    assert.equal(f.tables[0].innerHTML, html);
    assert.equal(f.manager.hasActiveTableSelection(), true, 'the existing partial cell mode is retained');
    f.manager.selectedCells = [];
    f.manager.selectionRange = null;
    f.update();
    assert.equal(f.manager.hasActiveTableSelection(), false, 'native text coverage does not create an editing mode');
});
