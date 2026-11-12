const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const source = fs.readFileSync(path.join(__dirname, '..', 'media', 'editor.js'), 'utf8');
const dragScrollSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'modules', 'DragSelectionScroll.js'), 'utf8');
const dragScrollModule = import(`data:text/javascript;base64,${Buffer.from(dragScrollSource).toString('base64')}`);

function extract(name) {
    const start = source.indexOf(`    function ${name}(`);
    assert.ok(start >= 0, `${name} exists`);
    const end = source.indexOf('\n    }', start);
    return source.slice(start, end + '\n    }'.length);
}

function fixture(html) {
    const window = domino.createWindow(`<div id="editor">${html}</div>`);
    const document = window.document;
    const editor = document.getElementById('editor');
    const textNodes = element => {
        const result = [];
        const visit = node => {
            if (node.nodeType === 3) result.push(node);
            else Array.from(node.childNodes).forEach(visit);
        };
        visit(element);
        return result;
    };
    document.createRange = () => ({
        setStart(node, offset) { this.startContainer = node; this.startOffset = offset; },
        selectNodeContents(node) { this.startContainer = node; this.startOffset = 0; },
        collapse() { this.collapsed = true; },
    });
    const domUtils = {
        getFirstTextNode: node => textNodes(node)[0] || null,
        getLastTextNode: node => textNodes(node).at(-1) || null,
        getTextWithoutCaretAnchors: node => node.textContent.replace(/[\u200B\uFEFF]/g, ''),
        getParentElement(node, tag) {
            const element = node.nodeType === 1 ? node : node.parentElement;
            return element.closest(tag.toLowerCase());
        },
    };
    return { window, document, editor, domUtils };
}

function rootTextClickFixture(text = '日本語を入力') {
    const f = fixture(`${text}<div>次の行</div>`);
    const block = f.editor.lastChild;
    block.getBoundingClientRect = () => ({ top: 40, bottom: 60, height: 20 });
    f.domUtils.isBlockElement = element => ['DIV', 'P'].includes(element.tagName);
    const helpers = new Function('document', 'editor', 'Node', 'domUtils',
        `${[
            'isEditorLevelWhitespaceTextNode', 'isEditorRootTextRange',
            'createCollapsedRangeAtElementBoundary', 'getNearestBlockBoundaryRangeByY',
            'getStableGapClickRange', 'getClosestBlockElement',
            'getNearestTopLevelElementFromIndex', 'isSupportedBlockForLooseSideClick',
            'getVerticalDistanceScoreForBlock', 'pickCloserSupportedBlockByY',
            'getNearestSupportedBlockForLooseSideByY', 'resolveBlockForLooseSideTextClick',
        ].map(extract).join('\n')}
        return {
            place: getStableGapClickRange,
            resolveLooseSide: resolveBlockForLooseSideTextClick,
        };`
    )(f.document, f.editor, f.window.Node, f.domUtils);
    return { ...f, block, ...helpers };
}

for (const offset of [0, 2, 6]) {
    test(`clicking committed Japanese root text preserves the native caret at offset ${offset}`, () => {
        // Typing into a new empty editor leaves text directly under #editor.
        // Enter can add a DIV below it, which must not capture first-line clicks.
        const f = rootTextClickFixture();
        const range = { startContainer: f.editor.firstChild, startOffset: offset, collapsed: true };
        assert.ok(f.place(100, 20, f.editor, range) === null,
            'A valid hit on the first line must not snap to the block below');
    });

    test(`loose-side correction preserves committed Japanese root text at offset ${offset}`, () => {
        const f = rootTextClickFixture();
        const range = { startContainer: f.editor.firstChild, startOffset: offset, collapsed: true };
        assert.ok(f.resolveLooseSide(20, f.editor, range) === null,
            'Side-click correction must not target the following block for a native root-text hit');
    });
}

test('a gap click with an editor-level caret still snaps to the nearest editable block', () => {
    const f = rootTextClickFixture();
    const range = { startContainer: f.editor, startOffset: 1, collapsed: true };
    const placed = f.place(100, 20, f.editor, range);
    assert.equal(placed.startContainer, f.block.firstChild);
    assert.equal(placed.startOffset, 0);
    assert.equal(placed.collapsed, true);
    assert.ok(f.resolveLooseSide(20, f.editor, range) === f.block);
});

test('a gap click on ignorable root text still snaps to the nearest editable block', () => {
    const f = rootTextClickFixture('\n\u200B ');
    const range = { startContainer: f.editor.firstChild, startOffset: 1, collapsed: true };
    const placed = f.place(100, 20, f.editor, range);
    assert.equal(placed.startContainer, f.block.firstChild);
    assert.equal(placed.startOffset, 0);
    assert.equal(placed.collapsed, true);
    assert.ok(f.resolveLooseSide(20, f.editor, range) === f.block);
});

