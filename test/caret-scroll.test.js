const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const caretScrollSource = fs.readFileSync(
    path.join(__dirname, '..', 'media', 'modules', 'CaretScroll.js'),
    'utf8'
);
const editorSource = fs.readFileSync(
    path.join(__dirname, '..', 'media', 'editor.js'),
    'utf8'
);
const caretScrollModulePromise = import(
    `data:text/javascript;base64,${Buffer.from(caretScrollSource).toString('base64')}`
);

function revealOptions(overrides = {}) {
    return {
        scrollTop: 100,
        scrollHeight: 3000,
        clientHeight: 500,
        viewportTop: 0,
        viewportBottom: 500,
        targetTop: 20,
        targetBottom: 40,
        margin: 8,
        ...overrides
    };
}

test('caret reveal scrolls only enough to expose targets above and below the viewport', async () => {
    const {
        calculateCaretAnchorScrollTop,
        calculateCaretRevealScrollTop
    } = await caretScrollModulePromise;

    assert.equal(calculateCaretRevealScrollTop(revealOptions()), 100);
    assert.equal(calculateCaretRevealScrollTop(revealOptions({
        targetTop: -12,
        targetBottom: 8
    })), 80);
    assert.equal(calculateCaretRevealScrollTop(revealOptions({
        targetTop: 490,
        targetBottom: 510
    })), 118);

    // Chromium drifted the restored caret 60px down in the viewport. Increase
    // scrollTop by the same amount to put it back at its pre-history position.
    assert.equal(calculateCaretAnchorScrollTop({
        scrollTop: 2440,
        scrollHeight: 3420,
        clientHeight: 500,
        currentCaretViewportOffset: 335,
        desiredCaretViewportOffset: 275
    }), 2500);
    assert.equal(calculateCaretAnchorScrollTop({
        scrollTop: 20,
        scrollHeight: 1000,
        clientHeight: 500,
        currentCaretViewportOffset: 10,
        desiredCaretViewportOffset: 100
    }), 0);
});

test('oversized fallback rectangles do not oscillate between their top and bottom edges', async () => {
    const { calculateCaretRevealScrollTop } = await caretScrollModulePromise;
    let scrollTop = 100;
    const contentTop = 120;
    const contentBottom = 2120;

    for (let pass = 0; pass < 5; pass++) {
        scrollTop = calculateCaretRevealScrollTop(revealOptions({
            scrollTop,
            targetTop: contentTop - scrollTop,
            targetBottom: contentBottom - scrollTop
        }));
    }

    assert.equal(scrollTop, 112);
    assert.ok(contentTop - scrollTop >= 8);
    assert.ok(contentTop - scrollTop <= 492);
});

test('element fallback bounds collapse to the caret-facing edge', async () => {
    const {
        calculateCaretRevealScrollTop,
        collapseRectToCaretEdge
    } = await caretScrollModulePromise;
    const rect = { left: 20, right: 420, top: 30, bottom: 2030 };

    assert.deepEqual(collapseRectToCaretEdge(rect), {
        left: 20,
        right: 20,
        top: 30,
        bottom: 30,
        width: 0,
        height: 0,
        x: 20,
        y: 30
    });
    assert.deepEqual(collapseRectToCaretEdge(rect, true), {
        left: 420,
        right: 420,
        top: 2030,
        bottom: 2030,
        width: 0,
        height: 0,
        x: 420,
        y: 2030
    });

    // A native collapsed Range can occasionally report the whole final
    // paragraph. Using its end edge keeps the bottom-padded viewport stable.
    const finalParagraphRect = { left: 20, right: 420, top: -1500, bottom: 295 };
    const caretEdge = collapseRectToCaretEdge(finalParagraphRect, true);
    assert.equal(calculateCaretRevealScrollTop({
        scrollTop: 2500,
        scrollHeight: 3420,
        clientHeight: 500,
        viewportTop: 0,
        viewportBottom: 500,
        targetTop: caretEdge.top,
        targetBottom: caretEdge.bottom,
        margin: 8
    }), 2500);
});

