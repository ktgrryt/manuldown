const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const source = fs.readFileSync(path.join(__dirname, '..', 'media/editor.js'), 'utf8');
function extract(name) {
    const start = source.indexOf(`    function ${name}(`);
    const end = source.indexOf('\n    }\n', start);
    assert.ok(start >= 0 && end > start, name);
    return source.slice(start, end + 6);
}

function fixture() {
    const window = domino.createWindow('<div id="editor"><p>original text</p></div>');
    const document = window.document;
    const editor = document.getElementById('editor');
    const originalNode = editor.firstChild.firstChild;
    const events = [];
    const dependencies = {
        editor,
        cursorManager: { clearInlineCodeBoundaryState() {} },
        tableManager: { cancelCellDrag() {} },
        createSanitizedContainerFromHtml(html) {
            assert.equal(originalNode.isConnected, true, 'the old document still exists during cancellation');
            events.push('sanitize');
            const container = document.createElement('div');
            container.innerHTML = html;
            return container;
        },
        normalizeLoadedEditorBoundaryWhitespace() {}, stripEditorControlCharacters() {}, assignStableHeadingIds() {},
        footnoteManager: { cancelPendingDelete() {}, refresh() {} },
        mathManager: { dismissEditor() {} },
        performAuxiliaryHistoryCommand: () => false,
        typingUndoGroup: { break() {} },
        captureHistoryCaretViewportOffset() {},
        stateManager: {
            performUndo() { events.push('undo'); return true; },
            performRedo() { events.push('redo'); return true; },
        },
        syncUiAfterHistoryRestore() {}, revealCaretAfterHistoryRestore() {},
        onStop: () => events.push('stop'),
    };
    const api = new Function(...Object.keys(dependencies), `
        let manualPointerSelection = null;
        let pendingListMouseAdjustment = {}, pendingInlineCodeSideClick = {}, pendingMouseDriftCorrection = {};
        let historyCaretViewportOffsetPending = null;
        const dragSelectionScroll = { stop: onStop };
        ${['stopManualPointerSelection', 'beginManualPointerSelection', 'updateManualPointerSelection',
        'replaceEditorContentFromHtml', 'performEditorHistoryCommand'].map(extract).join('\n')}
        return {
            begin: beginManualPointerSelection,
            move: updateManualPointerSelection,
            replace: replaceEditorContentFromHtml,
            history: performEditorHistoryCommand,
            state: () => ({ manualPointerSelection, pendingListMouseAdjustment,
                pendingInlineCodeSideClick, pendingMouseDriftCorrection }),
        };
    `)(...Object.values(dependencies));
    const anchor = {
        startContainer: originalNode, startOffset: 4,
        cloneRange() { return { ...this }; },
    };
    api.begin({ button: 0, clientX: 100, clientY: 200 }, anchor);
    return { ...api, editor, originalNode, events };
}

test('document replacement cancels all pending pointer work before removing the old DOM', () => {
    const f = fixture();
    f.replace('<p>replacement text</p>');
    assert.deepEqual(f.events, ['stop', 'sanitize']);
    assert.deepEqual(f.state(), {
        manualPointerSelection: null, pendingListMouseAdjustment: null,
        pendingInlineCodeSideClick: null, pendingMouseDriftCorrection: null,
    });
    assert.equal(f.editor.innerHTML, '<p>replacement text</p>');
    f.move(100, 0);
    assert.deepEqual(f.events, ['stop', 'sanitize'], 'a held button cannot revive the replaced document selection');
});

for (const direction of ['undo', 'redo']) {
    test(`${direction} cancels a manual drag before restoring document history`, () => {
        const f = fixture();
        assert.equal(f.history(direction), true);
        assert.deepEqual(f.events, ['stop', direction]);
        assert.equal(f.state().manualPointerSelection, null);
    });
}