test('loose-side correction still resolves clicks in an existing paragraph', () => {
    const f = rootTextClickFixture();
    const range = { startContainer: f.block.firstChild, startOffset: 1, collapsed: true };
    assert.ok(f.resolveLooseSide(50, f.block, range) === f.block);
});

test('loose-side correction still resolves editor gaps without a native caret range', () => {
    const f = rootTextClickFixture();
    assert.ok(f.resolveLooseSide(20, f.editor, null) === f.block);
});

for (const boundary of ['start', 'end']) {
    test(`a gap click at a code block's ${boundary} uses editable code instead of toolbar text`, () => {
        const f = fixture('<pre><div data-exclude-from-markdown="true" contenteditable="false"><span>plaintext</span><button>Copy</button></div><code>first\nlast</code></pre>');
        const place = new Function('document', 'Node', 'domUtils',
            `${extract('createCollapsedRangeAtElementBoundary')}\nreturn createCollapsedRangeAtElementBoundary;`
        )(f.document, f.window.Node, f.domUtils);
        const code = f.editor.querySelector('code');
        const range = place(f.editor.querySelector('pre'), boundary);
        assert.equal(range.startContainer, code.firstChild);
        assert.equal(range.startOffset, boundary === 'start' ? 0 : code.textContent.length);
        assert.equal(range.collapsed, true);
    });

    test(`a gap click at a table's ${boundary} avoids its input-blocking edge anchors`, () => {
        const f = fixture('<div class="md-table-wrapper"><div data-exclude-from-markdown="true">\u00A0</div><table><tr><td>first</td><td>last</td></tr></table><div data-exclude-from-markdown="true">\u00A0</div></div>');
        const place = new Function('document', 'Node', 'domUtils',
            `${extract('createCollapsedRangeAtElementBoundary')}\nreturn createCollapsedRangeAtElementBoundary;`
        )(f.document, f.window.Node, f.domUtils);
        const cells = f.editor.querySelectorAll('td');
        const text = cells[boundary === 'start' ? 0 : 1].firstChild;
        const range = place(f.editor.firstChild, boundary);
        assert.equal(range.startContainer, text);
        assert.equal(range.startOffset, boundary === 'start' ? 0 : text.length);
    });
}

