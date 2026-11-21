const assert = require('node:assert/strict');
const test = require('node:test');
const { openEditor } = require('../helpers/browser-editor');

test('Control+E moves from inline code to the end of the current line', { timeout: 30_000 }, async t => {
    const source = [
        '`code only`',
        'Before **`hard break`**  \nNext line',
        'Before `with suffix` and **some text**',
        'Before $x$ and **`after math`**',
        '| First | Second |\n| --- | --- |\n| `cell code` suffix | **`cell end`** |',
    ].join('\n\n');
    const { evaluate, key, settle, select, connection, sessionId } = await openEditor(t, source, { platform: 'MacIntel' });

    const code = text => `Array.from(document.querySelectorAll('#editor code')).find(node => node.textContent.startsWith(${JSON.stringify(text)}))`;
    const moveToLineEnd = async (text, atCodeEnd = false) => {
        await select(`(() => { const node = ${code(text)}.firstChild; return [node, ${atCodeEnd ? 'node.length' : 1}]; })()`);
        await key('e', 'KeyE', 69, 2);
        await settle();
    };
    const assertAtTextEnd = async expression => {
        assert.equal(await evaluate(`(() => {
            const node = ${expression};
            const selection = getSelection();
            return selection.anchorNode === node && selection.anchorOffset === node.length;
        })()`), true);
    };

    await t.test('typing after a line-ending code span inserts plain text at the line end', async () => {
        for (const [text, blockSelector, hasBreak] of [
            ['code only', 'p', false],
            ['hard break', 'p', true],
            ['after math', 'p', false],
            ['cell end', 'td', false],
        ]) {
            await moveToLineEnd(text, text === 'cell end');
            await connection.send('Input.insertText', { text: '!' }, sessionId);
            await settle();
            assert.deepEqual(await evaluate(`(() => {
                const code = ${code(text)};
                const block = code.closest('${blockSelector}');
                const inserted = ${hasBreak ? "block.querySelector('br').previousSibling" : 'block.lastChild'};
                return [code.textContent, inserted.nodeType === Node.TEXT_NODE ? inserted.textContent.replaceAll('\u200b', '') : null];
            })()`), [text, '!'], text);
        }
    });

    await t.test('text after the code is included in the line movement', async () => {
        await moveToLineEnd('with suffix');
        await assertAtTextEnd(`${code('with suffix')}.closest('p').lastElementChild.firstChild`);

        for (const atCodeEnd of [false, true]) {
            await moveToLineEnd('cell code', atCodeEnd);
            await assertAtTextEnd(`${code('cell code')}.nextSibling`);
        }
    });
    assert.deepEqual(await evaluate('editorErrors'), []);
});
