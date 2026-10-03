const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const editorSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'editor.js'), 'utf8');
const stateSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'modules', 'StateManager.js'), 'utf8');

function extractFunction(name, indent = '        ') {
    const start = editorSource.indexOf(`${indent}function ${name}(`);
    const end = editorSource.indexOf(`\n${indent}}\n`, start);
    assert.ok(start >= 0 && end > start, `${name} exists`);
    return editorSource.slice(start, end + indent.length + 2);
}

function fixture(html = '<p>before link after</p>') {
    const window = domino.createWindow(`<div id="editor" contenteditable="true">${html}</div><input id="outside">`);
    const document = window.document;
    const editor = document.getElementById('editor');
    let activeElement = editor;
    let currentRange = null;
    let revealCount = 0;
    let saveCount = 0;
    const focusOptions = [];
    const timers = new Map();
    let timerId = 0;
    Object.defineProperty(document, 'activeElement', { get: () => activeElement });
    const selection = {
        get rangeCount() { return currentRange ? 1 : 0; },
        getRangeAt: () => currentRange,
        removeAllRanges() { currentRange = null; },
        addRange(range) { currentRange = range; }
    };
    window.getSelection = () => selection;
    document.createRange = () => ({
        setStart(node, offset) { this.startContainer = node; this.startOffset = offset; },
        setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; },
        collapse() { this.setEnd(this.startContainer, this.startOffset); },
        selectNodeContents(node) { this.setStart(node, 0); this.setEnd(node, node.childNodes.length); },
        get collapsed() { return this.startContainer === this.endContainer && this.startOffset === this.endOffset; },
        get commonAncestorContainer() {
            let node = this.startContainer;
            while (node && !node.contains(this.endContainer)) node = node.parentNode;
            return node;
        },
        cloneRange() {
            const clone = document.createRange();
            clone.setStart(this.startContainer, this.startOffset);
            clone.setEnd(this.endContainer, this.endOffset);
            return clone;
        }
    });
    Object.defineProperty(editor, 'focus', { value: (options) => {
        activeElement = editor;
        focusOptions.push(options);
        // Focusing a contenteditable can reset selection; restoration must follow it.
        selection.removeAllRanges();
    } });
    const StateManager = new Function('window', 'document',
        `${stateSource.replace('export class StateManager', 'class StateManager')}\nreturn StateManager;`
    )(window, document);
    const manager = new StateManager(editor, { postMessage() {} });
    const declarationsStart = editorSource.indexOf('        let linkPopover = null;');
    const declarationsEnd = editorSource.indexOf('        function createLinkPopover()', declarationsStart);
    const keydownStart = editorSource.indexOf("        document.addEventListener('keydown', (e) => {",
        editorSource.indexOf('// ポップオーバー内でEnter/Escapeキーで閉じる'));
    const keydownEnd = editorSource.indexOf('\n        });', keydownStart) + '\n        });'.length;
    assert.ok(keydownStart >= 0 && keydownEnd > keydownStart);
    const ui = new Function(
        'window', 'document', 'editor', 'stateManager', 'setTimeout', 'clearTimeout', 'revealCaretAfterKeyboardNavigation', 'onSave',
        `${editorSource.slice(declarationsStart, declarationsEnd)}
        const localUpdateRevision = 0;
        const activeResizeImage = null;
        const activeCompositionElement = null;
        const isMac = false;
        const isImeInteractionKeydown = (event) => event.isComposing;
        const selectionCanBecomeWorkspaceLink = () => true;
        const cancelActiveLinkPopoverRequest = () => {};
        const repositionLinkPopoverWithinViewport = () => {};
        const scheduleWorkspaceLinkSuggestions = () => {};
        const syncLinkPopoverOpenButtonState = () => {};
        const linkPopoverInputAwaitsWorkspaceSuggestion = () => false;
        const linkPopoverInputNeedsHostResolution = () => false;
        const clearWorkspaceLinkSuggestions = () => {
            linkSuggestions = [];
            if (linkPopover) linkPopover.querySelector('.link-popover-suggestions').hidden = true;
        };
        const saveLinkUrlIfChanged = () => {
            onSave();
            currentLink.setAttribute('href', linkPopover.querySelector('input').value);
        };
        ${extractFunction('focusEditorWithoutScroll', '    ')}
        ${extractFunction('createLinkPopover')}
        ${extractFunction('isLinkInputImeInteraction')}
        ${extractFunction('areLinkSuggestionsVisible')}
        ${extractFunction('showLinkPopover')}
        ${extractFunction('showNewLinkPopover')}
        ${extractFunction('commitLinkHistoryState')}
        ${extractFunction('hideLinkPopover')}
        ${editorSource.slice(keydownStart, keydownEnd)}
        return {
            showNew: showNewLinkPopover, showExisting: showLinkPopover, hide: hideLinkPopover,
            get popover() { return linkPopover; },
            showSuggestions() {
                linkSuggestions = [{ label: 'heading' }];
                linkPopover.querySelector('.link-popover-suggestions').hidden = false;
            }
        };`
    )(window, document, editor, manager,
        (callback) => { timers.set(++timerId, callback); return timerId; },
        (id) => timers.delete(id), () => { revealCount++; }, () => { saveCount++; });

    function open(link = null) {
        if (link) ui.showExisting(link);
        else ui.showNew(currentRange);
        const input = ui.popover.querySelector('input');
        Object.defineProperty(input, 'focus', {
            configurable: true,
            value: () => { activeElement = input; selection.removeAllRanges(); }
        });
        Object.defineProperty(input, 'select', { configurable: true, value: input.focus });
        for (const [id, callback] of timers) { timers.delete(id); callback(); }
        return input;
    }

    return {
        editor, document, ui, open, focusOptions,
        get range() { return currentRange; },
        get revealCount() { return revealCount; },
        get saveCount() { return saveCount; },
        select(node, start, end = start) {
            currentRange = document.createRange();
            currentRange.setStart(node, start);
            currentRange.setEnd(node, end);
            return currentRange;
        },
        focus(node) { activeElement = node; },
        key(key, isComposing = false) {
            const event = new window.Event('keydown', { bubbles: true, cancelable: true });
            event.key = key;
            event.isComposing = isComposing;
            activeElement.dispatchEvent(event);
            return event;
        }
    };
}