function codeBlockClickFixture(t, {
    selectedLabel = false, precedingText = false, followingHtml = '', mermaid = true,
    precedingHtml = precedingText ? '<p>above</p>' : '',
    marginSide = 'left',
} = {}) {
    const f = fixture(`${precedingHtml}<pre${mermaid ? ' data-mermaid-view="diagram"' : ''}><div class="code-block-toolbar" data-exclude-from-markdown="true" contenteditable="false"><span class="code-block-language">${mermaid ? 'mermaid' : 'javascript'}</span><button>Copy</button></div><code>${mermaid ? 'graph TD\nA--&gt;B' : 'const answer = 42;'}</code>${mermaid ? '<div class="mermaid-preview" data-exclude-from-markdown="true" contenteditable="false"><svg><text>A</text></svg></div>' : ''}</pre>${followingHtml}`);
    const pre = f.editor.querySelector('pre');
    const label = pre.querySelector('.code-block-language');
    const nodeListPrototype = Object.getPrototypeOf(f.editor.querySelectorAll('pre'));
    const previousForEach = nodeListPrototype.forEach;
    nodeListPrototype.forEach = Array.prototype.forEach;
    t.after(() => {
        if (previousForEach === undefined) delete nodeListPrototype.forEach;
        else nodeListPrototype.forEach = previousForEach;
    });
    const createRange = f.document.createRange;
    f.document.createRange = () => Object.assign(createRange(), {
        cloneRange() { return Object.assign(f.document.createRange(), this); },
    });
    let range = selectedLabel ? { startContainer: label.firstChild, collapsed: false } : null;
    const selection = {
        get rangeCount() { return range ? 1 : 0; },
        get isCollapsed() { return !range || range.collapsed; },
        getRangeAt: () => range,
        removeAllRanges() { range = null; },
        addRange(next) { range = next; },
    };
    f.window.getSelection = () => selection;
    f.editor.focus = () => {};
    pre.getBoundingClientRect = () => ({ top: 50, bottom: 250, height: 200 });
    for (const block of Array.from(f.editor.children)) {
        if (block !== pre) block.getBoundingClientRect = () => block === pre.previousElementSibling
            ? { top: 10, bottom: 30, height: 20 }
            : { top: 280, bottom: 300, height: 20 };
    }
    const loadClass = name => {
        const moduleSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'modules', `${name}.js`), 'utf8');
        return new Function('document', 'Node', 'NodeFilter',
            `${moduleSource.replace(`export class ${name}`, `class ${name}`)}\nreturn ${name};`
        )(f.document, f.window.Node, f.window.NodeFilter);
    };
    const gapManager = new (loadClass('CodeBlockGapManager'))(f.editor);
    const domUtils = new (loadClass('DOMUtils'))(f.editor);
    let hit = f.editor;
    let pointerRange;
    f.document.elementFromPoint = () => hit;
    let sideCorrections = 0;
    const dependencies = {
        editor: f.editor, document: f.document, window: f.window, Node: f.window.Node,
        domUtils, codeBlockGapManager: gapManager,
        cursorManager: {
            clearInlineCodeBoundaryState() {},
            resetCodeVerticalNavigation() {},
            getCodeBlockText: code => code.textContent,
            placeCursorAtLeadingImageLine: () => false,
        },
        tableManager: { handleMouseDown: () => false },
        getImageCaretRangeFromHorizontalClick: () => null,
        getCaretRangeFromPoint: () => pointerRange === undefined ? range : pointerRange,
        getLooseLeftSideTextClickRange: () => {
            sideCorrections++;
            if (!precedingText || marginSide !== 'left') return null;
            const sideRange = f.document.createRange();
            sideRange.setStart(f.editor.firstChild.firstChild, 0);
            sideRange.collapse(true);
            return sideRange;
        },
        getLooseRightSideTextClickRange: () => {
            if (!precedingText || marginSide !== 'right') return null;
            const text = f.editor.firstChild.firstChild;
            const sideRange = f.document.createRange();
            sideRange.setStart(text, text.length);
            sideRange.collapse(true);
            return sideRange;
        },
        getStableGapClickRange: () => null,
        getNextNavigableNodeAfter: node => gapManager.adjacentNode(node, 'down'),
        getPreferredFirstTextNodeForElement: node => domUtils.getFirstTextNode(node),
        placeCaretInEmptyParagraph: () => false,
        focusEditorWithoutScroll() {}, syncImageCaretEdgeIndicatorsNow() {},
        Range: { START_TO_START: 0 },
    };
    const start = source.indexOf("        editor.addEventListener('mousedown', (e) => {", source.indexOf('// mousedownイベント'));
    const end = source.indexOf("        document.addEventListener('mousemove',", start);
    assert.ok(start >= 0 && end > start);
    const mouseupStart = source.indexOf("        document.addEventListener('mouseup',", end);
    const pointerSelection = new Function(...Object.keys(dependencies), `
        let isUpdating = false;
        let pendingListMouseAdjustment, pendingInlineCodeSideClick, pendingMouseDriftCorrection;
        let manualPointerSelection, lastPointerCaretIntentTs, lastCaretIntentSource, caretScrollForcePending;
        let dragSelectionScroll = null;
        ${extract('stopManualPointerSelection')}
        ${extract('isEditorLevelWhitespaceTextNode')}
        ${extract('isEditorRootTextRange')}
        ${extract('getCodeBlockForAboveGapClick')}
        ${extract('getCodeBlockForBelowGapClick')}
        ${extract('exitEmptyCodeBlockDownFromPre')}
        ${extract('createDirectionalSelectionRange')}
        ${extract('getManualDragFocusRangeFromPoint')}
        ${extract('beginManualPointerSelection')}
        ${extract('updateManualPointerSelection')}
        ${source.slice(start, mouseupStart)}
        return {
            getManualSelection: () => manualPointerSelection,
            resolveFocusRange: getManualDragFocusRangeFromPoint,
            setScrollController(value) { dragSelectionScroll = value; },
        };
    `)(...Object.values(dependencies));
    return {
        ...f, pre, selection, gapManager, domUtils, ...pointerSelection,
        setPointRange(value) { pointerRange = value; },
        get sideCorrections() { return sideCorrections; },
        click({ y = 270, target = f.editor, shiftKey = false, button = 0 } = {}) {
            hit = target;
            const event = f.document.createEvent('Event');
            event.initEvent('mousedown', true, true);
            Object.assign(event, { clientX: 100, clientY: y, button, shiftKey, detail: 1 });
            target.dispatchEvent(event);
            return event;
        },
    };
}

