const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const domino = require('@mixmark-io/domino');
const { marked } = require('marked');

function loadMarkdownEditorProvider() {
    const originalLoad = Module._load;
    const vscodeMock = {
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
        return require('../out/editor/MarkdownEditorProvider').MarkdownEditorProvider;
    } finally {
        Module._load = originalLoad;
    }
}

const MarkdownEditorProvider = loadMarkdownEditorProvider();
const { MarkdownDocument } = require('../out/editor/MarkdownDocument');
function textDocument(text = '') {
    return {
        getText: () => text,
        uri: { fsPath: '/workspace/document.md', path: '/workspace/document.md', scheme: 'file', authority: '' },
    };
}
function toMarkdown(html) {
    return new MarkdownEditorProvider({}).htmlToMarkdown(html, textDocument());
}
function reopen(html) {
    const markdown = toMarkdown(html);
    return domino.createWindow(new MarkdownDocument(textDocument(markdown)).toHtml()).document;
}

function importModule(fileName) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'media', 'modules', fileName), 'utf8');
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

const markdownConverterModulePromise = importModule('MarkdownConverter.js');
const domUtilsModulePromise = importModule('DOMUtils.js');
const typingUndoGroupModulePromise = importModule('TypingUndoGroup.js');

class CaretRange {
    constructor(container = null, offset = 0) {
        this.startContainer = container;
        this.startOffset = offset;
        this.endContainer = container;
        this.endOffset = offset;
        this.collapsed = true;
    }

    get commonAncestorContainer() {
        return this.startContainer;
    }

    setStart(container, offset) {
        if (!container) {
            throw new TypeError('Range.setStart requires a node');
        }
        this.startContainer = container;
        this.startOffset = offset;
        this.endContainer = container;
        this.endOffset = offset;
    }

    collapse() {
        this.collapsed = true;
    }

    setStartAfter(node) {
        this.setStart(node.parentNode, Array.from(node.parentNode.childNodes).indexOf(node) + 1);
    }
}

// Build an editor from HTML, put the caret at `offset` in the text node that
// `findTextNode` returns, and run convertMarkdownSyntax.
async function convertAt(html, findTextNode, offset, insertedText) {
    const { MarkdownConverter } = await markdownConverterModulePromise;
    const { DOMUtils } = await domUtilsModulePromise;
    const window = domino.createWindow(`<div id="editor">${html}</div>`, 'https://example.test/');
    const document = window.document;
    const editor = document.getElementById('editor');
    const textNode = findTextNode(editor);
    assert.ok(textNode && textNode.nodeType === 3, 'test setup needs a text node');

    let activeRange = new CaretRange(textNode, offset === undefined ? textNode.textContent.length : offset);
    const selection = {
        get rangeCount() {
            return activeRange ? 1 : 0;
        },
        getRangeAt: () => activeRange,
        removeAllRanges: () => {
            activeRange = null;
        },
        addRange: (range) => {
            activeRange = range;
        },
    };
    const previous = {
        window: global.window,
        document: global.document,
        Node: global.Node,
        NodeFilter: global.NodeFilter,
    };
    document.createRange = () => new CaretRange();
    global.window = { getSelection: () => selection };
    global.document = document;
    global.Node = window.Node;
    global.NodeFilter = window.NodeFilter;
    try {
        const converter = new MarkdownConverter(editor, new DOMUtils(editor));
        let notified = 0;
        const converted = converter.convertMarkdownSyntax(() => {
            notified++;
        }, { insertedText });
        return { converted, notified, editor, html: editor.innerHTML, range: activeRange };
    } finally {
        Object.assign(global, previous);
    }
}

