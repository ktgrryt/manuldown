const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const stateManagerSource = fs.readFileSync(
    path.join(__dirname, '..', 'media', 'modules', 'StateManager.js'),
    'utf8'
);
const editorSource = fs.readFileSync(
    path.join(__dirname, '..', 'media', 'editor.js'),
    'utf8'
);
const extensionSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
);
const providerSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'editor', 'MarkdownEditorProvider.ts'),
    'utf8'
);
const packageJson = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'package.json'),
    'utf8'
));
const stateManagerModulePromise = import(
    `data:text/javascript;base64,${Buffer.from(stateManagerSource).toString('base64')}`
);

async function createStateManager(options = {}) {
    const { StateManager } = await stateManagerModulePromise;
    const editor = {
        innerHTML: '',
        scrollTop: 0,
        focus: () => {},
    };
    const messages = [];
    const manager = new StateManager(
        editor,
        { postMessage: (message) => messages.push(message) },
        options
    );
    manager.saveSelection = () => null;
    manager.restoreSelection = () => {};
    return { editor, manager, messages };
}

test('StateManager trims oldest snapshots by total estimated memory', async () => {
    const { editor, manager } = await createStateManager({
        maxHistorySize: 10,
        maxHistoryBytes: 24,
    });

    for (const html of ['AAAAA', 'BBBBB', 'CCCCC']) {
        editor.innerHTML = html;
        manager.saveState();
    }

    assert.deepEqual(manager.undoStack.map((state) => state.html), ['BBBBB', 'CCCCC']);
    assert.equal(manager.undoHistoryBytes, 20);
    assert.ok(manager.undoHistoryBytes + manager.redoHistoryBytes <= manager.maxHistoryBytes);
});

test('StateManager deduplicates identical HTML snapshots and keeps the count limit', async () => {
    const { editor, manager } = await createStateManager({
        maxHistorySize: 3,
        maxHistoryBytes: 1024,
    });

    editor.innerHTML = 'same';
    manager.saveState();
    manager.saveState();
    assert.equal(manager.undoStack.length, 1);

    for (const html of ['one', 'two', 'three', 'four']) {
        editor.innerHTML = html;
        manager.saveState();
    }

    assert.deepEqual(manager.undoStack.map((state) => state.html), ['two', 'three', 'four']);
});

test('StateManager keeps one latest snapshot when it alone exceeds the memory budget', async () => {
    const { editor, manager } = await createStateManager({
        maxHistorySize: 10,
        maxHistoryBytes: 8,
    });

    editor.innerHTML = 'old';
    manager.saveState();
    editor.innerHTML = 'a very large current snapshot';
    manager.saveState();

    assert.equal(manager.undoStack.length, 1);
    assert.equal(manager.undoStack[0].html, 'a very large current snapshot');
    assert.equal(manager.undoHistoryBytes, manager.undoStack[0].byteSize);
});

test('StateManager moves snapshots through redo without creating duplicates or host history actions', async () => {
    const { editor, manager, messages } = await createStateManager({
        maxHistorySize: 10,
        maxHistoryBytes: 1024,
    });
    let notifications = 0;
    const notify = () => {
        notifications++;
    };

    for (const html of ['A', 'B', 'C']) {
        editor.innerHTML = html;
        manager.saveState();
    }
    const initialHistoryBytes = manager.undoHistoryBytes;

    manager.performUndo(notify);
    assert.equal(editor.innerHTML, 'B');
    assert.deepEqual(manager.undoStack.map((state) => state.html), ['A', 'B']);
    assert.deepEqual(manager.redoStack.map((state) => state.html), ['C']);
    assert.equal(manager.undoHistoryBytes + manager.redoHistoryBytes, initialHistoryBytes);

    manager.performRedo(notify);
    assert.equal(editor.innerHTML, 'C');
    assert.deepEqual(manager.undoStack.map((state) => state.html), ['A', 'B', 'C']);
    assert.deepEqual(manager.redoStack, []);
    assert.equal(manager.undoHistoryBytes, initialHistoryBytes);

    manager.performUndo(notify);
    assert.equal(editor.innerHTML, 'B');
    assert.equal(notifications, 3);
    assert.deepEqual(messages, []);
});