async function attachManualDragScroll(f) {
    const { DragSelectionScroll } = await dragScrollModule;
    const createRange = f.document.createRange;
    f.document.createRange = () => Object.assign(createRange(), {
        setStart(node, offset) { this.startContainer = node; this.startOffset = offset; },
        setEnd(node, offset) {
            this.endContainer = node;
            this.endOffset = offset;
            this.collapsed = this.startContainer === node && this.startOffset === offset;
        },
        collapse(toStart = true) {
            if (toStart) this.setEnd(this.startContainer, this.startOffset);
            else this.setStart(this.endContainer, this.endOffset);
            this.collapsed = true;
        },
        compareBoundaryPoints(_how, other) {
            if (this.startContainer === other.startContainer) return this.startOffset - other.startOffset;
            return this.startContainer.compareDocumentPosition(other.startContainer) & 4 ? -1 : 1;
        },
    });
    let scrollTop = 1000;
    let scrollWrites = 0;
    Object.defineProperties(f.editor, {
        clientHeight: { value: 300 }, clientWidth: { value: 500 },
        clientTop: { value: 0 }, clientLeft: { value: 0 }, scrollHeight: { value: 4000 },
        scrollTop: {
            get: () => scrollTop,
            set(value) { scrollTop = value; scrollWrites++; },
        },
    });
    f.editor.getBoundingClientRect = () => ({ top: 0, bottom: 300, left: 0, right: 500 });
    f.window.innerHeight = 600;
    f.window.innerWidth = 800;
    const frames = new Map();
    let sequence = 0;
    let timestamp = 0;
    f.window.requestAnimationFrame = callback => { frames.set(++sequence, callback); return sequence; };
    f.window.cancelAnimationFrame = id => frames.delete(id);
    const rangeAt = (node, offset = 0) => {
        const range = f.document.createRange();
        range.setStart(node, offset);
        range.collapse(true);
        return range;
    };
    f.selection.setBaseAndExtent = (anchorNode, anchorOffset, focusNode, focusOffset) => {
        const anchor = rangeAt(anchorNode, anchorOffset);
        const focus = rangeAt(focusNode, focusOffset);
        const range = f.document.createRange();
        if (anchor.compareBoundaryPoints(0, focus) <= 0) {
            range.setStart(anchorNode, anchorOffset);
            range.setEnd(focusNode, focusOffset);
        } else {
            range.setStart(focusNode, focusOffset);
            range.setEnd(anchorNode, anchorOffset);
        }
        f.selection.removeAllRanges();
        f.selection.addRange(range);
        Object.assign(f.selection, { anchorNode, anchorOffset, focusNode, focusOffset });
    };
    const controller = new DragSelectionScroll(f.editor, {
        getAnchorRange: () => f.getManualSelection()?.anchorRange,
        resolveFocusRange: f.resolveFocusRange,
        isEnabled: () => true,
    });
    f.setScrollController(controller);
    const dispatch = (type, properties, target = f.document) => {
        const event = f.document.createEvent('Event');
        event.initEvent(type, true, true);
        Object.assign(event, properties);
        target.dispatchEvent(event);
        return event;
    };
    return {
        controller, rangeAt,
        get scrollWrites() { return scrollWrites; },
        get frameCount() { return frames.size; },
        move(x, y) { dispatch('mousemove', { clientX: x, clientY: y, buttons: 1 }); },
        wheel() { return dispatch('wheel', { deltaY: 30 }, f.editor); },
        advance() {
            for (let i = 0; i < 20; i++) {
                timestamp += 1000 / 60;
                const callbacks = [...frames.values()];
                frames.clear();
                callbacks.forEach(callback => callback(timestamp));
                f.gapManager.reconcile(f.selection);
            }
        },
    };
}

for (const marginSide of ['left', 'right']) {
    test(`dragging from a paragraph's ${marginSide} margin scrolls with its original text anchor`, async t => {
        const f = codeBlockClickFixture(t, { precedingText: true, marginSide });
        const drag = await attachManualDragScroll(f);
        assert.equal(f.click({ y: 20 }).defaultPrevented, true);
        const anchor = f.getManualSelection().anchorRange;
        assert.equal(anchor.startContainer, f.editor.firstChild.firstChild);
        assert.equal(anchor.startOffset, marginSide === 'left' ? 0 : 'above'.length);
        f.setPointRange(drag.rangeAt(f.pre.querySelector('code').firstChild, 2));
        drag.move(100, 350);
        drag.advance();
        assert.ok(f.editor.scrollTop > 1000);
        assert.equal(f.selection.anchorNode, anchor.startContainer);
        assert.equal(f.selection.anchorOffset, anchor.startOffset);
        assert.equal(f.selection.focusNode, f.pre.querySelector('code').firstChild);
    });
}

