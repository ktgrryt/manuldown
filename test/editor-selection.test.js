const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const { createWindow } = require('@mixmark-io/domino');
const { projectEditorText, mapTextOffset, captureEditorSelection, restoreEditorSelection } = require('../out/editor/EditorSelection');

const originalLoad = Module._load;
Module._load = function (name, ...args) {
    return name === 'vscode' ? { workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } }
        : originalLoad.call(this, name, ...args);
};
let MarkdownDocument;
let MarkdownSelectionMap;
try {
    ({ MarkdownDocument } = require('../out/editor/MarkdownDocument'));
    ({ MarkdownSelectionMap } = require('../out/editor/MarkdownSelection'));
} finally { Module._load = originalLoad; }

function fixture(source) {
    const document = new MarkdownDocument({ getText: () => source, uri: { scheme: 'file', path: '/notes.md' } });
    const root = createWindow(`<div id="editor">${document.toHtml()}</div>`).document.getElementById('editor');
    return { root, text: projectEditorText(root).text, map: new MarkdownSelectionMap(document, source) };
}

test('switching maps authored character boundaries in common Markdown blocks', () => {
    const cases = [
        ['# Heading\n\nFirst paragraph.\n\nSecond paragraph.\n', 'Second', 3],
        ['# Heading\n\n**太字の日本語**と_斜体_、😀の文章。\n', '太字の日本語', 4],
        ['A [label](https://example.com/label) and `inline code` end.\n', 'inline code', 5],
        ['A [here](here) here again.\n', 'here again', 5],
        ['- First\n- Second **entry**\n  - Nested item\n', 'Nested item', 5],
        ['> Quoted line\n> Second quoted line\n', 'Second quoted line', 7],
        ['```js\nconst message = "日本語😀";\nconsole.log(message);\n```\n', 'console.log', 5],
        ['| Name | Value |\n| --- | --- |\n| Apple | Banana |\n', 'Banana', 3],
        ['---\ntitle: Example\n---\n\nText after metadata.\n', 'Text after', 5],
        ['Repeated text.\n\nRepeated text.\n\nFinal paragraph.\n', 'Final', 2],
        ['# Heading\r\n\r\nFirst.\r\n\r\nSecond paragraph.\r\n', 'Second', 3],
        ['> [!NOTE]\n> First callout line\n> Second callout line\n\nAfter.\n', 'Second callout', 8],
    ];
    for (const [source, needle, delta] of cases) {
        const { text, map } = fixture(source);
        const rendered = text.indexOf(needle) + delta;
        assert.ok(rendered >= delta, `Rendered text contains ${needle}`);
        const expected = source.indexOf(needle) + delta;
        assert.deepEqual(map.toSource({ anchor: rendered, active: rendered }),
            { anchor: expected, active: expected }, `rendered to source: ${JSON.stringify(source)}`);
        assert.deepEqual(map.toRendered({ anchor: expected, active: expected }),
            { anchor: rendered, active: rendered }, `source to rendered: ${JSON.stringify(source)}`);
    }
});

test('duplicate paragraphs retain their own position and backward selections retain direction', () => {
    const source = 'Same **words**.\n\nSame **words**.\n';
    const { text, map } = fixture(source);
    const anchor = source.lastIndexOf('words') + 4;
    const active = source.lastIndexOf('words') + 1;
    const rendered = map.toRendered({ anchor, active });
    assert.equal(rendered.anchor, text.lastIndexOf('words') + 4);
    assert.equal(rendered.active, text.lastIndexOf('words') + 1);
    assert.deepEqual(map.toSource(rendered), { anchor, active });
});

test('empty documents and positions in syntax have valid nearby editing positions', () => {
    for (const source of ['', '\n\n', '# Heading\n', '**bold**\n', '![alt](image.png)\n\nAfter.\n']) {
        const { text, map } = fixture(source);
        for (let offset = 0; offset <= source.length; offset++) {
            const value = map.toRendered({ anchor: offset, active: offset });
            assert.ok(value.active >= 0 && value.active <= text.length);
        }
    }
    assert.equal(mapTextOffset('bold', '**bold**\n', 0), 2);
    assert.equal(mapTextOffset('bold', '**bold**\n', 4), 6);
    assert.equal(mapTextOffset('\uFFFC', '![alt](image.png)', 1), '![alt](image.png)'.length);
});

test('projection excludes controls and captures/restores a caret after a paragraph boundary', () => {
    const window = createWindow('<div id="editor"><p>First</p><pre><div class="code-block-toolbar">JavaScript Preview</div><code>second</code></pre><p>Third</p></div>');
    const root = window.document.getElementById('editor');
    const node = root.lastChild.firstChild;
    let value = { anchorNode: node, anchorOffset: 0, focusNode: node, focusOffset: 3 };
    window.getSelection = () => ({ ...value, setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) {
        value = { anchorNode, anchorOffset, focusNode, focusOffset };
    } });
    root.focus = () => {};
    assert.equal(projectEditorText(root).text, 'First\nsecond\nThird\n');
    const selection = captureEditorSelection(root);
    assert.deepEqual(selection, { anchor: 13, active: 16 });
    restoreEditorSelection(root, selection);
    assert.equal(value.anchorNode, node);
    assert.equal(value.anchorOffset, 0);
    assert.equal(value.focusOffset, 3);
});

test('temporary caret anchors do not shift authored offsets', () => {
    const root = createWindow('<div id="editor"><p>a\u200Bb😀c</p></div>').document.getElementById('editor');
    const projection = projectEditorText(root, () => 1);
    assert.equal(projection.text, 'ab😀c\n');
    assert.equal(projection.offsetAt(root.firstChild.firstChild, 5), 4);
    assert.equal(projection.pointAt(4).offset, 5);
});

test('large source-only spans keep adjacent caret boundaries usable', () => {
    const longPath = 'x'.repeat(250_000);
    const image = `![image](${longPath})`;
    assert.equal(mapTextOffset('\uFFFC', image, 1), image.length);
    assert.equal(mapTextOffset('text', 'text' + longPath, 4), 4);
    assert.equal(mapTextOffset('text' + longPath, 'text', 100_000), 4);
});
