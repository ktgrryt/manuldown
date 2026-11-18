const assert = require('node:assert/strict');
const test = require('node:test');
const { openEditor } = require('../helpers/browser-editor');

test('Control+K follows the focused editor and only deletes once per keypress', { timeout: 30_000 }, async t => {
    const { evaluate, key, select, reset, waitFor } = await openEditor(t, 'Keep this paragraph.', { platform: 'MacIntel' });
    const paragraph = "document.querySelector('#editor > p')";
    const ctrlK = "new KeyboardEvent('keydown', {key:'k', ctrlKey:true, bubbles:true, cancelable:true})";

    await t.test('a key sent to a search or language field cannot delete a retained document selection', async () => {
        await reset('Keep this paragraph.\n\n```js\ncode\n```');
        for (const [field, open] of [
            ['.code-block-language-input', "document.querySelector('.code-block-language').click()"],
            ['.search-bar-input', "window.postMessage({type:'openSearch'},'*')"],
        ]) {
            await select(`[${paragraph}.firstChild,5]`);
            await evaluate(open);
            await waitFor(`document.activeElement.matches('${field}')`);
            const accepted = await evaluate(`document.activeElement.dispatchEvent(${ctrlK})`);
            assert.equal(accepted, true, field);
            assert.equal(await evaluate(`${paragraph}.textContent`), 'Keep this paragraph.');
        }
        await key('Escape', 'Escape', 27);
    });

    await t.test('IME owns its composition range', async () => {
        await select(`[${paragraph}.firstChild,5]`);
        const accepted = await evaluate(`document.getElementById('editor').dispatchEvent(new KeyboardEvent('keydown',
            {key:'k',ctrlKey:true,isComposing:true,bubbles:true,cancelable:true}))`);
        assert.equal(accepted, true);
        assert.equal(await evaluate(`${paragraph}.textContent`), 'Keep this paragraph.');
    });

    await t.test('deleting a table from its left edge leaves the next paragraph intact', async () => {
        await reset('| Name |\n| --- |\n| Value |\n\nKeep the next line.');
        const edge = "document.querySelector('#editor .md-table-edge-left')";
        await waitFor(`!!${edge}`);
        await select(`[${edge}.firstChild,0]`);
        await key('k', 'KeyK', 75, 2);
        assert.equal(await evaluate("document.querySelector('#editor table')"), null);
        assert.equal(await evaluate(`${paragraph}.textContent`), 'Keep the next line.');
    });

    await t.test('a duplicate native delete is blocked, and a new Delete key works immediately', async () => {
        for (const freshKey of [false, true]) {
            await reset('Keep this paragraph.');
            await select(`[${paragraph}.firstChild,5]`);
            const accepted = await evaluate(`(() => {
                const editor = document.getElementById('editor');
                editor.dispatchEvent(${ctrlK});
                if (${freshKey}) editor.dispatchEvent(new KeyboardEvent('keydown', {key:'Delete', bubbles:true, cancelable:true}));
                return editor.dispatchEvent(new InputEvent('beforeinput', {inputType:${freshKey ? "'deleteContentForward'" : "'deleteHardLineForward'"}, bubbles:true, cancelable:true}));
            })()`);
            assert.equal(accepted, freshKey);
            assert.equal(await evaluate(`${paragraph}.textContent`), 'Keep ');
        }
    });
    assert.deepEqual(await evaluate('editorErrors'), []);
});
