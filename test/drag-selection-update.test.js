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
