const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const editorSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'editor.js'), 'utf8');

function sliceEditorSource(startMarker, endMarker) {
    const start = editorSource.indexOf(startMarker);
    const end = editorSource.indexOf(endMarker, start);
    assert.ok(start !== -1 && end !== -1, `editor.js must define ${startMarker}`);
    return editorSource.slice(start, end);
}

// The editor.js helpers with a frame queue the test advances by hand.
function createDeferredCaretPlacement(options = {}) {
    const frames = new Map();
    let nextFrame = 1;
    const requestAnimationFrame = (callback) => {
        frames.set(nextFrame, callback);
        return nextFrame++;
    };
    const cancelAnimationFrame = (id) => frames.delete(id);
    const source = sliceEditorSource('const pendingCaretPlacements = new Set();', 'function getCodeBlockCursorOffset(');
    const pointerListeners = sliceEditorSource(
        "document.addEventListener('pointerdown', handlePointerCaretIntent, true);",
        '// Caret moves, shortcuts, clicks and IME input end the current typing'
    );
    const helpers = new Function(
        'requestAnimationFrame', 'cancelAnimationFrame', 'stateManager', 'document',
        'cursorManager', 'isComposing', 'compositionUpdateGate',
        `${source}\n${pointerListeners}\nreturn { deferCaretPlacement, flushPendingCaretPlacement };`
    )(requestAnimationFrame, cancelAnimationFrame,
        options.stateManager || { flushPendingHistoryRestore: () => false },
        options.document || { addEventListener() {} }, options.cursorManager || {},
        options.isComposing || false, options.compositionUpdateGate || { composing: false });
    const takeFrame = () => {
        const callbacks = [...frames.values()];
        frames.clear();
        return () => callbacks.forEach((callback) => callback());
    };
    return { ...helpers, runFrame: () => takeFrame()(), takeFrame };
}

function pointerFixture(html) {
    const window = domino.createWindow(`<div id="editor">${html}</div><input id="outside">`);
    const document = window.document;
    const editor = document.getElementById('editor');
    Object.defineProperty(document, 'activeElement', { configurable: true, value: editor, writable: true });
    editor.focus = () => { document.activeElement = editor; };
    document.createRange = () => ({
        startContainer: null, startOffset: 0, endContainer: null, endOffset: 0,
        get collapsed() { return this.startContainer === this.endContainer && this.startOffset === this.endOffset; },
        setStart(node, offset) {
            this.startContainer = node;
            this.startOffset = offset;
            if (!this.endContainer) this.setEnd(node, offset);
        },
        setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; },
        collapse(toStart) {
            if (toStart) this.setEnd(this.startContainer, this.startOffset);
            else this.setStart(this.endContainer, this.endOffset);
        },
    });
    let range = null;
    const selection = {
        get rangeCount() { return range ? 1 : 0; },
        getRangeAt: () => range,
        removeAllRanges() { range = null; },
        addRange(next) { range = next; },
    };
    window.getSelection = () => selection;
    const select = (node, offset = 0) => {
        range = document.createRange();
        range.setStart(node, offset);
        range.collapse(true);
    };
    const dispatchPointer = (type, target) => {
        const event = document.createEvent('Event');
        event.initEvent(type, true, true);
        target.dispatchEvent(event);
        // Domino does not implement native pointer selection/focus defaults.
        // They run after the real capture handlers installed by the helper.
        if (target.tagName === 'INPUT') {
            document.activeElement = target;
        } else {
            select(target.firstChild, 2);
            document.activeElement = editor;
        }
    };
    return { window, document, editor, selection, select, dispatchPointer, get range() { return range; } };
}

