const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

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
