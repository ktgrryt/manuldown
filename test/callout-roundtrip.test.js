const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const path = require('node:path');
const { createWindow } = require('@mixmark-io/domino');

function createMockUri(uriPath, scheme = 'file', authority = '') {
    return {
        fsPath: scheme === 'file' ? uriPath : '', path: uriPath, scheme, authority,
        toString: () => scheme === 'file' ? `file://${uriPath}` : `${scheme}://${authority}${uriPath}`,
        with: (changes) => createMockUri(changes.path ?? uriPath, changes.scheme ?? scheme, changes.authority ?? authority),
    };
}

function loadExtensionModules() {
    const originalLoad = Module._load;
    const vscodeMock = {
        Uri: {
            file: (fsPath) => createMockUri(fsPath),
            parse: (value) => {
                const parsed = new URL(value);
                return createMockUri(parsed.pathname, parsed.protocol.slice(0, -1), parsed.host);
            },
            joinPath: (base, ...segments) => createMockUri(path.posix.join(base.path, ...segments), base.scheme, base.authority),
        },
        workspace: {
            getWorkspaceFolder: () => null,
            getConfiguration: () => ({ get: (_key, defaultValue) => defaultValue }),
        },
        window: {},
    };
    Module._load = function (request, parent, isMain) {
        return request === 'vscode' ? vscodeMock : originalLoad.call(this, request, parent, isMain);
    };
    try {
        return {
            MarkdownDocument: require('../out/editor/MarkdownDocument').MarkdownDocument,
            MarkdownEditorProvider: require('../out/editor/MarkdownEditorProvider').MarkdownEditorProvider,
        };
    } finally {
        Module._load = originalLoad;
    }
}

const { MarkdownDocument, MarkdownEditorProvider } = loadExtensionModules();
const textDocument = (text) => ({ getText: () => text, uri: createMockUri('/workspace/callouts.md') });
const provider = () => new MarkdownEditorProvider({});
const render = (source) => new MarkdownDocument(textDocument(source)).toHtml();
const save = (html, source) => provider().htmlToMarkdown(html, textDocument(source));
const dom = (html) => createWindow(`<div id="editor">${html}</div>`).document.getElementById('editor');
const base64 = (value) => Buffer.from(value, 'utf8').toString('base64');

const examples = [
    ...['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'].map((type) => ({
        name: `GitHub ${type}`, source: `> [!${type}]\n> Original.\n`,
        variant: { NOTE: 'note', TIP: 'tip', IMPORTANT: 'important', WARNING: 'warning', CAUTION: 'caution' }[type],
    })),
    ...['info', 'tip', 'warning', 'success', 'question', 'error'].map((type) => ({
        name: `Obsidian ${type}`, source: `> [!${type}]\n> Original.\n`,
        variant: { info: 'note', tip: 'tip', warning: 'warning', success: 'tip', question: 'important', error: 'caution' }[type],
    })),
    ...['info', 'warn', 'alert'].map((type) => ({
        name: `Qiita ${type}`, source: `:::note ${type}\nOriginal.\n:::\n`,
        variant: { info: 'note', warn: 'warning', alert: 'caution' }[type],
    })),
    { name: 'Qiita omitted info', source: ':::note\nOriginal.\n:::\n', variant: 'note' },
    { name: 'Zenn message', source: ':::message\nOriginal.\n:::\n', variant: 'note' },
    { name: 'Zenn alert', source: ':::message alert\nOriginal.\n:::\n', variant: 'caution' },
    ...['note', 'tip', 'info', 'warning', 'danger'].map((type) => ({
        name: `Docusaurus ${type}`, source: `:::${type}\nOriginal.\n:::\n`,
        variant: { note: 'note', tip: 'tip', info: 'note', warning: 'warning', danger: 'caution' }[type],
    })),
    { name: 'VitePress spaced directive', source: '::: warning\nOriginal.\n:::\n', variant: 'warning' },
    { name: 'MkDocs note', source: '!!! note\n    Original.\n', variant: 'note' },
    { name: 'MkDocs warning', source: '!!! warning\n    Original.\n', variant: 'warning' },
];

