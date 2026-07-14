const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const stateManagerSource = fs.readFileSync(
    path.join(__dirname, '..', 'media', 'modules', 'StateManager.js'),
    'utf8'
);
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

test('StateManager moves snapshots through redo without creating duplicates', async () => {
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
    assert.deepEqual(
        messages.filter((message) => message.type === 'undoRedo'),
        [
            { type: 'undoRedo', direction: 'undo' },
            { type: 'undoRedo', direction: 'redo' },
            { type: 'undoRedo', direction: 'undo' },
        ]
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
    assert.deepEqual(
        messages.filter((message) => message.type === 'undoRedo'),
        [{ type: 'undoRedo', direction: 'undo' }]
    );
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