test('a pointer click after code-fence conversion keeps its new caret and focus after the queued frame', () => {
    for (const [type, targetName] of [['pointerdown', 'paragraph'], ['mousedown', 'paragraph'], ['pointerdown', 'input']]) {
        const f = pointerFixture('<p>```</p><p>click here</p>');
        let resets = 0;
        const deferred = createDeferredCaretPlacement({
            document: f.document, cursorManager: { resetCodeVerticalNavigation() { resets++; } },
        });
        const codeHandler = sliceEditorSource('function handleCodeBlockFenceEnterKeydown(', 'function handleCodeBlockEnterKeydown(');
        const env = {
            editor: f.editor, document: f.document, isComposing: false,
            domUtils: { getParentElement: (node, tag) => (node.nodeType === 3 ? node.parentElement : node).closest(tag) },
            stateManager: { saveState() {} },
            codeBlockManager: { addCodeBlockControls() {}, _isMathLanguage: () => false },
            deferCaretPlacement: deferred.deferCaretPlacement, notifyChange() {},
        };
        const convert = new Function(...Object.keys(env), `${codeHandler}\nreturn handleCodeBlockFenceEnterKeydown;`)(...Object.values(env));
        f.select(f.editor.firstChild.firstChild, 3);
        assert.equal(convert({ key: 'Enter', preventDefault() {} }, {
            selection: f.selection, range: f.range, container: f.range.startContainer,
        }), true);
        const target = targetName === 'input' ? f.document.getElementById('outside') : f.editor.lastChild;
        f.dispatchPointer(type, target);
        const clickedRange = f.range;
        deferred.runFrame();
        assert.equal(f.range, clickedRange, `${type}: ${targetName} caret`);
        assert.equal(f.document.activeElement, targetName === 'input' ? target : f.editor);
        assert.equal(resets, 1, 'a new pointer intent resets the preferred code column');
        assert.equal(deferred.flushPendingCaretPlacement(), false);
    }
});

test('a pointer click after Undo finishes the pending history restore before choosing the new location', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'media', 'modules', 'StateManager.js'), 'utf8');
    const { StateManager } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    const f = pointerFixture('<p>A</p><p>click here</p>');
    const previous = { window: global.window, document: global.document };
    Object.assign(global, { window: f.window, document: f.document });
    const history = new StateManager(f.editor, {});
    try {
        const deferred = createDeferredCaretPlacement({ document: f.document, stateManager: history });
        f.select(f.editor.firstChild.firstChild);
        history.seedState();
        history.saveState();
        f.editor.firstChild.textContent = 'B';
        f.select(f.editor.firstChild.firstChild, 1);
        history.commitStateAfterChange();
        assert.equal(history.performUndo(), true);
        assert.ok(history.pendingHistoryRestore);
        f.dispatchPointer('pointerdown', f.editor.lastChild);
        const clickedRange = f.range;
        assert.equal(history.pendingHistoryRestore, null);
        await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(f.range, clickedRange);
        assert.equal(f.range.startContainer.textContent, 'click here');
        assert.equal(f.range.startOffset, 2);
        deferred.runFrame();
        assert.equal(f.range, clickedRange);
    } finally {
        history.clearHistory();
        Object.assign(global, previous);
    }
});

test('pointer capture leaves pending placement untouched while IME owns the caret', () => {
    for (const state of [{ isComposing: true }, { compositionUpdateGate: { composing: true } }]) {
        const f = pointerFixture('<p>typing</p>');
        const deferred = createDeferredCaretPlacement({ document: f.document, ...state });
        let placements = 0;
        deferred.deferCaretPlacement(() => { placements++; });
        f.dispatchPointer('pointerdown', f.editor.firstChild);
        assert.equal(placements, 0);
    }
});

test('a deferred caret placement runs on the next frame', () => {
    const { deferCaretPlacement, flushPendingCaretPlacement, runFrame } = createDeferredCaretPlacement();
    const placements = [];
    deferCaretPlacement(() => placements.push('new item'));
    assert.deepEqual(placements, []);

    runFrame();
    assert.deepEqual(placements, ['new item']);
    assert.equal(flushPendingCaretPlacement(), false);
});

