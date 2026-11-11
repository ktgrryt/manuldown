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

test('spreadsheet paste parses quoted tabs, line breaks, escaped quotes and empty cells', async () => {
    const { TableManager } = await tableManagerModulePromise;
    const manager = Object.create(TableManager.prototype);
    assert.deepEqual(manager._parseClipboard(''), []);
    assert.deepEqual(manager._parseClipboard('"first\r\nsecond"\tB\r\nC\tD\r\n'),
        [['first\nsecond', 'B'], ['C', 'D']]);
    assert.deepEqual(manager._parseClipboard('"a\tb"\t"say ""hello"""\n\t\n'),
        [['a\tb', 'say "hello"'], ['', '']]);
    assert.deepEqual(manager._parseClipboard('literal"quote\t"unterminated\nnext\tvalue'),
        [['literal"quote', '"unterminated'], ['next', 'value']]);
});

test('copying and pasting selected cells retains literal quotes and multiline contents', async () => {
    const { TableManager } = await tableManagerModulePromise;
    const manager = Object.create(TableManager.prototype);
    const matrix = [['first\nsecond', '"quoted"'], ['a\tb', 'last']];
    manager.hasCellSelection = () => true;
    manager._getSelectedMatrix = () => matrix;
    let copied;
    manager._handleCopy({
        clipboardData: { setData: (_type, value) => { copied = value; } },
        preventDefault() {},
    });
    assert.deepEqual(manager._parseClipboard(copied), matrix);
});

test('pasting a quoted multiline cell into a selected 2x2 table preserves the last row', async () => {
    const { TableManager } = await tableManagerModulePromise;
    const window = domino.createWindow('<div><table><tr><td>old1</td><td>old2</td></tr><tr><td>old3</td><td>old4</td></tr></table></div>');
    const table = window.document.querySelector('table');
    const original = { window: global.window, document: global.document, Node: global.Node };
    Object.assign(global, { window, document: window.document, Node: window.Node });
    window.getSelection = () => ({ rangeCount: 1 });
    try {
        const manager = Object.create(TableManager.prototype);
        manager.selectedCells = [table.rows[0].cells[0]];
        manager.selectionRange = { table, minRow: 0, minCol: 0 };
        manager.stateManager = { saveState() {} };
        manager._getCellInfo = () => ({ table, rowIndex: 0, colIndex: 0 });
        manager.clearCellSelection = () => {};
        manager._setCursorToCellEnd = () => {};
        manager._ensureCellNotEmpty = () => {};
        assert.equal(manager.handlePaste({
            clipboardData: { getData: () => '"first\nsecond"\tB\nC\tD\n' },
            preventDefault() {},
        }), true);
        assert.deepEqual(Array.from(table.rows, row => Array.from(row.cells, cell => cell.textContent)),
            [['first\nsecond', 'B'], ['C', 'D']]);
    } finally {
        Object.assign(global, original);
    }
});

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

async function createTableBoundaryHarness(before = '', after = '') {
    const importModule = name => import(`data:text/javascript;base64,${Buffer.from(
        fs.readFileSync(path.join(__dirname, '..', 'media', 'modules', name), 'utf8')
    ).toString('base64')}`);
    const [{ TableManager }, { DOMUtils }, { CodeBlockGapManager }, { StateManager }] = await Promise.all([
        tableManagerModulePromise, domUtilsModulePromise,
        importModule('CodeBlockGapManager.js'), importModule('StateManager.js'),
    ]);
    const window = domino.createWindow(`<div id="editor">${before}<div class="md-table-wrapper">` +
        '<span class="md-table-edge md-table-edge-left" data-table-edge="left" data-exclude-from-markdown="true">&nbsp;</span>' +
        '<table><tbody><tr><th>A</th></tr><tr><td>B</td></tr></tbody></table>' +
        '<span class="md-table-edge md-table-edge-right" data-table-edge="right" data-exclude-from-markdown="true">&nbsp;</span>' +
        `</div>${after}</div>`);
    const document = window.document;
    const editor = document.querySelector('#editor');
    const nodeListPrototype = Object.getPrototypeOf(editor.querySelectorAll('p'));
    const previousForEach = nodeListPrototype.forEach;
    nodeListPrototype.forEach = Array.prototype.forEach;
    let range = null;
    const selection = {
        get rangeCount() { return range ? 1 : 0; },
        get isCollapsed() { return !!range?.collapsed; },
        getRangeAt: () => range,
        removeAllRanges() { range = null; },
        addRange(next) { range = next; },
    };
    class BoundaryRange extends CellTestRange {
        get commonAncestorContainer() { return this.startContainer; }
        setStart(node, offset) {
            super.setStart(node, offset);
            if (this.collapsed || !this.endContainer) super.setEnd(node, offset);
        }
        collapse(toStart = true) {
            if (toStart) super.setEnd(this.startContainer, this.startOffset);
            else super.setStart(this.endContainer, this.endOffset);
            this.collapsed = true;
        }
        cloneRange() { return Object.assign(new BoundaryRange(), this); }
    }
    document.createRange = () => new BoundaryRange();
    window.getSelection = () => selection;
    for (const edge of editor.querySelectorAll('.md-table-edge')) {
        edge.dataset = { tableEdge: edge.getAttribute('data-table-edge') };
    }
    const previous = { window: global.window, document: global.document, Node: global.Node, NodeFilter: global.NodeFilter };
    Object.assign(global, { window, document, Node: window.Node, NodeFilter: window.NodeFilter });
    const domUtils = new DOMUtils(editor);
    const history = new StateManager(editor, {}, {
        getComparableHtml: () => domUtils.getCleanedHTML({ historyComparable: true }),
    });
    history.finishHistoryRestore = () => {};
    const manager = new TableManager(editor, domUtils, history);
    manager._revealCurrentSelection = () => {};
    const gaps = new CodeBlockGapManager(editor);
    const place = (node, offset = 0) => {
        range = new BoundaryRange();
        range.setStart(node, offset);
        range.collapse(true);
    };
    return {
        editor, domUtils, history, manager, gaps, selection, place,
        navigate(key) {
            const side = key === 'ArrowUp' || key === 'ArrowLeft' ? 'left' : 'right';
            place(editor.querySelector(`.md-table-edge-${side}`).firstChild);
            assert.equal(manager.handleArrowKeydown({ key, preventDefault() {} }), true);
            gaps.reconcile(selection);
        },
        restore() {
            history.clearHistory();
            if (previousForEach === undefined) delete nodeListPrototype.forEach;
            else nodeListPrototype.forEach = previousForEach;
            Object.assign(global, previous);
        },
    };
}

