const assert = require('node:assert/strict');
const test = require('node:test');
const {
    collectMarkdownFilePaths,
    collectMarkdownImagePaths,
    rewriteMarkdownImagePaths,
} = require('../out/utils/markdownImagePaths.js');

const paths = text => collectMarkdownImagePaths(text).map(reference => reference.path);

test('image destinations are replaced without reformatting Markdown or line endings', () => {
    const markdown = '# Heading\r\n\r\nText ![a](images/memo/one.png "A title")  \r\n' +
        '![b](<images/memo/two%20two.png> \'B title\')\r\n';
    const result = rewriteMarkdownImagePaths(markdown, path => path.replace('images/memo/', 'images/new/'));
    assert.equal(result, markdown.replaceAll('images/memo/', 'images/new/'));
    for (const reference of collectMarkdownImagePaths(markdown)) {
        assert.equal(markdown.slice(reference.start, reference.end), reference.path);
    }
});

test('escaped brackets and balanced parentheses in an image destination are parsed', () => {
    const markdown = '![a \\] [nested]](images/memo/a\\(1\\).png "title") ' +
        '![b](images/memo/b(2).png)';
    assert.deepEqual(paths(markdown), ['images/memo/a(1).png', 'images/memo/b(2).png']);
    assert.equal(rewriteMarkdownImagePaths(markdown, () => 'images/new/new.png'),
        '![a \\] [nested]](images/new/new.png "title") ![b](images/new/new.png)');
});

test('fenced, indented and inline code and escaped image markers are left alone', () => {
    const markdown = '```md\n![a](images/fake.png)\n```\n\n' +
        '    ![a](images/fake.png)\n\n' +
        '`![a](images/fake.png)` \\![a](images/fake.png) ![a](images/real.png)\n';
    assert.deepEqual(paths(markdown), ['images/real.png']);
    assert.equal(rewriteMarkdownImagePaths(markdown, () => 'images/moved.png'),
        markdown.replace('images/real.png', 'images/moved.png'));
});

test('images nested in lists, quotes, emphasis and links retain correct source offsets', () => {
    const markdown = '> - `![a](same.png)` then **![a](same.png)**\n' +
        '>   [![b](other.png)](https://example.com)\n\n' +
        '> ![multi\n> line](third.png)\n';
    assert.deepEqual(paths(markdown), ['same.png', 'other.png', 'third.png']);
    const result = rewriteMarkdownImagePaths(markdown, path => `new/${path}`);
    assert.equal(result, markdown.replace('**![a](same.png)**', '**![a](new/same.png)**')
        .replace('(other.png)', '(new/other.png)').replace('(third.png)', '(new/third.png)'));
});

test('GFM table image paths keep table escapes and whitespace unchanged', () => {
    const markdown = '| ![a\\|b](images/a.png) | ![c](images/c.png) |\n| --- | --- |\n' +
        '| `![a](ignored.png)` | ![d](images/d.png) |\n';
    assert.deepEqual(paths(markdown), ['images/a.png', 'images/c.png', 'images/d.png']);
    assert.equal(rewriteMarkdownImagePaths(markdown, path => path.replace('images/', 'moved/')),
        markdown.replaceAll('images/', 'moved/'));
});

test('full, collapsed and shortcut image references rewrite only the used definitions', () => {
    const markdown = '![one][ID]\n![two][]\n![three]\n\n' +
        '[id]: <images/one%20one.png> "first"\n' +
        '[two]:\n  images/two.png\n  "second"\n' +
        '[three]: images/three.png\n' +
        '[unused]: images/unused.png\n' +
        '[download]: images/download.png\n\n' +
        '[download][download]\n';
    assert.deepEqual(paths(markdown), ['images/one%20one.png', 'images/two.png', 'images/three.png']);
    const result = rewriteMarkdownImagePaths(markdown, path => path.replace('images/', 'new/'));
    assert.equal(result, markdown.replace('images/one%20one.png', 'new/one%20one.png')
        .replace('images/two.png', 'new/two.png').replace('images/three.png', 'new/three.png'));
    assert.deepEqual(collectMarkdownFilePaths(markdown).map(reference => reference.path),
        ['images/one%20one.png', 'images/two.png', 'images/three.png', 'images/download.png']);
});

test('reference definitions inside quotes work and duplicate definitions stay untouched', () => {
    const markdown = '> ![a][foo]\n>\n> [foo]: images/real.png\n\n' +
        '[foo]: images/duplicate.png\n';
    assert.deepEqual(paths(markdown), ['images/real.png']);
    assert.equal(rewriteMarkdownImagePaths(markdown, () => 'moved.png'),
        markdown.replace('images/real.png', 'moved.png'));
});