// Keep the DOM and the converter's restored selection between native inputs.
// Rebuilding a fresh DOM per prefix misses shortcuts that fire too early and
// split the text node needed to recognize the rest of a construct.
async function typeCharacters(text, { tableCell = false, afterInput = () => {} } = {}) {
    const { MarkdownConverter } = await markdownConverterModulePromise;
    const { DOMUtils } = await domUtilsModulePromise;
    const window = domino.createWindow(`<div id="editor">${tableCell
        ? '<table><thead><tr><th>H</th></tr></thead><tbody><tr><td></td></tr></tbody></table>'
        : '<p></p>'}</div>`);
    const document = window.document;
    const editor = document.getElementById('editor');
    const target = editor.querySelector(tableCell ? 'td' : 'p');
    const initial = document.createTextNode('');
    target.appendChild(initial);
    let range = new CaretRange(initial, 0);
    const selection = {
        get rangeCount() { return range ? 1 : 0; },
        getRangeAt: () => range,
        removeAllRanges: () => { range = null; },
        addRange: next => { range = next; },
    };
    document.createRange = () => new CaretRange();
    const previous = { window: global.window, document: global.document, Node: global.Node, NodeFilter: global.NodeFilter };
    Object.assign(global, { window: { getSelection: () => selection }, document, Node: window.Node, NodeFilter: window.NodeFilter });
    try {
        const converter = new MarkdownConverter(editor, new DOMUtils(editor));
        let typed = '';
        for (const character of text) {
            const node = range.startContainer;
            const offset = range.startOffset;
            if (node.nodeType === Node.TEXT_NODE) {
                node.insertData(offset, character);
                range.setStart(node, offset + character.length);
            } else {
                const inserted = document.createTextNode(character);
                node.insertBefore(inserted, node.childNodes[offset] || null);
                range.setStart(inserted, character.length);
            }
            typed += character;
            const converted = converter.convertMarkdownSyntax(() => {}, { insertedText: character });
            afterInput({ typed, converted, editor, target });
        }
        return { editor, target, html: editor.innerHTML, range };
    } finally {
        Object.assign(global, previous);
    }
}

const lastTextNode = (root) => {
    let found = null;
    const visit = (node) => {
        for (const child of Array.from(node.childNodes)) {
            if (child.nodeType === 3) {
                found = child;
            }
            visit(child);
        }
    };
    visit(root);
    return found;
};

test('a list marker later in an item does not replace the item', async () => {
    const html = '<ul><li><code>--flag</code> - desc<ul><li>child</li></ul></li></ul>';
    const result = await convertAt(
        html,
        (editor) => editor.querySelector('li').childNodes[1],
        undefined,
        'c'
    );
    assert.equal(result.converted, false);
    assert.equal(result.html, html);
});

test('a quote marker after inline code does not split the paragraph', async () => {
    const html = '<p><code>x</code> &gt; 5</p>';
    const result = await convertAt(html, (editor) => editor.querySelector('p').lastChild, undefined, '5');
    assert.equal(result.converted, false);
    assert.equal(result.html, html);
});

test('a heading needs a marker the user just typed', async () => {
    // An escaped "\# foo" renders as the text "# foo"; typing at its end keeps it text.
    const literal = await convertAt('<p># foo</p>', (editor) => editor.querySelector('p').firstChild, undefined, 'o');
    assert.equal(literal.converted, false);
    assert.equal(literal.html, '<p># foo</p>');

    const typed = await convertAt('<p># a</p>', (editor) => editor.querySelector('p').firstChild, undefined, 'a');
    assert.equal(typed.converted, true);
    assert.equal(typed.html, '<h1>a</h1>');

    // An IME commit after "# " converts too.
    const composed = await convertAt('<p># 見出し</p>', (editor) => editor.querySelector('p').firstChild, undefined, '見出し');
    assert.equal(composed.converted, true);
    assert.equal(composed.html, '<h1>見出し</h1>');
});

