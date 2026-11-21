const assert = require('node:assert/strict');
const test = require('node:test');
const { openEditor } = require('../helpers/browser-editor');

test('hovering over Export opens the format menu over the edge of the tools menu', async t => {
    const { evaluate, waitFor, key, connection, sessionId, settle, select } = await openEditor(t, '本文');
    await select("[document.querySelector('#editor p').firstChild, 2]");
    const toggle = "document.querySelector('.toolbar-overflow-toggle')";
    const overflow = "document.querySelector('.toolbar-overflow-menu')";
    const trigger = `${overflow}.querySelector('[data-command="export"]')`;
    const formats = "document.getElementById('toolbar-export-menu')";
    const actions = () => evaluate("hostMessages.map(m => m.type).filter(type => ['chooseExport', 'openPdfPreview', 'exportHtml', 'exportWord'].includes(type))");
    const getPoint = element => evaluate(`(() => {
        const button = ${element};
        button.scrollIntoView({ block: 'nearest' });
        const rect = button.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    const hover = async element => {
        const point = await getPoint(element);
        await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, sessionId);
    };
    const click = async element => {
        const point = await getPoint(element);
        await connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }, sessionId);
        await connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }, sessionId);
    };
    const pressEnter = async () => {
        const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
        await connection.send('Input.dispatchKeyEvent', { type: 'keyDown', ...enter, text: '\r' }, sessionId);
        await connection.send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter }, sessionId);
    };
    const openFormats = async side => {
        await click(toggle);
        const height = await evaluate(`${overflow}.scrollHeight`);
        await hover(trigger);
        assert.equal(await evaluate(`${trigger}.getAttribute('aria-expanded')`), 'true');
        assert.equal(await evaluate('document.activeElement.id'), 'editor', 'Hover preserves editor focus');
        const { button, menu, parent, viewport } = await evaluate(`({
            button: ${trigger}.getBoundingClientRect().toJSON(),
            menu: ${formats}.getBoundingClientRect().toJSON(),
            parent: ${overflow}.getBoundingClientRect().toJSON(),
            viewport: { width: innerWidth, height: innerHeight }
        })`);
        const overlap = side === 'right' ? parent.right - menu.left : menu.right - parent.left;
        assert.ok(overlap >= 5 && overlap <= 7, `The format menu slightly overlaps the ${side} edge`);
        const top = Math.min(Math.max(parent.top, button.top), viewport.height - 8 - menu.height);
        assert.ok(Math.abs(menu.top - top) < 1, 'The menu lines up with Export when space permits');
        assert.ok(menu.left >= 0 && menu.top >= 0 && menu.right <= viewport.width && menu.bottom <= viewport.height);
        assert.equal(await evaluate(`${overflow}.scrollHeight`), height);
    };
    await openFormats('right');
    assert.deepEqual(await evaluate(`Array.from(${formats}.children, item => item.textContent)`), ['PDF', 'HTML', 'DOCX']);
    await hover(`${formats}.querySelector('[data-command="exportPdf"]')`);
    await evaluate('new Promise(resolve => setTimeout(resolve, 200))');
    assert.ok(await evaluate(`!${formats}.hidden && ${formats}.matches(':hover')`));
    await hover(`${overflow}.querySelector('[data-command="settings"]')`);
    await waitFor(`${formats}.hidden && !${overflow}.hidden`);

    await hover(trigger);
    await click(trigger);
    assert.equal(await evaluate('document.activeElement.textContent'), 'PDF');
    await key('Escape', 'Escape', 27);
    assert.ok(await evaluate(`${formats}.hidden && !${overflow}.hidden && document.activeElement === ${trigger}`));
    assert.deepEqual(await actions(), []);
    await key('ArrowRight', 'ArrowRight', 39);
    assert.equal(await evaluate('document.activeElement.textContent'), 'PDF');
    await pressEnter();
    assert.deepEqual(await actions(), ['openPdfPreview']);
    assert.ok(await evaluate(`${formats}.hidden && ${overflow}.hidden`));

    await connection.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 240, deviceScaleFactor: 1, mobile: false }, sessionId);
    await settle();
    await openFormats('left');
    await click(trigger);
    await key('ArrowDown', 'ArrowDown', 40);
    await pressEnter();
    assert.deepEqual(await actions(), ['openPdfPreview', 'exportHtml']);
    await openFormats('left');
    await hover(`${formats}.querySelector('[data-command="exportWord"]')`);
    await click(`${formats}.querySelector('[data-command="exportWord"]')`);
    assert.deepEqual(await actions(), ['openPdfPreview', 'exportHtml', 'exportWord']);
    assert.ok(await evaluate(`${formats}.hidden && ${overflow}.hidden`));
});

test('slash export synchronizes the text and opens the chosen export once', async t => {
    const { evaluate, waitFor, key, select, reset, connection, sessionId } = await openEditor(t, '本文');
    const formats = ['openPdfPreview', 'exportHtml', 'exportWord'];
    for (const [index, expected] of formats.entries()) {
        await reset('本文');
        await select("[document.querySelector('#editor p').firstChild, 2]");
        await evaluate('window.hostMessages.length = 0');
        await connection.send('Input.insertText', { text: ' /export' }, sessionId);
        const items = "document.querySelectorAll('.slash-command-menu:not(.insert-command-menu) .slash-command-name')";
        await waitFor(items + '.length === 3');
        assert.deepEqual(await evaluate('Array.from(' + items + ', item => item.textContent)'),
            ['/export-pdf', '/export-html', '/export-word']);
        for (let step = 0; step < index; step++) await key('ArrowDown', 'ArrowDown', 40);
        await key('Enter', 'Enter', 13);
        const messages = await evaluate('window.hostMessages');
        assert.deepEqual(messages.filter(message => formats.includes(message.type)).map(message => message.type), [expected]);
        const beforeExport = messages.slice(0, messages.findIndex(message => message.type === expected));
        const content = beforeExport.filter(message => message.type === 'update').at(-1).content;
        assert.match(content, /本文/);
        assert.doesNotMatch(content, /\/export/);
    }
});
