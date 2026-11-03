const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const searchManagerSource = fs.readFileSync(
    path.join(__dirname, '..', 'media', 'modules', 'SearchManager.js'),
    'utf8'
);
const searchManagerModulePromise = import(
    `data:text/javascript;base64,${Buffer.from(searchManagerSource).toString('base64')}`
);

function createRange(id) {
    return {
        id,
        cloneRange() {
            return createRange(id);
        },
        collapse() {}
    };
}

async function createManager() {
    const { SearchManager } = await searchManagerModulePromise;
    const manager = Object.create(SearchManager.prototype);
    manager.query = 'cat';
    manager.searchInput = { value: 'cat' };
    manager.replaceInput = { value: 'dog' };
    manager.matches = [createRange('first'), createRange('second'), createRange('third')];
    manager.matchOffsets = [0, 8, 16];
    manager.currentMatchIndex = 1;
    manager._inputDebounceTimer = null;
    manager.savedSelection = null;
    manager.onWillReplace = null;
    manager.onDidReplace = null;
    manager._ensureSearchIsCurrent = () => {};
    return manager;
}

async function createSearchBarFixture(isMac) {
    const window = domino.createWindow('<div class="search-bar"><input id="find"><input id="replace"></div>');
    const document = window.document;
    const manager = await createManager();
    manager._isMac = isMac;
    manager.searchBar = document.querySelector('.search-bar');
    manager.searchInput = document.getElementById('find');
    manager.replaceInput = document.getElementById('replace');
    manager._composingInputs = new WeakSet();
    manager._lastCompositionEndByInput = new WeakMap();
    manager._compositionEndGraceMs = 100;
    for (const name of ['nextButton', 'prevButton', 'replaceButton', 'replaceAllButton', 'closeButton', 'caseSensitiveButton']) {
        manager[name] = document.createElement('button');
        manager.searchBar.appendChild(manager[name]);
    }
    manager._bindEvents();

    return {
        manager,
        window,
        key(input, key, modifiers = {}) {
            const event = new window.Event('keydown', { bubbles: true, cancelable: true });
            Object.assign(event, { key, ...modifiers });
            input.dispatchEvent(event);
            return event;
        }
    };
}

for (const isMac of [true, false]) {
    for (const field of ['searchInput', 'replaceInput']) {
        test(`${isMac ? 'Cmd' : 'Ctrl'} clipboard shortcuts in ${field} reach the VS Code dispatcher`, async () => {
            const fixture = await createSearchBarFixture(isMac);
            const received = [];
            fixture.window.document.addEventListener('keydown', event => received.push(event));
            const modifier = isMac ? { metaKey: true } : { ctrlKey: true };
            const shortcuts = [
                ['v', modifier],
                ['c', modifier],
                ['x', modifier],
                ['V', { ...modifier, shiftKey: true }],
                ['Insert', { shiftKey: true }],
                ['Insert', { ctrlKey: true }]
            ];

            for (const [key, modifiers] of shortcuts) {
                const event = fixture.key(fixture.manager[field], key, modifiers);
                assert.ok(received.at(-1) === event, `${key} must reach the host`);
                assert.equal(event.defaultPrevented, false, `${key} must remain available to the host`);
            }
            assert.equal(received.length, shortcuts.length);
        });
    }
}

