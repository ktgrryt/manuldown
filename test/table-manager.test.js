const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const tableManagerSource = fs.readFileSync(
    path.join(__dirname, '..', 'media', 'modules', 'TableManager.js'),
    'utf8'
);
const tableManagerModulePromise = import(
    `data:text/javascript;base64,${Buffer.from(tableManagerSource).toString('base64')}`
);
const domUtilsSource = fs.readFileSync(
    path.join(__dirname, '..', 'media', 'modules', 'DOMUtils.js'),
    'utf8'
);
const domUtilsModulePromise = import(
    `data:text/javascript;base64,${Buffer.from(domUtilsSource).toString('base64')}`
);

function createClassList() {
    const classes = new Set();
    return {
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        contains: name => classes.has(name),
    };
}

function createHandleCell({ rowHandle = null, colHandle = null } = {}) {
    return {
        querySelector: selector => selector.includes('row-handle') ? rowHandle : colHandle,
    };
}

async function createHandleVisibilityHarness() {
    const { TableManager } = await tableManagerModulePromise;
    const selectedRowHandle = { classList: createClassList() };
    const selectedColHandle = { classList: createClassList() };
    const hoveredRowHandle = { classList: createClassList() };
    const hoveredColHandle = { classList: createClassList() };
    const allHandles = [
        selectedRowHandle,
        selectedColHandle,
        hoveredRowHandle,
        hoveredColHandle,
    ];

    const rows = [
        {
            cells: [
                createHandleCell({ rowHandle: hoveredRowHandle, colHandle: hoveredColHandle }),
                createHandleCell({ colHandle: selectedColHandle }),
            ],
        },
        {
            cells: [
                createHandleCell({ rowHandle: selectedRowHandle }),
                createHandleCell(),
            ],
        },
    ];
    const table = { isConnected: true, rows };
    const editor = {
        querySelectorAll: selector => selector === '.md-table-structure-handle.visible'
            ? allHandles.filter(handle => handle.classList.contains('visible'))
            : [],
    };
    const manager = Object.create(TableManager.prototype);
    manager.editor = editor;
    manager.structureSelection = null;
    manager.hoverHandleContext = null;
    manager.selectionHandleContext = { table, rowIndex: 1, colIndex: 1 };

    return {
        manager,
        table,
        selectedRowHandle,
        selectedColHandle,
        hoveredRowHandle,
        hoveredColHandle,
    };
}

test('table handles stay hidden when there is a caret but no hovered cell', async () => {
    const harness = await createHandleVisibilityHarness();

    harness.manager._syncHandleVisibility();

    assert.equal(harness.selectedRowHandle.classList.contains('visible'), false);
    assert.equal(harness.selectedColHandle.classList.contains('visible'), false);
    assert.equal(harness.hoveredRowHandle.classList.contains('visible'), false);
    assert.equal(harness.hoveredColHandle.classList.contains('visible'), false);
});

test('only the row and column handles for the hovered cell are visible', async () => {
    const harness = await createHandleVisibilityHarness();
    harness.manager.hoverHandleContext = {
        table: harness.table,
        rowIndex: 0,
        colIndex: 0,
    };

    harness.manager._syncHandleVisibility();

    assert.equal(harness.hoveredRowHandle.classList.contains('visible'), true);
    assert.equal(harness.hoveredColHandle.classList.contains('visible'), true);
    assert.equal(harness.selectedRowHandle.classList.contains('visible'), false);
    assert.equal(harness.selectedColHandle.classList.contains('visible'), false);
});

test('table-wide hover does not reveal every structure handle', () => {
    const css = fs.readFileSync(
        path.join(__dirname, '..', 'media', 'editor.css'),
        'utf8'
    );

    assert.doesNotMatch(
        css,
        /#editor \.md-table-wrapper:hover \.md-table-structure-handle/
    );
});

