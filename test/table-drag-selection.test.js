const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const read = name => fs.readFileSync(path.join(__dirname, '..', 'media', name), 'utf8');
const importModule = name => import(`data:text/javascript;base64,${Buffer.from(read(`modules/${name}.js`)).toString('base64')}`);
const tableModule = importModule('TableManager');
const scrollModule = importModule('DragSelectionScroll');
const source = read('editor.js');
const extract = name => {
    const start = source.indexOf(`    function ${name}(`);
    const end = source.indexOf('\n    }\n', start);
    assert.ok(start >= 0 && end > start, name);
    return source.slice(start, end + 6);
};

// Domino has no DOM Range. Resolve boundary points against its actual DOM tree
// so selections across table cells, wrappers, and paragraphs have a real order.
class TestRange {
    setStart(node, offset) { this.startContainer = node; this.startOffset = offset; }
    setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; }
    get collapsed() { return this.startContainer === this.endContainer && this.startOffset === this.endOffset; }
    get commonAncestorContainer() {
        let node = this.startContainer;
        while (node && node !== this.endContainer && !node.contains(this.endContainer)) node = node.parentNode;
        return node;
    }
    collapse(start = true) {
        if (start) this.setEnd(this.startContainer, this.startOffset);
        else this.setStart(this.endContainer, this.endOffset);
    }
    cloneRange() { return Object.assign(new TestRange(), this); }
    selectNodeContents(node) {
        this.setStart(node, 0);
        this.setEnd(node, node.nodeType === 3 ? node.length : node.childNodes.length);
    }
    index(node, offset) {
        let count = 0;
        let result = null;
        const visit = current => {
            if (result !== null) return;
            if (current === node) {
                result = count + (node.nodeType === 3 ? offset :
                    Array.from(node.childNodes).slice(0, offset).reduce((sum, child) => sum + child.textContent.length, 0));
                return;
            }
            if (current.nodeType === 3) count += current.length;
            else Array.from(current.childNodes).forEach(visit);
        };
        visit(node.ownerDocument.body);
        return result;
    }
    compareBoundaryPoints(_how, other) {
        return this.index(this.startContainer, this.startOffset) - this.index(other.startContainer, other.startOffset);
    }
    toString() {
        return this.startContainer.ownerDocument.body.textContent.slice(
            this.index(this.startContainer, this.startOffset), this.index(this.endContainer, this.endOffset));
    }
}