for (const example of examples) {
    test(`callout ${example.name} renders, edits, retains its dialect and reopens`, () => {
        const html = render(example.source);
        const editor = dom(html);
        const callout = editor.querySelector('.mdw-callout');
        assert.ok(callout, html);
        assert.equal(callout.getAttribute('data-mdw-callout-variant'), example.variant);
        const content = callout.querySelector('.mdw-callout-content');
        assert.ok(content);
        assert.notEqual(content.getAttribute('contenteditable'), 'false');
        assert.equal(content.querySelector('p').textContent, 'Original.');
        assert.equal(save(html, example.source), example.source);

        content.querySelector('p').textContent = '編集した本文。';
        const saved = save(editor.innerHTML, example.source);
        assert.equal(saved, example.source.replace('Original.', '編集した本文。'));
        assert.equal(save(render(saved), saved), saved);
        assert.equal(dom(render(saved)).querySelector('.mdw-callout-content').textContent.trim(), '編集した本文。');
    });
}

test('mixed callout dialects retain separate declarations after only one body is edited', () => {
    const source = examples.filter((example) => ['GitHub WARNING', 'Qiita warn', 'Zenn message', 'MkDocs note'].includes(example.name))
        .map((example) => example.source.trimEnd()).join('\n\n') + '\n';
    const editor = dom(render(source));
    assert.equal(editor.querySelectorAll('.mdw-callout').length, 4);
    assert.equal(save(editor.innerHTML, source), source);
    editor.querySelectorAll('.mdw-callout-content p')[1].textContent = 'Changed Qiita.';
    const expected = source.replace(':::note warn\nOriginal.', ':::note warn\nChanged Qiita.');
    assert.equal(save(editor.innerHTML, source), expected);
    assert.equal(save(render(expected), expected), expected);
});

test('same-looking callouts keep their individual forms and positions when reordered', () => {
    const source = '> [!WARNING]\n> Same.\n\n:::note warn\nSame.\n:::\n';
    const editor = dom(render(source));
    const callouts = editor.querySelectorAll('.mdw-callout');
    editor.insertBefore(callouts[1], callouts[0]);
    const saved = save(editor.innerHTML, source);
    assert.match(saved, /^:::note warn\nSame\.\n:::\n\n> \[!WARNING\]\n> Same\.\n$/);
    assert.equal(save(render(saved), saved), saved);
});

test('custom titles, case, folding flags and delimiter widths survive body edits', () => {
    for (const source of [
        '> [!TiP]- Custom 日本語 title\n> Original.\n',
        '> [!info]+ Expanded\n> Original.\n',
        '::::warning[Custom **title**]\nOriginal.\n::::\n',
        '::: danger STOP\nOriginal.\n:::\n',
        '!!! warning "Custom title"\n    Original.\n',
        '???+ note "Expanded title"\n    Original.\n',
    ]) {
        const editor = dom(render(source));
        assert.ok(editor.querySelector('.mdw-callout'), source);
        assert.equal(save(editor.innerHTML, source), source);
        editor.querySelector('.mdw-callout-content p').textContent = 'Changed.';
        assert.equal(save(editor.innerHTML, source), source.replace('Original.', 'Changed.'));
    }
});

test('callout text, inline formatting, multiple paragraphs, list and code serialize normally', () => {
    const source = ':::note warn\nOriginal.\n:::\n\nOutside remains.\n';
    const editor = dom(render(source));
    editor.querySelector('.mdw-callout-content').innerHTML = '<p>First <strong>bold</strong>, <em>italic</em> and <a href="https://example.com/">link</a>.</p>' +
        '<p>Second paragraph.</p><ul><li>One</li><li>Two</li></ul><pre><code class="language-js">const answer = 42;\n</code></pre>';
    const saved = save(editor.innerHTML, source);
    assert.match(saved, /^:::note warn\nFirst \*\*bold\*\*, [*_]italic[*_] and \[link\]\(https:\/\/example\.com\/\)\./);
    assert.match(saved, /\n\nSecond paragraph\.\n\n[-*] One\n[-*] Two/);
    assert.match(saved, /```js\nconst answer = 42;\n```/);
    assert.match(saved, /\n:::\n\nOutside remains\.\n$/);
    const reopened = dom(render(saved));
    const content = reopened.querySelector('.mdw-callout-content');
    assert.equal(content.querySelectorAll('p').length, 2);
    assert.ok(content.querySelector('strong'));
    assert.ok(content.querySelector('em'));
    assert.ok(content.querySelector('a'));
    assert.equal(content.querySelectorAll('li').length, 2);
    assert.equal(content.querySelector('pre code').textContent.trim(), 'const answer = 42;');
    assert.equal(save(reopened.innerHTML, saved), saved);
});

