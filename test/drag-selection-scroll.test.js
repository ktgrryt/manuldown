const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const source = fs.readFileSync(path.join(__dirname, '..', 'media/modules/DragSelectionScroll.js'), 'utf8');
const editorSource = fs.readFileSync(path.join(__dirname, '..', 'media/editor.js'), 'utf8');
const modulePromise = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

class BookmarkRange {
    setStart(node, offset) { this.startContainer = node; this.startOffset = offset; }
    setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; }
    collapse() { this.setEnd(this.startContainer, this.startOffset); }
    cloneRange() { return Object.assign(new BookmarkRange(), this); }
    selectNodeContents(node) {
        this.setStart(node, 0);
        this.setEnd(node, node.nodeType === 3 ? node.length : node.childNodes.length);
    }
    getBoundingClientRect() { return { left: 40, right: 200, top: 100, bottom: 120 }; }
    compareBoundaryPoints(_how, other) {
        if (this.startContainer === other.startContainer) return this.startOffset - other.startOffset;
        return this.startContainer.compareDocumentPosition(other.startContainer) & 4 ? -1 : 1;
    }
}

async function fixture({ scrollTop = 1000, directionalSelection = true,
    manual = true, listTag = 'ul', task = false, nested = false } = {}) {
    const { DragSelectionScroll } = await modulePromise;
    const tag = listTag ? 'li' : 'p';
    let content = Array.from({ length: 200 }, (_, index) => `<${tag} data-line>${
        task ? '<input type="checkbox">' : ''}Line ${index} with text</${tag}>`).join('');
    if (listTag) content = `<${listTag}>${content}</${listTag}>`;
    if (nested) content = `<ul><li>parent${content}</li></ul>`;
    const window = domino.createWindow(`<div id="editor" contenteditable="true">${content}
        <button>Control</button><textarea>Input</textarea></div><div id="outside">Outside</div>`);
    const document = window.document;
    const editor = document.getElementById('editor');
    const lines = Array.from(editor.querySelectorAll('[data-line]'), element =>
        Array.from(element.childNodes).find(node => node.nodeType === 3));
    let currentScrollTop = scrollTop;
    let scrollWrites = 0;
    Object.defineProperties(editor, {
        clientHeight: { value: 300 }, clientWidth: { value: 500 },
        clientTop: { value: 0 }, clientLeft: { value: 0 },
        scrollHeight: { value: 4000 },
        scrollTop: {
            get: () => currentScrollTop,
            set(value) { currentScrollTop = value; scrollWrites++; },
        },
    });
    editor.getBoundingClientRect = () => ({ left: 0, right: 500, top: 60, bottom: 360 });
    window.innerHeight = 600;
    window.innerWidth = 800;
    document.createRange = () => new BookmarkRange();
    const bookmark = (node, offset = 0) => {
        const range = new BookmarkRange();
        range.setStart(node, offset);
        range.collapse();
        return range;
    };
    const selection = {
        rangeCount: 1, anchorNode: lines[55], anchorOffset: 4, focusNode: lines[55], focusOffset: 4,
        setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) {
            Object.assign(this, { anchorNode, anchorOffset, focusNode, focusOffset });
        },
        removeAllRanges() { this.rangeCount = 0; },
        addRange(range) {
            this.rangeCount = 1;
            Object.assign(this, { anchorNode: range.startContainer, anchorOffset: range.startOffset,
                focusNode: range.endContainer, focusOffset: range.endOffset });
        },
    };
    if (!directionalSelection) delete selection.setBaseAndExtent;
    window.getSelection = () => selection;
    let sequence = 0;
    let now = 0;
    const frames = new Map();
    window.requestAnimationFrame = callback => { frames.set(++sequence, callback); return sequence; };
    window.cancelAnimationFrame = id => frames.delete(id);
    const hits = [];
    let enabled = true;
    let manualAnchor = manual ? bookmark(lines[55], 4) : null;
    const controller = new DragSelectionScroll(editor, {
        isEnabled: () => enabled,
        getAnchorRange: () => manualAnchor,
        resolveFocusRange(x, y) {
            hits.push({ x, y, scrollTop: editor.scrollTop });
            const index = Math.max(0, Math.min(lines.length - 1, Math.floor((y - 60 + editor.scrollTop) / 20)));
            return bookmark(lines[index], 2);
        },
    });
    const dispatch = (type, props = {}, target = document) => {
        const event = document.createEvent('Event');
        event.initEvent(type, true, true);
        Object.assign(event, props);
        target.dispatchEvent(event);
        return event;
    };
    return {
        editor, document, window, lines, selection, hits, bookmark, controller,
        get frameCount() { return frames.size; },
        get scrollWrites() { return scrollWrites; },
        setEnabled(value) { enabled = value; },
        setManualAnchor(value) { manualAnchor = value; },
        down(props = {}, target = editor) {
            return dispatch('mousedown', { button: 0, detail: 1, clientX: 100, clientY: 200, ...props }, target);
        },
        move(x, y, buttons = 1) { dispatch('mousemove', { clientX: x, clientY: y, buttons }); },
        dispatch,
        frame(elapsed = 1000 / 60) {
            now += elapsed;
            const callbacks = [...frames.values()];
            frames.clear();
            callbacks.forEach(callback => callback(now));
        },
        waitForFallback() {
            for (let i = 0; i < 16; i++) this.frame();
        },
    };
}