test('find, navigation and editing keys stay inside the search bar', async () => {
    const fixture = await createSearchBarFixture(true);
    const { manager } = fixture;
    const received = [];
    const actions = [];
    fixture.window.document.addEventListener('keydown', event => received.push(event));
    manager.goToNext = () => actions.push('next');
    manager.goToPrevious = () => actions.push('previous');
    manager.replaceCurrent = () => actions.push('replace');
    manager.close = () => actions.push('close');
    manager.searchInput.select = () => actions.push('select');

    assert.equal(fixture.key(manager.searchInput, 'f', { metaKey: true }).defaultPrevented, true);
    assert.equal(fixture.key(manager.searchInput, 'Enter').defaultPrevented, true);
    assert.equal(fixture.key(manager.searchInput, 'Enter', { shiftKey: true }).defaultPrevented, true);
    assert.equal(fixture.key(manager.replaceInput, 'Enter').defaultPrevented, true);
    assert.equal(fixture.key(manager.replaceInput, 'Escape').defaultPrevented, true);
    for (const key of ['a', 'v', 'ArrowDown', 'Backspace', 'Tab']) {
        assert.equal(fixture.key(manager.searchInput, key).defaultPrevented, false);
    }

    assert.deepEqual(actions, ['select', 'next', 'previous', 'replace', 'close']);
    assert.deepEqual(received, []);
});

test('replaceCurrent replaces the active match and searches after inserted text', async () => {
    const manager = await createManager();
    const calls = [];
    const caretRange = createRange('caret');
    manager._replaceRange = (range, replacement) => {
        calls.push(['replace', range.id, replacement]);
        return caretRange;
    };
    manager._notifyWillReplace = range => calls.push(['will', range.id]);
    manager._notifyDidReplace = range => calls.push(['did', range.id]);
    manager._performSearch = options => calls.push(['search', options]);

    assert.equal(manager.replaceCurrent(), true);
    assert.deepEqual(calls, [
        ['will', 'second'],
        ['replace', 'second', 'dog'],
        ['did', 'caret'],
        ['search', { targetOffset: 11, scrollToCurrentMatch: true }]
    ]);
    assert.equal(manager.savedSelection.id, 'caret');
});

test('replaceAll replaces matches from the end and creates one history change', async () => {
    const manager = await createManager();
    const calls = [];
    manager._replaceRange = (range, replacement) => {
        calls.push(['replace', range.id, replacement]);
        return createRange(`caret-${range.id}`);
    };
    manager._notifyWillReplace = range => calls.push(['will', range.id]);
    manager._notifyDidReplace = range => calls.push(['did', range.id]);
    manager._performSearch = options => calls.push(['search', options]);

    assert.equal(manager.replaceAll(), 3);
    assert.deepEqual(calls, [
        ['will', 'second'],
        ['replace', 'third', 'dog'],
        ['replace', 'second', 'dog'],
        ['replace', 'first', 'dog'],
        ['did', 'caret-second'],
        ['search', { scrollToCurrentMatch: false }]
    ]);
    assert.equal(manager.savedSelection.id, 'caret-second');
});

test('replace actions do nothing when there are no matches', async () => {
    const manager = await createManager();
    manager.matches = [];
    manager.matchOffsets = [];
    manager.currentMatchIndex = -1;
    manager._replaceRange = () => {
        throw new Error('replacement should not run');
    };

    assert.equal(manager.replaceCurrent(), false);
    assert.equal(manager.replaceAll(), 0);
});

test('search reports non-overlapping matches and can target the next clean-text offset', async () => {
    const manager = await createManager();
    manager.query = 'aa';
    manager.caseSensitive = false;
    manager.currentMatchIndex = -1;
    manager.savedSelection = null;
    manager._clearHighlights = () => {};
    manager._getSearchableTextNodes = () => [{ textContent: 'aaaa' }];
    manager._cleanPositionToRange = start => createRange(`match-${start}`);
    manager._applyHighlights = () => {};
    manager._updateCurrentMatchHighlight = () => {};
    manager._scrollToCurrentMatch = () => {};
    manager._updateMatchCountLabel = () => {};

    manager._performSearch({ targetOffset: 1 });

    assert.deepEqual(manager.matchOffsets, [0, 2]);
    assert.equal(manager.currentMatchIndex, 1);
});