for (const direction of ['above', 'below']) {
    test(`dragging from the input gap ${direction} a code block scrolls while retaining the temporary input line`, async t => {
        const f = codeBlockClickFixture(t, { mermaid: false });
        const drag = await attachManualDragScroll(f);
        assert.equal(f.click({ y: direction === 'above' ? 20 : 270 }).defaultPrevented, true);
        const gap = f.editor.querySelector('[data-mdw-code-gap="true"]');
        assert.ok(gap);
        const anchor = f.getManualSelection().anchorRange;
        assert.equal(anchor.startContainer, gap.firstChild);
        f.setPointRange(drag.rangeAt(f.pre.querySelector('code').firstChild, 2));
        drag.move(100, direction === 'above' ? 350 : -20);
        drag.advance();
        assert.ok(direction === 'above' ? f.editor.scrollTop > 1000 : f.editor.scrollTop < 1000);
        assert.equal(f.selection.anchorNode, gap.firstChild);
        assert.equal(f.selection.anchorOffset, anchor.startOffset);
        assert.ok(gap.isConnected, 'the input gap remains a live endpoint of the expanded selection');
    });
}

test('native paragraph text drags never start the manual scroll helper', async t => {
    const f = codeBlockClickFixture(t, { precedingText: true });
    const drag = await attachManualDragScroll(f);
    const paragraph = f.editor.firstChild;
    f.setPointRange(drag.rangeAt(paragraph.firstChild, 2));
    assert.equal(f.click({ y: 20, target: paragraph }).defaultPrevented, false);
    assert.equal(f.getManualSelection(), null);
    drag.move(100, -20);
    drag.advance();
    assert.equal(drag.scrollWrites, 0);
    assert.equal(drag.frameCount, 0);
});

for (const origin of ['paragraph margin', 'code gap']) {
    test(`a ${origin} drag can resume edge scrolling after a wheel adjustment`, async t => {
        const f = codeBlockClickFixture(t, { precedingText: origin === 'paragraph margin', mermaid: false });
        const drag = await attachManualDragScroll(f);
        assert.equal(f.click({ y: origin === 'paragraph margin' ? 20 : 270 }).defaultPrevented, true);
        const anchorNode = f.getManualSelection().anchorRange.startContainer;
        f.setPointRange(drag.rangeAt(f.pre.querySelector('code').firstChild, 2));
        drag.move(100, -20);
        drag.advance();
        assert.ok(f.editor.scrollTop < 1000);
        assert.equal(drag.wheel().defaultPrevented, false);
        f.editor.scrollTop += 30;
        const afterWheel = f.editor.scrollTop;
        drag.advance();
        assert.equal(f.editor.scrollTop, afterWheel, 'momentum remains browser-owned until pointer movement');
        drag.move(100, 150);
        drag.move(100, -20);
        drag.advance();
        assert.ok(f.editor.scrollTop < afterWheel);
        assert.equal(f.selection.anchorNode, anchorNode);
    });

    test(`replacing content during a ${origin} drag cancels scrolling and its stale pointer selection`, async t => {
        const f = codeBlockClickFixture(t, { precedingText: origin === 'paragraph margin', mermaid: false });
        const drag = await attachManualDragScroll(f);
        f.click({ y: origin === 'paragraph margin' ? 20 : 270 });
        const anchorNode = f.getManualSelection().anchorNode;
        f.setPointRange(drag.rangeAt(f.pre.querySelector('code').firstChild, 2));
        drag.move(100, -20);
        drag.advance();
        f.editor.innerHTML = '<p>replacement content</p>';
        const before = f.editor.scrollTop;
        drag.advance();
        assert.equal(anchorNode.isConnected, false);
        assert.equal(drag.frameCount, 0);
        assert.equal(drag.controller.drag, null);
        assert.equal(f.editor.scrollTop, before);
        drag.move(100, -20);
        assert.equal(f.getManualSelection(), null, 'later pointer moves cannot reuse the removed text anchor');
        assert.equal(f.editor.textContent, 'replacement content');
        assert.equal(f.editor.scrollTop, before);
    });
}

for (const selectedLabel of [false, true]) {
    test(`clicking below a lone Mermaid preview opens a temporary input line with ${selectedLabel ? 'its label selected' : 'no selection'}`, t => {
        const f = codeBlockClickFixture(t, { selectedLabel });
        const original = f.domUtils.getCleanedHTML();
        assert.equal(f.click().defaultPrevented, true);
        const gap = f.editor.querySelector('[data-mdw-code-gap="true"]');
        assert.ok(gap);
        assert.equal(gap.previousElementSibling, f.pre);
        assert.ok(gap.contains(f.selection.getRangeAt(0).startContainer));
        assert.equal(f.selection.isCollapsed, true);
        assert.equal(f.domUtils.getCleanedHTML(), original, 'an untouched line is not saved');

        f.gapManager.reconcile(null);
        assert.equal(gap.parentNode, null, 'leaving without input removes the line');
        f.click();
        const typedGap = f.editor.querySelector('[data-mdw-code-gap="true"]');
        typedGap.firstChild.textContent += '日本語';
        f.gapManager.reconcile(f.selection);
        assert.equal(typedGap.hasAttribute('data-mdw-code-gap'), false);
        assert.ok(f.domUtils.getCleanedHTML().includes('<p>日本語</p>'));
    });
}