test('hover resolution ignores a stale event target after handles are rebuilt', async () => {
    const { TableManager } = await tableManagerModulePromise;
    const manager = Object.create(TableManager.prototype);
    const staleHandle = { nodeType: 1 };
    const currentCellTarget = { nodeType: 1 };
    const table = {};
    const cell = {
        closest: () => table,
        getBoundingClientRect: () => ({ left: 0, right: 100, top: 0, bottom: 100 }),
    };
    const resolvedTargets = [];
    const previousDocument = global.document;
    const previousNode = global.Node;
    global.Node = { ELEMENT_NODE: 1 };
    global.document = { elementFromPoint: () => currentCellTarget };
    manager.editor = {
        contains: target => target === currentCellTarget || target === manager.insertLineVertical ||
            target === manager.insertLineHorizontal,
    };
    manager.isMouseDown = false;
    manager.structureDrag = null;
    manager.insertLineVertical = {};
    manager.insertLineHorizontal = {};
    manager._getStructureHandleInfoFromTarget = () => null;
    manager._getCellFromTarget = target => {
        resolvedTargets.push(target);
        return target === currentCellTarget ? cell : null;
    };
    manager._getCellInfo = () => ({ table, rowIndex: 1, colIndex: 2 });
    manager._syncHandleVisibility = () => {};
    manager._clearInsertHover = () => {};

    try {
        manager._handleHoverMove({ clientX: 50, clientY: 50, target: staleHandle });
    } finally {
        if (previousDocument === undefined) {
            delete global.document;
        } else {
            global.document = previousDocument;
        }
        if (previousNode === undefined) {
            delete global.Node;
        } else {
            global.Node = previousNode;
        }
    }

    assert.equal(resolvedTargets[0], currentCellTarget);
    assert.deepEqual(manager.hoverHandleContext, { table, rowIndex: 1, colIndex: 2 });
});

