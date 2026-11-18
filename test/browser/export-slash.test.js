const assert = require('node:assert/strict');
const test = require('node:test');
const { openEditor } = require('../helpers/browser-editor');

test('the toolbar offers one Export entry that opens the format picker', async t => {
    const { evaluate, waitFor } = await openEditor(t, '本文');
    await evaluate("document.querySelector('.toolbar-overflow-toggle').click()");
    const menu = "document.querySelector('.toolbar-overflow-menu')";
    await waitFor('!' + menu + '.hidden');
    assert.deepEqual(await evaluate(`Array.from(${menu}.querySelectorAll('[data-command^="export"]:not([hidden])'), item => item.textContent)`), ['Export']);
    await evaluate(menu + '.querySelector(\'[data-command="export"]\').click()');
    assert.deepEqual(await evaluate("hostMessages.map(m => m.type).filter(type => ['chooseExport', 'exportHtml', 'exportWord', 'openPdfPreview'].includes(type))"), ['chooseExport']);
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