test('heading and quote shortcuts keep the rich inline content of their line', async () => {
    const rich = '<strong>world</strong> <a href="./note.md">link</a> <img src="image.png" alt="diagram">';
    for (const [marker, selector] of [['#', 'h1'], ['>', 'blockquote p']]) {
        for (const text of ['hello\u00a0', '']) {
            let originalStrong;
            let originalImage;
            const html = `<p>before<br>${marker} ${text}${rich}<br>after</p>`;
            const result = await convertAt(html, editor => {
                originalStrong = editor.querySelector('strong');
                originalImage = editor.querySelector('img');
                return editor.querySelector('p').childNodes[2];
            }, marker.length + 1, ' ');
            assert.equal(result.converted, true, html);
            const block = result.editor.querySelector(selector);
            assert.ok(block.querySelector('strong') === originalStrong, 'bold content stays in the converted block');
            assert.ok(block.querySelector('img') === originalImage, 'the image stays in the converted block');
            assert.equal(block.textContent, text + 'world link ');
            assert.equal(result.editor.firstElementChild.outerHTML, '<p>before</p>');
            assert.equal(result.editor.lastElementChild.outerHTML, '<p>after</p>');
            assert.equal(result.range.startContainer, block.firstChild);
            assert.equal(result.range.startOffset, 0);
            assert.equal(toMarkdown(result.html),
                `before\n\n${marker} ${text}**world** [link](./note.md) ![diagram](image.png)\n\nafter\n`);
        }
    }
});

test('new ordered list shortcuts preserve their starting number when saved', async () => {
    for (const number of [0, 1, 3, 10]) {
        const marker = `${number}. `;
        const result = await convertAt(`<p>${marker}item</p>`, editor => editor.querySelector('p').firstChild,
            marker.length, ' ');
        assert.equal(result.converted, true);
        assert.equal(Number(result.editor.querySelector('ol').getAttribute('start') ?? 1), number);
        assert.equal(toMarkdown(result.html), `${number}. item\n`);
    }

    const converted = await convertAt('<ul><li>before</li><li>3. item</li><li>after</li></ul>',
        editor => editor.querySelectorAll('li')[1].firstChild, 3, ' ');
    assert.equal(converted.editor.querySelector('ol').getAttribute('start'), '3');
    assert.match(toMarkdown(converted.html), /(?:^|\n)3\. item(?:\n|$)/);

    const existing = await convertAt('<ol start="7"><li>3. item</li></ol>',
        editor => editor.querySelector('li').firstChild, 3, ' ');
    assert.equal(existing.editor.querySelector('ol').getAttribute('start'), '7');
    assert.equal(toMarkdown(existing.html), '7. item\n');

    const adjacent = await convertAt('<ol start="7"><li>before</li></ol><p>3. item</p>',
        editor => editor.querySelector('p').firstChild, 3, ' ');
    assert.equal(adjacent.editor.querySelectorAll('ol').length, 2);
    assert.equal(toMarkdown(adjacent.html), '7. before\n\n3. item\n');
});

test('shortcuts never fire inside code', async () => {
    for (const html of ['<p><code># title</code></p>', '<p><code>- item</code></p>', '<p><code>---</code></p>']) {
        const result = await convertAt(html, (editor) => editor.querySelector('code').firstChild, undefined, 'x');
        assert.equal(result.converted, false, html);
        assert.equal(result.html, html);
    }
    const codeBlock = '<pre><code class="language-python"># comment</code></pre>';
    const result = await convertAt(codeBlock, (editor) => editor.querySelector('code').firstChild, undefined, 't');
    assert.equal(result.converted, false);
    assert.equal(result.html, codeBlock);
});

test('typing inline code preserves its literal content until a matching backtick run closes', async () => {
    const before = 'Before\u00a0';
    const after = '\u00a0after';
    for (const tableCell of [false, true]) {
        for (const [delimiter, body, expected] of [
            ['`', '*value* **bold** ~~gone~~ $x$ \\*literal\\*', '*value* **bold** ~~gone~~ $x$ \\*literal\\*'],
            ['`', '[x](https://example.test "Title") https://example.test ', '[x](https://example.test "Title") https://example.test '],
            ['``', 'a`b', 'a`b'],
            ['```', 'a``b `c` d', 'a``b `c` d'],
            ['``', ' `quoted` ', '`quoted`'],
        ]) {
            const syntax = delimiter + body + delimiter;
            const end = before.length + syntax.length;
            const result = await typeCharacters(before + syntax + after, {
                tableCell,
                afterInput({ typed, converted, target }) {
                    if (typed.length < end) {
                        assert.equal(converted, false, typed);
                        assert.equal(target.textContent, typed);
                        assert.ok(!target.querySelector('code,a,strong,em,del,span'), typed);
                    }
                },
            });
            assert.equal(result.target.querySelector('code').textContent, expected, syntax);
            assert.equal(result.target.firstChild.textContent, before);
            assert.equal(result.target.lastChild.textContent, after);
            const reloaded = reopen(result.html);
            assert.equal(reloaded.querySelector('code').textContent, expected, syntax);
            assert.equal(reloaded.querySelector(tableCell ? 'td' : 'p').textContent, before + expected + after);
        }
    }
});