function installEditorListMouseDown(f) {
    const text = f.lines[55];
    const target = text.parentElement;
    const querySelector = target.querySelector.bind(target);
    // Domino does not implement :scope; the browser uses this direct-child query.
    Object.defineProperty(target, 'querySelector', { value: selector => selector === ':scope > input[type="checkbox"]'
        ? Array.from(target.children).find(child => child.matches('input[type="checkbox"]')) || null
        : querySelector(selector) });
    f.document.elementFromPoint = () => target;
    const beginStart = editorSource.indexOf('    function beginManualPointerSelection(');
    const beginEnd = editorSource.indexOf('\n    }', beginStart) + 6;
    const start = editorSource.indexOf("        editor.addEventListener('mousedown', (e) => {",
        editorSource.indexOf('// mousedownイベント'));
    const end = editorSource.indexOf("        document.addEventListener('mousemove',", start);
    assert.ok(beginStart > 0 && start > 0 && end > start);
    const dependencies = {
        editor: f.editor, document: f.document, window: f.window,
        Node: f.window.Node, NodeFilter: f.window.NodeFilter,
        cursorManager: { clearInlineMathVerticalState() {}, clearInlineCodeBoundaryState() {} },
        tableManager: { handleMouseDown: () => false },
        domUtils: {
            getParentElement(node, tag) {
                return (node.nodeType === 3 ? node.parentElement : node).closest(tag.toLowerCase());
            },
        },
        getImageCaretRangeFromHorizontalClick: () => null,
        getCaretRangeFromPoint: () => f.bookmark(text, 4),
        isEditorRootTextRange: () => false,
        getFirstDirectTextNodeAfterCheckbox: item => Array.from(item.childNodes).find(node => node.nodeType === 3),
        getCheckboxTextMinOffset: () => 0,
        focusEditorWithoutScroll() {},
    };
    const getAnchorRange = new Function(...Object.keys(dependencies), `
        const isUpdating = false;
        let pendingListMouseAdjustment, pendingInlineCodeSideClick, pendingMouseDriftCorrection;
        let manualPointerSelection, lastPointerCaretIntentTs, lastCaretIntentSource, caretScrollForcePending;
        ${editorSource.slice(beginStart, beginEnd)}
        ${editorSource.slice(start, end)}
        return () => manualPointerSelection?.anchorRange;
    `)(...Object.values(dependencies));
    f.controller.getAnchorRange = getAnchorRange;
    return { target, getAnchorRange };
}

