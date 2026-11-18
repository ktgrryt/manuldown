const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { unzipSync, strFromU8 } = require('fflate');
const { loadPdfModules, uri } = require('./helpers/pdf-modules');

const sourceUri = uri('/workspace/手順.MD');
const extensionUri = uri(path.resolve(__dirname, '..'));
let target, dialog, saved;
const notices = [];
const { exportWord } = loadPdfModules({
    window: {
        showSaveDialog: async options => { dialog = options; return target; },
        showInformationMessage: message => notices.push(message),
        showWarningMessage: message => notices.push(message),
    },
    workspace: { getConfiguration: () => ({ get: () => '/nonexistent/manuldown-test-browser' }), fs: {
        writeFile: async (temporary, bytes) => { saved = { temporary, parts: unzipSync(bytes) }; },
        rename: async (temporary, destination, options) => {
            assert.equal(temporary, saved.temporary);
            assert.match(temporary.path, /\.docx\..+\.tmp$/i);
            assert.equal(destination, target);
            assert.equal(options.overwrite, true);
        },
        delete: async temporary => assert.equal(temporary, saved.temporary),
    } },
});
const xml = name => strFromU8(saved.parts[name]);
const run = (source, resolveImage = async () => null) => exportWord(extensionUri, sourceUri, async () => ({ source }), resolveImage);
test.beforeEach(() => {
    target = uri('/workspace/手順.DOCX');
    saved = undefined;
    notices.length = 0;
});

test('Word export writes editable Japanese text, headings, lists, tables, equations and footnotes', async () => {
    await run([
        '# 手順', '段落に **太字** と $x^2$。[^注]', '1. 番号付き\n   - 入れ子', '- [x] 完了',
        '| 項目 | 値 |\n| --- | --- |\n| 長さ | 12 |', '$$\n\\frac{a}{b}\n$$',
        '[^注]: 脚注の本文。',
    ].join('\n\n'));
    assert.equal(dialog.defaultUri.path, '/workspace/手順.docx');
    assert.deepEqual(dialog.filters, { Word: ['docx'] });
    assert.deepEqual(notices, ['Word exported.']);
    const body = xml('word/document.xml');
    for (const part of ['Heading1', '手順', '<w:b', '太字', '<w:numPr>', '入れ子', '<w14:checkbox>',
        '<w:tbl>', '長さ', '<m:sSup>', '<m:oMathPara>', '<m:f>', '<w:footnoteReference ']) {
        assert.ok(body.includes(part), part);
    }
    assert.ok(!body.includes('脚注の本文。'));
    assert.ok(xml('word/footnotes.xml').includes('脚注の本文。'));
});

test('Word keeps expanded macros editable, centers display math, and preserves surrounding content on errors', async () => {
    await run([
        '前 $\\newcommand{\\sq}[1]{#1^2}\\sq{x}$ 後。途中 $$a+b$$ 続き。',
        '```math\n\\begin{aligned}a&=b\\\\c&=d\\end{aligned}\n```',
        '| 値 |\n| --- |\n| $\\sqrt[3]{x}$ |',
        '脚注[^注]。', '[^注]: $\\frac{1}{2}$',
        '`$code$` と $\\unknownFormula{x}$ の後。',
    ].join('\n\n'));
    const body = xml('word/document.xml');
    assert.match(body, /前 [\s\S]*<m:sSup>[\s\S]* 後。途中/);
    assert.equal((body.match(/<m:oMathPara>/g) || []).length, 2);
    assert.match(body, /<m:m>[\s\S]*<m:mr>[\s\S]*<m:mr>/);
    assert.match(body, /<m:mcJc m:val="right"\/>[\s\S]*<m:mcJc m:val="left"\/>/);
    assert.match(body, /<w:tc>[\s\S]*<m:rad>/);
    assert.match(xml('word/footnotes.xml'), /<m:f>/);
    assert.match(body, /\$code\$/);
    assert.match(body, /\\unknownFormula\{x\}[\s\S]*の後。/);
    assert.doesNotMatch(body, /newcommand|begin\{aligned\}|&amp;|<w:drawing>/);
    assert.match(notices[0], /unknownFormula/);
});