test('boundary clicks keep the insert highlight after notifying a change without moving the pointer', async (t) => {
    const { TableManager } = await tableManagerModulePromise;
    const { DOMUtils } = await domUtilsModulePromise;
    const cases = [
        { name: 'left column boundary', type: 'col', x: 101, y: 148 },
        { name: 'right column boundary', type: 'col', x: 399, y: 148 },
        { name: 'top row boundary', type: 'row', x: 165, y: 101 },
        { name: 'interior row boundary', type: 'row', x: 165, y: 140 },
        { name: 'bottom row boundary', type: 'row', x: 165, y: 219 },
    ];

    for (const scenario of cases) {
        await t.test(scenario.name, () => {
            const domWindow = domino.createWindow(
                '<div id="editor"><div class="md-table-wrapper"><table class="md-table">' +
                '<thead><tr><th>A</th><th>B</th><th>C</th></tr></thead>' +
                '<tbody><tr><td>D</td><td>E</td><td>F</td></tr>' +
                '<tr><td>G</td><td>H</td><td>I</td></tr></tbody></table></div></div>'
            );
            const editor = domWindow.document.querySelector('#editor');
            const table = editor.querySelector('table');
            const previousGlobals = {
                document: global.document, window: global.window,
                Node: global.Node, NodeFilter: global.NodeFilter,
            };
            const nodeListPrototype = Object.getPrototypeOf(editor.querySelectorAll('td'));
            const previousForEach = nodeListPrototype.forEach;
            nodeListPrototype.forEach = Array.prototype.forEach;
            Object.assign(global, {
                document: domWindow.document, window: domWindow,
                Node: domWindow.Node, NodeFilter: domWindow.NodeFilter,
            });
            domWindow.getSelection = () => ({ rangeCount: 0, removeAllRanges() {}, addRange() {} });
            domWindow.document.createRange = () => ({ setStart() {}, collapse() {} });
            editor.scrollLeft = 0;
            editor.scrollTop = 0;
            editor.getBoundingClientRect = () => ({ left: 0, top: 0 });
            table.getBoundingClientRect = () => ({
                left: 100, top: 100, width: 300, height: table.rows.length * 40,
            });
            table.tBodies = Array.from(table.querySelectorAll('tbody'));
            // Supply the table indices and layout APIs missing from Domino.
            domWindow.document.elementFromPoint = (x, y) => {
                Array.from(table.rows).forEach((row, rowIndex) => {
                    row.rowIndex = rowIndex;
                    Array.from(row.cells).forEach((cell, cellIndex) => {
                        cell.cellIndex = cellIndex;
                        cell.getBoundingClientRect = () => {
                            const width = 300 / row.cells.length;
                            const left = 100 + cellIndex * width;
                            const top = 100 + rowIndex * 40;
                            return { left, right: left + width, top, bottom: top + 40, width, height: 40 };
                        };
                    });
                });
                return Array.from(table.querySelectorAll('td, th')).find(cell => {
                    const rect = cell.getBoundingClientRect();
                    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
                }) || editor;
            };
            const domUtils = new DOMUtils(editor);
            let savedStates = 0;
            const manager = Object.create(TableManager.prototype);
            Object.assign(manager, {
                editor, domUtils, isMouseDown: false, structureDrag: null,
                structureSelection: null, hoverHandleContext: null,
                // Structure handles are covered separately; Domino lacks dataset.
                _ensureStructureHandles() {},
                stateManager: { saveState: () => savedStates++ },
                notifyChange: () => domUtils.cleanupGhostStyles(),
            });

            try {
                manager._createInsertLines();
                manager._handleHoverMove({ clientX: scenario.x, clientY: scenario.y });
                assert.equal(manager.hoverInsert.type, scenario.type);
                const line = scenario.type === 'col' ? manager.insertLineVertical : manager.insertLineHorizontal;

                for (let click = 1; click <= 2; click++) {
                    const target = domWindow.document.elementFromPoint(scenario.x, scenario.y);
                    assert.equal(manager.handleMouseDown({
                        button: 0, target, clientX: scenario.x, clientY: scenario.y,
                        preventDefault() {},
                    }), true);
                    assert.equal(line.style.display, 'block');
                    assert.equal(manager.hoverInsert.type, scenario.type);
                    assert.equal(table.rows.length, scenario.type === 'row' ? 3 + click : 3);
                    assert.equal(table.rows[0].cells.length, scenario.type === 'col' ? 3 + click : 3);
                    assert.equal(savedStates, click);
                }
                assert.ok(line.style.left.endsWith('px'));
                assert.ok(line.style.top.endsWith('px'));
                const size = scenario.type === 'col' ? line.style.height : line.style.width;
                assert.equal(size, scenario.type === 'col' ? `${table.rows.length * 40 + 2}px` : '302px');

                manager._handleHoverMove({ clientX: 120, clientY: 120 });
                assert.equal(line.style.display, 'none');
                assert.equal(manager.hoverInsert, null);
            } finally {
                if (previousForEach === undefined) delete nodeListPrototype.forEach;
                else nodeListPrototype.forEach = previousForEach;
                for (const [key, value] of Object.entries(previousGlobals)) {
                    if (value === undefined) delete global[key];
                    else global[key] = value;
                }
            }
        });
    }
});