for (const options of [{ listTag: 'ul' }, { listTag: 'ol' }, { listTag: 'ul', nested: true }, { listTag: 'ul', task: true }]) {
    const kind = options.task ? 'task list' : options.nested ? 'nested list' : options.listTag;
    test(`dragging from a ${kind}'s corrected right margin scrolls and keeps its text anchor`, async () => {
        const f = await fixture({ ...options, manual: false });
        const { target, getAnchorRange } = installEditorListMouseDown(f);
        assert.equal(f.down({ clientX: 240 }, target).defaultPrevented, true);
        assert.equal(getAnchorRange().startContainer, f.lines[55]);
        assert.equal(getAnchorRange().startOffset, f.lines[55].length);
        f.move(100, 0);
        f.waitForFallback();
        assert.ok(f.editor.scrollTop < 1000);
        assert.equal(f.selection.anchorNode, f.lines[55]);
        assert.equal(f.selection.anchorOffset, f.lines[55].length);
        assert.ok(f.lines.indexOf(f.selection.focusNode) < 55);
    });
}

test('dragging from the task-list marker area participates in selection scrolling', async () => {
    const f = await fixture({ manual: false, task: true });
    const { target, getAnchorRange } = installEditorListMouseDown(f);
    assert.equal(f.down({ clientX: 10 }, target).defaultPrevented, true);
    assert.ok(getAnchorRange(), 'cancelling the native mousedown must start a manual selection');
    assert.equal(getAnchorRange().startContainer, f.lines[55]);
    assert.equal(getAnchorRange().startOffset, 0);
    f.move(100, 0);
    f.waitForFallback();
    assert.ok(f.editor.scrollTop < 1000);
    assert.equal(f.selection.anchorNode, f.lines[55]);
});

for (const listTag of [null, 'ul', 'ol']) {
    test(`ordinary ${listTag || 'paragraph'} text selections retain native scrolling`, async () => {
        const f = await fixture({ manual: false, listTag });
        const { target, getAnchorRange } = installEditorListMouseDown(f);
        assert.equal(f.down({ clientX: 100 }, target).defaultPrevented, false);
        assert.equal(getAnchorRange(), undefined);
        f.move(100, 0);
        f.waitForFallback();
        assert.equal(f.frameCount, 0);
        assert.equal(f.scrollWrites, 0);
        assert.equal(f.hits.length, 0);
    });
}

test('dragging above the editor keeps scrolling and extending a backward selection while the pointer is stationary', async () => {
    const f = await fixture();
    const originalHtml = f.editor.innerHTML;
    f.down();
    f.move(100, 0);
    f.waitForFallback();
    const firstFocus = f.selection.focusNode;
    const firstScroll = f.editor.scrollTop;
    for (let i = 0; i < 12; i++) f.frame();
    assert.ok(f.editor.scrollTop < firstScroll && firstScroll < 1000);
    assert.equal(f.selection.anchorNode, f.lines[55]);
    assert.equal(f.selection.anchorOffset, 4);
    assert.ok(f.lines.indexOf(f.selection.focusNode) < f.lines.indexOf(firstFocus));
    assert.ok(f.lines.indexOf(f.selection.focusNode) > 0, 'hit-testing stays at the visible top, rather than the document start');
    assert.ok(f.hits.every(hit => hit.y === 62));
    assert.equal(f.editor.innerHTML, originalHtml);
});

test('dragging below the viewport scrolls down and clamps hit-testing inside the editor', async () => {
    const f = await fixture();
    f.down();
    f.move(900, 900);
    f.waitForFallback();
    for (let i = 0; i < 8; i++) f.frame();
    assert.ok(f.editor.scrollTop > 1000);
    assert.equal(f.selection.anchorNode, f.lines[55]);
    assert.ok(f.lines.indexOf(f.selection.focusNode) > 55);
    assert.ok(f.hits.every(hit => hit.x === 498 && hit.y === 358));
});