test('an unsafe cross-block match does not hide an overlapping match in the next block', async () => {
    const manager = await createManager();
    manager.query = 'aa';
    manager.caseSensitive = false;
    manager.currentMatchIndex = -1;
    manager.savedSelection = null;
    manager._clearHighlights = () => {};
    manager._getSearchableTextNodes = () => [{ textContent: 'aaa' }];
    manager._cleanPositionToRange = start => start === 0 ? null : createRange(`match-${start}`);
    manager._applyHighlights = () => {};
    manager._updateCurrentMatchHighlight = () => {};
    manager._scrollToCurrentMatch = () => {};
    manager._updateMatchCountLabel = () => {};

    manager._performSearch();

    assert.deepEqual(manager.matchOffsets, [1]);
});

test('IME confirmation keydowns are not treated as find or replace actions', async () => {
    const manager = await createManager();
    const input = {};
    manager._composingInputs = new WeakSet();
    manager._lastCompositionEndByInput = new WeakMap();
    manager._compositionEndGraceMs = 100;

    manager._composingInputs.add(input);
    assert.equal(manager._isImeConfirmationKeydown({ currentTarget: input }), true);

    manager._composingInputs.delete(input);
    assert.equal(manager._isImeConfirmationKeydown({ currentTarget: input, keyCode: 229 }), true);

    manager._lastCompositionEndByInput.set(input, Date.now());
    assert.equal(manager._isImeConfirmationKeydown({ currentTarget: input }), true);

    manager._lastCompositionEndByInput.set(input, Date.now() - 200);
    assert.equal(manager._isImeConfirmationKeydown({ currentTarget: input }), false);
});

function createRangeIn(id, readOnly) {
    // A match whose text node sits inside a read-only preserved block or not.
    const textNode = {
        nodeType: 3,
        parentElement: {
            closest: (selector) => (readOnly && selector.includes('mdw-opaque-source') ? {} : null),
        },
    };
    return {
        id,
        startContainer: textNode,
        endContainer: textNode,
        cloneRange() {
            return createRangeIn(id, readOnly);
        },
        collapse() {}
    };
}

test('replace skips matches inside read-only preserved blocks', async () => {
    const manager = await createManager();
    manager.matches = [
        createRangeIn('editable-1', false),
        createRangeIn('front-matter', true),
        createRangeIn('editable-2', false),
    ];
    const calls = [];
    manager._replaceRange = (range, replacement) => {
        calls.push(['replace', range.id, replacement]);
        return createRange(`caret-${range.id}`);
    };
    manager._notifyWillReplace = () => {};
    manager._notifyDidReplace = () => {};
    manager._performSearch = () => {};
    manager.goToNext = () => calls.push(['next']);

    // Replace on a read-only match only moves on.
    manager.currentMatchIndex = 1;
    assert.equal(manager.replaceCurrent(), false);
    assert.deepEqual(calls, [['next']]);

    calls.length = 0;
    assert.equal(manager.replaceAll(), 2);
    assert.deepEqual(calls, [
        ['replace', 'editable-2', 'dog'],
        ['replace', 'editable-1', 'dog'],
    ]);
});

test('search stops collecting matches at the limit and highlights without spreading', async () => {
    const { SearchManager } = await searchManagerModulePromise;
    const manager = await createManager();
    manager.query = 'a';
    manager.caseSensitive = false;
    manager.currentMatchIndex = -1;
    manager.savedSelection = null;
    manager._clearHighlights = () => {};
    manager._getSearchableTextNodes = () => [{ textContent: 'a'.repeat(25) }];
    manager._cleanPositionToRange = start => createRange(`match-${start}`);
    manager._updateCurrentMatchHighlight = () => {};
    manager._scrollToCurrentMatch = () => {};
    manager.matchCountLabel = { textContent: '', classList: { toggle() {}, remove() {} } };
    manager.replaceButton = {};
    manager.replaceAllButton = {};

    // The Highlight constructor must not receive every range as an argument.
    const added = [];
    const previous = { CSS: global.CSS, Highlight: global.Highlight, Range: global.Range };
    global.CSS = { highlights: { set() {} } };
    global.Highlight = class {
        constructor(...ranges) {
            assert.equal(ranges.length, 0);
        }
        add(range) {
            added.push(range);
        }
    };
    global.Range = class {
        setStart() {}
        setEnd() {}
    };
    const previousLimit = SearchManager.MAX_MATCHES;
    SearchManager.MAX_MATCHES = 10;
    try {
        manager._performSearch({ scrollToCurrentMatch: false });
    } finally {
        SearchManager.MAX_MATCHES = previousLimit;
        Object.assign(global, previous);
    }

    assert.equal(manager.matches.length, 10);
    assert.equal(manager.matchLimitReached, true);
    assert.equal(added.length, 10);
    assert.match(manager.matchCountLabel.textContent, /\/10\+$/);
});