test('clicks below a diagram take priority over snapping to earlier text', t => {
    const f = codeBlockClickFixture(t, { precedingText: true });
    f.click();
    assert.ok(f.editor.querySelector('[data-mdw-code-gap="true"]'));
    assert.equal(f.sideCorrections, 0);
});

test('the bottom padding of the Mermaid block also opens a temporary input line', t => {
    const f = codeBlockClickFixture(t, { selectedLabel: true });
    assert.equal(f.click({ target: f.pre, y: 246 }).defaultPrevented, true);
    assert.ok(f.editor.querySelector('[data-mdw-code-gap="true"]'));
});

test('clicking below a diagram reuses its temporary input line', t => {
    const f = codeBlockClickFixture(t);
    f.click();
    const gap = f.editor.querySelector('[data-mdw-code-gap="true"]');
    gap.getBoundingClientRect = () => ({ top: 280, bottom: 300, height: 20 });
    f.click();
    assert.equal(f.editor.querySelectorAll('[data-mdw-code-gap="true"]').length, 1);
    assert.ok(gap.contains(f.selection.getRangeAt(0).startContainer));
});

test('clicking below a diagram uses an existing paragraph without inserting another line', t => {
    const f = codeBlockClickFixture(t, { selectedLabel: true, followingHtml: '<p><br></p>' });
    const paragraph = f.editor.lastChild;
    f.click();
    assert.equal(f.editor.querySelectorAll('p').length, 1);
    assert.ok(!f.editor.querySelector('[data-mdw-code-gap]'));
    assert.ok(paragraph.contains(f.selection.getRangeAt(0).startContainer));
});

test('a native hit on text after a diagram preserves its caret position', t => {
    const f = codeBlockClickFixture(t, { followingHtml: '日本語を入力' });
    const range = f.document.createRange();
    range.setStart(f.editor.lastChild, 2);
    range.collapse(true);
    f.selection.addRange(range);
    assert.equal(f.click().defaultPrevented, false);
    assert.ok(!f.editor.querySelector('[data-mdw-code-gap]'));
    assert.equal(f.selection.getRangeAt(0), range);
    assert.equal(range.startOffset, 2);
});

test('diagram content, controls, Shift-click and secondary clicks do not create input lines', t => {
    for (const options of [
        { target: '.mermaid-preview text', y: 246 },
        { target: '.code-block-toolbar button', y: 246 },
        { target: 'pre', y: 150 },
        { shiftKey: true },
        { button: 2 },
    ]) {
        const f = codeBlockClickFixture(t, { selectedLabel: true });
        f.click({ ...options, target: options.target ? f.editor.querySelector(options.target) : f.editor });
        assert.ok(!f.editor.querySelector('[data-mdw-code-gap]'));
    }
});

for (const mermaid of [false, true]) {
    for (const selectedLabel of [false, true]) {
        test(`clicking above a leading ${mermaid ? 'Mermaid preview' : 'code block'} opens a temporary line with ${selectedLabel ? 'its label selected' : 'no selection'}`, t => {
            const f = codeBlockClickFixture(t, { mermaid, selectedLabel });
            const original = f.domUtils.getCleanedHTML();
            assert.equal(f.click({ y: 35 }).defaultPrevented, true);
            const gap = f.editor.querySelector('[data-mdw-code-gap="true"]');
            assert.ok(gap);
            assert.equal(gap.parentElement, f.editor);
            assert.equal(gap.nextElementSibling, f.pre);
            assert.ok(gap.contains(f.selection.getRangeAt(0).startContainer));
            assert.equal(f.selection.isCollapsed, true);
            assert.equal(f.domUtils.getCleanedHTML(), original, 'an untouched line is not saved');

            f.gapManager.reconcile(null);
            assert.equal(gap.parentNode, null, 'leaving without typing removes the line');
            f.click({ y: 35 });
            const typedGap = f.editor.querySelector('[data-mdw-code-gap="true"]');
            typedGap.firstChild.textContent += '日本語';
            f.gapManager.reconcile(f.selection);
            assert.equal(typedGap.hasAttribute('data-mdw-code-gap'), false);
            assert.ok(f.domUtils.getCleanedHTML().startsWith('<p>日本語</p>'));
        });
    }
}

test('repeated clicks above a leading code block reuse its temporary line', t => {
    const f = codeBlockClickFixture(t, { mermaid: false });
    f.click({ y: 35 });
    const gap = f.editor.querySelector('[data-mdw-code-gap="true"]');
    assert.ok(gap);
    gap.getBoundingClientRect = () => ({ top: 10, bottom: 30, height: 20 });
    f.click({ y: 35 });
    assert.equal(f.editor.querySelectorAll('[data-mdw-code-gap="true"]').length, 1);
    assert.ok(gap.contains(f.selection.getRangeAt(0).startContainer));
});