test('a clipped editor uses its visible container edges for drag hit-testing in both directions', async () => {
    const f = await fixture();
    const container = f.document.createElement('div');
    container.className = 'editor-container';
    f.editor.parentNode.insertBefore(container, f.editor);
    container.appendChild(f.editor);
    container.getBoundingClientRect = () => ({ top: 100, bottom: 260, left: 30, right: 480 });
    assert.deepEqual(f.controller.getViewport(), { top: 100, bottom: 260, left: 30, right: 480 });
    f.down();
    f.move(900, 900);
    f.waitForFallback();
    assert.ok(f.editor.scrollTop > 1000);
    assert.ok(f.hits.every(hit => hit.x === 478 && hit.y === 258));
    f.move(-100, -100);
    f.waitForFallback();
    assert.deepEqual({ x: f.hits.at(-1).x, y: f.hits.at(-1).y }, { x: 32, y: 102 });
});

test('a drag from a manually placed gap caret retains the original anchor', async () => {
    const f = await fixture();
    f.setManualAnchor(f.bookmark(f.lines[58], 6));
    // Manual backward selection installs an ordered range whose native anchor
    // is now the earlier endpoint. Auto-scroll must retain the drag's start.
    f.selection.anchorNode = f.lines[51];
    f.down();
    f.move(100, 60);
    f.waitForFallback();
    assert.equal(f.selection.anchorNode, f.lines[58]);
    assert.equal(f.selection.anchorOffset, 6);
    assert.ok(f.editor.scrollTop < 1000);
});

test('a normal paragraph selection keeps its browser-owned anchor and never starts a helper animation', async () => {
    const f = await fixture({ manual: false, listTag: null });
    f.selection.anchorNode = f.lines[1];
    f.down();
    f.selection.anchorNode = f.lines[56];
    f.selection.anchorOffset = 8;
    f.move(100, 60);
    f.waitForFallback();
    assert.equal(f.selection.anchorNode, f.lines[56]);
    assert.equal(f.selection.anchorOffset, 8);
    assert.equal(f.frameCount, 0);
    assert.equal(f.scrollWrites, 0);
    assert.equal(f.hits.length, 0);
});

test('a native drag remains observable without taking over its scrolling or selection', async () => {
    const f = await fixture({ manual: false });
    f.down();
    assert.equal(f.controller.isSelectingWithPointer, false);
    f.move(101, 201);
    assert.equal(f.controller.isSelectingWithPointer, false, 'a click or pointer jitter is not a selection drag');
    f.move(100, 360);
    assert.equal(f.controller.drag, null, 'the scroll assistant still leaves native selections alone');
    assert.equal(f.controller.isSelectingWithPointer, true);
    f.move(100, 200);
    assert.equal(f.controller.isSelectingWithPointer, true, 'returning inside the viewport keeps the held gesture');
    f.waitForFallback();
    assert.equal(f.frameCount, 0);
    assert.equal(f.scrollWrites, 0);
    assert.equal(f.hits.length, 0);
});

for (const end of ['mouseup', 'lost button', 'blur', 'dragstart', 'pointercancel', 'hidden']) {
    test(`${end} ends observation of a native drag that never enabled scroll assistance`, async () => {
        const f = await fixture({ manual: false });
        f.down();
        f.move(100, 360);
        assert.equal(f.controller.isSelectingWithPointer, true);
        if (end === 'lost button') f.move(100, 360, 0);
        else if (end === 'hidden') {
            Object.defineProperty(f.document, 'visibilityState', { value: 'hidden' });
            f.dispatch('visibilitychange');
        } else f.dispatch(end, {}, end === 'blur' ? f.window : f.document);
        assert.equal(f.controller.isSelectingWithPointer, false);
        assert.equal(f.scrollWrites, 0);
        assert.equal(f.frameCount, 0);
    });
}