test('HTML image attributes decode entities and preserve tag spelling and other attributes', () => {
    const markdown = '<IMG class="a" SRC = "images/a&amp;b.png" alt="A">\n\n' +
        "text <img src='images/two.png'> and <img src=images/three.png>\n";
    assert.deepEqual(paths(markdown), ['images/a&b.png', 'images/two.png', 'images/three.png']);
    const result = rewriteMarkdownImagePaths(markdown, path => path.replace('images/', 'new/'));
    assert.equal(result, markdown.replaceAll('images/', 'new/'));
});

test('comments, raw HTML code and links do not count as images', () => {
    const markdown = '<!-- <img src="fake.png"> -->\n\n' +
        '<pre><img src="fake.png"></pre>\n\n' +
        '<script>"<img src=\'fake.png\'>"</script>\n\n' +
        '[download](images/a.png) <a href="images/b.png">download</a>\n\n' +
        '![real](images/c.png)';
    assert.deepEqual(paths(markdown), ['images/c.png']);
    assert.deepEqual(collectMarkdownFilePaths(markdown).map(reference => reference.path),
        ['images/a.png', 'images/b.png', 'images/c.png']);
});

test('undefined replacements preserve source paths byte for byte', () => {
    const markdown = '![a](a\\(1\\).png)\n\n<img src="a&amp;b.png">';
    assert.equal(rewriteMarkdownImagePaths(markdown, () => undefined), markdown);
});

test('nested fenced blocks and task markers do not confuse repeated image destinations', () => {
    const markdown = '- [x] actual ![a](first.png)\n  - ```md\n' +
        '    ![a](second.png)\n    ```\n  - actual ![a](second.png)\n';
    const references = collectMarkdownImagePaths(markdown);
    assert.deepEqual(references.map(reference => reference.path), ['first.png', 'second.png']);
    assert.equal(references[1].start, markdown.lastIndexOf('second.png'));
});

test('HTML attribute references expose the escaping context for workspace text edits', () => {
    const markdown = '<img src="images/a&amp;b.png"> <img src=images/two.png>';
    const references = collectMarkdownImagePaths(markdown);
    assert.equal(references[0].path, 'images/a&b.png');
    assert.equal(references[0].format, 'html');
    assert.equal(references[0].quote, '"');
    assert.equal(markdown.slice(references[0].start, references[0].end), 'images/a&amp;b.png');
    assert.equal(references[1].quote, '');
    assert.equal(rewriteMarkdownImagePaths(markdown, () => 'new.png?a=1&b=2'),
        '<img src="new.png?a=1&amp;b=2"> <img src=new.png?a&#61;1&amp;b&#61;2>');
});

test('a definition-looking line inside a paragraph or code never wins over the real definition', () => {
    const markdown = 'text\n[id]: images/real.png\n\n' +
        '```md\n[id]: images/real.png\n```\n\n' +
        '![x][id]\n\n[id]: images/real.png\n';
    const references = collectMarkdownImagePaths(markdown);
    assert.deepEqual(references.map(reference => reference.path), ['images/real.png']);
    assert.equal(references[0].start, markdown.lastIndexOf('images/real.png'));
});

test('footnote images and downloads are collected with their original source offsets', () => {
    const markdown = 'Text[^note].\n\n[^note]: ![a](images/a.png)\n\n' +
        '    ![b][image]\n\n    [download](images/shared.png)\n\n' +
        '[image]: images/b.png\n';
    assert.deepEqual(paths(markdown), ['images/a.png', 'images/b.png']);
    assert.deepEqual(collectMarkdownFilePaths(markdown).map(reference => reference.path),
        ['images/a.png', 'images/shared.png', 'images/b.png']);
    assert.equal(rewriteMarkdownImagePaths(markdown, path => path.replace('images/', 'new/')),
        markdown.replace('images/a.png', 'new/a.png').replace('images/b.png', 'new/b.png'));
});

test('footnote-looking text in code and code inside real footnotes remain literal', () => {
    const markdown = '```md\n[^fake]: ![a](fake.png)\n```\n\n' +
        '[^real]: first\n\n    ```md\n    ![a](fake.png)\n    ```\n\n' +
        '    ![a](real.png)\n';
    assert.deepEqual(paths(markdown), ['real.png']);
});

test('file URI autolinks count as readers of shared files', () => {
    const markdown = '<file:///workspace/images/doc/doc.png>\n';
    assert.deepEqual(paths(markdown), []);
    const [reference] = collectMarkdownFilePaths(markdown);
    assert.equal(reference.path, 'file:///workspace/images/doc/doc.png');
    assert.equal(markdown.slice(reference.start, reference.end), reference.path);
});