test('finishing a structure drag refreshes handles from the mouseup position', async () => {
    const { TableManager } = await tableManagerModulePromise;
    const manager = Object.create(TableManager.prototype);
    const table = {
        isConnected: true,
        rows: [{ cells: [{}] }, { cells: [{}] }],
    };
    const calls = [];
    const previousDocument = global.document;
    global.document = {
        body: {
            classList: {
                remove: name => calls.push(['removeClass', name]),
            },
        },
    };
    manager.structureDrag = {
        type: 'row',
        table,
        sourceIndex: 0,
        insertIndex: 2,
        isDragging: true,
    };
    manager.stateManager = { saveState: () => calls.push(['saveState']) };
    manager.editor = { focus: () => {} };
    manager._clearInsertHover = () => calls.push(['clearInsertHover']);
    manager._reorderRows = () => 1;
    manager._ensureStructureHandles = () => calls.push(['ensureHandles']);
    manager.clearStructureSelection = () => calls.push(['clearSelection']);
    manager._refreshInsertHoverFromPoint = (x, y) => calls.push(['refresh', x, y]);
    manager.notifyChange = () => calls.push(['notifyChange']);

    try {
        manager._handleStructureDragMouseUp({ clientX: 120, clientY: 80 });
    } finally {
        if (previousDocument === undefined) {
            delete global.document;
        } else {
            global.document = previousDocument;
        }
    }

    assert.deepEqual(
        calls.filter(call => call[0] === 'refresh'),
        [['refresh', 120, 80]]
    );
    assert.equal(manager.hoverHandleContext, null);
});

class CellTestRange {
    constructor() {
        this.startContainer = null;
        this.startOffset = 0;
        this.endContainer = null;
        this.endOffset = 0;
        this.collapsed = true;
        this._root = null;
    }

    setStart(container, offset) {
        this.startContainer = container;
        this.startOffset = offset;
    }

    setEnd(container, offset) {
        this.endContainer = container;
        this.endOffset = offset;
    }

    collapse() {
        this.collapsed = true;
    }

    selectNodeContents(node) {
        this._root = node;
        this.startContainer = node;
        this.startOffset = 0;
        this.endContainer = node;
        this.endOffset = node.childNodes.length;
        this.collapsed = false;
    }

    // Offset of a boundary point within the text of the selected contents.
    _textIndex(container, offset) {
        let index = 0;
        let found = null;
        const visit = (node) => {
            if (found !== null) return;
            if (node === container && node.nodeType === 3) {
                found = index + offset;
                return;
            }
            if (node.nodeType === 3) {
                index += node.data.length;
                return;
            }
            Array.from(node.childNodes).forEach((child, childIndex) => {
                if (node === container && childIndex === offset) found = index;
                visit(child);
            });
            if (node === container && found === null) found = index;
        };
        visit(this._root);
        return found;
    }

    toString() {
        const start = this._textIndex(this.startContainer, this.startOffset);
        const end = this._textIndex(this.endContainer, this.endOffset);
        return this._root.textContent.slice(start, end);
    }
}

async function createInlineCodeCellHarness() {
    const { TableManager } = await tableManagerModulePromise;
    const domWindow = domino.createWindow(
        '<div id="editor"><table><tbody><tr>' +
        '<td>w</td>' +
        '<td><code>ab</code><span class="md-table-structure-handle" contenteditable="false"></span></td>' +
        '<td>x</td>' +
        '</tr></tbody></table></div>'
    );
    const editor = domWindow.document.querySelector('#editor');
    const table = editor.querySelector('table');
    const cells = Array.from(table.querySelectorAll('td'));
    const [beforeCell, codeCell, afterCell] = cells;
    const code = codeCell.querySelector('code');

    let currentRange = null;
    const selection = {
        get rangeCount() { return currentRange ? 1 : 0; },
        getRangeAt: () => currentRange,
        removeAllRanges: () => { currentRange = null; },
        addRange: (range) => { currentRange = range; },
    };
    const previousGlobals = { document: global.document, window: global.window, Node: global.Node };
    domWindow.document.createRange = () => new CellTestRange();
    domWindow.getSelection = () => selection;
    global.document = domWindow.document;
    global.window = domWindow;
    global.Node = domWindow.Node;

    const manager = Object.create(TableManager.prototype);
    manager.editor = editor;
    manager.placeCaretBeforeInlineCode = null;
    manager._getCellInfo = cell => ({ table, rowIndex: 0, colIndex: cells.indexOf(cell) });
    manager._handleCheckboxCaretNavigationInCell = () => false;
    manager._moveAcrossVisualLineBoundaryInCell = () => false;
    manager._hasVisualLineInCell = () => false;
    // Every caret used below sits on a visual line edge of its cell.
    manager._isAtCurrentVisualLineEndInCell = () => true;
    manager._isAtCurrentVisualLineStartInCell = () => true;

    const placeCaret = (node, offset) => {
        const range = new CellTestRange();
        range.setStart(node, offset);
        currentRange = range;
        return range;
    };

    return {
        manager,
        beforeCell,
        codeCell,
        afterCell,
        code,
        selection,
        placeCaret,
        getRange: () => currentRange,
        restoreGlobals: () => {
            for (const [key, value] of Object.entries(previousGlobals)) {
                if (value === undefined) {
                    delete global[key];
                } else {
                    global[key] = value;
                }
            }
        },
    };
}