test('the native selection scroll gets time to start before a fallback changes anything', async () => {
    const f = await fixture();
    f.down();
    f.move(100, 60);
    for (let i = 0; i < 10; i++) f.frame();
    assert.equal(f.editor.scrollTop, 1000);
    assert.equal(f.scrollWrites, 0);
    assert.equal(f.hits.length, 0);
    f.waitForFallback();
    assert.ok(f.editor.scrollTop < 1000, 'a stalled native drag still gets scroll assistance');
});

test('native scrolling keeps exactly its own speed and selection in either direction', async () => {
    for (const direction of [-1, 1]) {
        const f = await fixture({ manual: false });
        f.down();
        f.move(100, direction < 0 ? 60 : 360);
        f.selection.focusNode = f.lines[60];
        for (let i = 0; i < 60; i++) {
            // Native scrolling can vary its speed from one frame to the next.
            const nativePosition = f.editor.scrollTop + direction * (1 + i % 9);
            f.editor.scrollTop = nativePosition;
            const writes = f.scrollWrites;
            f.move(100, direction < 0 ? 60 : 360);
            f.frame();
            assert.equal(f.editor.scrollTop, nativePosition);
            assert.equal(f.scrollWrites, writes, 'the helper must not add even a second same-position scroll write');
            assert.equal(f.selection.focusNode, f.lines[60]);
        }
        assert.equal(f.hits.length, 0, 'native selection is also left alone');
    }
});

test('intermittent native frames are not mistaken for a stalled drag', async () => {
    const f = await fixture();
    f.down();
    f.move(100, 60);
    for (let i = 0; i < 50; i++) {
        if (i % 5 === 0) f.editor.scrollTop -= 8;
        const nativePosition = f.editor.scrollTop;
        const writes = f.scrollWrites;
        f.frame();
        assert.equal(f.editor.scrollTop, nativePosition);
        assert.equal(f.scrollWrites, writes);
    }
    assert.equal(f.hits.length, 0);
});

test('a fallback yields immediately when native scrolling resumes, and only assists again after a stall', async () => {
    const f = await fixture();
    f.down();
    f.move(100, 60);
    f.waitForFallback();
    const nativePosition = f.editor.scrollTop - 6;
    f.editor.scrollTop = nativePosition;
    const writes = f.scrollWrites;
    const hits = f.hits.length;
    f.frame();
    for (let i = 0; i < 8; i++) f.frame();
    assert.equal(f.editor.scrollTop, nativePosition);
    assert.equal(f.scrollWrites, writes);
    assert.equal(f.hits.length, hits);
    f.waitForFallback();
    assert.ok(f.editor.scrollTop < nativePosition);
    assert.equal(f.selection.anchorNode, f.lines[55]);
});

test('explicit wheel scrolling pauses assistance without consuming wheel events or their momentum', async () => {
    const f = await fixture();
    f.down();
    f.move(100, 60);
    f.waitForFallback();
    const event = f.dispatch('wheel', { deltaY: 30 }, f.editor);
    assert.equal(event.defaultPrevented, false);
    assert.equal(f.frameCount, 0);
    f.editor.scrollTop += 30;
    const nativePosition = f.editor.scrollTop;
    f.waitForFallback();
    assert.equal(f.editor.scrollTop, nativePosition);
    f.move(101, 61);
    assert.equal(f.frameCount, 0, 'incidental pointer jitter must not interrupt wheel momentum');
    assert.ok(f.controller.drag, 'wheel scrolling retains the active drag');
});

test('the same held-button drag resumes at an edge after a wheel adjustment', async () => {
    const f = await fixture();
    f.down();
    f.move(100, 60);
    f.waitForFallback();
    f.dispatch('wheel', { deltaY: 30 }, f.editor);
    f.editor.scrollTop += 30;
    const afterWheel = f.editor.scrollTop;
    f.move(100, 200);
    f.move(100, 60);
    f.waitForFallback();
    assert.ok(f.editor.scrollTop < afterWheel);
    assert.equal(f.selection.anchorNode, f.lines[55]);
    assert.equal(f.selection.anchorOffset, 4);
});

