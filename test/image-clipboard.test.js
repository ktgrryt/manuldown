const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const source = fs.readFileSync(path.join(__dirname, '..', 'media/modules/ImageClipboard.js'), 'utf8');
const clipboardModule = import(`data:text/javascript;base64,${Buffer.from(`${source}\n//# sourceURL=ImageClipboard.js`).toString('base64')}`);
const editorSource = fs.readFileSync(path.join(__dirname, '..', 'media/editor.js'), 'utf8');
const extractFunction = name => {
    const start = editorSource.indexOf(`    function ${name}(`);
    const end = editorSource.indexOf('\n    }\n', start);
    assert.ok(start >= 0 && end > start);
    return editorSource.slice(start, end + 6);
};

async function fixture(html, overrides = {}) {
    const { createImageClipboardSnapshot, writeImageClipboard } = await clipboardModule;
    const document = domino.createWindow().document;
    Object.getPrototypeOf(document.querySelectorAll('img')).forEach = Array.prototype.forEach;
    const { parseImageAltSizeSpec, fragmentToClipboardPlainText } = new Function('Node', `
        const mathManager = { toMarkdown: element => element.textContent };
        ${extractFunction('parseImageAltSizeSpec')}
        ${extractFunction('fragmentToClipboardPlainText')}
        return { parseImageAltSizeSpec, fragmentToClipboardPlainText };
    `)(document.defaultView.Node);
    const snapshot = createImageClipboardSnapshot(html, {
        document,
        imageAltText: image => parseImageAltSizeSpec(image.getAttribute('alt') || '').altText,
        serializePlainText: fragmentToClipboardPlainText
    });
    const writes = [];
    const conversions = [];
    const options = {
        ClipboardItem: class { constructor(data) { this.data = data; } },
        Blob,
        markHtml: html => `<!--manuldown-clipboard-start-->${html}<!--manuldown-clipboard-end-->`,
        rasterizeImage: async image => {
            const src = image.getAttribute('src');
            conversions.push(src);
            return { blob: new Blob([src], { type: 'image/png' }), dataUrl: `data:image/png;base64,${Buffer.from(src).toString('base64')}` };
        },
        clipboard: {
            async write(items) {
                // Consume all the promised representations just as the browser
                // does. Record a write only when every representation succeeds.
                const output = await Promise.all(items.map(async item => Object.fromEntries(
                    await Promise.all(Object.entries(item.data).map(async ([type, value]) => [type, await value]))
                )));
                writes.push(output);
            }
        },
        ...overrides
    };
    return { snapshot, writes, conversions, write: () => writeImageClipboard(snapshot, options) };
}

test('a selected image offers original-size PNG, self-contained HTML and alt text without Markdown syntax', async () => {
    const original = '<p><img src="https://local-resource/one.png" data-md-path="images/one.png" alt="one|120x60" width="120" height="60"></p>';
    const f = await fixture(original);
    assert.equal(f.snapshot.singleImage, true);
    assert.equal(f.snapshot.text, 'one');
    const result = await f.write();
    const formats = f.writes[0][0];
    assert.deepEqual(Object.keys(formats).sort(), ['image/png', 'text/html', 'text/plain']);
    assert.equal(await formats['image/png'].text(), 'https://local-resource/one.png');
    const html = await formats['text/html'].text();
    assert.match(html, /<!--manuldown-clipboard-start--><p><img src="data:image\/png;base64,/);
    assert.match(html, /width="120" height="60"/);
    assert.doesNotMatch(html, /data-md-path|https:\/\/local-resource|!\[/);
    assert.equal(await formats['text/plain'].text(), 'one');
    assert.equal(result.html, f.snapshot.container.innerHTML);
    assert.deepEqual(f.snapshot.originalImages, [{ alt: 'one|120x60', markdownPath: 'images/one.png' }]);
});

test('mixed text and several images retain their order and formatting in one HTML item', async () => {
    const f = await fixture('<p><strong>before</strong><img src="one" data-md-path="one.png" alt="first"></p><p>between<img src="two" alt="second">after</p>');
    assert.equal(f.snapshot.singleImage, false);
    assert.equal(f.snapshot.text, 'beforefirst\nbetweensecondafter');
    await f.write();
    assert.equal(f.writes[0].length, 1);
    const formats = f.writes[0][0];
    assert.equal(formats['image/png'], undefined, 'mixed content must not expose only its first image as a PNG');
    const html = await formats['text/html'].text();
    assert.match(html, /<strong>before<\/strong><img src="data:image\/png;base64,b25l"/);
    assert.match(html, /between<img src="data:image\/png;base64,dHdv" alt="second">after/);
    assert.deepEqual(f.conversions, ['one', 'two']);
});

test('multiple images without text are all embedded rather than copied as multiple native clipboard items', async () => {
    const f = await fixture('<p><img src="one"><img src="two"></p>');
    assert.equal(f.snapshot.singleImage, false);
    await f.write();
    assert.equal(f.writes[0].length, 1);
    assert.equal((await f.writes[0][0]['text/html'].text()).match(/data:image\/png/g).length, 2);
    assert.equal(await f.writes[0][0]['text/plain'].text(), '');
});

test('one image alongside other nontext content is a rich selection', async () => {
    for (const other of ['<hr>', '<input type="checkbox">', '<table><tr><td></td></tr></table>', '<span data-mdw-math="inline"></span>']) {
        const f = await fixture(`<img src="one">${other}`);
        assert.equal(f.snapshot.singleImage, false, other);
    }
});

test('several copies of the same source are decoded once and preserve their separate descriptions', async () => {
    const f = await fixture('<p><img src="one" alt="first"><img src="one" alt="second"></p>');
    await f.write();
    assert.deepEqual(f.conversions, ['one']);
    assert.equal(f.snapshot.originalImages.length, 2);
    assert.equal(f.snapshot.text, 'firstsecond');
});

test('a failed image aborts all representations without partially copying a selection', async () => {
    const f = await fixture('<img src="one"><img src="two">', {
        rasterizeImage: async () => { throw new Error('decode failed'); }
    });
    await assert.rejects(f.write(), /decode failed/);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.snapshot.originalImages.map(image => image.markdownPath), ['one', 'two']);
});

test('blocked and unresolved images never copy a placeholder or request their original remote source', async () => {
    for (const html of ['<img src="placeholder" data-md-path="https://remote/image.png" data-remote-image-blocked="true">', '<img data-md-path="missing.png">']) {
        const f = await fixture(html);
        await assert.rejects(f.write(), /blocked or is not loaded/);
        assert.deepEqual(f.conversions, []);
        assert.deepEqual(f.writes, []);
    }
});

test('a newer copy prevents a delayed image conversion from overwriting it', async () => {
    let finish;
    let current = true;
    const conversion = new Promise(resolve => { finish = resolve; });
    const f = await fixture('<img src="one">', {
        isCurrent: () => current,
        rasterizeImage: () => conversion
    });
    const pending = f.write();
    current = false;
    finish({ blob: new Blob(['png'], { type: 'image/png' }), dataUrl: 'data:image/png;base64,cG5n' });
    await assert.rejects(pending, /superseded/);
    assert.deepEqual(f.writes, []);
});

test('missing clipboard APIs and denied permissions report failure without an unhandled data promise', async () => {
    const unavailable = await fixture('<img src="one">', { clipboard: {} });
    await assert.rejects(unavailable.write(), /unavailable/);
    assert.deepEqual(unavailable.conversions, []);
    const denied = await fixture('<img src="one">', {
        clipboard: { write: () => Promise.reject(new Error('denied')) },
        rasterizeImage: async () => { throw new Error('decode failed'); }
    });
    await assert.rejects(denied.write(), /denied/);
    await new Promise(resolve => setImmediate(resolve));
});

test('the total encoded image size is bounded', async () => {
    const f = await fixture('<img src="one"><img src="two">', {
        rasterizeImage: async () => ({ blob: { size: 11 * 1024 * 1024 }, dataUrl: 'data:image/png;base64,cG5n' })
    });
    await assert.rejects(f.write(), /too large/);
    assert.deepEqual(f.writes, []);
});

test('a text-only selection leaves the normal copy path alone', async () => {
    const f = await fixture('<p>text</p>');
    assert.equal(f.snapshot, null);
});

test('native paste wrappers preserve local image provenance, while changed content never gains trust', () => {
    const document = domino.createWindow().document;
    const html = '<p><img src="data:image/png;base64,cG5n" alt="first|40x20"></p>';
    const candidate = { html, plainText: 'first', images: [{ alt: 'first|40x20', markdownPath: 'one.svg' }], createdAt: Date.now() };
    const trusted = new Function('document', 'trustedClipboardPayload', `
        const TRUSTED_CLIPBOARD_PAYLOAD_MAX_AGE_MS = 5 * 60 * 1000;
        ${extractFunction('normalizeClipboardPlainText')}
        ${extractFunction('getTrustedClipboardPayload')}
        return getTrustedClipboardPayload;
    `)(document, candidate);
    assert.equal(trusted(html, 'first'), candidate);
    assert.equal(trusted(`<html><head></head><body>${html}`, 'first'), candidate);
    for (const changed of [html.replace('cG5n', 'Y2hhbmdlZA=='), html.replace('first|40x20', 'changed'), `${html}<p>extra</p>`, html.replace('<p>', '<p onclick="alert(1)">')]) {
        assert.equal(trusted(changed, 'first'), null);
    }
    assert.equal(trusted(html, 'different text'), null);
    candidate.createdAt = Date.now() - 6 * 60 * 1000;
    assert.equal(trusted(html, 'first'), null);
});
