const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'media', 'editor.js'), 'utf8');

function extractFunction(name) {
    const start = source.indexOf(`    function ${name}(`);
    const end = source.indexOf('\n    }\n', start);
    assert.ok(start >= 0 && end > start, `${name} exists`);
    return source.slice(start, end + '\n    }'.length);
}

function extractListener(target, event) {
    const start = source.indexOf(`        ${target}.addEventListener('${event}', () => {`);
    const end = source.indexOf('\n        });', start);
    assert.ok(start >= 0 && end > start, `${event} listener exists`);
    return source.slice(start, end + '\n        });'.length);
}

function rect(left, top, width, height) {
    return { left, top, right: left + width, bottom: top + height, width, height };
}

function fixture() {
    const caretRect = rect(320, 760, 0, 22);
    const range = { getClientRects: () => [caretRect] };
    let match = { range, query: '' };
    const listeners = {};
    const editor = { addEventListener: (name, callback) => { listeners[name] = callback; } };
    const window = {
        innerWidth: 1280, innerHeight: 720, scrollX: 0, scrollY: 0,
        addEventListener: (name, callback) => { listeners[name] = callback; }
    };
    const menu = {
        style: { display: 'block' },
        getBoundingClientRect: () => rect(
            parseFloat(menu.style.left) - window.scrollX,
            parseFloat(menu.style.top) - window.scrollY,
            220, 200
        )
    };
    const items = [{ id: 'link' }, { id: 'toc' }];
    const state = { visible: true, match, items, activeIndex: 1, query: '' };
    const noop = () => {};
    const position = new Function(
        'editor', 'window', 'slashMenu', 'slashMenuState', 'getSlashCommandMatch', 'hideSlashCommandMenu',
        'syncImageResizeOverlayPosition', 'repositionLinkPopoverWithinViewport', 'scheduleEditorOverflowStateUpdate',
        `${extractFunction('positionSlashMenu')}
        ${extractFunction('repositionSlashCommandMenu')}
        ${extractListener('editor', 'scroll')}
        ${extractListener('window', 'resize')}
        return positionSlashMenu;`
    )(editor, window, menu, state, () => match, () => {
        state.visible = false;
        menu.style.display = 'none';
    }, noop, noop, noop);
    position(range);
    return { menu, state, items, window, caretRect, listeners, setMatch(next) { match = next; } };
}

test('auto-scroll after typing / at the document end keeps the command menu visible above the caret', () => {
    const f = fixture();
    f.caretRect.top = 670;
    f.caretRect.bottom = 692;
    f.listeners.scroll();
    assert.equal(f.state.visible, true);
    assert.equal(f.menu.style.display, 'block');
    assert.equal(f.menu.style.top, '466px');
    assert.ok(parseFloat(f.menu.style.top) + 200 <= f.window.innerHeight - 8);
    assert.equal(f.state.activeIndex, 1);
    assert.ok(f.state.items === f.items, 'scrolling preserves candidates and keyboard selection');
});

test('scrolling follows the live slash range instead of its previous position', () => {
    const f = fixture();
    const range = { getClientRects: () => [rect(120, 160, 0, 22)] };
    const match = { query: '', range };
    f.setMatch(match);
    f.listeners.scroll();
    assert.equal(f.menu.style.left, '120px');
    assert.equal(f.menu.style.top, '186px');
    assert.ok(f.state.match === match);
});

test('scrolling closes an obsolete menu when the selection no longer matches a slash command', () => {
    const f = fixture();
    f.setMatch(null);
    f.listeners.scroll();
    assert.equal(f.state.visible, false);
    assert.equal(f.menu.style.display, 'none');
});

test('scrolling or resizing does not reopen a menu dismissed with Escape', () => {
    const f = fixture();
    f.state.visible = false;
    f.menu.style.display = 'none';
    const top = f.menu.style.top;
    f.caretRect.top = 200;
    f.caretRect.bottom = 222;
    f.listeners.scroll();
    f.listeners.resize();
    assert.equal(f.state.visible, false);
    assert.equal(f.menu.style.display, 'none');
    assert.equal(f.menu.style.top, top);
});

test('resizing keeps a visible menu above the bottom caret and within the horizontal viewport', () => {
    const f = fixture();
    f.window.innerWidth = 400;
    f.window.innerHeight = 420;
    f.caretRect.top = 380;
    f.caretRect.bottom = 402;
    f.listeners.resize();
    assert.equal(f.state.visible, true);
    assert.equal(f.menu.style.top, '176px');
    assert.equal(f.menu.style.left, '172px');
});