test('typing link and image titles waits until their entire destination has closed', async () => {
    const before = 'Before\u00a0';
    const after = '\u00a0after';
    for (const tableCell of [false, true]) {
        for (const [marker, tag, attribute] of [['', 'a', 'href'], ['!', 'img', 'src']]) {
            for (const [destination, titleSyntax, title] of [
                ['https://example.test/a(b)', '"Title (detail)"', 'Title (detail)'],
                ['https://example.test', "'Title *detail* `code`'", 'Title *detail* `code`'],
                [' <https://example.test/a)b>', '"Title \\(detail\\)"', 'Title (detail)'],
            ]) {
                const syntax = `${marker}[x](${destination} ${titleSyntax})`;
                const end = before.length + syntax.length;
                const result = await typeCharacters(before + syntax + after, {
                    tableCell,
                    afterInput({ typed, converted, target }) {
                        if (typed.length < end) {
                            assert.equal(converted, false, typed);
                            assert.equal(target.textContent, typed);
                            assert.ok(!target.querySelector('a,img,code,strong,em,span'), typed);
                        }
                    },
                });
                const expectedDestination = destination.trim().replace(/^<|>$/g, '');
                const node = result.target.querySelector(tag);
                assert.equal(node.getAttribute(attribute), expectedDestination);
                assert.equal(node.getAttribute('title'), title);
                assert.equal(result.target.firstChild.textContent, before);
                assert.equal(result.target.lastChild.textContent, after);
                const reloaded = reopen(result.html).querySelector(tag);
                assert.equal(reloaded.getAttribute(attribute), expectedDestination);
                assert.equal(reloaded.getAttribute('title'), title);
            }
        }
    }
});

test('code context detection preserves block shortcuts and math containing backticks', async () => {
    for (const [marker, selector] of [['# ', 'h1'], ['- ', 'li'], ['3. ', 'li'], ['> ', 'blockquote p']]) {
        const result = await typeCharacters(marker + '`code`');
        const block = result.editor.querySelector(selector);
        assert.ok(block, marker);
        assert.equal(block.querySelector('code').textContent, 'code');
        assert.equal(reopen(result.html).querySelector(selector).querySelector('code').textContent, 'code');
    }
    const currency = await typeCharacters('cost $5 and `code`');
    assert.equal(currency.target.querySelector('code').textContent, 'code');
    assert.equal(reopen(currency.html).querySelector('code').textContent, 'code');
    for (const tableCell of [false, true]) {
        for (const tex of ['a`b', "\\text{`quoted'}"]) {
            const result = await typeCharacters('$' + tex + '$', { tableCell });
            const math = result.target.querySelector('[data-mdw-math="inline"]');
            assert.ok(math, tex);
            assert.equal(math.textContent, tex);
            assert.equal(reopen(result.html).querySelector('[data-mdw-math="inline"]').textContent, tex);
        }
    }
});

test('typing an escaped block marker keeps it literal when the next space is typed', async () => {
    for (const marker of ['-', '*', '#', '>']) {
        const escaped = await convertAt(`<p>\\${marker}</p>`, editor => editor.querySelector('p').firstChild, undefined, marker);
        assert.equal(escaped.converted, true);
        assert.equal(escaped.editor.querySelector('[data-mdw-escaped-character]').textContent, marker);
        const continued = await convertAt(escaped.html.replace('</p>', ' </p>'),
            editor => editor.querySelector('p').lastChild, undefined, ' ');
        assert.equal(continued.converted, false);
        assert.equal(continued.editor.querySelector('p').textContent, marker + ' ');
        assert.ok(!continued.editor.querySelector('ul,h1,blockquote'));
    }
});