async function withFixture(run) {
    const [{ TableManager }, { DragSelectionScroll }] = await Promise.all([tableModule, scrollModule]);
    const window = domino.createWindow('<div id="editor" contenteditable="true">' +
        '<p id="before">before selected text</p><div class="md-table-wrapper">' +
        '<div class="md-table-edge" data-exclude-from-markdown="true">&nbsp;</div>' +
        '<table><tbody><tr><td>first cell</td><td><strong>second cell</strong></td></tr>' +
        '<tr><td>third cell</td><td>last cell</td></tr></tbody></table>' +
        '<div class="md-table-edge" data-exclude-from-markdown="true">&nbsp;</div></div>' +
        '<p id="after">after selected text</p><p id="farther">farther text</p></div><p id="outside">outside editor</p>');
    const document = window.document;
    const editor = document.getElementById('editor');
    const table = editor.querySelector('table');
    const cells = Array.from(table.querySelectorAll('td'));
    // Domino exposes rows/cells, but not the browser's rowIndex/cellIndex.
    Array.from(table.rows).forEach((row, rowIndex) => {
        Object.defineProperty(row, 'rowIndex', { value: rowIndex });
        Array.from(row.cells).forEach((cell, cellIndex) => Object.defineProperty(cell, 'cellIndex', { value: cellIndex }));
    });
    const before = document.getElementById('before').firstChild;
    const after = document.getElementById('after').firstChild;
    const farther = document.getElementById('farther').firstChild;
    const original = { window: global.window, document: global.document, Node: global.Node, NodeFilter: global.NodeFilter };
    const listPrototype = Object.getPrototypeOf(editor.querySelectorAll('td'));
    const previousForEach = listPrototype.forEach;
    listPrototype.forEach = Array.prototype.forEach;
    Object.assign(global, { window, document, Node: window.Node, NodeFilter: window.NodeFilter });
    document.createRange = () => new TestRange();
    let currentRange = null;
    const selection = {
        get rangeCount() { return currentRange ? 1 : 0; },
        get isCollapsed() { return !currentRange || currentRange.collapsed; },
        getRangeAt: () => currentRange,
        removeAllRanges() { currentRange = null; },
        addRange(range) {
            currentRange = range;
            this.anchorNode = range.startContainer; this.anchorOffset = range.startOffset;
            this.focusNode = range.endContainer; this.focusOffset = range.endOffset;
        },
        setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) {
            const anchor = point(anchorNode, anchorOffset), focus = point(focusNode, focusOffset);
            const range = anchor.cloneRange();
            if (anchor.compareBoundaryPoints(0, focus) <= 0) range.setEnd(focusNode, focusOffset);
            else range.setStart(focusNode, focusOffset);
            currentRange = range;
            Object.assign(this, { anchorNode, anchorOffset, focusNode, focusOffset });
        },
        toString: () => currentRange?.toString() || '',
    };
    window.getSelection = () => selection;
    const point = (node, offset = 0) => {
        const range = new TestRange();
        range.setStart(node, offset); range.collapse();
        return range;
    };
    let hovered = cells[0];
    let pointerRange = point(cells[0].firstChild, 2);
    document.elementFromPoint = () => hovered;
    editor.focus = () => {};
    table.getBoundingClientRect = () => ({ top: 100, bottom: 200, left: 40, right: 400 });
    editor.getBoundingClientRect = () => ({ top: 0, bottom: 300, left: 0, right: 500 });
    Object.defineProperties(editor, {
        clientTop: { value: 0 }, clientLeft: { value: 0 }, clientHeight: { value: 300 },
        clientWidth: { value: 500 }, scrollHeight: { value: 4000 },
    });
    editor.scrollTop = 1000;
    window.innerHeight = 600; window.innerWidth = 800;
    const frames = new Map();
    let sequence = 0, timestamp = 0;
    window.requestAnimationFrame = callback => { frames.set(++sequence, callback); return sequence; };
    window.cancelAnimationFrame = id => frames.delete(id);
    const manager = new TableManager(editor, {}, { saveState() { assert.fail('selection must not edit the document'); } });
    for (const name of ['_createInsertLines', '_handleHoverMove', '_handleGlobalHoverCleanup',
        '_clearInsertHover', '_syncSelectionHandleContextFromSelection', '_syncHandleVisibility']) manager[name] = () => {};
    let caretPlacements = 0;
    manager._setCursorToCellStart = cell => {
        caretPlacements++;
        const text = cell.querySelector('strong')?.firstChild || cell.firstChild;
        selection.addRange(point(text));
    };
    manager.setup({ notifyChange() { assert.fail('selection must not change Markdown'); } });
    editor.addEventListener('mousedown', event => manager.handleMouseDown(event));
    const dependencies = {
        editor, document, window, Node: window.Node, tableManager: manager, Range: { START_TO_START: 0 },
        mathManager: { getDragSelectionRangeFromPoint: () => null },
        getCaretRangeFromPoint: () => pointerRange,
        getLooseLeftSideTextClickRange: () => null, getLooseRightSideTextClickRange: () => null,
        getImageCaretRangeFromHorizontalClick: () => null, getStableGapClickRange: () => null,
        getNearestBlockBoundaryRangeByY: () => null,
    };
    const moveStart = source.indexOf("        document.addEventListener('mousemove',", source.indexOf('// mousedownイベント'));
    const moveEnd = source.indexOf("        document.addEventListener('mouseup',", moveStart);
    const api = new Function(...Object.keys(dependencies), `
        let isUpdating = false, isComposing = false;
        let manualPointerSelection = null, dragSelectionScroll = null;
        let pendingListMouseAdjustment = null, pendingInlineCodeSideClick = null, pendingMouseDriftCorrection = null;
        ${['isEditorRange', 'createDirectionalSelectionRange', 'getManualDragFocusRangeFromPoint',
        'stopManualPointerSelection', 'beginManualPointerSelection', 'updateManualPointerSelection',
        'extendTableSelectionToText'].map(extract).join('\n')}
        ${source.slice(moveStart, moveEnd)}
        return {
            promote: extendTableSelectionToText,
            getManual: () => manualPointerSelection,
            setController(value) { dragSelectionScroll = value; },
            stop: stopManualPointerSelection,
        };
    `)(...Object.values(dependencies));
    manager.extendSelectionOutsideTable = api.promote;
    const controller = new DragSelectionScroll(editor, {
        getAnchorRange: () => api.getManual()?.anchorRange,
        resolveFocusRange: () => pointerRange,
        isEnabled: () => !manager.hasActiveTableSelection() && !manager.structureDrag,
    });
    api.setController(controller);
    const dispatch = (type, properties = {}, target = document) => {
        const event = document.createEvent('Event'); event.initEvent(type, true, true);
        Object.assign(event, properties); target.dispatchEvent(event); return event;
    };
    const harness = {
        editor, table, cells, before, after, farther, manager, selection, point, controller, ...api,
        get caretPlacements() { return caretPlacements; },
        get frameCount() { return frames.size; },
        down(cell = cells[0], shiftKey = false, offset = 2) {
            hovered = cell;
            const text = cell.querySelector('strong')?.firstChild || cell.firstChild;
            pointerRange = point(text, offset); selection.addRange(pointerRange.cloneRange());
            return dispatch('mousedown', { button: 0, buttons: 1, shiftKey, clientX: 100, clientY: 150 }, cell);
        },
        move(node, y, offset = 4, buttons = 1) {
            hovered = node?.nodeType === 3 ? node.parentElement : node;
            const text = node?.nodeType === 3 ? node : node?.querySelector('strong')?.firstChild || node?.firstChild;
            pointerRange = text ? point(text, offset) : null;
            return dispatch('mousemove', { clientX: 100, clientY: y, buttons });
        },
        up() { dispatch('mouseup', { button: 0, buttons: 0 }); },
        wheel() { dispatch('wheel', { deltaY: 20 }, editor); },
        advance() {
            for (let i = 0; i < 20; i++) {
                timestamp += 1000 / 60;
                const callbacks = [...frames.values()]; frames.clear();
                callbacks.forEach(callback => callback(timestamp));
            }
        },
    };
    try { await run(harness); }
    finally {
        controller.stop();
        if (previousForEach === undefined) delete listPrototype.forEach;
        else listPrototype.forEach = previousForEach;
        Object.assign(global, original);
    }
}