test('right arrow at the end of inline code in a cell leaves the step outside the code to inline-code navigation', async () => {
    const harness = await createInlineCodeCellHarness();
    try {
        const range = harness.placeCaret(harness.code.firstChild, 2);

        assert.equal(harness.manager._handleCellNavigation(harness.codeCell, range, 'right'), false);
        assert.equal(harness.getRange(), range);
    } finally {
        harness.restoreGlobals();
    }
});

test('left arrow at the start of inline code in a cell leaves the step outside the code to inline-code navigation', async () => {
    const harness = await createInlineCodeCellHarness();
    try {
        const range = harness.placeCaret(harness.code.firstChild, 0);

        assert.equal(harness.manager._handleCellNavigation(harness.codeCell, range, 'left'), false);
        assert.equal(harness.getRange(), range);
    } finally {
        harness.restoreGlobals();
    }
});

test('a caret between inline-code characters is at neither code edge', async () => {
    const harness = await createInlineCodeCellHarness();
    try {
        const range = harness.placeCaret(harness.code.firstChild, 1);

        assert.equal(harness.manager._isCaretAtInlineCodeStart(harness.codeCell, range), false);
        assert.equal(harness.manager._isCaretAtInlineCodeEnd(harness.codeCell, range), false);
    } finally {
        harness.restoreGlobals();
    }
});

test('left arrow into a cell ending with inline code stops outside the code first', async () => {
    const harness = await createInlineCodeCellHarness();
    try {
        const range = harness.placeCaret(harness.afterCell.firstChild, 0);

        assert.equal(harness.manager._handleCellNavigation(harness.afterCell, range, 'left'), true);
        const landed = harness.getRange();
        assert.equal(landed.startContainer.nodeType, 3);
        assert.equal(landed.startContainer.data, '\u200B');
        assert.equal(landed.startContainer.previousSibling, harness.code);
        assert.equal(landed.startOffset, 1);
        assert.equal(harness.code.textContent, 'ab');

        // Re-entering reuses the anchor instead of stacking new ones.
        harness.manager._setCursorToCellEndFromRight(harness.codeCell);
        assert.equal(harness.getRange().startContainer, landed.startContainer);
        assert.equal(harness.codeCell.textContent, 'ab\u200B');
    } finally {
        harness.restoreGlobals();
    }
});

test('right arrow into a cell starting with inline code stops outside the code first', async () => {
    const harness = await createInlineCodeCellHarness();
    const calls = [];
    harness.manager.placeCaretBeforeInlineCode = (code, selection) => {
        calls.push([code, selection]);
        return true;
    };
    try {
        const range = harness.placeCaret(harness.beforeCell.firstChild, 1);

        assert.equal(harness.manager._handleCellNavigation(harness.beforeCell, range, 'right'), true);
        assert.deepEqual(calls, [[harness.code, harness.selection]]);
    } finally {
        harness.restoreGlobals();
    }
});