async function createCloseFixture(t, {
    savedSelection = createRange('saved'), invalidRange = false, onDidClose = true,
    scrollTop = 1800, paddingBefore = 40, paddingAfter = 40,
    nativeAnchoringDelta = 0, focusChangesScroll = true
} = {}) {
    const { SearchManager } = await searchManagerModulePromise;
    const calls = [];
    let restoredRange = null;
    let paddingTop = paddingBefore;
    const expectedScrollTop = Math.max(0, scrollTop + paddingAfter - paddingBefore);
    const originalWindow = global.window;
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(global, 'navigator');
    global.window = {
        getComputedStyle: () => ({ paddingTop: `${paddingTop}px` }),
        getSelection: () => ({
            removeAllRanges() { calls.push('clear selection'); restoredRange = null; },
            addRange(range) {
                calls.push('restore selection');
                if (invalidRange) throw new Error('Detached selection');
                restoredRange = range;
            },
        }),
    };
    Object.defineProperty(global, 'navigator', { configurable: true, value: { platform: 'MacIntel' } });
    t.after(() => {
        if (originalWindow === undefined) delete global.window;
        else global.window = originalWindow;
        if (navigatorDescriptor) Object.defineProperty(global, 'navigator', navigatorDescriptor);
        else delete global.navigator;
    });

    class CloseSearchManager extends SearchManager {
        _createSearchBar() {}
        _observeEditorMutations() {}
    }
    const editor = {
        scrollTop,
        scrollLeft: 35,
        focus(options) {
            calls.push(['focus', options]);
            // Native focus/selection restoration may move the viewport even
            // when focus options were supplied. Close must restore it afterward.
            if (focusChangesScroll) {
                this.scrollTop = 0;
                this.scrollLeft = 0;
            }
        },
    };
    const options = onDidClose ? {
        onDidClose: (...args) => {
            calls.push(['did close', args]);
            assert.equal(manager.searchBar.style.display, 'none');
            assert.equal(editor.scrollTop, expectedScrollTop);
            assert.equal(editor.scrollLeft, 35);
            assert.ok(calls.some(call => Array.isArray(call) && call[0] === 'focus'));
        },
    } : {};
    const manager = new CloseSearchManager(editor, options);
    manager.isOpen = true;
    manager.searchBar = { style: { display: 'flex' } };
    manager.savedSelection = savedSelection;
    manager.matches = [createRange('match')];
    manager.matchOffsets = [300];
    manager.currentMatchIndex = 0;
    manager._setReservedSpace = value => {
        calls.push(['reserved space', value]);
        if (value === 0) {
            paddingTop = paddingAfter;
            editor.scrollTop += nativeAnchoringDelta;
        }
    };
    manager._clearHighlights = () => calls.push('clear highlights');
    manager._updateMatchCountLabel = () => {};
    return {
        manager, editor, calls,
        get restoredRange() { return restoredRange; },
        // A fixed paragraph's viewport position follows layout padding and scroll.
        get contentTop() { return 2000 + paddingTop - editor.scrollTop; }
    };
}

