const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const slugSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'modules', 'MarkdownHeadingSlug.js'), 'utf8');
const slugModule = import(`data:text/javascript;base64,${Buffer.from(slugSource).toString('base64')}`);
const editorSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'editor.js'), 'utf8');

function fixture(html) {
    const window = domino.createWindow(`<div id="editor">${html}</div>`);
    const editor = window.document.getElementById('editor');
    return { editor, headings: () => editor.querySelectorAll('h1, h2, h3, h4, h5, h6') };
}

function extractFunction(name) {
    const start = editorSource.indexOf(`        function ${name}(`);
    const end = editorSource.indexOf('\n        }\n', start);
    assert.ok(start >= 0 && end > start);
    return editorSource.slice(start, end + '\n        }'.length);
}

test('opening link insertion lists current-document headings with their Markdown levels', async () => {
    const { getMarkdownHeadingLinkSuggestions } = await slugModule;
    const f = fixture('<h1>メモ</h1><p>body</p><h2>TODO項目</h2><h3>詳細</h3>');
    const items = getMarkdownHeadingLinkSuggestions(f.headings());
    assert.deepEqual(items.map(({ label, kind }) => ({ label, kind })), [
        { label: '# メモ', kind: 'heading' },
        { label: '## TODO項目', kind: 'heading' },
        { label: '### 詳細', kind: 'heading' }
    ]);
    assert.equal(items[1].linkLabel, 'TODO項目');
    assert.equal(items[1].path, '#todo項目');
    assert.equal(f.editor.querySelector('h2').id, 'todo項目');
});

test('heading search accepts text, Markdown heading prefixes, and fragment slugs', async () => {
    const { getMarkdownHeadingLinkSuggestions } = await slugModule;
    const f = fixture('<h2>TODO項目</h2><h3>Other topic</h3>');
    for (const query of ['TODO', '## TODO項目', '#todo項目', '#todo%E9%A0%85%E7%9B%AE', 'ＴＯＤＯ']) {
        assert.deepEqual(getMarkdownHeadingLinkSuggestions(f.headings(), query).map(item => item.linkLabel), ['TODO項目']);
    }
    assert.equal(getMarkdownHeadingLinkSuggestions(f.headings(), '#').length, 2);
    assert.equal(getMarkdownHeadingLinkSuggestions(f.headings(), 'missing').length, 0);
});

test('duplicate and formatted headings use the same IDs as fragment navigation', async () => {
    const { getMarkdownHeadingLinkSuggestions, assignStableHeadingIds } = await slugModule;
    const f = fixture('<h2><strong>TODO項目</strong></h2><h2>TODO項目</h2><h3>TODO項目-1</h3><h4>!!!</h4>');
    const items = getMarkdownHeadingLinkSuggestions(f.headings());
    assert.deepEqual(items.map(item => item.path), ['#todo項目', '#todo項目-1', '#todo項目-1-1', '#heading-3']);
    assignStableHeadingIds(f.headings());
    items.forEach(item => assert.ok(f.editor.querySelectorAll('[id]').some(heading => heading.id === decodeURIComponent(item.path.slice(1)))));
});

test('heading candidates reflect unsaved additions and renames in the live editor', async () => {
    const { getMarkdownHeadingLinkSuggestions } = await slugModule;
    const f = fixture('<h2>Old title</h2>');
    f.editor.querySelector('h2').textContent = 'New title';
    f.editor.insertAdjacentHTML('beforeend', '<h3>New unsaved heading</h3>');
    const items = getMarkdownHeadingLinkSuggestions(f.headings(), 'new');
    assert.deepEqual(items.map(item => item.path), ['#new-title', '#new-unsaved-heading']);
});

test('URLs and workspace paths do not show unrelated heading candidates', async () => {
    const { getMarkdownHeadingLinkSuggestions } = await slugModule;
    const f = fixture('<h2>TODO項目</h2>');
    for (const query of ['https://example.com', 'mailto:a@example.com', './TODO.md', '../TODO.md', '/TODO.md', 'C:\\TODO.md', ' TODO ', 'TODO\u202E', 'x'.repeat(257)]) {
        assert.equal(getMarkdownHeadingLinkSuggestions(f.headings(), query).length, 0, query);
    }
});

test('heading candidate limits leave space for project file matches', async () => {
    const { getMarkdownHeadingLinkSuggestions } = await slugModule;
    const f = fixture(Array.from({ length: 30 }, (_, index) => `<h2>TODO ${index}</h2>`).join(''));
    assert.equal(getMarkdownHeadingLinkSuggestions(f.headings()).length, 20);
    assert.equal(getMarkdownHeadingLinkSuggestions(f.headings(), 'TODO', 10).length, 10);
});

