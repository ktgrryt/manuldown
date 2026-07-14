const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const gateSource = fs.readFileSync(
    path.join(__dirname, '..', 'media', 'modules', 'CompositionUpdateGate.js'),
    'utf8'
);
const gateModulePromise = import(
    `data:text/javascript;base64,${Buffer.from(gateSource).toString('base64')}`
);

async function createGate() {
    const { CompositionUpdateGate } = await gateModulePromise;
    return new CompositionUpdateGate();
}

test('CompositionUpdateGate retains only the newest external change', async () => {
    const gate = await createGate();
    gate.begin();

    assert.equal(gate.defer({ type: 'update', external: true, changeId: 1 }), true);
    assert.equal(gate.defer({ type: 'update', external: true, changeId: 3 }), true);
    assert.equal(gate.defer({ type: 'update', external: true, changeId: 2 }), true);

    const token = gate.end();
    assert.deepEqual(gate.finish(token), {
        type: 'update',
        external: true,
        changeId: 3,
    });
});

test('CompositionUpdateGate also blocks the compositionend finalization window', async () => {
    const gate = await createGate();
    gate.begin();
    const token = gate.end();

    assert.equal(gate.defer({ type: 'update', external: true, changeId: 4 }), true);
    assert.deepEqual(gate.finish(token), {
        type: 'update',
        external: true,
        changeId: 4,
    });
    assert.equal(gate.finish(token), null);
});

test('CompositionUpdateGate invalidates an old finalizer when composition restarts', async () => {
    const gate = await createGate();
    gate.begin();
    const oldToken = gate.end();
    gate.defer({ type: 'update', external: true, changeId: 5 });

    gate.begin();
    assert.equal(gate.finish(oldToken), null);
    const currentToken = gate.end();
    assert.deepEqual(gate.finish(currentToken), {
        type: 'update',
        external: true,
        changeId: 5,
    });
});

test('CompositionUpdateGate carries an invalidated local commit into a table-edge finalizer', async () => {
    const gate = await createGate();
    gate.begin();
    const oldToken = gate.end({ localChange: true });

    gate.begin();
    assert.equal(gate.shouldCommitLocalChange(oldToken), false);
    const currentToken = gate.end({ localChange: false });

    assert.equal(gate.shouldCommitLocalChange(currentToken), true);
    assert.equal(gate.finish(currentToken), null);
    assert.equal(gate.shouldCommitLocalChange(currentToken), false);
});

test('CompositionUpdateGate prefers an explicit refresh for the same change', async () => {
    const gate = await createGate();
    gate.begin();
    gate.defer({ type: 'refresh', external: true, changeId: 6, force: true });
    gate.defer({ type: 'update', external: true, changeId: 6 });
    const token = gate.end();

    assert.deepEqual(gate.finish(token), {
        type: 'refresh',
        external: true,
        changeId: 6,
        force: true,
    });
});

test('CompositionUpdateGate ignores non-external and post-finalization messages', async () => {
    const gate = await createGate();
    assert.equal(gate.defer({ type: 'update', external: true, changeId: 1 }), false);
    gate.begin();
    assert.equal(gate.defer({ type: 'update', external: false, changeId: 2 }), false);
    const token = gate.end();
    assert.equal(gate.finish(token), null);
    assert.equal(gate.defer({ type: 'refresh', external: true, changeId: 3 }), false);
});

test('editor finalizes the local IME revision before replaying an external update', () => {
    const editorSource = fs.readFileSync(
        path.join(__dirname, '..', 'media', 'editor.js'),
        'utf8'
    );

    assert.match(
        editorSource,
        /compositionstart[\s\S]*?compositionUpdateGate\.begin\(\)[\s\S]*?compositionend[\s\S]*?compositionUpdateGate\.end\(\{/
    );
    assert.match(
        editorSource,
        /markdownConverter\.convertMarkdownSyntax\(notifyChange\)[\s\S]*?compositionUpdateGate\.finish\(finalizationToken\)[\s\S]*?handleHostMessage\(pendingExternalMessage\)/,
        'The local revision must advance before a deferred host message is replayed'
    );
    assert.match(
        editorSource,
        /tableManager\.handleEdgeCompositionEnd\(\)[\s\S]*?compositionUpdateGate\.end\(\{[\s\S]*?localChange: !tableEdgeCompositionBlocked[\s\S]*?compositionUpdateGate\.shouldCommitLocalChange\(finalizationToken\)/,
        'An invalidated local commit must carry into the current finalizer'
    );
    assert.match(
        editorSource,
        /if \(tableEdgeCompositionBlocked\)[\s\S]*?finalizeComposition\(\);[\s\S]*?return;/,
        'The table-edge early return must still drain deferred external updates'
    );
    assert.match(
        editorSource,
        /handleHostMessage = \(message\)[\s\S]*?compositionUpdateGate\.defer\(message\)[\s\S]*?switch \(message\.type\)/,
        'External update and refresh messages must be gated before DOM replacement'
    );
});