test('manual mousemove rejects a live range that retargeted after its original text was removed', () => {
    const f = fixture();
    const range = f.state().manualPointerSelection.anchorRange;
    f.editor.innerHTML = '<p>replacement</p>';
    range.startContainer = f.editor;
    range.startOffset = 0;
    f.move(100, 0);
    assert.deepEqual(f.events, ['stop']);
    assert.equal(f.state().manualPointerSelection, null);
    assert.equal(f.editor.innerHTML, '<p>replacement</p>');
});

function dragFocusFixture() {
    const window = domino.createWindow('<div id="editor">' +
        ['start', 'visible top', 'visible middle', 'visible bottom', 'end']
            .map(text => `<p>${text}</p>`).join('') + '</div>');
    const document = window.document;
    const editor = document.getElementById('editor');
    const blocks = Array.from(editor.children);
    [-500, 70, 140, 340, 1000].forEach((top, index) => {
        blocks[index].getBoundingClientRect = () => ({ top, bottom: top + 20, height: 20 });
    });
    const hits = [];
    let nativeRange = null;
    let mathRange = null;
    document.elementFromPoint = (x, y) => { hits.push({ type: 'element', x, y }); return editor; };
    const dependencies = {
        editor, document, Node: window.Node,
        dragSelectionScroll: { getViewport: () => ({ top: 60, bottom: 360, left: 0, right: 500 }) },
        mathManager: { getDragSelectionRangeFromPoint: () => mathRange },
        getCaretRangeFromPoint(x, y) { hits.push({ type: 'caret', x, y }); return nativeRange; },
        getLooseLeftSideTextClickRange: () => null, getLooseRightSideTextClickRange: () => null,
        getImageCaretRangeFromHorizontalClick: () => null, getStableGapClickRange: () => null,
        createCollapsedRangeAtElementBoundary: (block, boundary) => ({ block, boundary }),
    };
    const resolve = new Function(...Object.keys(dependencies), `
        ${extract('getNearestBlockBoundaryRangeByY')}
        ${extract('getManualDragFocusRangeFromPoint')}
        return getManualDragFocusRangeFromPoint;
    `)(...Object.values(dependencies));
    return { resolve, hits, blocks,
        setNativeRange(value) { nativeRange = value; },
        setMathRange(value) { mathRange = value; } };
}

test('manual mousemoves above and below the editor select the visible edge rather than the document boundary', () => {
    const f = dragFocusFixture();
    assert.deepEqual(f.resolve(100, 900), { block: f.blocks[3], boundary: 'end' });
    assert.deepEqual(f.resolve(100, -100), { block: f.blocks[1], boundary: 'start' });
    assert.deepEqual(f.hits.filter(hit => hit.type === 'caret'), [
        { type: 'caret', x: 100, y: 358 }, { type: 'caret', x: 100, y: 62 },
    ]);
});

test('manual drag hit-testing stays inside both horizontal editor edges', () => {
    const f = dragFocusFixture();
    f.resolve(-100, 150);
    f.resolve(900, 150);
    assert.deepEqual(f.hits.filter(hit => hit.type === 'caret'), [
        { type: 'caret', x: 2, y: 150 }, { type: 'caret', x: 498, y: 150 },
    ]);
});

test('manual drag hit-testing preserves the native text offset inside the viewport', () => {
    const f = dragFocusFixture();
    const range = { startContainer: f.blocks[2].firstChild, startOffset: 4 };
    f.setNativeRange(range);
    assert.equal(f.resolve(130, 150), range);
    assert.deepEqual(f.hits, [{ type: 'caret', x: 130, y: 150 }]);
});

test('math boundaries take precedence over a native caret probe returning the original drag anchor', () => {
    const f = dragFocusFixture();
    const anchor = { startContainer: f.blocks[1].firstChild, startOffset: 0 };
    const afterMath = { startContainer: f.blocks[3], startOffset: 0 };
    f.setNativeRange(anchor);
    f.setMathRange(afterMath);
    assert.equal(f.resolve(130, 350), afterMath,
        'the selection must not collapse back to its anchor while crossing a preview');
    assert.deepEqual(f.hits, [{ type: 'caret', x: 130, y: 350 }],
        'math overrides the unstable native caret probe');
});
