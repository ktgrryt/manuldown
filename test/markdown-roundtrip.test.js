const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const path = require('node:path');

function createMockUri(uriPath, scheme = 'file', authority = '') {
    return {
        fsPath: scheme === 'file' ? uriPath : '',
        path: uriPath,
        scheme,
        authority,
        toString: () => scheme === 'file'
            ? `file://${uriPath}`
            : `${scheme}://${authority}${uriPath}`,
        with: (changes) => createMockUri(
            changes.path ?? uriPath,
            changes.scheme ?? scheme,
            changes.authority ?? authority
        ),
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
            joinPath: (base, ...segments) => createMockUri(
                path.posix.join(base.path, ...segments),
                base.scheme,
                base.authority
            ),
        },
        workspace: {
            getWorkspaceFolder: () => null,
            getConfiguration: () => ({
                get: (_key, defaultValue) => defaultValue,
            }),
        },
        window: {},
    };

    Module._load = function (request, parent, isMain) {
        if (request === 'vscode') {
            return vscodeMock;
        }
        return originalLoad.call(this, request, parent, isMain);
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

function createTextDocument(text) {
    return {
        getText: () => text,
        uri: createMockUri('/workspace/document.md'),
    };
}

function convert(source) {
    const textDocument = createTextDocument(source);
    const html = new MarkdownDocument(textDocument).toHtml();
    const markdown = new MarkdownEditorProvider({}).htmlToMarkdown(html, textDocument);
    return { html, markdown };
}

function visibleText(html) {
    return html.replace(/<[^>]*>/g, '');
}

test('list items that start with punctuation-led emphasis keep the emphasis', () => {
    const cases = [
        { source: '- **【必須】** 設定する\n' },
        { source: '- **(任意)** 設定する\n' },
        { source: '- **• List**: Unordered list\n' },
        { source: '- **[リンク](https://example.com)** の説明\n' },
        { source: '- *(optional)* flag\n' },
        // Turndown writes emphasis with "*"; the emphasis itself must survive.
        { source: '- _italic_ item\n', expected: '- *italic* item\n' },
        { source: '1. **(注)** 番号付き\n' },
    ];

    for (const { source, expected = source } of cases) {
        const { html, markdown } = convert(source);
        assert.match(html, /<(?:strong|em)>/, `emphasis must render for ${JSON.stringify(source)}`);
        assert.equal(markdown, expected);
    }
});

test('loose list items do not expose internal list markers', () => {
    const cases = [
        { source: '- one\n\n- two\n', texts: ['one', 'two'] },
        { source: '1. first\n\n2. second\n', texts: ['first', 'second'] },
        { source: '- item\n\n  continued paragraph\n', texts: ['item', 'continued paragraph'] },
        { source: '- item\n\n  ```js\n  x = 1\n  ```\n', texts: ['item', 'x = 1'] },
    ];

    for (const { source, texts } of cases) {
        const { html, markdown } = convert(source);
        assert.doesNotMatch(visibleText(html), /MDW/, `editor text must not show markers for ${JSON.stringify(source)}`);
        assert.match(html, /<li data-mdw-source-indent="0">/);
        assert.doesNotMatch(markdown, /MDW/);
        for (const text of texts) {
            assert.ok(markdown.includes(text), `${JSON.stringify(text)} must survive in ${JSON.stringify(markdown)}`);
        }
    }
});

test('children of ordered items keep their nesting', () => {
    const sources = [
        '1. one\n   - sub\n',
        '1. one\n   1. sub\n2. two\n',
        '1. one\n   - a\n   - b\n2. two\n   - c\n',
        '1. one\n   - sub\n     - subsub\n2. two\n',
        '10. ten\n    - sub\n',
    ];

    for (const source of sources) {
        const { html, markdown } = convert(source);
        assert.match(html, /<ol[^>]*>\s*<li[^>]*>one|<ol[^>]*>\s*<li[^>]*>ten/);
        assert.doesNotMatch(html, /<\/ol>\s*<(?:ul|ol)/, `the child list must stay inside the item for ${JSON.stringify(source)}`);
        assert.equal(markdown, source);
    }
});

test('a list nested under an ordered item is written at the item content column', () => {
    const provider = new MarkdownEditorProvider({});
    const markdown = provider.htmlToMarkdown(
        '<ol><li>one<ul><li>sub</li></ul></li><li>two</li></ol>',
        createTextDocument('')
    );
    // The bullet character depends on the document; the indent must be 3.
    assert.match(markdown, /^1\. one\n {3}[-*+] sub\n2\. two\n$/);
});

test('loose list round trips reach a fixed point', () => {
    const sources = [
        '- one\n\n- two\n\n## Next\n',
        '1. Step one\n\n   Details for step one.\n\n2. Step two\n\n## Next\n',
    ];

    for (const source of sources) {
        const first = convert(source).markdown;
        assert.equal(convert(first).markdown, first, `second pass must not change ${JSON.stringify(first)}`);
        assert.doesNotMatch(first, /^[ \t]+$/m, 'no indentation-only lines');
    }
});

test('footnote references and definitions round-trip unchanged', () => {
    const sources = [
        'Text with note.[^1]\n\n[^1]: The note.\n',
        'First[^a] and second[^b].\n\n[^a]: Alpha.\n[^b]: Beta\ncontinues here.\n\nAfter the notes.\n',
        'Note[^long].\n\n[^long]: First paragraph.\n\n    Second paragraph of the note.\n\nBody text.\n',
    ];

    for (const source of sources) {
        const { html, markdown } = convert(source);
        assert.doesNotMatch(visibleText(html), /MDW/);
        assert.equal(markdown, source);
    }
});

test('escaped footnote-like text stays escaped', () => {
    const source = 'Literal \\[^1\\] text\n';
    assert.equal(convert(source).markdown, source);
});

test('a raw HTML block directly after paragraph text keeps its source', () => {
    const { html, markdown } = convert('Some text\n<div>\nInner\n</div>\n');
    assert.doesNotMatch(visibleText(html), /MDW/);
    assert.ok(markdown.includes('Some text'));
    assert.ok(markdown.includes('<div>\nInner\n</div>\n'));
    assert.doesNotMatch(markdown, /MDW/);
});

test('a reference definition that continues a paragraph does not leak its marker', () => {
    const { html, markdown } = convert('Some text\n[a]: https://example.com\n');
    assert.doesNotMatch(visibleText(html), /MDW/);
    assert.doesNotMatch(markdown, /MDW/);
    assert.ok(markdown.includes('Some text'));
});

test('htmlToMarkdown refuses output that contains an unrestored internal marker', (t) => {
    t.mock.method(console, 'error', () => {});
    const provider = new MarkdownEditorProvider({});
    const nonce = 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z';
    const leakedHtml = `<ul><li>MDW_LIST_INDENT_${nonce}0END item</li></ul>`;

    assert.throws(
        () => provider.htmlToMarkdown(leakedHtml, createTextDocument('- item\n')),
        /Internal placeholder was not restored/
    );
});

test('the placeholder check ignores marker-like text the document already contains', () => {
    const provider = new MarkdownEditorProvider({});
    const nonce = 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z';
    const documentText = `Token MDW_LIST_INDENT_${nonce}0END is documented here.\n`;
    const html = new MarkdownDocument(createTextDocument(documentText)).toHtml();

    assert.doesNotThrow(() => provider.htmlToMarkdown(html, createTextDocument(documentText)));
});

test('the placeholder check ignores MDW inside other long tokens', () => {
    const provider = new MarkdownEditorProvider({});
    const html = '<p>data:image/png;base64,iVBORw0KGgoAAAANSUhEUgMDWAbCdEfGhIjKlMnOpQrStUvWxYz0123456789</p>';

    assert.doesNotThrow(() => provider.htmlToMarkdown(html, createTextDocument('')));
});