test('Word keeps automatic, explicit and suppressed labels on their original equation rows', async () => {
    const aligned = String.raw`\begin{align}x&=1\\y&=2\tag{A}\\z&=3\notag\\w&=4\end{align}`;
    await run('$$\n' + aligned + '\n$$');
    const body = xml('word/document.xml');
    const rows = body.match(/<m:mr>[\s\S]*?<\/m:mr>/g);
    assert.equal(rows.length, 4);
    assert.match(rows[0], /\(1\)/);
    assert.match(rows[1], /\(A\)/);
    assert.doesNotMatch(rows[2], /\(/);
    assert.match(rows[3], /\(2\)/);
    assert.doesNotMatch(body, /&amp;|<w:drawing>/);
    assert.deepEqual(notices, ['Word exported.']);
});

test('Word styles preserve Markdown alignments, callouts, code whitespace and syntax colors', async () => {
    await run('# 日本語の表\n\n> [!WARNING]\n> 注意事項\n\n| 左 | 中 | 右 |\n| :--- | :---: | ---: |\n| abc | 123 | 右列 |\n\n' +
        '```python\nif score < 10:\n    print("low")\n```');
    const body = xml('word/document.xml');
    assert.match(body, /<w:tblHeader\b/);
    assert.match(body, /<w:cantSplit\b/);
    assert.match(body, /<w:jc w:val="right"\/>[\s\S]*?右列/);
    assert.match(body, /<w:jc w:val="center"\/>[\s\S]*?123/);
    assert.match(body, /w:fill="FFFBED"/i);
    assert.match(body, /w:color="BF8700"/i);
    assert.match(body, /w:val="CF222E"[\s\S]*?>if<\//i);
    assert.match(body, /<w:br\/>[\s\S]*?xml:space="preserve"> {4}/);
    const styles = xml('word/styles.xml');
    assert.match(styles, /w:eastAsia="Yu Gothic"/);
    assert.match(styles, /w:styleId="Heading1"[\s\S]*?<w:keepNext\/>/);
    assert.deepEqual(notices, ['Word exported.']);
});

test('Word keeps a single definition for repeated footnotes and fits wide images within table cells', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJZkAAAAASUVORK5CYII=';
    await run('最初[^注] と再掲[^注]、次の注[^別]。\n\n| 画像 | 解説 |\n| --- | --- |\n| ![図\\|800](fig.png) | 本文 |' +
        '\n\n[^注]: 一番目の注\n\n[^別]: 二番目の注', async () => png);
    const body = xml('word/document.xml');
    assert.equal((body.match(/<w:footnoteReference /g) || []).length, 2);
    assert.equal((xml('word/footnotes.xml').match(/一番目の注/g) || []).length, 1);
    const bookmark = /<w:bookmarkStart [^>]*w:name="([^"]+)"/.exec(body)[1];
    assert.ok(body.includes(`w:anchor="${bookmark}"`));
    const [, cx, cy] = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(body);
    assert.equal(cx, cy);
    assert.ok(Number(cx) > 250 * 9525 && Number(cx) < 320 * 9525);
    assert.deepEqual(notices, ['Word exported.']);
});

test('Word preserves source and alternative text when illustrations cannot be rendered', async () => {
    const cancelled = String.raw`\newcommand{\gone}[1]{\cancel{#1}}\gone{x}`;
    await run('```mermaid\ngraph LR\n  A --> B\n```\n\n![写真](image.webp)\n\n$\\textcolor{red}{x^2}$ と $' + cancelled + '$。',
        async () => 'data:image/webp;base64,UklGRg==');
    const body = xml('word/document.xml');
    assert.match(body, /graph LR[\s\S]*A --&gt; B/);
    assert.match(body, /\[Image unavailable: 写真\]/);
    assert.match(body, /<m:sSup>/);
    assert.ok(body.includes(cancelled));
    assert.match(notices[0], /Mermaid source kept/);
    assert.match(notices[0], /Formula source kept/);
    assert.match(notices[0], /Image could not be converted for Word: 写真/);
});

test('Word embeds resolved image bytes at the chosen width, reports missing images and filters links', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJZkAAAAASUVORK5CYII=';
    const requests = [];
    await run('# 節\n\n[ここ](#節) [外部](https://example.com) [ローカル](../secret)\n\n' +
        '![図|120](./fig.png) ![再掲](./fig.png) ![欠落](./missing)', async path => {
        requests.push(path);
        return path === './fig.png' ? 'data:image/png;base64,' + png : null;
    });
    assert.deepEqual(requests, ['./fig.png', './missing']);
    const body = xml('word/document.xml');
    assert.match(body, /<wp:extent cx="1143000" cy="1143000"/);
    assert.match(body, /w:anchor="節"/);
    assert.ok(body.includes('ローカル'));
    assert.ok(body.includes('[Image unavailable: 欠落]'));
    assert.match(notices[0], /Image unavailable or blocked: 欠落/);
    const rels = xml('word/_rels/document.xml.rels');
    assert.match(rels, /Target="https:\/\/example.com"/);
    assert.doesNotMatch(rels, /secret|fig\.png|missing/);
    const media = Object.keys(saved.parts).find(name => name.startsWith('word/media/') && name.endsWith('.png'));
    assert.equal(Buffer.from(saved.parts[media]).toString('base64'), png);
});

test('Word cancellation and invalid destinations skip capture, and a failed capture leaves the target alone', async () => {
    const capture = () => assert.fail('Unexpected capture');
    target = undefined;
    await exportWord(extensionUri, sourceUri, capture, async () => null);
    target = sourceUri;
    await assert.rejects(exportWord(extensionUri, sourceUri, capture, async () => null), /ending in \.docx/);
    target = uri('/workspace/手順.docx');
    await assert.rejects(exportWord(extensionUri, sourceUri, async () => { throw new Error('Edit conflict'); }, async () => null), /Edit conflict/);
    assert.equal(saved, undefined);
    assert.deepEqual(notices, []);
});
