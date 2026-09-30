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

test('text shown literally stays literal: entities and tag-like text', () => {
    const cases = [
        { source: 'Generic &lt;T&gt; type\n' },
        { source: 'Write &amp;copy; to show the code\n' },
        // Tag-like text the document writes as it is stays as it is.
        { source: 'Replace <your-token> and a < b > c\n' },
        { source: '`&copy; <T>` in code\n' },
        { source: 'Use <kbd>Ctrl</kbd>\n' },
    ];
    for (const { source } of cases) {
        assert.equal(convert(source).markdown, source);
    }

    // Text typed in the editor that looks like HTML or an entity.
    const provider = new MarkdownEditorProvider({});
    assert.equal(
        provider.htmlToMarkdown('<p>&lt;div&gt; and &amp;copy;</p>', createTextDocument('')),
        '&lt;div> and &amp;copy;\n'
    );
});

test('fence info strings and non-ASCII link targets keep their spelling', () => {
    const sources = [
        '```js title="a.js"\nx\n```\n',
        '```ts {1,3}\ny\n```\n',
        '[wiki](https://ja.wikipedia.org/wiki/日本)\n',
        '[encoded](https://ja.wikipedia.org/wiki/%E6%97%A5%E6%9C%AC)\n',
    ];
    for (const source of sources) {
        assert.equal(convert(source).markdown, source);
    }

    // After the language is changed in the editor, the old info string is dropped.
    const provider = new MarkdownEditorProvider({});
    assert.equal(
        provider.htmlToMarkdown(
            '<pre><code class="language-ts" data-mdw-code-info="js title=&quot;a.js&quot;">x\n</code></pre>',
            createTextDocument('')
        ),
        '```ts\nx\n```\n'
    );
});

test('empty list items keep their place in the list', () => {
    assert.equal(convert('- a\n- \n- c\n').markdown, '- a\n- \n- c\n');
    assert.equal(convert('1. a\n2.\n3. c\n').markdown, '1. a\n2. \n3. c\n');

    // An empty item made in the editor does not pull the next item under it.
    const provider = new MarkdownEditorProvider({});
    assert.equal(
        provider.htmlToMarkdown('<ul><li>a</li><li><br></li><li>c</li></ul>', createTextDocument('- a\n- c\n')),
        '- a\n- \n- c\n'
    );
});

test('tabs inside fenced code blocks survive the round trip', () => {
    const sources = [
        '```make\nall:\n\tgo build ./...\n```\n',
        '```go\nfunc main() {\n\tif ok {\n\t\treturn\n\t}\n}\n```\n',
        '<div>\n\n```\n\tinside raw html\n```\n\n</div>\n',
    ];

    for (const source of sources) {
        const { html, markdown } = convert(source);
        assert.doesNotMatch(visibleText(html), /MDW/);
        assert.equal(markdown, source);
    }
});

test('table cells that hold only an image keep the image', () => {
    const sources = [
        '| icon | name |\n| --- | --- |\n| ![home](img/home.png) | Home |\n',
        '| badge |\n| --- |\n| [![build](https://example.com/b.svg)](https://example.com) |\n',
        '| a | b |\n| --- | --- |\n|  | 2 |\n',
    ];

    for (const source of sources) {
        assert.equal(convert(source).markdown, source);
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

test('emptied blocks inside lists, quotes and table cells convert without leftover markers', () => {
    const provider = new MarkdownEditorProvider({});
    const cases = [
        {
            html: '<ul><li data-mdw-source-indent="0"><p>a</p></li><li data-mdw-source-indent="0"><p><br></p></li></ul>',
            source: '- a\n\n- b\n',
            expected: /^- a\n- ?\n$/,
        },
        {
            html: '<ol><li data-mdw-source-indent="0"><p>a</p></li><li data-mdw-source-indent="0"><p><br></p></li></ol>',
            source: '1. a\n\n2. b\n',
            expected: /^1\. a\n2\. ?\n$/,
        },
        {
            html: '<ul><li>x<blockquote><p></p></blockquote></li></ul>',
            source: '- x\n',
            expected: /^- x\n\n {2}>\n$/,
        },
        {
            html: '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td><p><br></p></td><td>2</td></tr></tbody></table>',
            source: '| a | b |\n| --- | --- |\n| x | 2 |\n',
            expected: /^\| a \| b \|\n\| --- \| --- \|\n\| +\| 2 \|\n$/,
        },
    ];

    for (const { html, source, expected } of cases) {
        const markdown = provider.htmlToMarkdown(html, createTextDocument(source));
        assert.match(markdown, expected);
        assert.doesNotMatch(markdown, /MDW/);
    }
});

test('an image hard break inside a list item converts without leftover markers', () => {
    const sources = [
        '- ![img](a.png)  \n  text\n',
        '1. ![img](a.png)  \n   caption\n',
        '> - ![img](a.png)  \n>   text\n',
    ];

    for (const source of sources) {
        assert.equal(convert(source).markdown, source);
    }
});

test('an image hard break followed by a blank line does not grow on each round trip', () => {
    const source = '# Title\n\n![image](images/a.png)  \n\n## Features\n';
    const first = convert(source).markdown;
    assert.equal(convert(first).markdown, first);
    assert.doesNotMatch(first, /\n\n\n/);
});

test('newly typed identifiers that start with MDW_ are not mistaken for markers', () => {
    const provider = new MarkdownEditorProvider({});
    const markdown = provider.htmlToMarkdown(
        '<p>MDW_CONFIGURATION_SETTING_FOR_PRODUCTION_ENV</p>',
        createTextDocument('')
    );
    assert.equal(markdown, 'MDW\\_CONFIGURATION\\_SETTING\\_FOR\\_PRODUCTION\\_ENV\n');
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