test('history reveal uses native caret geometry and coalesces restoration passes', () => {
    const ensureStart = editorSource.indexOf('function ensureCaretVisible(force = false)');
    const ensureEnd = editorSource.indexOf('function scheduleEnsureCaretVisible', ensureStart);
    const ensureSource = editorSource.slice(ensureStart, ensureEnd);
    assert.ok(ensureStart >= 0 && ensureEnd > ensureStart);
    assert.match(ensureSource, /measureCaretRangeRect\(caretRange\)/);

    const measureStart = editorSource.indexOf('function measureCaretRangeRect(range)');
    const measureEnd = editorSource.indexOf(
        'function captureHistoryCaretViewportOffset',
        measureStart
    );
    const measureSource = editorSource.slice(measureStart, measureEnd);
    assert.ok(measureStart >= 0 && measureEnd > measureStart);
    assert.ok(measureSource.indexOf('getNativeCaretRect(range)') <
        measureSource.indexOf('cursorManager._getCaretRect'));

    const revealStart = editorSource.indexOf('function revealCaretAfterHistoryRestore(');
    const revealEnd = editorSource.indexOf('function focusEditorAndRevealCaret', revealStart);
    const revealSource = editorSource.slice(revealStart, revealEnd);
    assert.match(revealSource, /scheduleEnsureCaretVisible\(true, preservedScrollTop\)/);
    assert.doesNotMatch(revealSource, /ensureCaretVisible\(true\)/);

    const historyStart = editorSource.indexOf('function performEditorHistoryCommand(direction)');
    const historyEnd = editorSource.indexOf('function handleUndoRedoKeydown', historyStart);
    const historySource = editorSource.slice(historyStart, historyEnd);
    assert.equal((historySource.match(/revealCaretAfterHistoryRestore/g) || []).length, 2);
    assert.match(historySource, /captureHistoryCaretViewportOffset\(\)/);

    const scheduleStart = editorSource.indexOf('function scheduleEnsureCaretVisible');
    const scheduleEnd = editorSource.indexOf(
        'function revealCaretAfterKeyboardNavigation',
        scheduleStart
    );
    const scheduleSource = editorSource.slice(scheduleStart, scheduleEnd);
    const anchorIndex = scheduleSource.indexOf('calculateCaretAnchorScrollTop');
    const revealIndex = scheduleSource.indexOf('ensureCaretVisible(shouldForce)');
    assert.ok(anchorIndex >= 0 && revealIndex > anchorIndex);
});

function extractEditorFunction(name) {
    const start = editorSource.indexOf(`    function ${name}(`);
    const end = editorSource.indexOf('\n    }', start);
    assert.ok(start >= 0 && end > start, `${name} exists`);
    return editorSource.slice(start, end + '\n    }'.length);
}

async function searchCloseCaretFixture() {
    const { calculateCaretAnchorScrollTop, calculateCaretRevealScrollTop } = await caretScrollModulePromise;
    const text = { nodeType: 3 };
    const range = {
        startContainer: text, endContainer: text,
        startOffset: 0, endOffset: 0, collapsed: true
    };
    const editor = {
        scrollTop: 800, scrollHeight: 3000, clientHeight: 400,
        contains: node => node === text,
        getBoundingClientRect: () => ({ top: 0, bottom: 400, height: 400 })
    };
    const frames = [];
    let keydownHandler;
    editor.addEventListener = (type, handler) => {
        assert.equal(type, 'keydown');
        keydownHandler = handler;
    };
    const dependencies = {
        editor,
        dragSelectionScroll: { isSelectingWithPointer: false },
        window: { getSelection: () => ({ rangeCount: 1, isCollapsed: true, getRangeAt: () => range }) },
        requestAnimationFrame: callback => frames.push(callback),
        calculateCaretAnchorScrollTop, calculateCaretRevealScrollTop,
        measureCaretRangeRect: () => ({ top: 50 - editor.scrollTop, bottom: 70 - editor.scrollTop }),
        ensureCodeBlockCaretVisible() {},
        isHRSelected: () => null,
        getSelectedCodeBlockLanguageLabel: () => null,
        getSelectedImageNodeFromRange: () => null,
        isImeInteractionKeydown: () => false,
        handleKeydown() {}, // A forward key at document end leaves the range unchanged.
        handleVerticalNavigation: navigate => navigate(),
        cursorManager: {},
        footnoteManager: { normalizeCaret() {} },
        mathManager: { normalizeCaret() {} },
        codeBlockGapManager: { reconcile() {} },
        syncCheckboxCaretIndicatorNow() {}
    };
    const functions = ['preserveViewportAfterSearchClose', 'ensureCaretVisible',
        'scheduleEnsureCaretVisible', 'revealCaretAfterKeyboardNavigation'];
    const keydownStart = editorSource.indexOf('// キーボードイベント\n');
    const keydownEnd = editorSource.indexOf('// Reset the preferred column', keydownStart);
    assert.ok(keydownStart >= 0 && keydownEnd > keydownStart);
    const helpers = new Function(...Object.keys(dependencies), `
        let isUpdating = false, lastCaretIntentSource = 'keyboard', lastPointerCaretIntentTs = 0;
        let caretScrollRaf = null, caretScrollForcePending = false, caretScrollRestoreTopPending = null;
        let historyCaretViewportOffsetPending = null, searchCloseSelection = null;
        const isMac = true, isComposing = false, compositionUpdateGate = { composing: false };
        const caretScrollMargin = 8;
        ${functions.map(extractEditorFunction).join('\n')}
        ${editorSource.slice(keydownStart, keydownEnd)}
        return { ${functions.join(', ')} };
    `)(...Object.values(dependencies));
    return {
        ...helpers, editor, range,
        setPointerDrag(active) { dependencies.dragSelectionScroll.isSelectingWithPointer = active; },
        key(event) { keydownHandler(event); },
        runFrame() {
            const callbacks = frames.splice(0);
            callbacks.forEach(callback => callback());
        }
    };
}