test('continuing to type inside an escaped-character span never turns it into formatting', async () => {
    const html = '<p><span data-mdw-escaped-character="true">*literal*</span></p>';
    const result = await convertAt(html, editor => editor.querySelector('span').firstChild, undefined, '*');
    assert.equal(result.converted, false);
    assert.equal(result.html, html);
});

test('inline shortcuts keep user zero-width characters in the prefix and formatted content', async () => {
    const prefix = 'a\u200bb\u2060c\ufeffd ';
    const body = 'x\u200by\u2060z';
    for (const [delimiter, tag] of [['**', 'strong'], ['*', 'em'], ['`', 'code']]) {
        const result = await convertAt(`<p>${prefix}${delimiter}${body}${delimiter}</p>`,
            editor => editor.querySelector('p').firstChild, undefined, delimiter.slice(-1));
        assert.equal(result.converted, true);
        assert.equal(result.editor.querySelector('p').firstChild.textContent, prefix);
        assert.equal(result.editor.querySelector(tag).textContent, body);
    }
});

test('pasted list parsing preserves invisible characters in the item content', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'media/editor.js'), 'utf8');
    const start = source.indexOf('        const clipboardVariationSelectorPattern =');
    const end = source.indexOf('        const pastedTextLooksLikeList =', start);
    const parse = new Function(`${source.slice(start, end)}\nreturn parsePastedListLine;`)();
    const text = '\u200ba\u2060b\u200dc\ufeff';
    for (const marker of ['-', '•', '1.']) {
        assert.equal(parse(`${marker} ${text}`).content, text);
        assert.equal(parse(`\u200b${marker} ${text}`).content, text);
    }
});

test('--- on a later line of a paragraph keeps the earlier line', async () => {
    const result = await convertAt('<p>foo<br>---</p>', (editor) => editor.querySelector('p').lastChild, undefined, '-');
    assert.equal(result.converted, true);
    assert.match(result.html, /^<p>foo<\/p><hr>/);
});

test('--- stays text inside a list item', async () => {
    const html = '<ul><li>---<ul><li>child</li></ul></li></ul>';
    const result = await convertAt(html, (editor) => editor.querySelector('li').firstChild, undefined, '-');
    assert.equal(result.converted, false);
    assert.equal(result.html, html);
});

test('typing a list marker at the start of an item keeps its other content', async () => {
    const ordered = await convertAt(
        '<ol><li>- text<strong>b</strong><ul><li>child</li></ul></li></ol>',
        (editor) => editor.querySelector('li').firstChild,
        2,
        ' '
    );
    assert.equal(ordered.converted, true);
    assert.equal(ordered.html, '<ul><li>text<strong>b</strong><ul><li>child</li></ul></li></ul>');

    const bullet = await convertAt(
        '<ul><li>- text<strong>b</strong></li></ul>',
        (editor) => editor.querySelector('li').firstChild,
        2,
        ' '
    );
    assert.equal(bullet.converted, true);
    assert.equal(bullet.html, '<ul><li>text<strong>b</strong></li></ul>');
});

test('typing a list marker at an image left edge keeps the image in the new item', async () => {
    const imageHtml = '<img src="display.png" data-md-path="images/original.png" alt="diagram|240x120">';
    for (const [marker, tag, task] of [['- ', 'ul', false], ['* ', 'ul', false], ['-\u00a0', 'ul', false],
        ['1. ', 'ol', false], ['- [ ] ', 'ul', true], ['- [x] ', 'ul', true]]) {
        let originalImage;
        const result = await convertAt(`<p>before</p><p>${marker}${imageHtml}</p><p>after</p>`, editor => {
            originalImage = editor.querySelector('img');
            return editor.querySelectorAll('p')[1].firstChild;
        }, marker.length, marker.slice(-1));
        assert.equal(result.converted, true, marker);
        assert.equal(result.notified, 1);
        const list = result.editor.children[1];
        const item = list.firstElementChild;
        assert.equal(list.tagName, tag.toUpperCase());
        assert.ok(originalImage.parentElement === item, result.html);
        assert.equal(originalImage.outerHTML, imageHtml);
        assert.equal(result.editor.children.length, 3);
        assert.equal(result.editor.firstElementChild.textContent, 'before');
        assert.equal(result.editor.lastElementChild.textContent, 'after');
        assert.equal(item.querySelectorAll('input[type="checkbox"]').length, task ? 1 : 0);
        assert.ok(item.contains(result.range.startContainer));
        assert.equal(result.range.startOffset, 0);
        assert.ok(result.range.startContainer.nextSibling === originalImage);
    }
});

