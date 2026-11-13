const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const headingSource = fs.readFileSync(path.join(__dirname, '..', 'media/modules/MarkdownHeadingSlug.js'), 'utf8');
const managerSource = fs.readFileSync(path.join(__dirname, '..', 'media/modules/TableOfContentsManager.js'), 'utf8')
    .replace("'./MarkdownHeadingSlug.js'", JSON.stringify(moduleUrl(headingSource)));
const managerModule = import(moduleUrl(managerSource));

async function fixture({ height = 180, offsets = [12, 120, 500], itemHeight = 24 } = {}) {
    const { TableOfContentsManager } = await managerModule;
    const window = domino.createWindow('<div class="editor-container"><div id="editor">' +
        '<h2>Keep exploring</h2><h2>数式のサンプル</h2><h3>総和</h3></div>' +
        '<div id="toc-container"><div id="toc-content">' +
        '<div class="toc-item">Keep exploring</div><div class="toc-item">数式のサンプル</div>' +
        '<div class="toc-item">総和</div></div></div></div>');
    const document = window.document;
    const outer = document.querySelector('.editor-container');
    const editor = document.getElementById('editor');
    const tocContainer = document.getElementById('toc-container');
    const tocContent = document.getElementById('toc-content');
    const items = Array.from(tocContent.children);
    let tocScrollTop = 0;
    const writes = [];
    Object.defineProperties(tocContent, {
        clientTop: { value: 1 }, clientHeight: { value: height }, scrollHeight: { value: 1000 },
        scrollTop: {
            get: () => tocScrollTop,
            set(value) { tocScrollTop = value; writes.push(value); },
        },
    });
    tocContent.getBoundingClientRect = () => ({ top: 100, bottom: 102 + height });
    items.forEach((item, index) => {
        item.getBoundingClientRect = () => {
            const top = 101 + offsets[index] - tocScrollTop;
            return { top, bottom: top + itemHeight, height: itemHeight };
        };
    });
    Object.defineProperties(editor, { clientWidth: { value: 400 }, scrollHeight: { value: 2000 } });
    outer.scrollTop = 17;
    outer.scrollLeft = 9;
    editor.scrollTop = 820;
    document.body.scrollTop = 7;
    document.documentElement.scrollTop = 5;
    const selection = { anchorNode: editor.firstChild.firstChild, anchorOffset: 4 };
    window.getSelection = () => selection;
    let nativeRevealCalls = 0;
    items.forEach(item => {
        // Native reveal is allowed to scroll every ancestor, including a hidden
        // overflow container. Model that side effect so using it fails the test.
        item.scrollIntoView = () => {
            nativeRevealCalls++;
            outer.scrollTop += 20;
            outer.scrollLeft += 10;
            document.body.scrollTop += 20;
            document.documentElement.scrollTop += 20;
        };
    });
    const manager = new TableOfContentsManager(editor, tocContainer, tocContent, null);
    manager.headings = Array.from(editor.children);
    manager.headingTops = [0, 400, 800];
    manager.tocItems = items;
    manager.lastMeasuredClientWidth = editor.clientWidth;
    manager.lastMeasuredScrollHeight = editor.scrollHeight;
    const outsideScroll = () => ({
        editor: editor.scrollTop, outer: outer.scrollTop, outerLeft: outer.scrollLeft,
        body: document.body.scrollTop, root: document.documentElement.scrollTop,
    });
    return {
        manager, tocContent, items, writes, selection, outsideScroll,
        get nativeRevealCalls() { return nativeRevealCalls; },
    };
}

test('following a late heading reveals only its TOC item without scrolling editor ancestors', async () => {
    const f = await fixture();
    const before = f.outsideScroll();
    const anchor = f.selection.anchorNode;
    f.manager.updateActiveFromScroll();
    assert.equal(f.manager.activeIndex, 2);
    assert.equal(f.items[2].classList.contains('active'), true);
    assert.equal(f.tocContent.scrollTop, 344);
    assert.deepEqual(f.outsideScroll(), before);
    assert.equal(f.nativeRevealCalls, 0);
    assert.equal(f.selection.anchorNode === anchor, true);
    assert.equal(f.selection.anchorOffset, 4);

    f.manager.setActiveIndex(0);
    assert.equal(f.tocContent.scrollTop, 12);
    assert.deepEqual(f.outsideScroll(), before);
});

test('an already visible TOC item does not rewrite its scroll position', async () => {
    const f = await fixture();
    f.tocContent.scrollTop = 40;
    f.writes.length = 0;
    f.manager.setActiveIndex(1);
    assert.equal(f.tocContent.scrollTop, 40);
    assert.deepEqual(f.writes, []);
    assert.equal(f.nativeRevealCalls, 0);
});

test('explicitly skipping TOC reveal changes the active item without scrolling', async () => {
    const f = await fixture();
    const before = f.outsideScroll();
    f.manager.setActiveIndex(2, { scrollIntoView: false });
    assert.equal(f.items[2].classList.contains('active'), true);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.outsideScroll(), before);
    assert.equal(f.nativeRevealCalls, 0);
});

test('an item taller than the TOC viewport stays stable across repeated active-heading changes', async () => {
    const f = await fixture({ offsets: [80, 120, 80], itemHeight: 240 });
    const before = f.outsideScroll();
    f.manager.setActiveIndex(2);
    assert.equal(f.tocContent.scrollTop, 80);
    for (let i = 0; i < 5; i++) {
        f.manager.setActiveIndex(0);
        f.manager.setActiveIndex(2);
    }
    assert.deepEqual(f.writes, [80]);
    assert.deepEqual(f.outsideScroll(), before);
});

test('a hidden TOC does not try to reveal its active item', async () => {
    const f = await fixture({ height: 0 });
    f.manager.setActiveIndex(2);
    assert.equal(f.items[2].classList.contains('active'), true);
    assert.deepEqual(f.writes, []);
    assert.equal(f.nativeRevealCalls, 0);
});