test('StateManager moves to each changed snapshot across repeated undo and redo', async () => {
    const { editor, manager } = await createStateManager({
        maxHistorySize: 10,
        maxHistoryBytes: 16 * 1024,
    });
    const selectionFor = (id, blockIndex) => ({
        id,
        startPath: [blockIndex, 0],
        startOffset: 2,
        endPath: [blockIndex, 0],
        endOffset: 2,
        collapsed: true,
    });
    let activeSelection = null;
    manager.saveSelection = () => activeSelection;
    manager.restoreSelection = (savedSelection) => {
        activeSelection = savedSelection;
        return !!savedSelection;
    };

    const historyA = selectionFor('history-a', 0);
    const historyB = selectionFor('history-b', 10);
    const historyC = selectionFor('history-c', 30);
    editor.innerHTML = 'A';
    activeSelection = historyA;
    manager.seedState();
    activeSelection = historyB;
    manager.saveState();
    editor.innerHTML = 'B';
    activeSelection = historyC;
    manager.saveState();
    editor.innerHTML = 'C';
    manager.commitStateAfterChange();

    const operations = [
        ['undo', 'B', historyC, 900],
        ['undo', 'A', historyB, 100],
        ['redo', 'B', historyB, 100],
        ['redo', 'C', historyC, 900],
    ];

    let finalSelection = null;
    let finalScrollTop = null;
    for (const [index, [direction, expectedHtml, expectedSelection, expectedScrollTop]] of operations.entries()) {
        activeSelection = selectionFor(`unrelated-live-${index}`, 80 + index);
        editor.scrollTop = 1700 + index;
        const revealChange = () => {
            editor.scrollTop = activeSelection === historyC ? 900 : 100;
        };
        if (direction === 'undo') {
            manager.performUndo(null, revealChange);
        } else {
            manager.performRedo(null, revealChange);
        }
        assert.equal(editor.innerHTML, expectedHtml);
        assert.equal(activeSelection, expectedSelection);
        assert.equal(editor.scrollTop, 1700 + index);
        await new Promise((resolve) => setTimeout(resolve, 2));
        assert.equal(editor.scrollTop, expectedScrollTop);
        finalSelection = expectedSelection;
        finalScrollTop = expectedScrollTop;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(activeSelection, finalSelection);
    assert.equal(editor.scrollTop, finalScrollTop);
});

test('StateManager retains rapid native edits even when the burst returns to its initial HTML', async () => {
    const { editor, manager } = await createStateManager({
        maxHistorySize: 30,
        maxHistoryBytes: 32 * 1024,
    });
    let activeSelection = { id: 'empty-start' };
    manager.saveSelection = () => activeSelection;
    manager.restoreSelection = (savedSelection) => {
        activeSelection = savedSelection;
        return !!savedSelection;
    };

    editor.innerHTML = '';
    manager.seedState();
    const rapidValues = [
        '1', '12', '123', '1234', '12345',
        '1234', '123', '12', '1', ''
    ];
    rapidValues.forEach((html, index) => {
        // Mirrors editor.js: beforeinput checkpoints the old DOM, then input
        // schedules the new DOM. The following beforeinput flushes that timer.
        manager.saveState();
        editor.innerHTML = html;
        activeSelection = { id: `caret-${index}`, offset: html.length };
        manager.saveStateDebounced();
    });

    const undoValues = [];
    for (let index = 0; index < 5; index++) {
        assert.equal(manager.performUndo(), true);
        undoValues.push(editor.innerHTML);
    }
    assert.deepEqual(undoValues, ['1', '12', '123', '1234', '12345']);

    const redoValues = [];
    for (let index = 0; index < 5; index++) {
        assert.equal(manager.performRedo(), true);
        redoValues.push(editor.innerHTML);
    }
    assert.deepEqual(redoValues, ['1234', '123', '12', '1', '']);
    manager.clearHistory();
});

test('StateManager rebases restored UI normalization without clearing Redo', async () => {
    const { editor, manager } = await createStateManager({
        maxHistorySize: 30,
        maxHistoryBytes: 64 * 1024,
    });
    const values = [
        '', '1', '12', '123', '1234', '12345',
        '1234', '123', '12', '1', ''
    ];
    values.forEach((html, index) => {
        editor.innerHTML = html;
        manager.commitStateAfterChange({
            preferLiveSelection: true,
            changeSelection: { id: `change-${index}` }
        });
    });

    const normalizeRestoredUi = () => {
        editor.innerHTML += '|restored-ui';
    };
    const semanticHtml = () => editor.innerHTML.replace(/\|restored-ui$/, '');
    const undoValues = [];
    for (let index = 0; index < 5; index++) {
        assert.equal(manager.performUndo(normalizeRestoredUi), true);
        undoValues.push(semanticHtml());
    }
    assert.deepEqual(undoValues, ['1', '12', '123', '1234', '12345']);

    const redoValues = [];
    for (let index = 0; index < 5; index++) {
        assert.equal(manager.performRedo(normalizeRestoredUi), true);
        redoValues.push(semanticHtml());
    }
    assert.deepEqual(redoValues, ['1234', '123', '12', '1', '']);
    assert.equal(
        manager.undoHistoryBytes,
        manager.undoStack.reduce((total, state) => total + manager.getStateByteSize(state), 0)
    );
    assert.equal(
        manager.redoHistoryBytes,
        manager.redoStack.reduce((total, state) => total + manager.getStateByteSize(state), 0)
    );
});

test('StateManager still clears Redo for a real edit after restored UI normalization', async () => {
    const { editor, manager } = await createStateManager({
        maxHistorySize: 10,
        maxHistoryBytes: 4096,
    });
    for (const html of ['A', 'B', 'C']) {
        editor.innerHTML = html;
        manager.commitStateAfterChange({ preferLiveSelection: true });
    }

    manager.performUndo(() => {
        editor.innerHTML += '|restored-ui';
    });
    assert.equal(manager.redoStack.length, 1);

    editor.innerHTML = 'a real new edit';
    assert.equal(manager.performRedo(), false);
    assert.deepEqual(manager.redoStack, []);
    assert.equal(editor.innerHTML, 'a real new edit');
});

test('StateManager reapplies and reveals the change location after normalization and focus', async () => {
    const { editor, manager } = await createStateManager({
        maxHistorySize: 10,
        maxHistoryBytes: 4096,
    });
    const selectionA = {
        id: 'history-a',
        startPath: [0, 0],
        startOffset: 0,
        endPath: [0, 0],
        endOffset: 0,
        collapsed: true,
    };
    const changeSelection = {
        id: 'change-location',
        startPath: [12, 0],
        startOffset: 4,
        endPath: [12, 0],
        endOffset: 4,
        collapsed: true,
    };
    const topSelection = { id: 'detached-to-top' };
    let activeSelection = selectionA;
    const focusOptions = [];
    let revealCount = 0;
    manager.saveSelection = () => activeSelection;
    manager.restoreSelection = (savedSelection) => {
        activeSelection = savedSelection;
        return !!savedSelection;
    };
    editor.focus = (options) => {
        focusOptions.push(options);
        activeSelection = topSelection;
        editor.scrollTop = 0;
    };

    editor.innerHTML = 'A';
    manager.seedState();
    activeSelection = changeSelection;
    manager.saveState();
    editor.innerHTML = 'B';
    manager.commitStateAfterChange();
    activeSelection = { id: 'unrelated-live-caret' };
    editor.scrollTop = 1600;

    const disruptRestoredChange = () => {
        activeSelection = topSelection;
        editor.scrollTop = 0;
    };
    const revealChange = (preservedScrollTop) => {
        revealCount++;
        assert.equal(activeSelection, changeSelection);
        const expectedPreservedScrollTop = revealCount === 1 ? 1600 : 1800;
        assert.equal(preservedScrollTop, expectedPreservedScrollTop);
        assert.equal(editor.scrollTop, expectedPreservedScrollTop);
        editor.scrollTop = 720;
    };

    manager.performUndo(disruptRestoredChange, revealChange);
    assert.equal(activeSelection, changeSelection);
    assert.equal(editor.scrollTop, 1600);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(activeSelection, changeSelection);
    assert.equal(editor.scrollTop, 720);

    activeSelection = { id: 'another-unrelated-live-caret' };
    editor.scrollTop = 1800;
    manager.performRedo(disruptRestoredChange, revealChange);
    assert.equal(editor.scrollTop, 1800);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(activeSelection, changeSelection);
    assert.equal(editor.scrollTop, 720);
    assert.equal(revealCount, 2);
    assert.deepEqual(focusOptions, [
        { preventScroll: true },
        { preventScroll: true },
        { preventScroll: true },
        { preventScroll: true },
    ]);
});

test('StateManager keeps the input-time anchor while a debounced save is pending', async () => {
    const { editor, manager } = await createStateManager({
        maxHistorySize: 10,
        maxHistoryBytes: 4096,
    });
    const initialSelection = { id: 'initial' };
    const editSelection = { id: 'typed-at-line-40' };
    const unrelatedSelection = { id: 'clicked-at-line-200' };
    let activeSelection = initialSelection;
    manager.saveSelection = () => activeSelection;
    manager.restoreSelection = (savedSelection) => {
        activeSelection = savedSelection;
        return !!savedSelection;
    };

    editor.innerHTML = 'A';
    manager.seedState();
    editor.innerHTML = 'B';
    activeSelection = editSelection;
    manager.saveStateDebounced();
    activeSelection = unrelatedSelection;

    manager.performUndo();
    assert.equal(editor.innerHTML, 'A');
    assert.equal(activeSelection, editSelection);
    assert.equal(manager.redoStack[0].selection, editSelection);

    manager.performRedo();
    assert.equal(editor.innerHTML, 'B');
    assert.equal(activeSelection, editSelection);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(activeSelection, editSelection);
});

test('StateManager does not overwrite a snapshot change anchor with a same-HTML save', async () => {
    const { editor, manager } = await createStateManager({
        maxHistorySize: 10,
        maxHistoryBytes: 4096,
    });
    const selectionA = { id: 'change-a' };
    const selectionB = { id: 'change-b' };
    const unrelatedSelection = { id: 'moved-without-editing' };
    let activeSelection = selectionA;
    manager.saveSelection = () => activeSelection;
    manager.restoreSelection = (savedSelection) => {
        activeSelection = savedSelection;
        return !!savedSelection;
    };

    editor.innerHTML = 'A';
    manager.seedState();
    activeSelection = selectionB;
    manager.saveState();
    editor.innerHTML = 'B';
    manager.commitStateAfterChange();
    activeSelection = unrelatedSelection;
    manager.saveState();

    assert.equal(manager.undoStack[1].selection, selectionB);
    manager.performUndo();
    assert.equal(activeSelection, selectionB);
});

test('StateManager captures a programmatic edit that only saved its pre-change state', async () => {
    const { editor, manager } = await createStateManager({
        maxHistorySize: 10,
        maxHistoryBytes: 4096,
    });
    const initialSelection = { id: 'initial' };
    const changeSelection = { id: 'table-insert-location' };
    const unrelatedSelection = { id: 'later-click' };
    let activeSelection = initialSelection;
    manager.saveSelection = () => activeSelection;
    manager.restoreSelection = (savedSelection) => {
        activeSelection = savedSelection;
        return !!savedSelection;
    };

    editor.innerHTML = 'A';
    manager.seedState();
    activeSelection = changeSelection;
    manager.saveState();
    editor.innerHTML = 'B';
    activeSelection = unrelatedSelection;

    manager.performUndo();
    assert.equal(editor.innerHTML, 'A');
    assert.equal(activeSelection, changeSelection);
    assert.equal(manager.redoStack[0].html, 'B');
    assert.equal(manager.redoStack[0].selection, changeSelection);

    manager.performRedo();
    assert.equal(editor.innerHTML, 'B');
    assert.equal(activeSelection, changeSelection);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(activeSelection, changeSelection);
});

test('StateManager keeps distinct anchors for consecutive programmatic changes', async () => {
    const { editor, manager } = await createStateManager({
        maxHistorySize: 10,
        maxHistoryBytes: 4096,
    });
    const initialSelection = { id: 'initial' };
    const firstChange = { id: 'first-programmatic-change' };
    const secondChange = { id: 'second-programmatic-change' };
    let activeSelection = initialSelection;
    manager.saveSelection = () => activeSelection;
    manager.restoreSelection = (savedSelection) => {
        activeSelection = savedSelection;
        return !!savedSelection;
    };

    editor.innerHTML = 'A';
    manager.seedState();

    activeSelection = firstChange;
    manager.saveState();
    editor.innerHTML = 'B';

    activeSelection = secondChange;
    manager.saveState();
    editor.innerHTML = 'C';

    activeSelection = { id: 'unrelated-before-undo' };
    manager.performUndo();
    assert.equal(editor.innerHTML, 'B');
    assert.equal(activeSelection, secondChange);

    manager.performUndo();
    assert.equal(editor.innerHTML, 'A');
    assert.equal(activeSelection, firstChange);

    manager.performRedo();
    assert.equal(editor.innerHTML, 'B');
    assert.equal(activeSelection, firstChange);

    manager.performRedo();
    assert.equal(editor.innerHTML, 'C');
    assert.equal(activeSelection, secondChange);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(activeSelection, secondChange);
});

test('StateManager keeps an async edit bound to its request-scoped anchor', async () => {
    const { editor, manager } = await createStateManager({
        maxHistorySize: 10,
        maxHistoryBytes: 4096,
    });
    const initialSelection = { id: 'initial' };
    const typedSelection = { id: 'typed-while-image-picker-was-open' };
    const imageSelection = { id: 'request-scoped-image-location' };
    const unrelatedSelection = { id: 'current-caret-elsewhere' };
    let activeSelection = initialSelection;
    manager.saveSelection = () => activeSelection;
    manager.restoreSelection = (savedSelection) => {
        activeSelection = savedSelection;
        return !!savedSelection;
    };

    editor.innerHTML = 'A';
    manager.seedState();

    editor.innerHTML = 'B';
    activeSelection = typedSelection;
    manager.saveStateDebounced();

    activeSelection = unrelatedSelection;
    manager.beginChangeAtSelection(imageSelection);
    editor.innerHTML = 'C';
    manager.commitStateAfterChange({ changeSelection: imageSelection });

    assert.deepEqual(
        manager.undoStack.map((state) => [state.html, state.selection]),
        [
            ['A', initialSelection],
            ['B', typedSelection],
            ['C', imageSelection],
        ]
    );

    manager.performUndo();
    assert.equal(editor.innerHTML, 'B');
    assert.equal(activeSelection, imageSelection);

    manager.performUndo();
    assert.equal(editor.innerHTML, 'A');
    assert.equal(activeSelection, typedSelection);

    manager.performRedo();
    assert.equal(editor.innerHTML, 'B');
    assert.equal(activeSelection, typedSelection);

    manager.performRedo();
    assert.equal(editor.innerHTML, 'C');
    assert.equal(activeSelection, imageSelection);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(activeSelection, imageSelection);
});

test('StateManager reuses target-DOM bookmarks after normalization rebuilds nodes', async () => {
    const { editor, manager } = await createStateManager({
        maxHistorySize: 10,
        maxHistoryBytes: 4096,
    });
    const initialSelection = { id: 'initial' };
    const sourceChange = { id: 'source-dom-change-path' };
    const mappedA = { id: 'target-a-path' };
    const mappedB = { id: 'target-b-path' };
    const detachedTop = { id: 'detached-top' };
    let activeSelection = initialSelection;
    let normalized = false;
    manager.saveSelection = () => activeSelection;
    manager.restoreSelection = (savedSelection) => {
        if (!normalized && savedSelection === sourceChange) {
            activeSelection = editor.innerHTML === 'A' ? mappedA : mappedB;
            return true;
        }
        const expectedMapped = editor.innerHTML === 'A' ? mappedA : mappedB;
        if (savedSelection === expectedMapped) {
            activeSelection = savedSelection;
            return true;
        }
        return false;
    };
    editor.focus = () => {
        activeSelection = detachedTop;
    };

    editor.innerHTML = 'A';
    manager.seedState();
    activeSelection = sourceChange;
    manager.saveState();
    editor.innerHTML = 'B';
    manager.commitStateAfterChange();

    const normalize = () => {
        normalized = true;
        activeSelection = detachedTop;
    };
    const revealMappedSelection = () => {
        assert.equal(activeSelection, editor.innerHTML === 'A' ? mappedA : mappedB);
    };

    normalized = false;
    manager.performUndo(normalize, revealMappedSelection);
    assert.equal(activeSelection, mappedA);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(activeSelection, mappedA);

    normalized = false;
    manager.performRedo(normalize, revealMappedSelection);
    assert.equal(activeSelection, mappedB);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(activeSelection, mappedB);
});

test('StateManager ignores reconstructed UI while traversing undo and redo history', async () => {
    let editorRef = null;
    const { editor, manager } = await createStateManager({
        maxHistorySize: 10,
        maxHistoryBytes: 4096,
        getComparableHtml: () => editorRef.innerHTML.replace(/\|ui:[^|]*/g, ''),
    });
    editorRef = editor;

    editor.innerHTML = 'A|ui:initial';
    manager.seedState();
    manager.saveState();
    editor.innerHTML = 'B|ui:before-normalize';
    manager.commitStateAfterChange();
    manager.saveState();
    editor.innerHTML = 'C|ui:before-normalize';
    manager.commitStateAfterChange();

    const normalizeRestoredUi = () => {
        const semanticHtml = editor.innerHTML.replace(/\|ui:[^|]*/g, '');
        editor.innerHTML = `${semanticHtml}|ui:rebuilt`;
    };

    assert.equal(manager.performUndo(normalizeRestoredUi), true);
    assert.equal(editor.innerHTML, 'B|ui:rebuilt');
    assert.deepEqual(manager.undoStack.map((state) => state.html[0]), ['A', 'B']);
    assert.deepEqual(manager.redoStack.map((state) => state.html[0]), ['C']);

    assert.equal(manager.performUndo(normalizeRestoredUi), true);
    assert.equal(editor.innerHTML, 'A|ui:rebuilt');

    assert.equal(manager.performRedo(normalizeRestoredUi), true);
    assert.equal(editor.innerHTML, 'B|ui:rebuilt');
    assert.equal(manager.performRedo(normalizeRestoredUi), true);
    assert.equal(editor.innerHTML, 'C|ui:rebuilt');
    await new Promise((resolve) => setTimeout(resolve, 5));
});

test('StateManager ignores selections outside the editor', async () => {
    const { StateManager } = await stateManagerModulePromise;
    const outsideNode = { parentNode: null };
    const editor = {
        contains: () => false,
    };
    const previousWindow = global.window;
    global.window = {
        getSelection: () => ({
            rangeCount: 1,
            getRangeAt: () => ({
                startContainer: outsideNode,
                startOffset: 0,
                endContainer: outsideNode,
                endOffset: 0,
                collapsed: true,
            }),
        }),
    };

    try {
        const manager = new StateManager(editor, null);
        assert.equal(manager.saveSelection(), null);
    } finally {
        if (previousWindow === undefined) {
            delete global.window;
        } else {
            global.window = previousWindow;
        }
    }
});

test('StateManager restores a missing selection path at the nearest editor boundary', async () => {
    const { StateManager } = await stateManagerModulePromise;
    const textNode = {
        nodeType: 3,
        data: 'visible text',
        textContent: 'visible text',
        childNodes: [],
        parentNode: null,
    };
    const paragraph = {
        nodeType: 1,
        childNodes: [textNode],
        parentNode: null,
    };
    const editor = {
        nodeType: 1,
        childNodes: [paragraph],
        contains: (candidate) => candidate === paragraph || candidate === textNode,
    };
    textNode.parentNode = paragraph;
    paragraph.parentNode = editor;

    let restoredRange = null;
    const range = {
        startContainer: null,
        startOffset: null,
        collapsed: false,
        setStart(node, offset) {
            this.startContainer = node;
            this.startOffset = offset;
        },
        setEnd() {},
        collapse(value) {
            this.collapsed = value;
        },
    };
    const selection = {
        removeAllRanges() {},
        addRange(nextRange) {
            restoredRange = nextRange;
        },
    };
    const previousWindow = global.window;
    const previousDocument = global.document;
    global.window = { getSelection: () => selection };
    global.document = { createRange: () => range };

    try {
        const manager = new StateManager(editor, null);
        const restored = manager.restoreSelection({
            startPath: [4, 0],
            startOffset: 20,
            endPath: [4, 0],
            endOffset: 20,
            collapsed: true,
        });

        assert.equal(restored, true);
        assert.equal(restoredRange.startContainer, editor);
        assert.equal(restoredRange.startOffset, editor.childNodes.length);
        assert.equal(restoredRange.collapsed, true);

        manager.restoreSelection({
            startPath: [0, 0, 0],
            startOffset: 4,
            endPath: [0, 0, 0],
            endOffset: 4,
            collapsed: true,
        });
        assert.equal(restoredRange.startContainer, textNode);
        assert.equal(restoredRange.startOffset, 4);
    } finally {
        if (previousWindow === undefined) {
            delete global.window;
        } else {
            global.window = previousWindow;
        }
        if (previousDocument === undefined) {
            delete global.document;
        } else {
            global.document = previousDocument;
        }
    }
});

test('external document updates restore the caret after syntax highlighting', () => {
    const updateStart = editorSource.indexOf("case 'update':");
    const updateEnd = editorSource.indexOf("case 'refresh':", updateStart);
    assert.ok(updateStart >= 0 && updateEnd > updateStart);

    const updateHandlerSource = editorSource.slice(updateStart, updateEnd);
    const highlightIndex = updateHandlerSource.indexOf('codeBlockManager.highlightCodeBlocks();');
    const finalRestoreIndex = updateHandlerSource.lastIndexOf(
        'stateManager.restoreSelection(savedSelection);'
    );
    const finalScrollRestoreIndex = updateHandlerSource.lastIndexOf(
        'editor.scrollTop = scrollTop;'
    );

    assert.ok(highlightIndex >= 0);
    assert.ok(finalRestoreIndex > highlightIndex);
    assert.ok(finalScrollRestoreIndex > finalRestoreIndex);
});

test('initial document state is seeded before delayed normalization', () => {
    const initStart = editorSource.indexOf("case 'init':");
    const initEnd = editorSource.indexOf("case 'loadError':", initStart);
    assert.ok(initStart >= 0 && initEnd > initStart);

    const initHandlerSource = editorSource.slice(initStart, initEnd);
    const seedIndex = initHandlerSource.indexOf('stateManager.seedState();');
    const updatingEndsIndex = initHandlerSource.indexOf('isUpdating = false;');
    const timeoutIndex = initHandlerSource.indexOf('setTimeout(() =>');
    const checkboxNormalizationIndex = initHandlerSource.indexOf('normalizeCheckboxListItems();');
    const imageNormalizationIndex = initHandlerSource.indexOf('applyImageRenderSizes();');

    assert.ok(seedIndex >= 0);
    assert.ok(checkboxNormalizationIndex >= 0 && checkboxNormalizationIndex < seedIndex);
    assert.ok(imageNormalizationIndex >= 0 && imageNormalizationIndex < seedIndex);
    assert.ok(seedIndex < updatingEndsIndex);
    assert.ok(seedIndex < timeoutIndex);
    assert.equal(initHandlerSource.lastIndexOf('stateManager.seedState();'), seedIndex);
});

test('history shortcuts force the restored change location into view', () => {
    const handlerStart = editorSource.indexOf('function handleUndoRedoKeydown(e)');
    const handlerEnd = editorSource.indexOf('function handleFormatShortcutKeydown(e)', handlerStart);
    assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);

    const handlerSource = editorSource.slice(handlerStart, handlerEnd);
    assert.match(handlerSource, /e\.preventDefault\(\)/);
    assert.doesNotMatch(handlerSource, /performEditorHistoryCommand\(/);

    const commandStart = editorSource.indexOf('function performEditorHistoryCommand(direction)');
    assert.ok(commandStart >= 0 && commandStart < handlerStart);
    const commandSource = editorSource.slice(commandStart, handlerStart);
    assert.match(
        commandSource,
        /performUndo\(\s*syncUiAfterHistoryRestore,\s*revealCaretAfterHistoryRestore\s*\)/
    );
    assert.match(
        commandSource,
        /performRedo\(\s*syncUiAfterHistoryRestore,\s*revealCaretAfterHistoryRestore\s*\)/
    );
});

test('VS Code history keybindings use the ManulDown Webview as the single history owner', () => {
    const contributedCommands = packageJson.contributes.commands.map((entry) => entry.command);
    assert.ok(contributedCommands.includes('manulDown.undo'));
    assert.ok(contributedCommands.includes('manulDown.redo'));

    const undoBinding = packageJson.contributes.keybindings.find(
        (entry) => entry.command === 'manulDown.undo'
    );
    const redoBindings = packageJson.contributes.keybindings.filter(
        (entry) => entry.command === 'manulDown.redo'
    );
    const redoBinding = redoBindings.find((entry) => entry.mac === 'cmd+shift+z');
    const alternateRedoBinding = redoBindings.find((entry) => entry.key === 'ctrl+y');
    assert.deepEqual(
        { key: undoBinding.key, mac: undoBinding.mac, when: undoBinding.when },
        {
            key: 'ctrl+z',
            mac: 'cmd+z',
            when: "activeCustomEditorId == 'manulDown.editor'",
        }
    );
    assert.deepEqual(
        { key: redoBinding.key, mac: redoBinding.mac, when: redoBinding.when },
        {
            key: 'ctrl+shift+z',
            mac: 'cmd+shift+z',
            when: "activeCustomEditorId == 'manulDown.editor'",
        }
    );
    assert.deepEqual(
        { key: alternateRedoBinding.key, when: alternateRedoBinding.when },
        {
            key: 'ctrl+y',
            when: "!isMac && activeCustomEditorId == 'manulDown.editor'",
        }
    );

    assert.match(extensionSource, /type:\s*'historyCommand'/);
    assert.match(editorSource, /case 'historyCommand':/);
    assert.match(editorSource, /isHistoryCommandBlockedByComposition\(\)/);
    assert.match(editorSource, /!isMac && e\.ctrlKey[^\n]+key === 'y'/);
    assert.match(editorSource, /document\.execCommand\(direction === 'redo' \? 'redo' : 'undo'\)/);
    assert.doesNotMatch(editorSource, /pendingHistoryCommandEcho/);
    assert.doesNotMatch(stateManagerSource, /type:\s*'undoRedo'/);
    assert.doesNotMatch(providerSource, /case 'undoRedo':/);
    assert.doesNotMatch(providerSource, /PendingWebviewHistoryAction/);
});

test('link input history is committed to document history only when the popover closes', () => {
    const linkStart = editorSource.indexOf('// リンクポップオーバー');
    const linkEnd = editorSource.indexOf('function syncImageResizeOverlayPosition()', linkStart);
    assert.ok(linkStart >= 0 && linkEnd > linkStart);
    const linkSource = editorSource.slice(linkStart, linkEnd);

    const saveStart = linkSource.indexOf('function saveLinkUrlIfChanged(options = {})');
    const saveEnd = linkSource.indexOf('function performLinkInputHistory(direction)', saveStart);
    const draftSaveSource = linkSource.slice(saveStart, saveEnd);
    assert.doesNotMatch(draftSaveSource, /stateManager\.(?:saveStateDebounced|commitStateAfterChange)/);

    assert.match(
        linkSource,
        /function commitLinkHistoryState\(\)[\s\S]*?stateManager\.commitStateAfterChange\(\{[\s\S]*?changeSelection: linkHistorySelection/
    );
    assert.match(
        linkSource,
        /function hideLinkPopover\(skipSave = false\)[\s\S]*?commitLinkHistoryState\(\)/
    );
});

test('StateManager does not redo over a pending text edit', async () => {
    const { editor, manager } = await createStateManager({
        maxHistorySize: 10,
        maxHistoryBytes: 1024,
    });
    for (const html of ['A', 'B', 'C']) {
        editor.innerHTML = html;
        manager.saveState();
    }
    manager.performUndo();
    assert.equal(editor.innerHTML, 'B');
    assert.deepEqual(manager.redoStack.map((state) => state.html), ['C']);

    editor.innerHTML = 'new text';
    manager.saveStateDebounced();
    manager.performRedo();

    assert.equal(editor.innerHTML, 'new text');
    assert.deepEqual(manager.undoStack.map((state) => state.html), ['A', 'B', 'new text']);
    assert.deepEqual(manager.redoStack, []);
});

test('StateManager can immediately undo a debounced programmatic deletion', async () => {
    const { editor, manager, messages } = await createStateManager({
        maxHistorySize: 10,
        maxHistoryBytes: 1024,
    });
    const codeBlock = '<pre><code>\n</code></pre>';
    const deleted = '<p><br></p>';

    editor.innerHTML = codeBlock;
    manager.saveState();
    manager.saveState();
    editor.innerHTML = deleted;
    manager.saveStateDebounced();
    manager.performUndo();

    assert.equal(editor.innerHTML, codeBlock);
    assert.deepEqual(messages, []);
});

test('StateManager does not declare no-op history actions', async () => {
    const { editor, manager, messages } = await createStateManager();
    editor.innerHTML = 'only state';
    manager.saveState();

    manager.performUndo();
    manager.performRedo();

    assert.deepEqual(messages, []);
});

test('StateManager clearHistory releases stacks and byte accounting', async () => {
    const { editor, manager } = await createStateManager();
    editor.innerHTML = 'A';
    manager.saveState();
    editor.innerHTML = 'B';
    manager.saveState();
    manager.performUndo();

    manager.clearHistory();

    assert.deepEqual(manager.undoStack, []);
    assert.deepEqual(manager.redoStack, []);
    assert.equal(manager.undoHistoryBytes, 0);
    assert.equal(manager.redoHistoryBytes, 0);
});