test('nested callouts preserve their source when the editable outer body changes', () => {
    for (const source of [
        '> [!info] Outer\n> Outer body.\n>\n> > [!warning]- Inner\n> > Original.\n',
        '::::info[Outer]\nOuter body.\n\n:::warning[Inner]\nOriginal.\n:::\n::::\n',
        '!!! note "Outer"\n    Outer body.\n\n    !!! warning "Inner"\n        Original.\n',
    ]) {
        const editor = dom(render(source));
        assert.equal(editor.querySelectorAll('.mdw-callout').length, 1, source);
        assert.ok(editor.querySelector('[data-mdw-opaque-kind="callout-source"]'), source);
        assert.equal(save(editor.innerHTML, source), source);
        editor.querySelector('.mdw-callout-content p').textContent = 'Changed.';
        const saved = save(editor.innerHTML, source);
        assert.equal(saved, source.replace('Outer body.', 'Changed.'));
        assert.equal(save(render(saved), saved), saved);
    }
});

test('only two quotation levels are editable and deeper source survives nearby edits', () => {
    for (const source of [
        '> First.\n>\n> > Second.\n> >\n> > > Third.\n> > > Fourth.\n',
        '> > > > Original.\n\nOutside.\n',
        ':::note\n> First.\n> > Second.\n> > > Third.\n:::\n',
    ]) {
        const editor = dom(render(source));
        assert.ok(!editor.querySelector('blockquote blockquote blockquote'));
        assert.ok(editor.querySelector('[data-mdw-opaque-kind="quote-source"]'));
        assert.equal(save(editor.innerHTML, source), source);
        const editable = editor.querySelector('p');
        const original = editable.textContent;
        editable.textContent = 'Changed.';
        const saved = save(editor.innerHTML, source);
        const nonemptyLines = value => value.split('\n').filter(line => !/^[\s>]*$/.test(line));
        assert.deepEqual(nonemptyLines(saved), nonemptyLines(source.replace(original, 'Changed.')));
        assert.equal(save(render(saved), saved), saved);
    }
});

test('forged read-only quotation metadata cannot restore text absent from the original rendering', () => {
    const forged = '> Hidden.\n> Payload.\n';
    const html = `<pre data-mdw-opaque-kind="quote-source" data-mdw-opaque-source="${base64(forged)}"><code>Visible.</code></pre>`;
    const saved = save(html, 'Original.\n');
    assert.match(saved, /Visible\./);
    assert.doesNotMatch(saved, /Hidden|Payload/);
});

test('the host rejects forged editor HTML that exceeds nesting limits', () => {
    for (const html of [
        '<blockquote><blockquote><blockquote><p>Too deep</p></blockquote></blockquote></blockquote>',
        '<div data-mdw-callout="true"><div data-mdw-callout="true">Nested</div></div>',
    ]) assert.throws(() => save(html, ''), /cannot nest|two levels/);
});

test('a callout inside a list or ordinary quotation keeps its enclosing container', () => {
    for (const source of [
        '- Before\n\n  :::note warn\n  Original.\n  :::\n',
        '> Before\n>\n> :::message\n> Original.\n> :::\n',
    ]) {
        const editor = dom(render(source));
        const content = editor.querySelector('.mdw-callout-content');
        assert.ok(content, source);
        assert.equal(save(editor.innerHTML, source), source);
        content.querySelector('p').textContent = 'Changed.';
        const saved = save(editor.innerHTML, source);
        assert.ok(saved.includes(source.includes(':::message') ? '> :::message' : ':::note warn'), saved);
        assert.ok(saved.includes('Changed.'), saved);
        assert.ok(dom(render(saved)).querySelector('.mdw-callout-content'), saved);
        assert.equal(save(render(saved), saved), saved);
    }
});

