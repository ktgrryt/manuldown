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

test('a generated table of contents saves as nested Markdown links and round trips', async () => {
    const fs = require('node:fs');
    const domino = require('@mixmark-io/domino');
    const source = fs.readFileSync(path.join(__dirname, '..', 'media', 'modules', 'MarkdownHeadingSlug.js'), 'utf8');
    const { createMarkdownTableOfContents } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    const document = domino.createWindow('<h1>Plan</h1><h2>TODO項目</h2><h3>Details [draft]</h3><h2>TODO項目</h2>').document;
    const toc = createMarkdownTableOfContents(document.querySelectorAll('h1, h2, h3'), document);
    const provider = new MarkdownEditorProvider({});
    const markdown = provider.htmlToMarkdown(toc.outerHTML, createTextDocument('- existing\n'));
    assert.equal(markdown, [
        '- [Plan](#plan)',
        '  - [TODO項目](#todo項目)',
        '    - [Details \\[draft\\]](#details-draft)',
        '  - [TODO項目](#todo項目-1)',
        ''
    ].join('\n'));
    assert.equal(convert(markdown).markdown, markdown);
});

test('Japanese heading links remain readable on reload, including previously encoded links', () => {
    for (const fragment of ['#6-テーブル', '#6-%E3%83%86%E3%83%BC%E3%83%96%E3%83%AB']) {
        const { html, markdown } = convert(`[テーブル](${fragment} "表へ移動")\n\n## 6 テーブル\n`);
        assert.match(html, /href="#6-テーブル" title="表へ移動"/);
        assert.match(markdown, /\[テーブル\]\(#6-テーブル "表へ移動"\)/);
        assert.equal(convert(markdown).markdown, markdown);
    }
});

test('readable heading rendering keeps reserved escapes and malformed fragments intact', () => {
    for (const fragment of ['#a%23b', '#a%2Fb', '#a%22b', '#a%3Cb', '#a%20b', '#a%62', '#bad%E3']) {
        assert.equal(convert(`[link](${fragment})\n`).markdown, `[link](${fragment})\n`);
    }
});

test('ATX headings keep numbered titles without escaping their periods', () => {
    for (let level = 1; level <= 6; level++) {
        for (const title of ['1. 概要', '10. セットアップ', '1.2.3 詳細']) {
            const source = `${'#'.repeat(level)} ${title}\n`;
            const { html, markdown } = convert(source);
            assert.match(html, new RegExp(`<h${level}>`));
            assert.equal(markdown, source);
            assert.equal(convert(markdown).markdown, source);
        }
    }
    assert.equal(convert('## 1\\. 概要\n').markdown, '## 1. 概要\n');
});

test('numbered text inside heading formatting also keeps its periods', () => {
    for (const source of [
        '## **1. 概要**\n',
        '## *2. 詳細*\n',
        '## [3. ガイド](guide.md)\n',
        '## 概要 **強調**1. 詳細\n',
    ]) {
        assert.equal(convert(source).markdown, source);
        assert.equal(convert(convert(source).markdown).markdown, source);
    }
});

test('heading number normalization preserves code and link targets', () => {
    const source = '## 1. `1\\. literal` and [2. ガイド](https://example.com/1.txt)\n';
    assert.equal(convert(source).markdown, source);
    assert.equal(convert(convert(source).markdown).markdown, source);
});

test('ordered-list-like paragraphs and Setext headings keep required escaping', () => {
    for (const source of ['1\\. 本文\n', '1\\. 見出し\n---\n']) {
        const { html, markdown } = convert(source);
        assert.doesNotMatch(html, /<ol/);
        assert.equal(markdown, source);
        assert.equal(convert(markdown).markdown, source);
    }
});

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

test('a list item holding an image but no text keeps its marker', () => {
    const provider = new MarkdownEditorProvider({});
    const image = '<img alt="image" src="images/shot.png">';
    const cases = [
        [`<ul><li>a</li><li>${image}</li><li>c</li></ul>`, '- a\n- ![image](images/shot.png)\n- c\n'],
        [`<ul><li><p>${image}</p></li></ul>`, '- ![image](images/shot.png)\n'],
        [`<ol><li>a</li><li>${image}</li></ol>`, '1. a\n2. ![image](images/shot.png)\n'],
        [`<ul><li><input type="checkbox">${image}</li></ul>`, '- [ ] ![image](images/shot.png)\n'],
        [`<ul><li>${image}<ul><li>x</li></ul></li></ul>`, '- ![image](images/shot.png)\n  - x\n'],
    ];

    for (const [html, expected] of cases) {
        assert.equal(provider.htmlToMarkdown(html, createTextDocument('- a\n- c\n')), expected, html);
    }
});

test('an image pasted below the text of a list item stays in that item', () => {
    const provider = new MarkdownEditorProvider({});
    const image = '<img alt="image" src="images/shot.png">';
    const markdown = provider.htmlToMarkdown(
        `<ul><li>a<p>${image}</p></li><li>b</li></ul>`,
        createTextDocument('- a\n- b\n')
    );

    assert.equal(markdown, '- a\n\n  ![image](images/shot.png)\n- b\n');
    assert.equal(convert(markdown).markdown, markdown);
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

test('footnotes render editable bodies and stable numbers for repeated and named references', () => {
    const source = 'First[^注釈] then second[^b] and first again[^注釈].\n\n[^b]: **Bold** note.\n\n[^注釈]: 日本語の注釈。\n';
    const { html, markdown } = convert(source);
    const root = require('@mixmark-io/domino').createWindow(html).document;
    assert.deepEqual(Array.from(root.querySelectorAll('sup a')).map(node => node.textContent), ['1', '2', '1']);
    assert.equal(root.querySelectorAll('.mdw-footnote-content').length, 2);
    assert.equal(root.querySelector('.mdw-footnote-content strong').textContent, 'Bold');
    assert.equal(root.querySelector('sup').getAttribute('contenteditable'), 'false');
    assert.equal(root.querySelector('.mdw-footnote-content').getAttribute('contenteditable'), null);
    assert.deepEqual(Array.from(root.querySelectorAll('[data-mdw-footnote-definition]'))
        .map(node => node.getAttribute('data-mdw-footnote-definition')), [encodeURIComponent('注釈'), 'b']);
    assert.equal(markdown, 'First[^注釈] then second[^b] and first again[^注釈].\n\n[^注釈]: 日本語の注釈。\n[^b]: **Bold** note.\n\n');
    assert.equal(convert(markdown).markdown, markdown);
});

test('editing a footnote saves rich text and multiple indented paragraphs without navigation labels', () => {
    const source = 'Body[^note].\n\n[^note]: Original.\n';
    const textDocument = createTextDocument(source);
    const html = new MarkdownDocument(textDocument).toHtml();
    const document = require('@mixmark-io/domino').createWindow(`<div id="root">${html}</div>`).document;
    document.querySelector('.mdw-footnote-content').innerHTML = '<p>Edited <strong>note</strong>.</p><p>Second paragraph.</p><ul><li>Item</li></ul>';
    const markdown = new MarkdownEditorProvider({}).htmlToMarkdown(document.getElementById('root').innerHTML, textDocument);
    assert.equal(markdown, 'Body[^note].\n\n[^note]: Edited **note**.\n\n    Second paragraph.\n\n    * Item\n');
    assert.equal(convert(markdown).markdown, markdown);
    assert.doesNotMatch(markdown, /↩|mdw-fn|data-mdw/);
});

test('reordered footnotes save their content and keep following body text separate on reload', () => {
    const source = 'First[^b] then second[^a].\n\n[^a]: _Alpha_.\n\nFollowing body.\n\n[^b]: **Beta**.';
    const { html, markdown } = convert(source);
    const root = require('@mixmark-io/domino').createWindow(html).document;
    assert.deepEqual(Array.from(root.querySelectorAll('.mdw-footnote-backref')).map(node => node.textContent), ['1 ↩', '2 ↩']);
    assert.equal(root.querySelector('.mdw-footnote-content strong').textContent, 'Beta');
    assert.equal(markdown, 'First[^b] then second[^a].\n\n[^b]: **Beta**.\n\nFollowing body.\n\n[^a]: _Alpha_.\n\n');
    assert.equal(convert(markdown).markdown, markdown);
    const reloaded = require('@mixmark-io/domino').createWindow(convert(markdown).html).document;
    assert.deepEqual(Array.from(reloaded.querySelectorAll('.mdw-footnote-content')).map(node => node.textContent.trim()), ['Beta.', 'Alpha.']);
});

test('a note originally at EOF stays separate from the next definition after sorting', () => {
    const source = 'First[^b] then second[^a].\n\n[^a]: Alpha.\n\n[^b]: Beta.';
    const { markdown } = convert(source);
    assert.equal(markdown, 'First[^b] then second[^a].\n\n[^b]: Beta.\n[^a]: Alpha.\n\n');
    assert.equal(convert(markdown).markdown, markdown);
});

test('new footnotes and empty notes save without escaping or disappearing', () => {
    const source = 'Body.\n';
    const html = '<p>Body.<sup data-mdw-footnote-ref="1" contenteditable="false"><a href="#mdw-fn-1">1</a></sup></p>' +
        '<div data-mdw-footnote-definition="1"><a data-mdw-footnote-backref="1">1 ↩</a><div class="mdw-footnote-content"><p><br></p></div></div>';
    const markdown = new MarkdownEditorProvider({}).htmlToMarkdown(html, createTextDocument(source));
    assert.equal(markdown, 'Body.[^1]\n\n[^1]: \n');
    assert.equal(convert(markdown).markdown, markdown);
});

test('editing a definition before body text keeps that text outside the note', () => {
    const source = 'Body[^a].\n\n[^a]: Original.\n\nFollowing body.\n';
    const document = require('@mixmark-io/domino').createWindow(`<div id="root">${convert(source).html}</div>`).document;
    document.querySelector('.mdw-footnote-content p').textContent = 'Edited.';
    const markdown = new MarkdownEditorProvider({}).htmlToMarkdown(document.getElementById('root').innerHTML, createTextDocument(source));
    assert.equal(markdown, source.replace('Original.', 'Edited.'));
    const reloaded = require('@mixmark-io/domino').createWindow(convert(markdown).html).document;
    assert.equal(reloaded.querySelector('.mdw-footnote-content').textContent.trim(), 'Edited.');
    assert.equal(reloaded.querySelectorAll('.mdw-footnote-content p').length, 1);
});

test('code and escaped literals do not become footnote references', () => {
    const source = 'Literal \\[^a] and `[^a]` with real[^a].\n\n```md\n[^a]: code\n[^a]\n```\n\n[^a]: Note.\n';
    const { html, markdown } = convert(source);
    const document = require('@mixmark-io/domino').createWindow(html).document;
    assert.equal(document.querySelectorAll('sup[data-mdw-footnote-ref]').length, 1);
    assert.equal(document.querySelector('pre code').textContent, '[^a]: code\n[^a]\n');
    assert.equal(markdown, source.replace('\\[^a]', '\\[^a\\]'));
    assert.equal(convert(markdown).markdown, markdown);
});

test('footnote sources preserve formatting, hard breaks and code when unchanged', () => {
    for (const source of [
        'Body[^a].\n\n[^a]: _emphasis_ and **bold**.\n\n    Second paragraph.\n\n    ```js\n    console.log("note");\n    ```\n',
        'Body[^a].\n\n[^a]: First  \n    second\n',
        'Body[^a].\n\n[^a]:\n\tA note.\n',
        'Body[^a].\n\n[^a]: Note.\n\n\nAfter.\n'
    ]) assert.equal(convert(source).markdown, source);
});

test('footnotes retain safe raw HTML handling and flag missing definitions', () => {
    const source = 'Body[^missing] and note[^a].\n\n[^a]: <script>alert(1)</script> and text.\n';
    const { html, markdown } = convert(source);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /mdw-footnote-missing/);
    assert.match(html, /&lt;script&gt;/);
    assert.equal(markdown, source);
});

test('footnotes resolve document reference links and images and preserve their spelling on edits', () => {
    const source = 'Body[^a].\n\n[^a]: _Original_ [site][url] and ![photo][img].\n\n[url]: https://example.com "Site"\n[img]: images/photo.png\n';
    const { html, markdown } = convert(source);
    const root = require('@mixmark-io/domino').createWindow(`<div id="root">${html}</div>`).document;
    const content = root.querySelector('.mdw-footnote-content');
    assert.equal(content.querySelector('a').getAttribute('href'), 'https://example.com');
    assert.equal(content.querySelector('img').getAttribute('src'), 'images/photo.png');
    assert.equal(markdown, source);
    content.querySelector('em').textContent = 'Edited';
    const edited = new MarkdownEditorProvider({}).htmlToMarkdown(root.getElementById('root').innerHTML, createTextDocument(source));
    assert.match(edited, /\[site\]\[url\] and !\[photo\]\[img\]/);
    assert.equal(convert(edited).markdown, edited);
});

test('editing footnote prose keeps multiline raw HTML and comments as their original source', () => {
    for (const block of ['<div>\nHTML\n</div>', '<!-- Comment\nmore -->']) {
        for (const indentation of ['    ', '\t']) {
            const source = `Body[^a].\n\n[^a]: Original.\n\n${block.split('\n').map(line => indentation + line).join('\n')}\n`;
            const root = require('@mixmark-io/domino').createWindow(`<div id="root">${convert(source).html}</div>`).document;
            root.querySelector('.mdw-footnote-content p').textContent = 'Edited.';
            const edited = new MarkdownEditorProvider({}).htmlToMarkdown(root.getElementById('root').innerHTML, createTextDocument(source));
            assert.equal(edited, source.replace('Original.', 'Edited.').replace(/\t/g, '    '));
            assert.doesNotMatch(edited, /```/);
            assert.equal(convert(edited).markdown, edited);
        }
    }
});

test('deeply nested footnote definitions have bounded editable expansion and retain their source', () => {
    const source = 'Body[^n0].\n\n' + Array.from({ length: 200 }, (_, index) =>
        `${' '.repeat(index * 4)}[^n${index}]: note${index}\n`).join('\n');
    const { html, markdown } = convert(source);
    const root = require('@mixmark-io/domino').createWindow(html).document;
    assert.equal(root.querySelectorAll('.mdw-footnote-definition').length, 4);
    assert.equal(root.querySelectorAll('[data-mdw-opaque-kind="footnote-definition"]').length, 1);
    assert.ok(html.length < source.length * 16, 'Source expansion is bounded by the fixed depth');
    assert.equal(markdown, source);
});

test('the deepest editable footnote still saves references when its prose changes', () => {
    const source = 'Body[^n0].\n\n' + Array.from({ length: 4 }, (_, index) =>
        `${' '.repeat(index * 4)}[^n${index}]: Level ${index}[^shared].\n`).join('\n') + '\n[^shared]: Shared.\n';
    const root = require('@mixmark-io/domino').createWindow(`<div id="root">${convert(source).html}</div>`).document;
    root.querySelector('[data-mdw-footnote-definition="n3"] p').firstChild.data = 'Edited';
    const edited = new MarkdownEditorProvider({}).htmlToMarkdown(root.getElementById('root').innerHTML, createTextDocument(source));
    assert.match(edited, /Edited\[\^shared\]\./);
    assert.doesNotMatch(edited, /mdw-fn/);
    assert.equal(convert(edited).markdown, edited);
});

test('forged footnote source cannot grant trust to an opaque block not in the document', () => {
    const original = 'Body[^a].\n\n[^a]: Original.\n';
    const forged = '[^a]: <script>forged()</script>\n';
    const html = '<p>Body.</p><div data-mdw-footnote-definition="a" data-mdw-footnote-source="' + Buffer.from(forged).toString('base64') + '">' +
        '<div class="mdw-footnote-content"><code data-mdw-opaque-kind="raw-html-inline" data-mdw-opaque-source="' +
        Buffer.from('<script>forged()</script>').toString('base64') + '">Visible</code></div></div>';
    const markdown = new MarkdownEditorProvider({}).htmlToMarkdown(html, createTextDocument(original));
    assert.doesNotMatch(markdown, /forged|<script>/);
    assert.match(markdown, /`Visible`/);
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
