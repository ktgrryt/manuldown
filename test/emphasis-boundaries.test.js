const assert = require('node:assert/strict');
const test = require('node:test');
const TurndownService = require('turndown');
const { marked } = require('marked');
const { createWindow } = require('@mixmark-io/domino');
const { EmphasisBoundarySerializer } = require('../out/editor/Emphasis');

function serialize(html) {
    const serializer = new EmphasisBoundarySerializer('UNIQUEBOUNDARY');
    const turndown = new TurndownService({ emDelimiter: '*', strongDelimiter: '**' });
    for (const [filter, delimiter] of [[['strong', 'b'], '**'], [['em', 'i'], '*']]) {
        turndown.addRule(`boundary-${delimiter}`, {
            filter,
            replacement: content => content.trim() ? serializer.wrap(content, delimiter) : '',
        });
    }
    return serializer.restore(turndown.turndown(html));
}

function render(markdown) {
    return createWindow(`<div id="root">${marked.parse(markdown)}</div>`).document.getElementById('root');
}

function assertReadable(markdown) {
    assert.doesNotMatch(markdown, /UNIQUEBOUNDARY|&#\d+;|[\u200B\u2060\uFEFF]/);
}

test('unsafe punctuation edges stay outside new bold and italic without changing the text', () => {
    for (const [tag, delimiter] of [['strong', '**'], ['em', '*']]) {
        for (const [selected, expected, formatted] of [
            ['「文字」', `「${delimiter}文字${delimiter}」`, '文字'],
            ['「文字', `「${delimiter}文字${delimiter}`, '文字'],
            ['文字」', `${delimiter}文字${delimiter}」`, '文字'],
            ['(note)', `(${delimiter}note${delimiter})`, 'note'],
            ['【必須】', `【${delimiter}必須${delimiter}】`, '必須'],
            ['『文字』', `『${delimiter}文字${delimiter}』`, '文字'],
        ]) {
            const markdown = serialize(`<p>前<${tag}>${selected}</${tag}>後</p>`);
            assert.equal(markdown, `前${expected}後`);
            const root = render(markdown);
            assert.equal(root.textContent.trim(), `前${selected}後`);
            assert.equal(root.querySelector(tag).textContent, formatted);
            assertReadable(markdown);
        }
    }
});

test('a repair keeps both matching brackets outside even when only one boundary is unsafe', () => {
    assert.equal(serialize('<p>前<strong>「文字」</strong> 後</p>'), '前「**文字**」 後');
    assert.equal(serialize('<p>、<em>「文字」</em>後</p>'), '、「*文字*」後');
});

test('standalone and already safe emphasis keep ordinary Markdown and their full selection', () => {
    for (const [html, expected] of [
        ['<strong>「文字」</strong>', '**「文字」**'],
        ['前 <strong>「文字」</strong> 後', '前 **「文字」** 後'],
        ['（<strong>「文字」</strong>）', '（**「文字」**）'],
        ['前<strong>文字</strong>後', '前**文字**後'],
        ['前<strong>😀文字😀</strong>後', '前**😀文字😀**後'],
        ['前<em>文字</em>後', '前*文字*後'],
    ]) {
        assert.equal(serialize(`<p>${html}</p>`), expected);
    }
});

test('transparent inline nodes and Unicode neighbors do not introduce character references', () => {
    const markdown = serialize('<p>😀<strong><span>「</span>文字<span>」</span></strong>𠮷</p>');
    assert.equal(markdown, '😀「**文字**」𠮷');
    assert.equal(render(markdown).textContent.trim(), '😀「文字」𠮷');
    assert.equal(render(markdown).querySelector('strong').textContent, '文字');
    assertReadable(markdown);
});

test('nested emphasis moves literal brackets outside both formats', () => {
    for (const html of [
        '<p>前<strong><em>「文字」</em></strong>後</p>',
        '<p>前<em><strong>「文字」</strong></em>後</p>',
    ]) {
        const markdown = serialize(html);
        assert.equal(markdown, '前「***文字***」後');
        const root = render(markdown);
        assert.equal(root.querySelector('strong').textContent, '文字');
        assert.equal(root.querySelector('em').textContent, '文字');
    }
    const markdown = serialize('<p>前<strong>a<em>「文字」</em>b</strong>後</p>');
    assert.equal(markdown, '前**a「*文字*」b**後');
    assert.equal(render(markdown).querySelector('strong').textContent, 'a「文字」b');
    assert.equal(render(markdown).querySelector('em').textContent, '文字');
});

test('repairs preserve adjacent mixed emphasis without leaking delimiter stars', () => {
    for (const [html, expected, strong, em] of [
        ['X<em>a</em><strong>「b」</strong>Y', 'X*a*「**b**」Y', 'b', 'a'],
        ['<strong>a)</strong><em>b</em>', '**a**)*b*', 'a', 'b'],
    ]) {
        const markdown = serialize(`<p>${html}</p>`);
        assert.equal(markdown, expected);
        const root = render(markdown);
        assert.equal(root.querySelector('strong').textContent, strong);
        assert.equal(root.querySelector('em').textContent, em);
        assertReadable(markdown);
    }
});

test('punctuation-only selections omit the unrepresentable wrapper and keep every character', () => {
    for (const selected of ['「', '「」', '***', '[ ]']) {
        const markdown = serialize(`<p>前<strong>${selected}</strong>後</p>`);
        const root = render(markdown);
        assert.equal(root.textContent.trim(), `前${selected}後`);
        assert.ok(!root.querySelector('strong'));
        assertReadable(markdown);
    }
});

test('escaped literal punctuation moves as a whole and literal star pairs are never deleted', () => {
    for (const [selected, expected] of [
        ['[文字]', '前\\[**文字**\\]後'],
        ['**「テスト」**', '前\\*\\*「**テスト**」\\*\\*後'],
        ['\\文字\\', '前\\\\**文字**\\\\後'],
    ]) {
        const markdown = serialize(`<p>前<strong>${selected}</strong>後</p>`);
        assert.equal(markdown, expected);
        const root = render(markdown);
        assert.equal(root.textContent.trim(), `前${selected}後`);
        assert.equal(root.querySelector('strong').textContent, selected.includes('テスト') ? 'テスト' : '文字');
        assertReadable(markdown);
    }
});

test('complex link and code boundaries omit only unsafe wrappers and retain their structure', () => {
    const markdown = serialize('<p>前<strong><a href="https://example.com">文字</a></strong>後 '+
        '前<em><code>code</code></em>後 '+
        '前<strong><em><a href="./note.md">「文字」</a></em></strong>後</p>');
    assert.equal(markdown, '前[文字](https://example.com)後 前`code`後 前[「文字」](./note.md)後');
    const root = render(markdown);
    assert.ok(!root.querySelector('strong, em'));
    assert.deepEqual(Array.from(root.querySelectorAll('a')).map(link => link.getAttribute('href')),
        ['https://example.com', './note.md']);
    assert.equal(root.querySelector('code').textContent, 'code');
    assertReadable(markdown);
    // Marked also masks emphasis between escaped backticks. Preserve those
    // literal characters without generating delimiter text in the preview.
    const literalBackticks = serialize('<p>前<strong>`文字`</strong>後</p>');
    assert.equal(literalBackticks, '前\\`文字\\`後');
    assert.equal(render(literalBackticks).textContent.trim(), '前`文字`後');
    assert.ok(!render(literalBackticks).querySelector('strong, code'));
});

test('literal brackets outside a structured child can still supply valid emphasis boundaries', () => {
    const markdown = serialize('<p>前<strong>「<a href="./note.md">文字</a>」</strong>後 '+
        '前<em>「<code>code</code>」</em>後</p>');
    assert.equal(markdown, '前「**[文字](./note.md)**」後 前「*`code`*」後');
    const root = render(markdown);
    assert.equal(root.querySelector('strong a').textContent, '文字');
    assert.equal(root.querySelector('em code').textContent, 'code');
    assertReadable(markdown);
});

test('code, links, source character references and literal delimiters outside new wraps are untouched', () => {
    const serializer = new EmphasisBoundarySerializer('SEPARATENAMESPACE');
    const wrapped = serializer.wrap('「new」', '**');
    const source = '`literal**stars**` [before](https://example.com/a)'+wrapped+
        '[after](https://example.com/b) **「literal」**後 &#12399;';
    assert.equal(serializer.restore(source),
        '`literal**stars**` [before](https://example.com/a)**「new」**'+
        '[after](https://example.com/b) **「literal」**後 &#12399;');
    const root = render(serializer.restore(source));
    assert.equal(root.querySelector('code').textContent, 'literal**stars**');
    assert.equal(root.querySelector('strong').textContent, '「new」');
    assert.equal(root.querySelectorAll('a').length, 2);
});

test('unused wraps, repeated restoration and incomplete markers never leak bookkeeping', () => {
    const serializer = new EmphasisBoundarySerializer('CUSTOM.REGEX+[NAMESPACE]');
    serializer.wrap('unused', '*');
    const wrapped = serializer.wrap('「文字」', '**');
    const markdown = serializer.restore(`前${wrapped}後`);
    assert.equal(markdown, '前「**文字**」後');
    assert.equal(serializer.restore(markdown), markdown);
    assert.equal(serializer.restore('plain **「literal」**後'), 'plain **「literal」**後');
    const missingClosingMarker = wrapped.slice(0, wrapped.lastIndexOf('CUSTOM.REGEX+[NAMESPACE]'));
    assert.equal(serializer.restore(missingClosingMarker), '**「文字」**');
    assert.equal(new EmphasisBoundarySerializer('UNUSED').restore('plain **text**'), 'plain **text**');
});
