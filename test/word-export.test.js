const assert = require('node:assert/strict');
const test = require('node:test');
const { unzipSync, strFromU8 } = require('fflate');
const { loadPdfModules, uri } = require('./helpers/pdf-modules');

const sourceUri = uri('/workspace/手順.MD');
let target, dialog, saved;
const notices = [];
const { exportWord } = loadPdfModules({
    window: {
        showSaveDialog: async options => { dialog = options; return target; },
        showInformationMessage: message => notices.push(message),
        showWarningMessage: message => notices.push(message),
    },
    workspace: { fs: {
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
const run = (source, resolveImage = async () => null) => exportWord(sourceUri, async () => ({ source }), resolveImage);
test.beforeEach(() => {
    target = uri('/workspace/手順.DOCX');
    saved = undefined;
    notices.length = 0;
});

test('Word export writes editable Japanese text, headings, lists, tables, equations and footnotes', async () => {
    await run([
        '# 手順', '段落に **太字** と $x^2$。[^注]', '1. 番号付き\n   - 入れ子', '- [x] 完了',
        '| 項目 | 値 |\n| --- | --- |\n| 長さ | 12 |', '$$\n\\frac{a}{b}\n$$',
        '[^注]: 脚注の本文。', '```mermaid\ngraph LR\n  A --> B\n```',
    ].join('\n\n'));
    assert.equal(dialog.defaultUri.path, '/workspace/手順.docx');
    assert.deepEqual(dialog.filters, { Word: ['docx'] });
    assert.deepEqual(notices, ['Word exported.']);
    const body = xml('word/document.xml');
    for (const part of ['Heading1', '手順', '<w:b', '太字', '<w:numPr>', '入れ子', '<w14:checkbox>',
        '<w:tbl>', '長さ', '<m:sSup>', '<m:f>', '<w:footnoteReference ', 'graph LR', 'A --&gt; B']) {
        assert.ok(body.includes(part), part);
    }
    assert.ok(!body.includes('脚注の本文。'));
    assert.ok(xml('word/footnotes.xml').includes('脚注の本文。'));
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
    await exportWord(sourceUri, capture, async () => null);
    target = sourceUri;
    await assert.rejects(exportWord(sourceUri, capture, async () => null), /ending in \.docx/);
    target = uri('/workspace/手順.docx');
    await assert.rejects(exportWord(sourceUri, async () => { throw new Error('Edit conflict'); }, async () => null), /Edit conflict/);
    assert.equal(saved, undefined);
    assert.deepEqual(notices, []);
});