test('arrows beyond a document-boundary table open only a temporary input line', async () => {
    for (const key of ['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight']) {
        const f = await createTableBoundaryHarness();
        try {
            const original = f.domUtils.getCleanedHTML();
            f.history.saveState();
            f.navigate(key);
            const gap = f.editor.querySelector('[data-mdw-code-gap="true"]');
            assert.ok(gap, key);
            assert.ok(gap.contains(f.selection.getRangeAt(0).startContainer));
            assert.equal(f.domUtils.getCleanedHTML(), original, 'navigation must not insert a Markdown blank line');
            f.history.saveState();
            assert.equal(f.history.undoStack.length, 1, 'navigation must not add an Undo step');
            f.place(f.editor.querySelector('td').firstChild);
            f.gaps.reconcile(f.selection);
            assert.equal(gap.parentNode, null, 'leaving the untouched line removes it');
            assert.equal(f.domUtils.getCleanedHTML(), original);
        } finally { f.restore(); }
    }
});

test('typing text or a space beside a table creates lasting authored content', async () => {
    for (const text of ['written', ' ']) {
        const f = await createTableBoundaryHarness();
        try {
            f.navigate('ArrowUp');
            const gap = f.editor.querySelector('[data-mdw-code-gap]');
            gap.firstChild.textContent += text;
            assert.ok(f.domUtils.getCleanedHTML().includes(`<p>${text}</p>`), 'input is serialized before callbacks finish');
            f.gaps.reconcile(f.selection);
            assert.equal(gap.hasAttribute('data-mdw-code-gap'), false);
            f.place(f.editor.querySelector('td').firstChild);
            f.gaps.reconcile(f.selection);
            assert.equal(gap.parentNode, f.editor);
            assert.ok(f.domUtils.getCleanedHTML().includes(`<p>${text}</p>`));
        } finally { f.restore(); }
    }
});

test('intentional Enter beside a table preserves the resulting empty paragraph', async () => {
    const f = await createTableBoundaryHarness();
    try {
        f.navigate('ArrowUp');
        const gap = f.editor.querySelector('[data-mdw-code-gap]');
        f.gaps.commitAtSelection(f.selection, () => f.history.saveState());
        assert.equal(gap.hasAttribute('data-mdw-code-gap'), false);
        f.place(f.editor.querySelector('td').firstChild);
        f.gaps.reconcile(f.selection);
        assert.equal(gap.parentNode, f.editor);
        assert.ok(f.domUtils.getCleanedHTML().startsWith('<p></p>'));
    } finally { f.restore(); }
});

test('existing authored empty paragraphs around a table survive navigation', async () => {
    const f = await createTableBoundaryHarness('<p><br></p>', '<p><br></p>');
    try {
        const paragraphs = Array.from(f.editor.querySelectorAll('p'));
        const original = f.domUtils.getCleanedHTML();
        for (const key of ['ArrowUp', 'ArrowDown']) {
            f.navigate(key);
            f.place(f.editor.querySelector('td').firstChild);
            f.gaps.reconcile(f.selection);
        }
        assert.deepEqual(Array.from(f.editor.querySelectorAll('p')), paragraphs);
        assert.equal(f.domUtils.getCleanedHTML(), original);
    } finally { f.restore(); }
});

test('typing into a temporary table line is undoable and redoable', async () => {
    const f = await createTableBoundaryHarness();
    try {
        const original = f.domUtils.getCleanedHTML();
        f.history.saveState();
        f.navigate('ArrowUp');
        f.history.saveState();
        f.editor.querySelector('[data-mdw-code-gap]').firstChild.textContent += 'written';
        f.gaps.reconcile(f.selection);
        f.history.commitStateAfterChange({ preferLiveSelection: true });
        assert.equal(f.history.undoStack.length, 2);
        assert.equal(f.history.performUndo(), true);
        assert.equal(f.domUtils.getCleanedHTML(), original);
        assert.equal(f.history.performRedo(), true);
        assert.ok(f.domUtils.getCleanedHTML().includes('<p>written</p>'));
    } finally { f.restore(); }
});