test('resuming a drag after wheel scrolling still yields to native momentum', async () => {
    const f = await fixture();
    f.down();
    f.move(100, 60);
    f.waitForFallback();
    f.dispatch('wheel', { deltaY: 30 }, f.editor);
    f.move(100, 70);
    for (let i = 0; i < 30; i++) {
        f.editor.scrollTop += 3;
        const nativePosition = f.editor.scrollTop;
        const writes = f.scrollWrites;
        f.frame();
        assert.equal(f.editor.scrollTop, nativePosition);
        assert.equal(f.scrollWrites, writes);
    }
    const afterMomentum = f.editor.scrollTop;
    f.waitForFallback();
    assert.ok(f.editor.scrollTop < afterMomentum);
    assert.equal(f.selection.anchorNode, f.lines[55]);
});

test('returning to the center cancels scrolling and returning to an edge resumes the same drag', async () => {
    const f = await fixture();
    f.down();
    f.move(100, 65);
    f.waitForFallback();
    const before = f.editor.scrollTop;
    f.move(100, 200);
    assert.equal(f.frameCount, 0);
    f.frame();
    assert.equal(f.editor.scrollTop, before);
    f.move(100, 65);
    f.waitForFallback();
    assert.ok(f.editor.scrollTop < before);
    assert.equal(f.selection.anchorNode, f.lines[55]);
});

test('hovering with selected text, clicks and small pointer jitter never start auto-scroll', async () => {
    const f = await fixture();
    f.selection.focusNode = f.lines[60];
    f.move(100, 60, 0);
    assert.equal(f.frameCount, 0);
    f.down({ clientY: 65 });
    f.move(101, 64);
    assert.equal(f.frameCount, 0);
    f.down();
    f.move(105, 200);
    assert.equal(f.frameCount, 0);
    assert.equal(f.editor.scrollTop, 1000);
});

for (const end of ['mouseup', 'lost button', 'blur', 'dragstart', 'pointercancel', 'hidden']) {
    test(`${end} stops a selection scroll immediately`, async () => {
        const f = await fixture();
        f.down();
        f.move(100, 60);
        f.waitForFallback();
        const before = f.editor.scrollTop;
        if (end === 'lost button') f.move(100, 60, 0);
        else if (end === 'hidden') {
            Object.defineProperty(f.document, 'visibilityState', { value: 'hidden' });
            f.dispatch('visibilitychange');
        } else f.dispatch(end, {}, end === 'blur' ? f.window : f.document);
        assert.equal(f.frameCount, 0);
        f.frame();
        assert.equal(f.editor.scrollTop, before);
    });
}