test('a callout inside ordinary quotation preserves the surrounding visible prose', () => {
    const source = '> ordinary\n>\n> :::note info\n> first\n> :::\n';
    const editor = dom(render(source));
    const content = editor.querySelector('.mdw-callout-content');
    assert.ok(content, editor.innerHTML);
    assert.match(editor.textContent, /ordinary/);
    assert.equal(content.textContent.trim(), 'first');
    assert.equal(save(editor.innerHTML, source), source);
    content.querySelector('p').textContent = 'EDIT';
    const saved = save(editor.innerHTML, source);
    assert.match(saved, /^> ordinary\n/);
    assert.match(saved, /> :::note info\n> EDIT\n> :::\n$/);
    const reopened = dom(render(saved));
    assert.match(reopened.textContent, /ordinary/);
    assert.equal(reopened.querySelector('.mdw-callout-content').textContent.trim(), 'EDIT');
});

test('callouts inside a quoted list item retain every enclosing prefix after edits', () => {
    for (const source of [
        '- > :::note warn\n  > Original.\n  > :::\n',
        '1. > :::note warn\n   > Original.\n   > :::\n',
    ]) {
        const editor = dom(render(source));
        const content = editor.querySelector('.mdw-callout-content');
        assert.ok(content, editor.innerHTML);
        assert.equal(save(editor.innerHTML, source), source);
        content.querySelector('p').textContent = 'EDIT';
        const saved = save(editor.innerHTML, source);
        assert.match(saved, /^[-1][. ]* > :::note warn\n/);
        assert.match(saved, /> EDIT\n/);
        const reopened = dom(render(saved));
        assert.equal(reopened.querySelector('.mdw-callout-content').textContent.trim(), 'EDIT');
        assert.ok(reopened.querySelector('li blockquote .mdw-callout'));
        assert.equal(save(reopened.innerHTML, saved), saved);
    }
});

test('callouts inside footnote definitions preserve their source and nested edits', () => {
    for (const source of [
        'Body[^a].\n\n[^a]: Outer.\n\n    :::note warn\n    Original.\n    :::\n',
        'Body[^a].\n\n[^a]: Outer.\n\n    > [!WARNING]- Custom title\n    > Original.\n',
    ]) {
        const editor = dom(render(source));
        const callout = editor.querySelector('.mdw-footnote-content .mdw-callout-content');
        assert.ok(callout, editor.innerHTML);
        assert.equal(save(editor.innerHTML, source), source);
        callout.querySelector('p').textContent = 'EDIT';
        const saved = save(editor.innerHTML, source);
        assert.equal(saved, source.replace('Original.', 'EDIT'));
        const reopened = dom(render(saved));
        assert.equal(reopened.querySelector('.mdw-footnote-content .mdw-callout-content').textContent.trim(), 'EDIT');
        assert.equal(save(reopened.innerHTML, saved), saved);
    }
});

test('indented MkDocs declarations retain the declaration indent and six-space body after edits', () => {
    const source = '  !!! warning "Indented title"\n      Original.\n';
    const editor = dom(render(source));
    const content = editor.querySelector('.mdw-callout-content');
    assert.ok(content, editor.innerHTML);
    assert.equal(content.textContent.trim(), 'Original.');
    assert.equal(save(editor.innerHTML, source), source);
    content.querySelector('p').textContent = 'EDIT';
    const saved = save(editor.innerHTML, source);
    assert.equal(saved, source.replace('Original.', 'EDIT'));
    assert.equal(save(render(saved), saved), saved);
});

test('code blocks and inline code containing callout examples stay literal', () => {
    const markers = '> [!NOTE]\n> Literal.\n\n:::note warn\nLiteral.\n:::\n\n!!! warning\n    Literal.';
    for (const source of [
        `\`\`\`markdown\n${markers}\n\`\`\`\n`,
        `~~~markdown\n${markers}\n~~~\n`,
        markers.split('\n').map((line) => `    ${line}`).join('\n') + '\n',
        '`> [!NOTE]` and `:::note warn` and `!!! warning`\n',
    ]) {
        const html = render(source);
        assert.equal(dom(html).querySelectorAll('.mdw-callout').length, 0, source);
        assert.equal(save(html, source), source);
        const editor = dom(html);
        editor.insertAdjacentHTML('beforeend', '<p>Adjacent edit.</p>');
        const saved = save(editor.innerHTML, source);
        assert.ok(saved.includes(source.trimEnd()), saved);
        assert.equal(dom(render(saved)).querySelectorAll('.mdw-callout').length, 0, saved);
    }
});