test('closing search preserves the manually scrolled viewport while restoring the saved caret', async t => {
    const f = await createCloseFixture(t);
    const savedSelection = f.manager.savedSelection;
    f.manager.close();
    assert.deepEqual(f.calls.at(-1), ['did close', []]);
    assert.deepEqual(f.calls.find(call => Array.isArray(call) && call[0] === 'focus'),
        ['focus', { preventScroll: true }]);
    assert.equal(f.editor.scrollTop, 1800);
    assert.equal(f.editor.scrollLeft, 35);
    assert.ok(f.restoredRange === savedSelection);
    assert.equal(f.manager.savedSelection, null);
    assert.equal(f.manager.isOpen, false);
    assert.equal(f.manager.searchBar.style.display, 'none');
    assert.deepEqual(f.manager.matches, []);
    assert.deepEqual(f.manager.matchOffsets, []);
    assert.equal(f.manager.currentMatchIndex, -1);
});

test('closing search without a saved selection or close callback still preserves scroll', async t => {
    const f = await createCloseFixture(t, { savedSelection: null, onDidClose: false });
    f.manager.close();
    assert.equal(f.editor.scrollTop, 1800);
    assert.equal(f.editor.scrollLeft, 35);
    assert.equal(f.calls.includes('clear selection'), false);
    assert.deepEqual(f.calls.find(call => Array.isArray(call) && call[0] === 'focus'),
        ['focus', { preventScroll: true }]);
});

test('closing search with an invalid saved range still restores focus without scrolling', async t => {
    const f = await createCloseFixture(t, { invalidRange: true });
    assert.doesNotThrow(() => f.manager.close());
    assert.equal(f.editor.scrollTop, 1800);
    assert.equal(f.editor.scrollLeft, 35);
    assert.equal(f.manager.savedSelection, null);
    assert.ok(f.calls.includes('restore selection'));
    assert.deepEqual(f.calls.find(call => Array.isArray(call) && call[0] === 'focus'),
        ['focus', { preventScroll: true }]);
});

test('closing search cancels pending query and refresh timers', async t => {
    const f = await createCloseFixture(t);
    const fired = [];
    const queryTimer = setTimeout(() => fired.push('query'), 10);
    const refreshTimer = setTimeout(() => fired.push('refresh'), 10);
    t.after(() => { clearTimeout(queryTimer); clearTimeout(refreshTimer); });
    f.manager._inputDebounceTimer = queryTimer;
    f.manager._refreshDebounceTimer = refreshTimer;
    f.manager.close();
    assert.equal(f.manager._inputDebounceTimer, null);
    assert.equal(f.manager._refreshDebounceTimer, null);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(fired, []);
});

for (const [layout, paddingBefore, paddingAfter] of [
    ['normal search bar', 78, 40],
    ['hidden toolbar', 78, 20],
    ['narrow search bar with fractional layout', 133.5, 40]
]) {
    test(`closing a ${layout} keeps the same paragraph at the same viewport position`, async t => {
        const f = await createCloseFixture(t, { paddingBefore, paddingAfter });
        const contentTop = f.contentTop;
        f.manager.close();
        assert.equal(f.contentTop, contentTop);
        assert.equal(f.editor.scrollTop, 1800 + paddingAfter - paddingBefore);
        assert.equal(f.editor.scrollLeft, 35);
    });
}

test('closing search does not apply the padding correction twice after native scroll anchoring', async t => {
    const f = await createCloseFixture(t, {
        paddingBefore: 90, paddingAfter: 40,
        nativeAnchoringDelta: -50, focusChangesScroll: false
    });
    const contentTop = f.contentTop;
    f.manager.close();
    assert.equal(f.editor.scrollTop, 1750);
    assert.equal(f.contentTop, contentTop);
});

test('closing search clamps padding correction at the document top', async t => {
    const f = await createCloseFixture(t, { scrollTop: 15, paddingBefore: 100, paddingAfter: 40 });
    f.manager.close();
    // Preserving the paragraph would require negative scrollTop at this edge.
    assert.equal(f.editor.scrollTop, 0);
});