test('closing search keeps the viewport through delayed selectionchange frames', async () => {
    const f = await searchCloseCaretFixture();
    f.scheduleEnsureCaretVisible(true, 0);
    f.preserveViewportAfterSearchClose();
    f.runFrame();
    assert.equal(f.editor.scrollTop, 800, 'pending keyboard reveal must not override search close');

    // Chromium can deliver the restored selectionchange after the first frame.
    for (let frame = 0; frame < 2; frame++) {
        f.scheduleEnsureCaretVisible();
        f.runFrame();
        assert.equal(f.editor.scrollTop, 800);
    }
});

test('a new caret position resumes automatic reveal after closing search', async () => {
    const f = await searchCloseCaretFixture();
    f.preserveViewportAfterSearchClose();
    f.range.startOffset = f.range.endOffset = 1;
    f.scheduleEnsureCaretVisible();
    f.runFrame();
    assert.equal(f.editor.scrollTop, 42);
});

test('a transient collapsed native selection cannot reveal the caret during a held-button drag', async () => {
    const f = await searchCloseCaretFixture();
    // This range lies above the viewport, as when native selection briefly
    // returns to its anchor while crossing a display formula and trailing NBSP.
    f.setPointerDrag(true);
    for (let frame = 0; frame < 3; frame++) {
        f.scheduleEnsureCaretVisible();
        f.runFrame();
        assert.equal(f.editor.scrollTop, 800);
    }
    f.setPointerDrag(false);
    f.scheduleEnsureCaretVisible();
    f.runFrame();
    assert.equal(f.editor.scrollTop, 42, 'normal caret reveal resumes when the pointer gesture ends');
});

test('explicit keyboard navigation still reveals its caret during a pointer gesture', async () => {
    const f = await searchCloseCaretFixture();
    f.preserveViewportAfterSearchClose();
    f.setPointerDrag(true);
    f.key({ key: 'f', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false });
    f.runFrame();
    assert.equal(f.editor.scrollTop, 42);
});

test('Control+F at document end reveals even the same caret after search close', async () => {
    const f = await searchCloseCaretFixture();
    f.preserveViewportAfterSearchClose();
    f.key({ key: 'f', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false });
    f.runFrame();
    assert.equal(f.editor.scrollTop, 42);
});

test('native editor mutations checkpoint their pre-input state', () => {
    const beforeInputStart = editorSource.indexOf("editor.addEventListener('beforeinput'");
    const inputStart = editorSource.indexOf("editor.addEventListener('input'", beforeInputStart);
    const beforeInputSource = editorSource.slice(beforeInputStart, inputStart);

    assert.ok(beforeInputStart >= 0 && inputStart > beforeInputStart);
    assert.match(beforeInputSource, /\^\(\?:insert\|delete\)/);
    assert.match(beforeInputSource, /stateManager\.saveState\(\)/);
    const checkpointIndex = beforeInputSource.indexOf('stateManager.saveState();');
    const nativeDeleteBranchIndex = beforeInputSource.indexOf(
        "if (typeof e.inputType === 'string' && e.inputType.startsWith('delete'))",
        checkpointIndex
    );
    assert.ok(
        checkpointIndex >= 0 &&
        nativeDeleteBranchIndex > checkpointIndex
    );
});