test('right arrow into a cell starting with inline code falls back to the cell start without the hook', async () => {
    const harness = await createInlineCodeCellHarness();
    harness.manager._ensureCellNotEmpty = () => {};
    harness.manager.domUtils = { getFirstTextNode: cell => cell.querySelector('code').firstChild };
    try {
        const range = harness.placeCaret(harness.beforeCell.firstChild, 1);

        assert.equal(harness.manager._handleCellNavigation(harness.beforeCell, range, 'right'), true);
        assert.equal(harness.getRange().startContainer, harness.code.firstChild);
        assert.equal(harness.getRange().startOffset, 0);
    } finally {
        harness.restoreGlobals();
    }
});

async function createCellDeletionHarness() {
    const f = await createInlineCodeCellHarness();
    const cleared = [];
    let checkpoints = 0;
    const manager = f.manager;
    manager._isMac = true;
    manager._normalizeStructureSelection = () => null;
    manager._isTableEmpty = () => false;
    manager._getEdgeFromSelection = () => null;
    manager._syncSelectionHandleContextFromSelection = () => {};
    manager._clearCellContent = cell => { cleared.push(cell); };
    manager.stateManager = { saveState: () => checkpoints++ };
    manager.notifyChange = null;
    manager.selectedCells = [];
    const selectCells = cells => {
        manager.selectedCells = cells;
        cells.forEach(cell => cell.classList.add('md-table-cell-selected'));
    };
    return { ...f, selectCells, cleared, get checkpoints() { return checkpoints; } };
}

for (const [key, ctrlKey] of [['Backspace', false], ['Delete', false], ['h', true]]) {
    test(`${key} after clicking cell text edits at the caret instead of clearing the whole cell`, async () => {
        const f = await createCellDeletionHarness();
        try {
            const text = f.code.firstChild;
            const range = f.placeCaret(text, 1);
            range.setEnd(text, 1);
            let prevented = false;
            const e = { key, ctrlKey, preventDefault: () => { prevented = true; } };
            assert.equal(f.manager.handleBackspaceKeydown(e), false);
            assert.equal(f.getRange(), range);
            assert.equal(f.code.textContent, 'ab');
            assert.equal(prevented, false);
            assert.deepEqual(f.cleared, []);
            assert.deepEqual(f.manager.selectedCells, []);
            assert.equal(f.checkpoints, 0);
        } finally {
            f.restoreGlobals();
        }
    });
}

test('Delete preserves native text selection without a cell highlight', async () => {
    const f = await createCellDeletionHarness();
    try {
        const text = f.code.firstChild;
        const range = f.placeCaret(text, 0);
        range.setEnd(text, 1);
        range.collapsed = false;
        assert.equal(f.manager.handleBackspaceKeydown({ key: 'Delete', preventDefault: () => assert.fail('native text deletion') }), false);
        assert.equal(f.getRange(), range);
        assert.deepEqual(f.cleared, []);
    } finally {
        f.restoreGlobals();
    }
});

for (const multiple of [false, true]) {
    test(`Backspace clears an explicit ${multiple ? 'multiple-cell' : 'cell-only'} selection`, async () => {
        const f = await createCellDeletionHarness();
        try {
            const cells = multiple ? [f.beforeCell, f.codeCell] : [f.codeCell];
            const range = f.placeCaret(f.code.firstChild, 1);
            range.setEnd(f.code.firstChild, 1);
            f.selectCells(cells);
            let prevented = false;
            assert.equal(f.manager.handleBackspaceKeydown({ key: 'Backspace', preventDefault: () => { prevented = true; } }), true);
            assert.equal(prevented, true);
            assert.deepEqual(f.cleared, cells);
            assert.equal(f.checkpoints, 1);
            assert.deepEqual(f.manager.selectedCells, []);
        } finally {
            f.restoreGlobals();
        }
    });
}