for (const direction of ['up', 'down']) {
    test(`a cell rectangle extends into text ${direction === 'up' ? 'above' : 'below'} its table`, async () => {
        await withFixture(f => {
            const originalHtml = f.editor.innerHTML;
            f.down();
            f.move(f.cells[3], 180);
            assert.equal(f.manager.selectedCells.length, 4);
            const target = direction === 'up' ? f.before : f.after;
            assert.equal(f.move(target, direction === 'up' ? 30 : 250, 8).defaultPrevented, true);
            assert.equal(f.manager.hasCellSelection(), false);
            assert.equal(f.manager.isMouseDown, false);
            assert.equal(f.getManual().anchorNode, f.cells[0]);
            assert.equal(f.selection.anchorNode, f.cells[0]);
            assert.equal(f.selection.focusNode, target);
            assert.equal(f.getManual().anchorRange.startOffset, direction === 'up' ? f.cells[0].childNodes.length : 0);
            assert.ok(f.selection.toString().includes('first cell'));
            assert.ok(direction === 'up' ? f.selection.toString().includes('elected text') : f.selection.toString().includes('after se'));
            const selected = f.selection.getRangeAt(0);
            const placements = f.caretPlacements;
            f.up();
            assert.equal(f.selection.getRangeAt(0), selected, 'mouseup must not collapse the cross-table selection');
            assert.equal(f.caretPlacements, placements);
            assert.equal(f.editor.innerHTML.replace(/ class=""/g, ''), originalHtml.replace(/ class=""/g, ''));
        });
    });
}