test('a list shortcut takes the image and its link without moving surrounding lines', async () => {
    const linkedImage = '<a href="https://example.test"><img src="image.png" alt="diagram"></a>';
    const result = await convertAt(`<p>before<br>- ${linkedImage} caption<br>after</p>`,
        editor => editor.querySelector('p').childNodes[2], 2, ' ');
    assert.equal(result.converted, true);
    assert.equal(result.html, `<p>before</p><ul><li>${linkedImage} caption</li></ul><p>after</p>`);
});

test('bold and italic conversion completes and keeps the preceding text', async () => {
    const bold = await convertAt('<p>a  **bold**</p>', (editor) => editor.querySelector('p').firstChild, undefined, '*');
    assert.equal(bold.converted, true);
    assert.equal(bold.notified, 1);
    assert.equal(bold.html, '<p>a&nbsp; <strong>bold</strong> </p>');

    const italic = await convertAt('<p>an *em*</p>', (editor) => editor.querySelector('p').firstChild, undefined, '*');
    assert.equal(italic.converted, true);
    assert.equal(italic.html, '<p>an <em>em</em> </p>');
});

test('inline shortcuts preserve NBSP in surrounding text and formatted labels', async () => {
    const prefix = 'Hello\u00a0world ';
    const suffix = '\u00a0after\u00a0text';
    for (const [syntax, tag, body] of [
        ['[a\u00a0b](https://example.test)', 'a', 'a\u00a0b'],
        ['![a\u00a0b](image.png)', 'img', 'a\u00a0b'],
        ['`a\u00a0b`', 'code', 'a b'],
    ]) {
        const result = await convertAt(`<p>${prefix}${syntax}${suffix}</p>`,
            editor => editor.querySelector('p').firstChild, prefix.length + syntax.length, syntax.slice(-1));
        assert.equal(result.converted, true);
        const paragraph = result.editor.querySelector('p');
        assert.equal(paragraph.firstChild.textContent, prefix);
        assert.equal(paragraph.lastChild.textContent, suffix);
        const formatted = paragraph.querySelector(tag);
        assert.equal(tag === 'img' ? formatted.getAttribute('alt') : formatted.textContent, body);
    }
    const autoLink = await convertAt(`<p>${prefix}https://example.test\u00a0${suffix}</p>`,
        editor => editor.querySelector('p').firstChild, prefix.length + 'https://example.test\u00a0'.length, '\u00a0');
    assert.equal(autoLink.converted, true);
    assert.equal(autoLink.editor.querySelector('p').firstChild.textContent, prefix);
    assert.equal(autoLink.editor.querySelector('p').lastChild.textContent, suffix);
});

test('block shortcuts preserve NBSP in content and accept it after the marker', async () => {
    for (const [marker, tag] of [['#', 'h1'], ['-', 'li'], ['1.', 'li'], ['>', 'blockquote p']]) {
        const result = await convertAt(`<p>${marker}\u00a0Hello\u00a0world</p>`,
            editor => editor.querySelector('p').firstChild, marker.length + 1, '\u00a0');
        assert.equal(result.converted, true);
        assert.equal(result.editor.querySelector(tag).textContent, 'Hello\u00a0world');
    }
});