async function createCellClickHarness() {
    const f = await createCellDeletionHarness();
    const manager = f.manager;
    const table = f.codeCell.closest('table');
    Object.defineProperty(table, 'rows', { value: [{ cells: [f.beforeCell, f.codeCell, f.afterCell] }] });
    manager._getStructureHandleInfoFromTarget = () => null;
    manager.hasStructureSelection = () => false;
    manager.clearStructureSelection = () => {};
    manager._clearInsertHover = () => {};
    manager._getEdgeFromTarget = () => null;
    manager._getCellFromPoint = () => manager.pointerCell;
    manager._setCursorToCellStart = cell => {
        const text = cell.querySelector('code')?.firstChild || cell.firstChild;
        const range = f.placeCaret(text, 0);
        range.setEnd(text, 0);
    };
    return {
        ...f, get checkpoints() { return f.checkpoints; },
        click(cell, shiftKey = false) {
            manager.pointerCell = cell;
            let prevented = false;
            manager.handleMouseDown({ button: 0, target: cell, shiftKey, clientX: 0, clientY: 0,
                preventDefault: () => { prevented = true; } });
            manager._handleMouseUp({ button: 0 });
            return prevented;
        },
    };
}

test('ordinary cell clicks clear prior cell selection and preserve the native text caret', async () => {
    const f = await createCellClickHarness();
    try {
        const range = f.placeCaret(f.code.firstChild, 1);
        range.setEnd(f.code.firstChild, 1);
        f.selectCells([f.beforeCell, f.codeCell]);
        assert.equal(f.click(f.codeCell), false);
        assert.equal(f.getRange(), range);
        assert.equal(f.manager.hasCellSelection(), false);
        assert.equal(f.codeCell.classList.contains('md-table-cell-selected'), false);
        assert.equal(f.beforeCell.classList.contains('md-table-cell-selected'), false);
        assert.equal(f.manager.isMouseDown, false);
    } finally {
        f.restoreGlobals();
    }
});

test('Shift-click selects exactly the clicked cell and Backspace clears its entire contents', async () => {
    const f = await createCellClickHarness();
    try {
        assert.equal(f.click(f.codeCell, true), true);
        assert.deepEqual(f.manager.selectedCells, [f.codeCell]);
        assert.equal(f.codeCell.classList.contains('md-table-cell-selected'), true);
        let prevented = false;
        assert.equal(f.manager.handleBackspaceKeydown({ key: 'Backspace', preventDefault: () => { prevented = true; } }), true);
        assert.equal(prevented, true);
        assert.deepEqual(f.cleared, [f.codeCell]);
        assert.equal(f.checkpoints, 1);
        assert.equal(f.manager.hasCellSelection(), false);
    } finally {
        f.restoreGlobals();
    }
});

test('an ordinary click after Shift-click returns to text editing without a cell highlight', async () => {
    const f = await createCellClickHarness();
    try {
        f.click(f.codeCell, true);
        const range = f.placeCaret(f.afterCell.firstChild, 1);
        range.setEnd(f.afterCell.firstChild, 1);
        assert.equal(f.click(f.afterCell), false);
        assert.equal(f.getRange(), range);
        assert.equal(f.manager.hasCellSelection(), false);
        assert.equal(f.codeCell.classList.contains('md-table-cell-selected'), false);
    } finally {
        f.restoreGlobals();
    }
});

test('dragging from a normally clicked cell across cells still selects a cell range', async () => {
    const f = await createCellClickHarness();
    try {
        f.manager.pointerCell = f.beforeCell;
        f.manager.handleMouseDown({ button: 0, target: f.beforeCell, clientX: 0, clientY: 0,
            preventDefault: () => assert.fail('ordinary click stays native') });
        assert.equal(f.manager.hasCellSelection(), false);
        f.manager.pointerCell = f.afterCell;
        f.manager._handleDragMove({ clientX: 100, clientY: 0 });
        assert.deepEqual(f.manager.selectedCells, [f.beforeCell, f.codeCell, f.afterCell]);
        f.manager._handleMouseUp({ button: 0 });
        assert.equal(f.manager.hasCellSelection(), true);
        assert.equal(f.getRange().startContainer, f.afterCell.firstChild);
    } finally {
        f.restoreGlobals();
    }
});
