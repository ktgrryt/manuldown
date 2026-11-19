const assert = require('node:assert/strict');
const test = require('node:test');
const { parseCallout, serializeCallout, renderCallout } = require('../out/editor/Callouts');
const { MarkdownDocument } = require('../out/editor/MarkdownDocument');
const domino = require('@mixmark-io/domino');

const html = source => new MarkdownDocument({ getText: () => source, uri: {} }).toHtml();
const dom = source => domino.createWindow(html(source)).document;

for (const [header, variant, format] of [
    ['> [!NOTE]', 'note', 'quote'], ['> [!TIP]', 'tip', 'quote'],
    ['> [!IMPORTANT]', 'important', 'quote'], ['> [!WARNING]', 'warning', 'quote'],
    ['> [!CAUTION]', 'caution', 'quote'], ['> [!info]', 'note', 'quote'],
    ['> [!summary]', 'note', 'quote'], ['> [!failure]', 'caution', 'quote'],
    [':::note info', 'note', 'container'], [':::note warn', 'warning', 'container'],
    [':::note alert', 'caution', 'container'], [':::message', 'note', 'container'],
    [':::message alert', 'caution', 'container'], [':::note', 'note', 'container'],
    [':::tip', 'tip', 'container'], [':::info', 'note', 'container'],
    [':::warning', 'warning', 'container'], [':::danger', 'caution', 'container'],
    ['!!! note', 'note', 'mkdocs'], ['!!! warning', 'warning', 'mkdocs'],
    ['???+ tip "Details"', 'tip', 'mkdocs'],
]) {
    test(`recognizes and renders ${header}`, () => {
        const source = format === 'quote' ? header + '\n> Original.\n'
            : format === 'container' ? header + '\nOriginal.\n:::\n' : header + '\n    Original.\n';
        const parsed = parseCallout(source);
        assert.equal(parsed.variant, variant);
        assert.equal(parsed.format, format);
        assert.equal(parsed.header, header);
        const document = dom(source);
        assert.equal(document.querySelectorAll('[data-mdw-callout="true"]').length, 1);
        assert.equal(document.querySelector('.mdw-callout-content').textContent.trim(), 'Original.');
        assert.equal(document.querySelector('.mdw-callout-title').getAttribute('contenteditable'), 'false');
        assert.equal(document.querySelector('.mdw-callout-content').getAttribute('contenteditable'), null);
        assert.equal(serializeCallout(parsed, 'Changed.\n').split('\n')[0], header);
    });
}

test('custom title text is escaped and folding declarations remain metadata', () => {
    const source = '> [!warning]- <img src=x onerror=alert(1)>\n> Body\n';
    const document = dom(source);
    assert.equal(document.querySelector('.mdw-callout-title').textContent, '<img src=x onerror=alert(1)>');
    assert.ok(!document.querySelector('img'));
    const parsed = parseCallout(source);
    assert.equal(serializeCallout(parsed, 'Changed\n'), '> [!warning]- <img src=x onerror=alert(1)>\n> Changed\n');
    assert.equal(parseCallout('!!! note ""\n    Body\n').title, '');
    assert.equal(parseCallout(':::note[Custom title]\nBody\n:::\n').title, 'Custom title');
});

test('callouts inside fenced/indented code and inline code remain literal', () => {
    for (const source of [
        '```md\n:::note info\nBody\n:::\n```\n',
        '~~~md\n> [!WARNING]\n> Body\n~~~\n',
        '    !!! note\n        Body\n',
        '`:::note info` and `> [!NOTE]`\n',
    ]) assert.ok(!dom(source).querySelector('[data-mdw-callout]'));
});

test('code fence colon delimiters do not terminate or widen a container', () => {
    const source = ':::note\nBefore\n\n```md\n:::warning\n:::\n```\n\nAfter\n:::\n';
    const parsed = parseCallout(source);
    assert.equal(parsed.raw, source);
    assert.equal(parsed.body, 'Before\n\n```md\n:::warning\n:::\n```\n\nAfter\n');
    assert.equal(serializeCallout(parsed, parsed.body), source);
    assert.equal(dom(source).querySelectorAll('[data-mdw-callout]').length, 1);
});

test('nested containers remain read-only source inside a single editable callout', () => {
    for (const source of [
        ':::note\nBefore\n\n:::tip\nNested\n:::\n\nAfter\n:::\n',
        '::::warning Title\nBefore\n\n:::tip\nNested\n:::\n\nAfter\n::::\n',
    ]) {
        const parsed = parseCallout(source);
        assert.equal(parsed.raw, source);
        assert.equal(serializeCallout(parsed, parsed.body), source);
        const document = dom(source);
        assert.equal(document.querySelectorAll('[data-mdw-callout]').length, 1);
        assert.ok(document.querySelector('[data-mdw-opaque-kind="callout-source"]'));
        assert.match(document.body.textContent, /Before[\s\S]*Nested[\s\S]*After/);
    }
});