async function requestFixture(html) {
    const { getMarkdownHeadingLinkSuggestions } = await slugModule;
    const f = fixture(html);
    const messages = [];
    const responses = [];
    const finished = [];
    const input = { value: '', removeAttribute() {} };
    const begin = new Function(
        'editor', 'getMarkdownHeadingLinkSuggestions', 'vscode', 'insertSelectedWorkspaceLink', 'finishInlineLinkRequest', 'linkPopover',
        `let activeLinkPopoverRequestId = null;
        let activeLinkPopoverRequestKind = null;
        let activeLinkPopoverRequestInput = '';
        const getLinkPopoverTarget = () => ({ range: {}, existingLink: null });
        const rememberWorkspaceLinkInsertion = () => 'workspace-link-1-1';
        const hideLinkSuggestionList = () => {};
        const clearWorkspaceLinkSuggestions = () => {};
        const syncLinkPopoverOpenButtonState = () => {};
        const markLinkPopoverInputInvalid = () => {};
        let linkSuggestionDebounceTimer = null;
        ${extractFunction('beginLinkPopoverRequest')}
        return beginLinkPopoverRequest;`
    )(f.editor, getMarkdownHeadingLinkSuggestions, { postMessage: message => messages.push(message) },
        message => { responses.push(message); return true; }, (...args) => finished.push(args),
        { style: { display: 'flex' }, querySelector: () => input });
    return { ...f, begin, messages, responses, finished, getMarkdownHeadingLinkSuggestions };
}

test('selecting a heading inserts its fragment and plain heading label without a host file request', async () => {
    const f = await requestFixture('<h2>TODO項目</h2><h2>TODO項目</h2>');
    const item = f.getMarkdownHeadingLinkSuggestions(f.headings())[1];
    assert.equal(f.begin('suggestion', item.path, item), true);
    assert.deepEqual(f.messages, []);
    assert.deepEqual(f.responses, [{ requestId: 'workspace-link-1-1', linkKind: 'workspace', href: item.path, label: 'TODO項目' }]);
});

test('a removed or renamed heading candidate cannot insert an obsolete fragment', async () => {
    for (const change of ['remove', 'rename']) {
        const f = await requestFixture('<h2>TODO項目</h2>');
        const item = f.getMarkdownHeadingLinkSuggestions(f.headings())[0];
        const heading = f.editor.querySelector('h2');
        if (change === 'remove') heading.remove();
        else heading.textContent = 'Renamed';
        assert.equal(f.begin('suggestion', item.path, item), false);
        assert.deepEqual(f.responses, []);
        assert.deepEqual(f.finished, [['workspace-link-1-1', false]]);
    }
});

test('workspace file candidates still use the host-owned candidate ID protocol', async () => {
    const f = await requestFixture('<h2>TODO項目</h2>');
    assert.equal(f.begin('suggestion', './TODO.md', { kind: 'workspace', searchRequestId: 'workspace-link-suggest-1-1', candidateId: 'candidate-2' }), true);
    assert.deepEqual(f.responses, []);
    assert.deepEqual(f.messages, [{ type: 'resolveWorkspaceLinkSuggestion', requestId: 'workspace-link-1-1', searchRequestId: 'workspace-link-suggest-1-1', candidateId: 'candidate-2' }]);
});

test('readable and previously encoded Japanese fragments navigate to the correct duplicate heading', async () => {
    const { assignStableHeadingIds } = await slugModule;
    const f = fixture('<h2>6 テーブル</h2><h2>6 テーブル</h2>');
    const scrolled = [];
    Array.from(f.headings()).forEach((heading, index) => {
        heading.scrollIntoView = () => scrolled.push(index);
    });
    const revealLinkAnchor = new Function('document', 'editor', 'assignStableHeadingIds',
        `${extractFunction('revealLinkAnchor')}\nreturn revealLinkAnchor;`
    )(f.editor.ownerDocument, f.editor, assignStableHeadingIds);
    for (const fragment of ['#6-テーブル', '#6-%E3%83%86%E3%83%BC%E3%83%96%E3%83%AB']) {
        assert.equal(revealLinkAnchor(fragment), true);
        assert.equal(revealLinkAnchor(`${fragment}-1`), true);
    }
    assert.deepEqual(scrolled, [0, 1, 0, 1]);
});