test('link and image shortcuts wait for balanced parentheses in their destination', async () => {
    const first = editor => editor.querySelector('p').firstChild;
    for (const [prefix, tag, attribute] of [['', 'a', 'href'], ['!', 'img', 'src']]) {
        for (const destination of [
            'https://en.wikipedia.org/wiki/Function_(mathematics)',
            'https://example.test/a(b(c))',
        ]) {
            const incomplete = `${prefix}[x](${destination}`;
            const pending = await convertAt(`<p>${incomplete}</p>`, first, undefined, ')');
            assert.equal(pending.converted, false, incomplete);
            assert.equal(pending.editor.querySelector('p').textContent, incomplete);
            const complete = await convertAt(`<p>${incomplete})</p>`, first, undefined, ')');
            assert.equal(complete.converted, true);
            assert.equal(complete.editor.querySelector(tag).getAttribute(attribute), destination);
        }
        for (const [target, expected] of [
            ['https://example.test/a\\(b\\)', 'https://example.test/a(b)'],
            ['<https://example.test/a(b)>', 'https://example.test/a(b)'],
            ['https://example.test/a(b) "Title (detail)"', 'https://example.test/a(b)'],
        ]) {
            const result = await convertAt(`<p>${prefix}[x](${target.replace(/</g, '&lt;').replace(/>/g, '&gt;')})</p>`,
                first, undefined, ')');
            assert.equal(result.converted, true, target);
            assert.equal(result.editor.querySelector(tag).getAttribute(attribute), expected);
        }
    }
});

test('link and image shortcuts preserve quoted titles through Markdown saving', async () => {
    const before = 'Hello\u00a0world ';
    const after = '\u00a0after\u00a0text';
    const title = 'Title (detail)';
    const destination = 'https://example.test/a(b)';
    for (const [marker, tag, attribute] of [['', 'a', 'href'], ['!', 'img', 'src']]) {
        for (const quote of ['"', "'"]) {
            for (const target of [destination, `<${destination}>`]) {
                const syntax = `${marker}[x](${target} ${quote}${title}${quote})`;
                const html = `<p>${before}${syntax.replace(/</g, '&lt;').replace(/>/g, '&gt;')}${after}</p>`;
                const result = await convertAt(html, editor => editor.querySelector('p').firstChild,
                    before.length + syntax.length, ')');
                assert.equal(result.converted, true, syntax);
                const node = result.editor.querySelector(tag);
                assert.equal(node.getAttribute(attribute), destination);
                assert.equal(node.getAttribute('title'), title);
                assert.equal(result.editor.querySelector('p').firstChild.textContent, before);
                assert.equal(result.editor.querySelector('p').lastChild.textContent, after);
                const saved = toMarkdown(result.html);
                const reopened = domino.createWindow(marked.parse(saved)).document;
                assert.equal(reopened.querySelector(tag).getAttribute(attribute), destination);
                assert.equal(reopened.querySelector(tag).getAttribute('title'), title);
                assert.ok(saved.startsWith(before));
                assert.ok(saved.endsWith(after + '\n'));
            }
        }
    }
});

test('quoted shortcut titles decode escaped punctuation and keep it when reopened', async () => {
    const rawTitle = 'Title \\(detail\\) & \\"quoted\\"';
    const title = 'Title (detail) & "quoted"';
    for (const [marker, tag] of [['', 'a'], ['!', 'img']]) {
        for (const quote of ['"', "'"]) {
            const syntax = `${marker}[x](https://example.test ${quote}${rawTitle}${quote})`;
            const result = await convertAt(`<p>${syntax}</p>`, editor => editor.querySelector('p').firstChild,
                undefined, ')');
            assert.equal(result.converted, true);
            assert.equal(result.editor.querySelector(tag).getAttribute('title'), title);
            const reopened = domino.createWindow(marked.parse(toMarkdown(result.html))).document;
            assert.equal(reopened.querySelector(tag).getAttribute('title'), title);
        }
    }
});