test('a key before the frame places the caret first, and only once', () => {
    const { deferCaretPlacement, flushPendingCaretPlacement, runFrame } = createDeferredCaretPlacement();
    const placements = [];
    deferCaretPlacement(() => placements.push('new item'));

    // An IME keydown arrives before the frame: the caret must already be in the
    // new item when the composition starts, not be moved under it afterwards.
    assert.equal(flushPendingCaretPlacement(), true);
    assert.deepEqual(placements, ['new item']);

    runFrame();
    assert.deepEqual(placements, ['new item']);
});

test('all pending edits complete before IME starts, without a later caret move', () => {
    const { deferCaretPlacement, flushPendingCaretPlacement, runFrame } = createDeferredCaretPlacement();
    const placements = [];
    let caret = 'old item';
    deferCaretPlacement(() => { placements.push('cleanup'); caret = 'new item'; });
    deferCaretPlacement(() => { placements.push('restore'); caret = 'new item end'; });

    assert.equal(flushPendingCaretPlacement(), true);
    assert.deepEqual(placements, ['cleanup', 'restore']);
    assert.equal(caret, 'new item end');
    caret = 'IME uncommitted t';

    runFrame();
    assert.equal(caret, 'IME uncommitted t');
    assert.deepEqual(placements, ['cleanup', 'restore']);
    assert.equal(flushPendingCaretPlacement(), false);
});

test('a frame already dequeued before IME cannot replay a flushed caret move', () => {
    const { deferCaretPlacement, flushPendingCaretPlacement, takeFrame } = createDeferredCaretPlacement();
    let caret = 'old item';
    deferCaretPlacement(() => { caret = 'new item'; });
    const dequeuedFrame = takeFrame();

    flushPendingCaretPlacement();
    assert.equal(caret, 'new item');
    caret = 'IME uncommitted t';
    dequeuedFrame();
    assert.equal(caret, 'IME uncommitted t');
});

test('a cleanup that queues another placement finishes before input too', () => {
    const { deferCaretPlacement, flushPendingCaretPlacement, runFrame } = createDeferredCaretPlacement();
    const placements = [];
    deferCaretPlacement(() => {
        placements.push('cleanup');
        deferCaretPlacement(() => placements.push('caret'));
    });

    flushPendingCaretPlacement();
    assert.deepEqual(placements, ['cleanup', 'caret']);
    runFrame();
    assert.deepEqual(placements, ['cleanup', 'caret']);
});

test('key, input and composition events flush a deferred caret placement', () => {
    assert.match(
        editorSource,
        /editor\.addEventListener\('keydown', \(e\) => \{\s*if \(!e\.isComposing && !isComposing\) \{\s*flushPendingCaretPlacement\(\);\s*\}\s*\}, true\);/
    );
    assert.match(
        editorSource,
        /editor\.addEventListener\('compositionstart', \(\) => \{[^}]*?flushPendingCaretPlacement\(\);/
    );
    assert.match(
        editorSource,
        /editor\.addEventListener\('beforeinput', \(e\) => \{\s*if \(!isComposing && !e\.isComposing\) \{\s*flushPendingCaretPlacement\(\);/
    );
});

test('list Enter never moves the caret on a bare animation frame', () => {
    const source = sliceEditorSource('function handleListItemEnterKeydown(e, context)', 'function handleTabKeydown(');
    assert.doesNotMatch(source, /requestAnimationFrame\(/);
    assert.match(source, /deferCaretPlacement\(/);
});

test('checkbox caret correction leaves the browser IME selection untouched', () => {
    const source = sliceEditorSource('function correctCheckboxCursorPosition()', '// Update list item classes based on content');
    for (const [composing, gateComposing] of [[true, false], [false, true], [false, false]]) {
        let selectionReads = 0;
        const correct = new Function('isComposing', 'compositionUpdateGate', 'window',
            `${source}\nreturn correctCheckboxCursorPosition;`
        )(composing, { composing: gateComposing }, {
            getSelection: () => { selectionReads++; return null; }
        });
        correct();
        assert.equal(selectionReads, composing || gateComposing ? 0 : 1);
    }
});
