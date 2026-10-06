const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

function createMockUri(uriPath) {
    return { fsPath: uriPath, path: uriPath, scheme: 'file', authority: '', toString: () => `file://${uriPath}` };
}

function loadExtensionModules() {
    const originalLoad = Module._load;
    const vscodeMock = {
        Uri: { file: createMockUri },
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

function createTextDocument(text) {
    return { getText: () => text, uri: createMockUri('/workspace/document.md') };
}

function toHtml(source) {
    return new MarkdownDocument(createTextDocument(source)).toHtml();
}

function toMarkdown(html, source = '') {
    return new MarkdownEditorProvider({}).htmlToMarkdown(html, createTextDocument(source));
}

const formula = (tex, mode = 'inline') =>
    `<span class="mdw-math" data-mdw-math="${mode}" contenteditable="false">${tex}</span>`;
const mathBlock = (tex, delimiter = ' data-mdw-math-delimiter="$$"') =>
    `<pre><code class="language-math"${delimiter}>${tex}</code></pre>`;

test('inline and display formulas render as elements that hold their TeX', () => {
    const html = toHtml('Energy $E = mc^2$, a sum $$\\sum_i x_i$$ and a<b: $a<b$.\n');
    assert.ok(html.includes(formula('E = mc^2')));
    assert.ok(html.includes(formula('\\sum_i x_i', 'display')));
    assert.ok(html.includes(formula('a&lt;b')));
    assert.doesNotMatch(html, /mdw-opaque/);
});

test('a "$$" block becomes a math code block that keeps its delimiters', () => {
    const html = toHtml('Intro\n$$\n\\frac{a}{b}\n$$\nAfter\n');
    assert.match(html, /<p>Intro<\/p>/);
    assert.ok(html.includes(mathBlock('\\frac{a}{b}\n')));
    assert.match(html, /<p>After<\/p>/);
    assert.ok(toHtml('$$ x + y $$\n').includes(mathBlock('x + y\n')));
});

test('"$$" that does not end its line stays a display formula in the paragraph', () => {
    const source = 'Intro\n$$x$$ more\n';
    const html = toHtml(source);
    assert.equal((html.match(/<p>/g) || []).length, 1);
    assert.ok(html.includes(formula('x', 'display')));
    // Marked cuts paragraphs where a block extension may start. A cut that
    // does not lead to a block must not corrupt the paragraph's source.
    const blocks = new MarkdownDocument(createTextDocument(source)).getSourceBlocks().filter(block => !block.inline);
    assert.equal(blocks.map(block => block.source).join(''), source);
});

test('TeX lines that look like list items stay in their "$$" block', () => {
    assert.ok(toHtml('$$\na = b\n  + c\n- d\n$$\n').includes(mathBlock('a = b\n  + c\n- d\n')));
    const listed = toHtml('- Item\n\n  $$\n  - x\n  $$\n- Next\n');
    assert.ok(listed.includes(mathBlock('- x\n')));
    assert.match(listed, /Next/);
});

test('a blank line ends a "$$" block before it closes', () => {
    const html = toHtml('$$\na\n\nb\n$$\n');
    assert.doesNotMatch(html, /language-math/);
});

test('new and edited formulas are written with dollar delimiters', () => {
    assert.equal(toMarkdown(`<p>A ${formula('x^2')} and ${formula('\\sum_i', 'display')} B</p>`),
        'A $x^2$ and $$\\sum_i$$ B\n');
    // A "$" in the TeX cannot close the formula early, and line breaks or
    // surrounding spaces cannot stop it from being one.
    assert.equal(toMarkdown(`<p>${formula(' cost: \\$5 + $\n x ')}</p>`), '$cost: \\$5 + \\$ x$\n');
    assert.equal(toMarkdown(`<p>${formula('')}text</p>`), 'text\n');
    assert.equal(toMarkdown(mathBlock('\\int_0^1 f\\,dx\n')), '$$\n\\int_0^1 f\\,dx\n$$\n');
    assert.equal(toMarkdown(mathBlock('\n')), '$$\n$$\n');
    assert.equal(toMarkdown(mathBlock('')), '$$\n$$\n');
});

test('"$$" blocks keep their delimiters inside quotes and lists', () => {
    const quoted = toMarkdown(`<blockquote>${mathBlock('a\nb\n')}</blockquote>`);
    assert.equal(quoted, '> $$\n> a\n> b\n> $$\n');
    const listed = toMarkdown(`<ul><li>Item${mathBlock('- x\n')}</li></ul>`);
    // The TeX line "- x" must not be taken for a list item by the cleanup.
    assert.match(listed, /^[-*] Item\n\n? {2}\$\$\n {2}- x\n {2}\$\$\n$/);
    for (const markdown of [quoted, listed]) {
        assert.match(toHtml(markdown), /<code class="language-math" data-mdw-math-delimiter="\$\$">/);
    }
});

test('TeX that "$$" cannot hold is written as a "```math" fence', () => {
    assert.equal(toMarkdown(mathBlock('a $$ b\n')), '```math\na $$ b\n```\n');
    assert.equal(toMarkdown(mathBlock('a\n\nb\n')), '```math\na\n\nb\n```\n');
    // A fence the document already uses stays a fence.
    assert.equal(toMarkdown(mathBlock('x\n', '')), '```math\nx\n```\n');
});

test('formulas written and reopened stay formulas', () => {
    const html = `<p>${formula('a_b')} then ${formula('x', 'display')}</p>${mathBlock('\\frac{1}{2}\n')}`;
    const reopened = toHtml(toMarkdown(html));
    assert.ok(reopened.includes(formula('a_b')));
    assert.ok(reopened.includes(formula('x', 'display')));
    assert.ok(reopened.includes(mathBlock('\\frac{1}{2}\n')));
});

test('editing text beside a formula keeps the formula source as written', () => {
    const source = 'Keep $$\nx\n$$ here\n';
    const html = toHtml(source).replace('Keep ', 'Kept ');
    assert.equal(toMarkdown(html, source), 'Kept $$\nx\n$$ here\n');
});

test('a formula in a table cell escapes its pipe', () => {
    const html = `<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>${formula('x|y')}</td></tr></tbody></table>`;
    const markdown = toMarkdown(html);
    assert.match(markdown, /\| \$x\\\|y\$ \|/);
    assert.ok(toHtml(markdown).includes(formula('x|y')));
});