test('editor controls and whitespace before a leading code block do not prevent opening a line above it', t => {
    const f = codeBlockClickFixture(t, {
        mermaid: false, precedingHtml: '\n<div data-exclude-from-markdown="true">UI</div>\n',
    });
    f.click({ y: 35 });
    const gap = f.editor.querySelector('[data-mdw-code-gap="true"]');
    assert.ok(gap);
    assert.equal(gap.nextElementSibling, f.pre);
});

test('clicks above a code block with preceding document content do not create a new line', t => {
    for (const precedingHtml of ['<p>above</p>', '<p><br></p>', '日本語']) {
        const f = codeBlockClickFixture(t, { mermaid: false, precedingHtml });
        f.click({ y: 35 });
        assert.ok(!f.editor.querySelector('[data-mdw-code-gap]'));
    }
});

test('top-of-document clicks preserve code controls, code text, Shift-click and secondary-click behavior', t => {
    for (const options of [
        { target: '.code-block-toolbar button', y: 55 },
        { target: 'code', y: 100 },
        { shiftKey: true },
        { button: 2 },
    ]) {
        const f = codeBlockClickFixture(t, { mermaid: false, selectedLabel: true });
        f.click({ y: 35, ...options, target: options.target ? f.editor.querySelector(options.target) : f.editor });
        assert.ok(!f.editor.querySelector('[data-mdw-code-gap]'));
    }
});

function emptyCodeClickFixture({ nativeOutside = false, directHit = true, otherBlock = false } = {}) {
    const f = fixture('<p><code data-is-new="true"><span contenteditable="false"></span>\u200B</code><br></p><p>below</p>');
    const code = f.editor.querySelector('code');
    const block = code.parentElement;
    const outsideText = f.document.createTextNode('\uFEFF');
    block.insertBefore(outsideText, code);
    const range = { startContainer: otherBlock ? f.editor.lastChild.firstChild : nativeOutside ? outsideText : code.lastChild, startOffset: 1, collapsed: true };
    f.window.getSelection = () => ({ rangeCount: 1, isCollapsed: true, getRangeAt: () => range });
    f.document.elementFromPoint = () => directHit ? code : block;
    code.getBoundingClientRect = () => ({ left: 20, right: 34, top: 96, bottom: 116 });
    const placements = [];
    const cursorManager = {
        _placeCursorBeforeInlineCodeElement: () => { placements.push('before'); return true; },
        _placeCursorAfterInlineCodeElement: () => { placements.push('after'); return true; },
        _placeCursorInsideInlineCodeStart: () => { placements.push('inside'); return true; },
    };
    const place = new Function('window', 'document', 'editor', 'Node', 'domUtils', 'cursorManager',
        'getCaretRangeFromPoint', 'getInlineCodeEdgeAtRange', 'getClosestBlockElement',
        `${extract('isInlineCodeNode')}\n${extract('placeCaretAtInlineCodeAfterClick')}\nreturn placeCaretAtInlineCodeAfterClick;`
    )(f.window, f.document, f.editor, f.window.Node, f.domUtils, cursorManager,
        () => range, () => ({ code, side: 'empty' }), () => block);
    return { place, placements };
}

for (const nativeOutside of [false, true]) {
    test(`clicking an empty code box enters it when the native caret is ${nativeOutside ? 'outside' : 'inside'}`, () => {
        const f = emptyCodeClickFixture({ nativeOutside });
        assert.equal(f.place(27, 106), true);
        assert.deepEqual(f.placements, ['inside']);
    });
}

for (const [x, expected] of [[15, 'before'], [54, 'after']]) {
    test(`clicking beside empty code places the caret ${expected} the box`, () => {
        const f = emptyCodeClickFixture({ directHit: false });
        assert.equal(f.place(x, 106), true);
        assert.deepEqual(f.placements, [expected]);
    });
}

test('empty-code click correction preserves placements in another row or block', () => {
    const above = emptyCodeClickFixture();
    assert.equal(above.place(27, 88), false);
    assert.deepEqual(above.placements, []);
    const other = emptyCodeClickFixture({ otherBlock: true });
    assert.equal(other.place(27, 106), false);
    assert.deepEqual(other.placements, []);
});