test('deep callouts and quotations stop before recursive parsing can block the host', () => {
    const { spawnSync } = require('node:child_process');
    const result = spawnSync(process.execPath, ['-e', `
        const assert = require('node:assert/strict');
        const { MarkdownDocument } = require('./out/editor/MarkdownDocument');
        const { createWindow } = require('@mixmark-io/domino');
        for (const source of [
            ':::note\\n'.repeat(400) + 'x\\n' + ':::\\n'.repeat(400),
            '>'.repeat(10000) + ' quoted\\n',
            ':::note\\n' + '>'.repeat(10000) + ' quoted\\n:::\\n',
        ]) {
            const document = new MarkdownDocument({ getText: () => source, uri: {} });
            const root = createWindow(document.toHtml()).document;
            assert.ok(!root.querySelector('blockquote blockquote blockquote'));
            assert.ok(!root.querySelector('[data-mdw-callout] [data-mdw-callout]'));
            document.getSourceBlocks();
        }
    `], { cwd: require('node:path').join(__dirname, '..'), timeout: 5000, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
});

test('ordinary quote context and nested callout body retain all inline text', () => {
    const document = dom('> ordinary\n>\n> :::note info\n> first **bold**\n> :::\n');
    assert.match(document.body.textContent, /ordinary[\s\S]*first bold/);
    assert.equal(document.querySelector('.mdw-callout-content strong').textContent, 'bold');
});

test('unknown and incomplete declarations retain text without becoming callouts', () => {
    for (const source of [
        ':::note warn\nOriginal.\n\nAdjacent.\n',
        ':::unknown\nOriginal.\n:::\n\nAdjacent.\n',
        '!!! unknown\n    Original.\n\nAdjacent.\n',
        '> [!unknown]\n> Original.\n\nAdjacent.\n',
    ]) {
        const document = dom(source);
        assert.ok(!document.querySelector('[data-mdw-callout]'));
        assert.match(document.body.textContent, /Original[\s\S]*Adjacent/);
    }
});

test('unknown nested directives preserve the entire outer source atomically', () => {
    const source = ':::note\nBefore\n:::unknown\nNested\n:::\nAfter\n:::\n';
    assert.equal(parseCallout(source), null);
    const document = dom(source);
    assert.ok(!document.querySelector('[data-mdw-callout]'));
    const opaque = document.querySelector('[data-mdw-opaque-kind="callout-source"]');
    assert.equal(opaque.textContent, source);
    assert.equal(Buffer.from(opaque.getAttribute('data-mdw-opaque-source'), 'base64').toString(), source);
});

test('CRLF source is extracted before preprocessing without losing delimiter metadata', () => {
    const source = 'Before\r\n\r\n:::note warn\r\nOriginal\r\n\r\nSecond\r\n:::\r\n\r\nAfter\r\n';
    const document = dom(source);
    assert.equal(document.querySelectorAll('[data-mdw-callout]').length, 1);
    assert.match(document.querySelector('.mdw-callout-content').textContent, /Original[\s\S]*Second/);
    assert.doesNotMatch(html(source), /MDW_(?:BLANK_LINE|LIST_INDENT)_/);
});

test('indented MkDocs declaration uses its own continuation indentation', () => {
    const source = '  !!! note "Title"\n      Original\n\n      Second\n';
    const parsed = parseCallout(source);
    assert.equal(parsed.body, 'Original\n\nSecond\n');
    assert.equal(serializeCallout(parsed, 'Changed\n\nSecond\n'), '  !!! note "Title"\n      Changed\n\n      Second\n');
});

test('rendering helper keeps metadata independent of the visible body', () => {
    const parsed = parseCallout(':::message alert\nOriginal\n:::\n');
    const document = domino.createWindow(renderCallout(parsed, '<p>Changed</p>')).document;
    assert.equal(document.querySelector('.mdw-callout-content').textContent, 'Changed');
    assert.equal(document.querySelector('[data-mdw-callout-type]').getAttribute('data-mdw-callout-type'), 'alert');
    assert.equal(Buffer.from(document.querySelector('[data-mdw-callout-header]').getAttribute('data-mdw-callout-header'), 'base64').toString(), ':::message alert');
});

test('multiline inline code cannot be interrupted by callout declarations', () => {
    for (const source of [
        '`literal\n:::note\nbody\n:::\nend`\n',
        'Before `literal\n:::note\nbody\n:::\nend` after\n',
        '`literal\n!!! note\n    body\nend`\n',
        '> [!NOTE]\n> `literal\n> :::tip\n> body\n> :::\n> end`\n',
    ]) {
        const document = dom(source);
        assert.equal(document.querySelectorAll('[data-mdw-callout]').length, source.startsWith('>') ? 1 : 0);
        assert.ok(document.querySelector('code'));
        assert.match(document.querySelector('code').textContent, /literal[\s\S]*end/);
    }
});

test('prototype property names remain unknown callout types', () => {
    for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
        for (const source of [`> [!${type}]\n> Body\n`, `!!! ${type}\n    Body\n`]) {
            assert.equal(parseCallout(source), null);
            assert.ok(!dom(source).querySelector('[data-mdw-callout]'));
        }
    }
});

test('many incomplete directives render in bounded time without repeated suffix parsing', () => {
    const { spawnSync } = require('node:child_process');
    const result = spawnSync(process.execPath, ['-e', `
        const { MarkdownDocument } = require('./out/editor/MarkdownDocument');
        const source = ':::note\\n'.repeat(4000);
        const html = new MarkdownDocument({ getText: () => source, uri: {} }).toHtml();
        if (html.includes('data-mdw-callout=')) process.exit(2);
        if (!html.includes(':::note')) process.exit(3);
    `], { cwd: require('node:path').join(__dirname, '..'), timeout: 5000, encoding: 'utf8' });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
});

test('delimiter examples inside list code fences cannot close the outer callout', () => {
    const source = ':::note\n- item\n\n  ```md\n  :::\n  ```\n\nAfter\n:::\n';
    const parsed = parseCallout(source);
    assert.equal(parsed.raw, source);
    assert.equal(parsed.footer, ':::');
    assert.equal(serializeCallout(parsed, parsed.body), source);
    const document = dom(source);
    assert.equal(document.querySelectorAll('[data-mdw-callout]').length, 1);
    assert.equal(document.querySelector('.mdw-callout-content code').textContent, ':::\n');
    assert.match(document.querySelector('.mdw-callout-content').textContent, /item[\s\S]*:::[\s\S]*After/);
});

test('standalone original-body rendering inherits document reference definitions', () => {
    const document = new MarkdownDocument({ getText: () => ':::note\n[label][ref]\n:::\n\n[ref]: https://example.com\n', uri: {} });
    const rendered = domino.createWindow(document.renderCalloutContent('[label][ref]\n')).document;
    assert.equal(rendered.querySelector('a').getAttribute('href'), 'https://example.com');
});

test('literal delimiter lines stay in a GitBook or Quarto body after saving', () => {
    for (const [header, footer, body] of [
        ['{% hint style="info" %}', '{% endhint %}', '{% endhint %}\n\nAfter.\n\n  {% hint style="warning" %}'],
        ['::::: {.callout-note}', ':::', ':::\n\nAfter.\n\n::::{warning}\n:::'],
    ]) {
        const original = parseCallout([header, 'Original.', footer, ''].join('\n'));
        const saved = serializeCallout(original, body);
        const parsed = parseCallout(saved + '\nOutside.\n');
        assert.equal(parsed.raw, saved);
        assert.equal(parsed.header, header);
        const document = dom(saved + '\nOutside.\n');
        const content = document.querySelector('.mdw-callout-content').textContent;
        for (const line of body.split('\n').filter(Boolean)) assert.ok(content.includes(line.trim()), content);
        assert.ok(!content.includes('Outside.'));
    }
});

test('fenced and inline code preserve closing markers without splitting a callout', () => {
    for (const [header, footer] of [
        ['{% hint style="info" %}', '{% endhint %}'],
        [':::{tip}', ':::'], ['::: {.callout-tip}', ':::'],
    ]) {
        const body = ['An inline `example', footer, 'ends here`.', '', '```md', footer, '```', '', 'After.'].join('\n');
        const source = [header, body, footer, ''].join('\n');
        const parsed = parseCallout(source);
        assert.equal(parsed.raw, source);
        assert.equal(serializeCallout(parsed, parsed.body), source);
        assert.match(dom(source).querySelector('.mdw-callout-content').textContent, /After\./);
        assert.equal(dom(source.replace(/\n/g, '\r\n')).querySelectorAll('.mdw-callout').length, 1);
    }
    const original = parseCallout('```{note} 注意\nBody.\n```\n');
    const body = 'Before.\n\n```js\ncode\n```\n\nAfter.';
    const saved = serializeCallout(original, body);
    assert.equal(saved, ['````{note} 注意', body, '````', ''].join('\n'));
    assert.equal(parseCallout(saved).body.trimEnd(), body);
});