for (const [start, end] of [[7, 7], [7, 11]]) {
    test(`Escape restores the original ${start === end ? 'caret' : 'text selection'} after cancelling link insertion`, () => {
        const f = fixture();
        const text = f.editor.querySelector('p').firstChild;
        const originalHtml = f.editor.innerHTML;
        f.select(text, start, end);
        f.open();
        assert.equal(f.range, null, 'the input no longer has an editor selection');
        assert.equal(f.key('Escape').defaultPrevented, true);
        assert.equal(f.ui.popover.style.display, 'none');
        assert.ok(f.document.activeElement === f.editor);
        assert.ok(f.range.startContainer === text);
        assert.equal(f.range.startOffset, start);
        assert.equal(f.range.endOffset, end);
        assert.deepEqual(f.focusOptions, [{ preventScroll: true }]);
        assert.equal(f.revealCount, 1);
        assert.equal(f.editor.innerHTML, originalHtml);
    });
}

for (const key of ['Escape', 'Enter']) {
    test(`${key} returns to the original position inside an existing link and saves its URL draft`, () => {
        const f = fixture('<p><a href="https://example.com">link text</a></p>');
        const link = f.editor.querySelector('a');
        f.select(link.firstChild, 4);
        const input = f.open(link);
        input.value = 'https://example.com/changed';
        f.key(key);
        assert.ok(f.document.activeElement === f.editor);
        assert.ok(f.range.startContainer === link.firstChild);
        assert.equal(f.range.startOffset, 4);
        assert.equal(link.getAttribute('href'), input.value);
        assert.equal(f.saveCount, 1);
    });
}

test('clicking a link with an unrelated editor selection returns to that link on Escape', () => {
    const f = fixture('<p>before<a href="https://example.com">link</a></p>');
    const link = f.editor.querySelector('a');
    f.select(f.editor.querySelector('p').firstChild, 2);
    f.open(link);
    f.key('Escape');
    assert.ok(f.document.activeElement === f.editor);
    assert.ok(f.range.startContainer === link);
    assert.equal(f.range.startOffset, 0);
});

test('closing suggestions keeps input focus; the next Escape restores the editor caret', () => {
    const f = fixture();
    f.select(f.editor.querySelector('p').firstChild, 7);
    const input = f.open();
    f.ui.showSuggestions();
    f.key('Escape');
    assert.ok(f.document.activeElement === input);
    assert.equal(f.ui.popover.style.display, 'flex');
    assert.equal(f.revealCount, 0);
    f.key('Escape');
    assert.ok(f.document.activeElement === f.editor);
    assert.equal(f.range.startOffset, 7);
});

test('Escape during IME composition keeps the link input open', () => {
    const f = fixture();
    f.select(f.editor.querySelector('p').firstChild, 7);
    const input = f.open();
    f.key('Escape', true);
    assert.ok(f.document.activeElement === input);
    assert.equal(f.ui.popover.style.display, 'flex');
    assert.equal(f.revealCount, 0);
});

test('Escape from a popover button also restores focus and repeated closing leaves selection alone', () => {
    const f = fixture();
    f.select(f.editor.querySelector('p').firstChild, 7);
    f.open();
    f.focus(f.ui.popover.querySelector('button'));
    f.key('Escape');
    assert.ok(f.document.activeElement === f.editor);
    assert.equal(f.range.startOffset, 7);
    f.ui.hide();
    assert.equal(f.focusOptions.length, 1);
    assert.equal(f.revealCount, 1);
});

for (const target of ['editor', 'outside']) {
    test(`closing after clicking ${target} preserves its focus and selection`, () => {
        const f = fixture();
        const text = f.editor.querySelector('p').firstChild;
        f.select(text, 7);
        f.open();
        const clicked = target === 'editor' ? f.editor : f.document.getElementById('outside');
        f.focus(clicked);
        const clickedRange = f.select(text, 1);
        f.ui.hide();
        assert.ok(f.document.activeElement === clicked);
        assert.ok(f.range === clickedRange);
        assert.equal(f.focusOptions.length, 0);
        assert.equal(f.revealCount, 0);
    });
}