test('a colon delimiter example inside callout code does not close the callout', () => {
    const source = ':::note warn\nBefore.\n\n```markdown\n:::message\nExample.\n:::\n```\n\nAfter.\n:::\n';
    const editor = dom(render(source));
    assert.equal(editor.querySelectorAll('.mdw-callout').length, 1);
    assert.ok(editor.querySelector('.mdw-callout-content pre code').textContent.includes(':::message'));
    assert.equal(save(editor.innerHTML, source), source);
    editor.querySelector('.mdw-callout-content p').textContent = 'Changed.';
    const saved = save(editor.innerHTML, source);
    assert.ok(saved.includes('```markdown\n:::message\nExample.\n:::\n```'), saved);
    assert.equal(dom(render(saved)).querySelectorAll('.mdw-callout').length, 1);
});

test('unknown and incomplete declarations stay literal and preserve source around adjacent edits', () => {
    for (const fragment of [
        ':::unknown\nOriginal.\n:::',
        ':::note warn\nOriginal.',
        ':::message unsupported\nOriginal.\n:::',
        '> [!unknown]\n> Original.',
        '> [!constructor]\n> Original.',
        '> [!NOTE\n> Original.',
        '!!! unknown\n    Original.',
        '!!! constructor\n    Original.',
        '!!! warning\nOriginal without indentation.',
        ':::note[Unclosed title\nOriginal.\n:::',
    ]) {
        const source = `${fragment}\n\nAdjacent.\n`;
        const editor = dom(render(source));
        assert.equal(editor.querySelectorAll('.mdw-callout').length, 0, source);
        assert.equal(save(editor.innerHTML, source), source);
        const paragraphs = Array.from(editor.querySelectorAll('p'));
        const adjacent = paragraphs.find((paragraph) => paragraph.textContent === 'Adjacent.');
        assert.ok(adjacent, `${source}\n${editor.innerHTML}`);
        adjacent.textContent = 'Changed adjacent.';
        const saved = save(editor.innerHTML, source);
        assert.equal(saved, source.replace('Adjacent.', 'Changed adjacent.'));
        assert.equal(dom(render(saved)).querySelectorAll('.mdw-callout').length, 0);
    }
});

test('unsupported nested containers are retained without converting only part of the block', () => {
    const source = '::::info\nBefore.\n\n:::custom-widget data\nOriginal.\n:::\n::::\n\nAdjacent.\n';
    const editor = dom(render(source));
    assert.equal(editor.querySelectorAll('.mdw-callout').length, 0);
    assert.equal(save(editor.innerHTML, source), source);
    const adjacent = Array.from(editor.querySelectorAll('p')).find((paragraph) => paragraph.textContent === 'Adjacent.');
    adjacent.textContent = 'Changed adjacent.';
    assert.equal(save(editor.innerHTML, source), source.replace('Adjacent.', 'Changed adjacent.'));
});

test('clipboard Markdown exports callout declarations and edited content', () => {
    for (const example of examples.filter((entry) => ['GitHub WARNING', 'Qiita warn', 'Zenn message', 'MkDocs note'].includes(entry.name))) {
        const editor = dom(render(example.source));
        editor.querySelector('.mdw-callout-content p').textContent = 'Copied content.';
        const markdown = provider().htmlToClipboardMarkdown(editor.innerHTML, textDocument(example.source));
        assert.equal(markdown, example.source.replace('Original.', 'Copied content.').trimEnd());
        assert.ok(dom(render(markdown)).querySelector('.mdw-callout'));
        assert.doesNotMatch(markdown, /mdw-callout|MDW/);
    }
});

