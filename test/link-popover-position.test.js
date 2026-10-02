const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const editorSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'editor.js'), 'utf8');
const caretScrollSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'modules', 'CaretScroll.js'), 'utf8');
const caretScrollModule = import(`data:text/javascript;base64,${Buffer.from(caretScrollSource).toString('base64')}`);

function extractFunction(name) {
    const start = editorSource.indexOf(`        function ${name}(`);
    assert.ok(start >= 0, `${name} exists`);
    const end = editorSource.indexOf('\n        }\n', start);
    assert.ok(end > start);
    return editorSource.slice(start, end + '\n        }'.length);
}

function rect(left, top, width, height) {
    return { left, top, right: left + width, bottom: top + height, width, height };
}

async function fixture({ measuredRect = null, elementRect = null, existingLinkRect = null } = {}) {
    const { isUsableCaretRect } = await caretScrollModule;
    const editor = { getBoundingClientRect: () => rect(0, 46, 1280, 674) };
    const element = elementRect ? { getBoundingClientRect: () => elementRect } : editor;
    const range = { startContainer: element };
    const popover = { style: { display: 'flex' }, getBoundingClientRect: () => rect(0, 0, 560, 80) };
    const window = {
        innerWidth: 1280, innerHeight: 720, scrollX: 0, scrollY: 0,
        getComputedStyle: (target) => target === editor
            ? { paddingLeft: '20px', paddingTop: '40px', lineHeight: '22.4px' }
            : { paddingLeft: '0px', paddingTop: '0px', lineHeight: '22.4px' }
    };
    const currentLink = existingLinkRect ? { getBoundingClientRect: () => existingLinkRect } : null;
    const position = new Function(
        'editor', 'window', 'linkPopover', 'currentLink', 'linkCreationRange',
        'measureCaretRangeRect', 'getNodeElement', 'isUsableCaretRect',
        `${extractFunction('getLinkPopoverAnchorRect')}\n${extractFunction('repositionLinkPopoverWithinViewport')}\nreturn repositionLinkPopoverWithinViewport;`
    )(editor, window, popover, currentLink, currentLink ? null : range,
        () => measuredRect, (node) => node, isUsableCaretRect);
    return { editor, window, popover, range, position };
}

test('link entry in an empty editor uses the padded first line instead of the page origin', async () => {
    const f = await fixture();
    f.position();
    assert.equal(f.popover.style.left, '20px');
    assert.equal(f.popover.style.top, '112.4px');
});

test('after /link is removed, a zero caret rectangle falls back to its paragraph', async () => {
    const f = await fixture({ measuredRect: rect(0, 0, 0, 0), elementRect: rect(20, 240, 800, 0) });
    f.position();
    assert.equal(f.popover.style.left, '20px');
    assert.equal(f.popover.style.top, '266.4px');
    // Clearing or displaying suggestions repositions the same input.
    f.position();
    assert.equal(f.popover.style.top, '266.4px');
});

test('measured caret and selected text geometry is preserved', async () => {
    for (const measuredRect of [rect(320, 200, 0, 22), rect(320, 200, 160, 44)]) {
        const f = await fixture({ measuredRect });
        f.position();
        assert.equal(f.popover.style.left, '320px');
        assert.equal(f.popover.style.top, `${measuredRect.bottom + 4}px`);
    }
});

test('bottom-edge insertion opens above the caret and stays inside the viewport', async () => {
    const f = await fixture({ measuredRect: rect(1200, 690, 0, 22) });
    f.position();
    assert.equal(f.popover.style.top, '606px');
    assert.equal(f.popover.style.left, '712px');
    assert.ok(parseFloat(f.popover.style.top) + 80 <= f.window.innerHeight - 8);
});

test('scrolling cannot place the link input under the toolbar or outside the viewport', async () => {
    for (const top of [-200, 0, 900]) {
        const f = await fixture({ measuredRect: rect(20, top, 0, 22) });
        f.position();
        assert.ok(parseFloat(f.popover.style.top) >= 54);
        assert.ok(parseFloat(f.popover.style.top) + 80 <= 712);
    }
});

test('existing-link editing follows the anchor after scroll and viewport resize', async () => {
    const anchor = rect(320, 200, 80, 22);
    const f = await fixture({ existingLinkRect: anchor });
    f.position();
    assert.equal(f.popover.style.top, '226px');
    anchor.top = 100;
    anchor.bottom = 122;
    f.window.innerWidth = 600;
    f.position();
    assert.equal(f.popover.style.top, '126px');
    assert.equal(f.popover.style.left, '32px');
});

test('hidden link inputs are not repositioned', async () => {
    const f = await fixture();
    f.popover.style.display = 'none';
    f.position();
    assert.equal(f.popover.style.top, undefined);
});
