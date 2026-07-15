const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

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