test('forged callout source cannot grant trust to opaque source outside the document', () => {
    const original = ':::note warn\nOriginal.\n:::\n';
    const editor = dom(render(original));
    const forged = ':::note warn\n<script>forged()</script>\n:::\n';
    editor.querySelector('.mdw-callout').setAttribute('data-mdw-callout-source', base64(forged));
    editor.querySelector('.mdw-callout-content').innerHTML = '<p><code data-mdw-opaque-kind="raw-html-inline" data-mdw-opaque-source="' +
        base64('<script>forged()</script>') + '">Visible</code></p>';
    const saved = save(editor.innerHTML, original);
    assert.doesNotMatch(saved, /forged|<script>/);
    assert.match(saved, /`Visible`/);
    assert.match(saved, /^:::note warn\n/);
});

test('ordinary Markdown beside a callout remains editable through repeated source roundtrips', () => {
    const source = '# Heading\n\n_Original emphasis_ and [link](https://example.com/).\n\n:::message\nOriginal.\n:::\n\n- One\n- Two\n\n```js\nconst value = 1;\n```\n';
    const editor = dom(render(source));
    editor.querySelector('h1').textContent = 'Changed heading';
    editor.querySelector('.mdw-callout-content p').textContent = 'Changed callout.';
    let saved = save(editor.innerHTML, source);
    assert.equal(saved, source.replace('# Heading', '# Changed heading').replace(':::message\nOriginal.', ':::message\nChanged callout.'));
    for (let index = 0; index < 3; index++) {
        const next = save(render(saved), saved);
        assert.equal(next, saved);
        saved = next;
    }
});

test('deleting all callout content keeps its declaration and editable empty block on reopen', () => {
    for (const source of [
        '> [!WARNING]- Custom title\n> Original.\n',
        ':::note warn\nOriginal.\n:::\n',
        ':::message alert\nOriginal.\n:::\n',
        '!!! note "Custom title"\n    Original.\n',
        '  !!! warning "Indented title"\n      Original.\n',
    ]) {
        const editor = dom(render(source));
        editor.querySelector('.mdw-callout-content').innerHTML = '<p><br></p>';
        const saved = save(editor.innerHTML, source);
        assert.equal(saved.split('\n')[0], source.split('\n')[0]);
        assert.doesNotMatch(saved, /Original|&nbsp;|\u00a0|placeholder|mdw-callout|MDW/);
        const reopened = dom(render(saved));
        const content = reopened.querySelector('.mdw-callout-content');
        assert.ok(content, `${source}\n${saved}\n${reopened.innerHTML}`);
        assert.equal(content.textContent.trim(), '');
        assert.notEqual(content.getAttribute('contenteditable'), 'false');
        assert.equal(save(reopened.innerHTML, saved), saved);
    }
});

test('saving edited callouts beside deeply indented code finishes in a bounded process', () => {
    const { spawnSync } = require('node:child_process');
    const worker = String.raw`
        const assert = require('node:assert/strict');
        const Module = require('node:module');
        const path = require('node:path');
        const { createWindow } = require('@mixmark-io/domino');
        ${createMockUri.toString()}
        ${loadExtensionModules.toString()}
        const { MarkdownDocument, MarkdownEditorProvider } = loadExtensionModules();
        const code = '\x60\x60\x60text\n' + ' '.repeat(1000) + 'literal code text\n\x60\x60\x60\n';
        const source = ':::message\nOriginal.\n:::\n\n' + code;
        const document = { getText: () => source, uri: createMockUri('/workspace/callouts.md') };
        const html = new MarkdownDocument(document).toHtml();
        const editor = createWindow('<div id="editor">' + html + '</div>').document.getElementById('editor');
        editor.querySelector('.mdw-callout-content p').textContent = 'Edited.';
        const provider = new MarkdownEditorProvider({});
        for (const options of [{ depth: 0 }, { depth: 0, preserveSource: false }]) {
            const saved = provider.htmlToMarkdown(editor.innerHTML, document, options);
            assert.match(saved, /^:::message\nEdited\.\n:::\n/);
            assert.ok(saved.includes(code), 'code whitespace must remain unchanged');
            assert.doesNotMatch(saved, /MDWCALLOUT/);
        }
        process.stdout.write('saved');
    `;
    const result = spawnSync(process.execPath, ['-e', worker], {
        cwd: __dirname, timeout: 10000, encoding: 'utf8', maxBuffer: 64 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'saved');
});