test('an ordinary cell text drag keeps its exact initial text offset when leaving the table', async () => {
    await withFixture(f => {
        f.down(f.cells[0], false, 3);
        f.move(f.after, 250, 5);
        assert.equal(f.getManual().anchorNode, f.cells[0].firstChild);
        assert.equal(f.getManual().anchorRange.startOffset, 3);
        assert.ok(f.selection.toString().startsWith('st cell'));
        assert.equal(f.manager.hasCellSelection(), false);
    });
});

test('a Shift-selected single cell extends as a whole into outside text', async () => {
    await withFixture(f => {
        assert.equal(f.down(f.cells[1], true).defaultPrevented, true);
        assert.equal(f.manager.selectedCells.length, 1);
        f.move(f.after, 250, 8);
        assert.ok(f.selection.toString().startsWith('second cell'));
        assert.equal(f.manager.hasCellSelection(), false);
        assert.equal(f.getManual().anchorNode, f.cells[1]);
    });
});

test('after leaving a table the same drag keeps extending across paragraphs and back into cells', async () => {
    await withFixture(f => {
        f.down(f.cells[0], true);
        f.move(f.after, 250, 5);
        f.move(f.farther, 275, 7);
        assert.equal(f.selection.getRangeAt(0).endContainer, f.farther);
        assert.equal(f.selection.getRangeAt(0).endOffset, 7);
        f.move(f.cells[2], 180, 4);
        assert.equal(f.manager.hasCellSelection(), false);
        assert.equal(f.selection.getRangeAt(0).endContainer, f.cells[2].firstChild);
    });
});

test('promoting a cell selection rearms edge scrolling and supports a wheel adjustment', async () => {
    await withFixture(f => {
        f.down(f.cells[0], true);
        f.move(f.cells[3], 180);
        assert.equal(f.controller.drag, null, 'the cell-only mode has stopped the scroll helper');
        f.move(f.after, 350, 8);
        f.advance();
        assert.ok(f.editor.scrollTop > 1000);
        const anchor = f.getManual().anchorNode;
        f.wheel();
        f.editor.scrollTop += 20;
        const afterWheel = f.editor.scrollTop;
        f.advance();
        assert.equal(f.editor.scrollTop, afterWheel);
        f.move(f.after, 250, 8);
        f.move(f.after, 350, 8);
        f.advance();
        assert.ok(f.editor.scrollTop > afterWheel);
        assert.equal(f.getManual().anchorNode, anchor);
    });
});

test('dragging only inside the table keeps the existing rectangular cell selection', async () => {
    await withFixture(f => {
        f.down();
        f.move(f.cells[3], 180);
        assert.equal(f.manager.selectedCells.length, 4);
        assert.equal(f.getManual(), null);
        f.up();
        assert.equal(f.manager.selectedCells.length, 4);
    });
});

test('horizontal table margins and points outside the editor do not replace the cell selection', async () => {
    await withFixture(f => {
        f.down(f.cells[0], true);
        f.move(null, 150);
        assert.equal(f.manager.hasCellSelection(), true);
        assert.equal(f.getManual(), null);
        f.move(null, -20);
        assert.equal(f.manager.hasCellSelection(), true);
        assert.equal(f.getManual(), null);
    });
});

test('cancelled or detached cell drags cannot select newly loaded document text', async () => {
    for (const detach of [false, true]) {
        await withFixture(f => {
            f.down(f.cells[0], true);
            if (detach) f.table.parentNode.remove();
            else f.stop();
            f.move(f.after, 250);
            assert.equal(f.manager.isMouseDown, false);
            assert.equal(f.getManual(), null);
        });
    }
});

test('a cell drag with the primary button released cannot promote to outside text', async () => {
    await withFixture(f => {
        f.down(f.cells[0], true);
        f.move(f.after, 250, 4, 0);
        assert.equal(f.manager.isMouseDown, false);
        assert.equal(f.getManual(), null);
        assert.equal(f.manager.hasCellSelection(), true);
    });
});

test('table decoration is not treated as outside document text', async () => {
    await withFixture(f => {
        f.down(f.cells[0], true);
        const edge = f.editor.querySelector('.md-table-edge');
        f.move(edge.firstChild, 250, 0);
        assert.equal(f.getManual(), null);
        assert.equal(f.manager.hasCellSelection(), true);
    });
});