test('angle destinations after spaces or tabs wait for the final closing parenthesis', async () => {
    const before = 'Hello\u00a0world ';
    const after = '\u00a0after\u00a0text';
    const first = editor => editor.querySelector('p').firstChild;
    for (const [marker, tag, attribute] of [['', 'a', 'href'], ['!', 'img', 'src']]) {
        for (const whitespace of [' ', '\t', '  \t']) {
            for (const destination of ['https://example.test/a)b', 'https://example.test/a(b']) {
                const syntax = `${marker}[x](${whitespace}<${destination}>)`;
                for (let length = 1; length <= syntax.length; length++) {
                    const typed = syntax.slice(0, length);
                    const html = `<p>${before}${typed.replace(/</g, '&lt;').replace(/>/g, '&gt;')}${after}</p>`;
                    const result = await convertAt(html, first, before.length + typed.length, typed.slice(-1));
                    const paragraph = result.editor.querySelector('p');
                    if (length < syntax.length) {
                        assert.equal(result.converted, false, typed);
                        assert.equal(result.notified, 0, typed);
                        assert.equal(paragraph.textContent, before + typed + after);
                        assert.ok(!paragraph.querySelector('a,img'), typed);
                    } else {
                        assert.equal(result.converted, true, syntax);
                        assert.equal(result.notified, 1, syntax);
                        assert.equal(paragraph.querySelector(tag).getAttribute(attribute), destination);
                        assert.equal(paragraph.firstChild.textContent, before);
                        assert.equal(paragraph.lastChild.textContent, after);
                        assert.equal(result.range.startContainer, paragraph.lastChild);
                        assert.equal(result.range.startOffset, 0);
                    }
                }
            }
        }
    }
});

test('delimiters around spaces are not emphasis', async () => {
    const result = await convertAt('<p>5 * 3 *</p>', (editor) => editor.querySelector('p').firstChild, undefined, '*');
    assert.equal(result.converted, false);
    assert.equal(result.html, '<p>5 * 3 *</p>');
});

test('typing is grouped into word-sized undo steps', async () => {
    const { TypingUndoGroup } = await typingUndoGroupModulePromise;
    let now = 0;
    const group = new TypingUndoGroup({ now: () => now, pauseMs: 500 });
    const type = (data) => {
        now += 50;
        return group.shouldCheckpoint({ inputType: 'insertText', data, collapsed: true });
    };
    const backspace = () => {
        now += 50;
        return group.shouldCheckpoint({ inputType: 'deleteContentBackward', collapsed: true });
    };

    assert.deepEqual(['h', 'e', 'l', 'l', 'o'].map(type), [true, false, false, false, false]);
    // The space ends the word; the next word is a new step.
    assert.equal(type(' '), false);
    assert.equal(type('w'), true);
    // Switching to deletion starts a new step, then deletions group.
    assert.deepEqual([backspace(), backspace(), backspace()], [true, false, false]);
    // A pause, a caret move or typing over a selection starts a new step.
    now += 1000;
    assert.equal(type('x'), true);
    group.break();
    assert.equal(type('y'), true);
    now += 50;
    assert.equal(group.shouldCheckpoint({ inputType: 'insertText', data: 'z', collapsed: false }), true);
    // Other edits always get their own step.
    assert.equal(group.shouldCheckpoint({ inputType: 'insertParagraph', collapsed: true }), true);
    assert.equal(group.shouldCheckpoint({ inputType: 'insertFromPaste', collapsed: true }), true);
});

test('typing the closing "$" turns "$tex$" into a formula', async () => {
    const first = (editor) => editor.querySelector('p').firstChild;
    const typed = await convertAt('<p>Energy $E = mc^2$ here</p>', first, 'Energy $E = mc^2$'.length, '$');
    assert.equal(typed.converted, true);
    assert.equal(typed.notified, 1);
    assert.equal(
        typed.html,
        '<p>Energy <span class="mdw-math" data-mdw-math="inline" contenteditable="false">E = mc^2</span> here</p>'
    );
});

test('dollar text that would not open as a formula stays text', async () => {
    const first = (editor) => editor.querySelector('p').firstChild;
    for (const text of ['costs $5 and $', 'a $ b$', 'escaped \\$x$', 'display $$x$', 'trailing $x\\$']) {
        const result = await convertAt(`<p>${text}</p>`, first, undefined, '$');
        assert.equal(result.converted, false, text);
        assert.doesNotMatch(result.html, /mdw-math/, text);
    }
    // Only a typed "$" closes a formula, not other input such as a paste.
    const pasted = await convertAt('<p>$x$</p>', first, undefined, null);
    assert.doesNotMatch(pasted.html, /mdw-math/);
});
