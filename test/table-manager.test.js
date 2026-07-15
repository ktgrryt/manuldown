const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const tableManagerSource = fs.readFileSync(
    path.join(__dirname, '..', 'media', 'modules', 'TableManager.js'),
    'utf8'
);
const tableManagerModulePromise = import(
    `data:text/javascript;base64,${Buffer.from(tableManagerSource).toString('base64')}`
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
