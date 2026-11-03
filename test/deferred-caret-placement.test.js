const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const editorSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'editor.js'), 'utf8');

function sliceEditorSource(startMarker, endMarker) {
    const start = editorSource.indexOf(startMarker);
    const end = editorSource.indexOf(endMarker, start);
    assert.ok(start !== -1 && end !== -1, `editor.js must define ${startMarker}`);
    return editorSource.slice(start, end);
}

// The editor.js helpers with a frame queue the test advances by hand.
function createDeferredCaretPlacement() {
    const frames = new Map();
    let nextFrame = 1;
    const requestAnimationFrame = (callback) => {
        frames.set(nextFrame, callback);
        return nextFrame++;
    };
    const cancelAnimationFrame = (id) => frames.delete(id);
    const source = sliceEditorSource('const pendingCaretPlacements = new Set();', 'function getCodeBlockCursorOffset(');
    const helpers = new Function(
        'requestAnimationFrame', 'cancelAnimationFrame', 'stateManager',
        `${source}\nreturn { deferCaretPlacement, flushPendingCaretPlacement };`
    )(requestAnimationFrame, cancelAnimationFrame, { flushPendingHistoryRestore: () => false });
    const takeFrame = () => {
        const callbacks = [...frames.values()];
        frames.clear();
        return () => callbacks.forEach((callback) => callback());
    };
    return { ...helpers, runFrame: () => takeFrame()(), takeFrame };
}

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