function populatedCodeClickFixture({ side, directHit = true, collapsed = true, readOnly = false }) {
    const f = fixture(`<p>before <code${readOnly ? ' contenteditable="false"' : ''}>value</code> after</p>`);
    const code = f.editor.querySelector('code');
    const block = code.parentElement;
    // At the left edge Chromium can report the preceding text's endpoint,
    // even when the click is inside the code's padding or first character.
    let range = { startContainer: code.previousSibling, startOffset: 7, collapsed };
    f.window.getSelection = () => ({
        rangeCount: 1, isCollapsed: collapsed, getRangeAt: () => range,
        removeAllRanges() {}, addRange(next) { range = next; },
    });
    f.document.elementFromPoint = () => directHit ? code : block;
    const createRange = f.document.createRange;
    f.document.createRange = () => ({
        ...createRange(),
        getClientRects: () => [{ left: 26, right: 76, top: 96, bottom: 116, width: 50 }],
    });
    const placements = [];
    const cursorManager = {
        _placeCursorBeforeInlineCodeElement: () => { placements.push('before'); return true; },
        _placeCursorInsideInlineCodeStart: () => { placements.push('inside'); return true; },
    };
    const place = new Function('window', 'document', 'editor', 'Node', 'domUtils', 'cursorManager',
        'getCaretRangeFromPoint', 'getInlineCodeEdgeAtRange', 'getClosestBlockElement',
        'moveCursorOutOfInlineCodeRight',
        `${extract('isInlineCodeNode')}\n${extract('placeCaretAtInlineCodeAfterClick')}\nreturn placeCaretAtInlineCodeAfterClick;`
    )(f.window, f.document, f.editor, f.window.Node, f.domUtils, cursorManager,
        () => range, () => side ? { code, side } : null, () => block,
        () => { placements.push('after'); return true; });
    return { place, placements, code, get range() { return range; } };
}

test('clicking the left padding of existing code enters it for editing', () => {
    const f = populatedCodeClickFixture({ side: 'start' });
    assert.equal(f.place(22, 106), true);
    assert.deepEqual(f.placements, ['inside']);
});

test('clicking the right padding of existing code places the caret at its editable text end', () => {
    const f = populatedCodeClickFixture({ side: 'end' });
    assert.equal(f.place(80, 106), true);
    assert.deepEqual(f.placements, []);
    assert.equal(f.range.startContainer, f.code.firstChild);
    assert.equal(f.range.startOffset, 5);
});

for (const [side, x, expected] of [['start', 15, 'before'], ['end', 90, 'after']]) {
    test(`clicking outside existing code still places the caret ${expected} it`, () => {
        const f = populatedCodeClickFixture({ side, directHit: false });
        assert.equal(f.place(x, 106), true);
        assert.deepEqual(f.placements, [expected]);
    });
}

for (const [name, options] of [
    ['interior carets', { side: null }],
    ['text selections', { side: 'start', collapsed: false }],
    ['read-only code', { side: 'start', readOnly: true }],
]) {
    test(`code click correction preserves ${name}`, () => {
        const f = populatedCodeClickFixture(options);
        const original = f.range;
        assert.equal(f.place(22, 106), false);
        assert.equal(f.range, original);
        assert.deepEqual(f.placements, []);
    });
}

for (const [name, markup, selector] of [
    ['link', '<a href="https://example.test">link</a>', 'a'],
    ['image', '<img alt="image">', 'img'],
    ['checkbox', '<input type="checkbox">', 'input'],
]) {
    test(`Shift-clicking a selected cell's ${name} suppresses its own click action`, () => {
        const f = fixture(`<table><tr><td>${markup}</td></tr></table>`);
        const cell = f.editor.querySelector('td');
        const target = cell.querySelector(selector);
        let childClicks = 0;
        let closedImageUi = 0;
        let closedLinkUi = 0;
        let hasCellSelection = false;
        target.addEventListener('click', () => { childClicks++; });
        const start = source.indexOf('        // Shift-click selects the whole cell without activating its contents.');
        const end = source.indexOf('        // コードブロック言語ラベルのクリックで編集開始', start);
        assert.ok(start >= 0 && end > start);
        new Function('editor', 'Node', 'isUpdating', 'tableManager', 'hideImageResizeOverlay', 'hideLinkPopover',
            source.slice(start, end)
        )(f.editor, f.window.Node, false, { hasCellSelection: () => hasCellSelection },
            () => { closedImageUi++; }, () => { closedLinkUi++; });
        const click = shiftKey => {
            const event = f.document.createEvent('Event');
            event.initEvent('click', true, true);
            event.shiftKey = shiftKey;
            target.dispatchEvent(event);
            return event.defaultPrevented;
        };

        assert.equal(click(false), false);
        assert.equal(click(true), false);
        assert.equal(childClicks, 2);

        hasCellSelection = true;
        cell.classList.add('md-table-cell-selected');
        assert.equal(click(true), true);
        assert.equal(childClicks, 2);
        assert.equal(closedImageUi, 1);
        assert.equal(closedLinkUi, 1);

        assert.equal(click(false), false);
        assert.equal(childClicks, 3);
    });
}
