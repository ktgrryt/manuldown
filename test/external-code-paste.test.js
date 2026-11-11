const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');
const { marked } = require('marked');

const source = fs.readFileSync(path.join(__dirname, '..', 'media/editor.js'), 'utf8');
function slice(startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start);
    return source.slice(start, end);
}

function fixture() {
    const window = domino.createWindow('<div id="editor"><p>target</p></div>');
    const document = window.document;
    const editor = document.getElementById('editor');
    const lastText = node => {
        if (node.nodeType === 3) return node;
        for (const child of Array.from(node.childNodes).reverse()) {
            const found = lastText(child);
            if (found) return found;
        }
        return null;
    };
    const env = {
        document, Node: window.Node,
        getSelectionRangeForPaste: () => ({ selection: {}, range: {} }),
        isRangeInsideCodeBlock: () => false, isRangeInTableCell: () => false,
        codeBlockManager: { addCodeBlockControls() {} },
        stateManager: { saveState() {} },
        tableManager: {
            _insertNodeAsBlock(_range, node) { editor.innerHTML = ''; editor.appendChild(node); },
            wrapTables() {},
        },
        normalizeCheckboxListItems() {}, updateListItemClasses() {},
        domUtils: { getLastTextNode: lastText },
        placeCollapsedCaret() {}, setCaretAfterNode() {}, notifyChange() {},
        findUrlLikeRanges: () => [],
        isPastedBlankLine: line => line.trim() === '',
        parsePastedListLine: () => null, splitMarkdownTableRow: () => null,
        isMarkdownTableSeparatorCell: () => false,
    };
    const code = [
        slice('    function parsePastedFenceOpening(', '    function isOfficeClipboardHtml('),
        slice('        const appendInlineMarkdownText =', '        const hasVisibleLinkText ='),
        slice('        const tryInsertFencedCodeBlockFromPastedText =', '        const splitMarkdownTableRow ='),
        slice('        const tryInsertMixedMarkdownFromPastedText =', '        const insertTextWithPasteBehavior ='),
    ].join('\n');
    const handlers = new Function(...Object.keys(env), `${code}\nreturn {
        single: tryInsertFencedCodeBlockFromPastedText,
        mixed: tryInsertMixedMarkdownFromPastedText,
    };`)(...Object.values(env));
    return { editor, ...handlers };
}

test('multiple pasted code blocks keep their separate code and intervening explanation', () => {
    const input = '```sh\necho one\n```\n\nEXPLANATION\n\n```sh\necho two\n```';
    const f = fixture();
    assert.equal(f.single(input), false);
    assert.equal(f.editor.textContent, 'target');
    assert.equal(f.mixed(input), true);
    assert.deepEqual(Array.from(f.editor.querySelectorAll('pre code'), node => node.textContent),
        ['echo one', 'echo two']);
    assert.equal(f.editor.querySelector('p').textContent, 'EXPLANATION');
});

for (const input of [
    'Intro\n\n```js\none\n```notclosing\ntwo\n```\n\nOutro',
    'Intro\n\n````js\none\n```\ntwo\n````\n\nOutro',
    'Intro\n\n~~~js\none\n```\ntwo\n~~~~\n\nOutro',
    'Intro\n\n```js\none\n``` trailing text\ntwo\n```\n\nOutro',
    'Intro\n\n~~~js\none\n',
]) {
    test(`pasted code retains every body line: ${JSON.stringify(input)}`, () => {
        const expected = marked.lexer(input).find(token => token.type === 'code').text;
        const f = fixture();
        assert.equal(f.mixed(input), true);
        assert.equal(f.editor.querySelector('pre code').textContent, expected);
        if (input.endsWith('Outro')) assert.equal(f.editor.lastChild.textContent, 'Outro');
    });
}

test('the single-block shortcut honors the opening fence length and marker', () => {
    for (const input of ['````js\none\n```\ntwo\n````', '~~~js\none\n```\ntwo\n~~~']) {
        const f = fixture();
        assert.equal(f.single(input), true);
        assert.equal(f.editor.querySelector('code').textContent, marked.lexer(input)[0].text);
    }
});