test('controls, other panels, modified clicks and disabled editor states do not start text-selection scrolling', async () => {
    const f = await fixture();
    for (const target of [f.editor.querySelector('button'), f.editor.querySelector('textarea'), f.document.getElementById('outside')]) {
        f.down({}, target);
        f.move(100, 60);
        assert.equal(f.frameCount, 0);
    }
    for (const props of [{ button: 2 }, { metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
        f.down(props);
        f.move(100, 60);
        assert.equal(f.frameCount, 0);
    }
    f.setEnabled(false);
    f.down();
    f.move(100, 60);
    assert.equal(f.frameCount, 0);
});

test('an editor update or detached selection anchor stops an active scroll', async () => {
    for (const detach of [false, true]) {
        const f = await fixture();
        f.down();
        f.move(100, 60);
        f.waitForFallback();
        const before = f.editor.scrollTop;
        if (detach) f.selection.anchorNode.parentNode.remove();
        else f.setEnabled(false);
        f.frame();
        assert.equal(f.frameCount, 0);
        assert.equal(f.editor.scrollTop, before);
    }
});

test('a normal mousedown can clear a previous table selection before drag scrolling starts', async () => {
    const f = await fixture();
    f.setEnabled(false);
    f.down();
    f.setEnabled(true);
    f.move(100, 60);
    f.waitForFallback();
    assert.ok(f.editor.scrollTop < 1000);
});

test('hit-testing respects the visible window when the editor extends beyond it', async () => {
    const f = await fixture();
    f.window.innerHeight = 250;
    f.down();
    f.move(100, 600);
    f.waitForFallback();
    assert.equal(f.hits[0].y, 248);
    assert.ok(f.editor.scrollTop > 1000);
});

test('scrolling clamps at both document boundaries and releases its animation frame', async () => {
    for (const bottom of [false, true]) {
        const f = await fixture({ scrollTop: bottom ? 3699 : 1 });
        f.down();
        f.move(100, bottom ? 400 : 0);
        f.waitForFallback();
        assert.equal(f.editor.scrollTop, bottom ? 3700 : 0);
        assert.equal(f.frameCount, 0);
        assert.equal(f.selection.anchorNode, f.lines[55]);
    }
});

test('edge scrolling is time-based and does not jump after a delayed animation frame', async () => {
    const distances = [];
    for (const rate of [60, 120]) {
        const f = await fixture();
        f.down();
        f.move(100, 60);
        for (let i = 0; i < rate; i++) f.frame(1000 / rate);
        distances.push(1000 - f.editor.scrollTop);
    }
    assert.ok(Math.abs(distances[0] - distances[1]) < 10);
    const f = await fixture();
    f.down();
    f.move(100, 60);
    f.waitForFallback();
    const before = f.editor.scrollTop;
    f.frame(2000);
    assert.ok(before - f.editor.scrollTop <= 45);
});

test('the range fallback extends upward without reversing its ordered endpoints', async () => {
    const f = await fixture({ directionalSelection: false });
    f.down();
    f.move(100, 60);
    f.waitForFallback();
    assert.ok(f.lines.indexOf(f.selection.anchorNode) < 55);
    assert.equal(f.selection.focusNode, f.lines[55]);
    assert.equal(f.selection.focusOffset, 4);
    f.frame();
    assert.equal(f.selection.focusNode, f.lines[55]);
});

test('replacing the document stops scrolling even when live ranges move their anchors to the editor', async () => {
    for (const listTag of [null, 'ul']) {
        const f = await fixture({ listTag });
        f.down();
        f.move(100, 60);
        f.waitForFallback();
        const manualAnchor = f.controller.getAnchorRange();
        const scrollAnchor = f.controller.drag.anchor;
        f.editor.innerHTML = '<p>replacement document</p>';
        // Native DOM Ranges follow removed nodes to their surviving parent.
        // Model that independently of the non-live BookmarkRange fixture.
        for (const range of [manualAnchor, scrollAnchor]) {
            range.setStart(f.editor, 0);
            range.collapse();
        }
        const before = f.editor.scrollTop;
        const writes = f.scrollWrites;
        const hits = f.hits.length;
        f.frame();
        f.move(100, 60);
        f.waitForFallback();
        assert.equal(f.controller.drag, null);
        assert.equal(f.frameCount, 0);
        assert.equal(f.editor.scrollTop, before);
        assert.equal(f.scrollWrites, writes);
        assert.equal(f.hits.length, hits);
    }
});

test('a live range retargeted while scrolling is paused cannot restart from the replacement document', async () => {
    const f = await fixture();
    f.down();
    f.move(100, 60);
    f.waitForFallback();
    f.move(100, 200);
    const manualAnchor = f.controller.getAnchorRange();
    const scrollAnchor = f.controller.drag.anchor;
    f.editor.innerHTML = '<p>replacement</p>';
    for (const range of [manualAnchor, scrollAnchor]) {
        range.setStart(f.editor, 0);
        range.collapse();
    }
    const before = f.scrollWrites;
    f.move(100, 60);
    f.waitForFallback();
    assert.equal(f.controller.drag, null);
    assert.equal(f.scrollWrites, before);
});
