const assert = require('node:assert/strict');
const test = require('node:test');
const { openEditor } = require('../helpers/browser-editor');

test('macOS Control+K deletes only the active line or selection, and Control+Y restores the text', { timeout: 30_000 }, async t => {
    const { evaluate, key, reset, select, settle, connection, sessionId } = await openEditor(t, '', { platform: 'MacIntel' });
    const editor = "document.getElementById('editor')";
    const control = async name => {
        await key(name, 'Key' + name.toUpperCase(), name.toUpperCase().charCodeAt(0), 2);
        await settle();
    };
    const load = async html => {
        await reset('Seed');
        await evaluate(`(() => {
            const root = ${editor};
            window.insertLines = Array.from(root.querySelectorAll('.md-table-insert-line'));
            for (const node of Array.from(root.childNodes)) {
                if (!insertLines.includes(node)) node.remove();
            }
            root.insertAdjacentHTML('afterbegin', ${JSON.stringify(html)});
        })()`);
    };
    const caretPrefix = () => evaluate(`(() => {
        const range = document.createRange();
        range.selectNodeContents(${editor});
        range.setEnd(getSelection().focusNode, getSelection().focusOffset);
        return range.toString();
    })()`);

    for (const [label, offset, following] of [
        ['beginning of a single root text line', 0, ''],
        ['middle of a single root text line', 1, ''],
        ['beginning before a second paragraph', 0, '<div id="next">次の行</div>'],
        ['middle before a second paragraph', 1, '<div id="next">次の行</div>'],
        ['end before a second paragraph', 3, '<div id="next">次の行</div>'],
    ]) {
        await t.test(label, async () => {
            const first = '日本語';
            if (following) {
                await load(first + following);
            } else {
                await reset('');
                await evaluate(`window.insertLines = Array.from(${editor}.querySelectorAll('.md-table-insert-line')); ${editor}.focus()`);
                await connection.send('Input.insertText', { text: first }, sessionId);
                await settle();
            }
            await select(`[${editor}.firstChild,${offset}]`);
            await control('k');
            const expectedPrefix = first.slice(0, offset);
            const expectedNext = following ? '次の行' : '';
            assert.equal(await evaluate(`${editor}.textContent`), expectedPrefix + expectedNext);
            assert.equal(await caretPrefix(), expectedPrefix);
            assert.equal(await evaluate(`insertLines.every(line => line.parentNode === ${editor})`), true);
            if (following) assert.equal(await evaluate("document.getElementById('next').textContent"), expectedNext);
            if (offset < first.length) {
                await control('y');
                assert.equal(await evaluate(`${editor}.textContent`), first + expectedNext);
                if (following) assert.equal(await evaluate("document.getElementById('next').textContent"), expectedNext);
            }
        });
    }

    await t.test('an editor boundary before root text keeps the next paragraph intact', async () => {
        await load('日本語<div id="next">次の行</div>');
        await select(`[${editor},0]`);
        await control('k');
        assert.equal(await evaluate(`${editor}.textContent`), '次の行');
        assert.equal(await caretPrefix(), '');
        await control('y');
        assert.equal(await evaluate(`${editor}.textContent`), '日本語次の行');
        assert.equal(await evaluate("document.getElementById('next').textContent"), '次の行');
    });

    await t.test('the root boundary after typed text stays on that line when controls precede the next block', async () => {
        await load('日本語');
        await evaluate(`${editor}.insertAdjacentHTML('beforeend', '<div>次の行</div>')`);
        await select(`[${editor},1]`);
        await control('k');
        assert.equal(await evaluate(`${editor}.textContent`), '日本語次の行');
        assert.equal(await caretPrefix(), '日本語');
    });

    for (const [label, offset] of [['middle of a hard-broken line', 1], ['end of a hard-broken line', 3]]) {
        await t.test(label, async () => {
            await load('<p>日本語<br><strong>次の行</strong></p>');
            await select(`[${editor}.querySelector('p').firstChild,${offset}]`);
            await control('k');
            assert.equal(await evaluate(`${editor}.querySelector('p').innerText`), '日本語'.slice(0, offset) + '\n次の行');
            assert.equal(await evaluate(`${editor}.querySelector('br + strong').textContent`), '次の行');
            assert.equal(await caretPrefix(), '日本語'.slice(0, offset));
            if (offset === 1) {
                await control('y');
                assert.equal(await evaluate(`${editor}.querySelector('p').innerText`), '日本語\n次の行');
            }
        });
    }

    await t.test('a root line containing inline formatting keeps its prefix and the following paragraph', async () => {
        await load('日<strong>本語</strong>です<div id="next">続き</div>');
        await select(`[${editor}.querySelector('strong').firstChild,1]`);
        await control('k');
        assert.equal(await evaluate(`${editor}.textContent`), '日本続き');
        assert.equal(await evaluate(`${editor}.querySelector('strong').textContent`), '本');
        assert.equal(await caretPrefix(), '日本');
        await control('y');
        assert.equal(await evaluate(`${editor}.textContent`), '日本語です続き');
    });

    await t.test('yanking a whole hard-broken line at an element boundary keeps the authored break', async () => {
        await load('<p>日本語<br>次の行</p>');
        await select(`[${editor}.querySelector('p'),0]`);
        await control('k');
        assert.equal(await evaluate(`${editor}.querySelector('p').innerText`), '\n次の行');
        await control('y');
        assert.equal(await evaluate(`${editor}.querySelector('p').innerText`), '日本語\n次の行');
    });

    await t.test('a second kill on the resulting empty line removes just its break', async () => {
        await load('<p>最初<br>次の行</p>');
        await select(`[${editor}.querySelector('p').firstChild,0]`);
        await control('k');
        await control('k');
        assert.equal(await evaluate(`${editor}.querySelector('p').innerText`), '次の行');
        await control('y');
        assert.equal(await evaluate(`${editor}.querySelector('p').innerText`), '\n次の行');
    });

    await t.test('a nested native block starts a new line', async () => {
        await load('<div>最初<div>次の行</div></div>');
        await select(`[${editor}.firstChild.firstChild,1]`);
        await control('k');
        assert.equal(await evaluate(`${editor}.firstChild.innerText`), '最\n次の行');
    });

    await t.test('removing a blank paragraph between lists leaves the caret in the next item', async () => {
        await load('<ul><li>前</li></ul><p><br></p><ul><li id="next">次</li></ul>');
        await select(`[${editor}.querySelector('p'),0]`);
        await control('k');
        assert.equal(await evaluate(`${editor}.querySelector('p') === null`), true);
        assert.equal(await evaluate(`${editor}.querySelector('#next').contains(getSelection().focusNode)`), true);
        assert.equal(await caretPrefix(), '前');
    });

    await t.test('a suffix containing only spaces is killed and yanked', async () => {
        await load('<p>日本語   </p><p>続き</p>');
        await select(`[${editor}.firstChild.firstChild,3]`);
        await control('k');
        assert.equal(await evaluate(`${editor}.firstChild.textContent`), '日本語');
        await control('y');
        const text = await evaluate(`${editor}.firstChild.textContent`);
        assert.equal(text.replace(/\u00a0/g, ' '), '日本語   ');
    });

    await t.test('a line containing only spaces retains the part before the caret', async () => {
        await load('<p>&nbsp;&nbsp;&nbsp;</p><p>次の行</p>');
        await select(`[${editor}.firstChild.firstChild,1]`);
        await control('k');
        assert.equal(await evaluate(`${editor}.firstChild.textContent`), '\u00a0');
        assert.equal(await evaluate(`${editor}.children[1].textContent`), '次の行');
    });

    await t.test('Undo and Redo restore a first-line edit and its caret', async () => {
        await reset('');
        await evaluate(`${editor}.focus()`);
        await connection.send('Input.insertText', { text: '日本語' }, sessionId);
        await select(`[${editor}.firstChild,1]`);
        await control('k');
        await evaluate("window.postMessage({type:'historyCommand',direction:'undo'},'*')");
        await settle();
        assert.equal(await evaluate(`${editor}.textContent`), '日本語');
        assert.equal(await caretPrefix(), '日');
        await evaluate("window.postMessage({type:'historyCommand',direction:'redo'},'*')");
        await settle();
        assert.equal(await evaluate(`${editor}.textContent`), '日');
        assert.equal(await caretPrefix(), '日');
    });

    await t.test('a backward selection ends before the unselected suffix', async () => {
        await load('<p>日本語の文章</p><p>続き</p>');
        await select(`[${editor}.firstChild.firstChild,4]`);
        await evaluate(`getSelection().extend(${editor}.firstChild.firstChild,1)`);
        await control('k');
        assert.equal(await evaluate(`${editor}.textContent`), '日文章続き');
        assert.equal(await caretPrefix(), '日');
        await control('y');
        assert.equal(await evaluate(`${editor}.textContent`), '日本語の文章続き');
    });
    await t.test('a code element boundary kills only the current line and preserves whitespace-only lines', async () => {
        const code = `${editor}.querySelector('pre code')`;
        for (const remaining of ['next\n', '    \n\n']) {
            await load(`<pre><code>first\n${remaining}</code></pre><p>after</p>`);
            await select(`[${code},0]`);
            await control('k');
            assert.equal(await evaluate(`${code}.textContent`), '\n' + remaining);
            assert.equal(await evaluate(`${code}.contains(getSelection().focusNode)`), true);
            await control('y');
            assert.equal(await evaluate(`${code}.textContent`), 'first\n' + remaining);
        }
    });
    await t.test('a kill at the end of a cell preserves the next cell and paragraph', async () => {
        await reset('| A | B |\n| --- | --- |\n| 左 | 右 |\n\n次の段落');
        for (const index of [0, 1]) {
            await select(`(() => { const cell = ${editor}.querySelectorAll('td')[${index}];
                const text = Array.from(cell.childNodes).find(n => n.nodeType === Node.TEXT_NODE && n.length);
                return [text, text.length]; })()`);
            await control('k');
            assert.deepEqual(await evaluate(`Array.from(${editor}.querySelectorAll('td'), td => td.textContent)`), ['左', '右']);
            assert.equal(await evaluate(`${editor}.querySelector('p:last-of-type').textContent`), '次の段落');
            assert.equal(await evaluate(`${editor}.querySelectorAll('td')[${index}].contains(getSelection().focusNode)`), true);
        }
    });
    assert.deepEqual(await evaluate('editorErrors'), []);
});
