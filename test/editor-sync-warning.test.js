const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../media/editor.js'), 'utf8');

function createSyncWarningHarness() {
    const warning = { hidden: true, textContent: '' };
    const helperStart = source.indexOf('    function syncUpdateFailureWarning(');
    const helperEnd = source.indexOf('\n    }\n', helperStart) + 6;
    const casesStart = source.indexOf("            case 'updateApplied':");
    const casesEnd = source.indexOf("            case 'update':", casesStart);
    assert.ok(helperStart >= 0 && helperEnd > helperStart && casesStart >= 0 && casesEnd > casesStart);
    const receive = new Function('document', `
        let acknowledgedUpdateRevision = 0;
        let failedUpdateRevision = 0;
        let failedUpdateReason = 'conversion';
        ${source.slice(helperStart, helperEnd)}
        return message => {
            switch (message.type) {
                ${source.slice(casesStart, casesEnd)}
            }
        };
    `)({ getElementById: () => warning });
    return { warning, receive };
}

test('an apply failure stays visible until its revision or a newer edit is acknowledged', () => {
    const { warning, receive } = createSyncWarningHarness();
    receive({ type: 'updateFailed', revision: 3, reason: 'apply' });
    assert.equal(warning.hidden, false);
    assert.match(warning.textContent, /could not be applied/);
    assert.match(warning.textContent, /try saving again/);

    receive({ type: 'updateApplied', revision: 2 });
    assert.equal(warning.hidden, false);
    receive({ type: 'updateApplied', revision: 4 });
    assert.equal(warning.hidden, true);
    receive({ type: 'updateFailed', revision: 3, reason: 'apply' });
    assert.equal(warning.hidden, true, 'a delayed failure cannot revive an acknowledged warning');
});

test('the warning follows the latest failure reason without older messages replacing it', () => {
    const { warning, receive } = createSyncWarningHarness();
    receive({ type: 'updateFailed', revision: 1 });
    assert.match(warning.textContent, /could not be converted/);
    receive({ type: 'updateFailed', revision: 2, reason: 'apply' });
    assert.match(warning.textContent, /could not be applied/);
    receive({ type: 'updateFailed', revision: 1 });
    assert.match(warning.textContent, /could not be applied/);
    receive({ type: 'updateFailed', revision: 3 });
    assert.match(warning.textContent, /could not be converted/);
    receive({ type: 'updateApplied', revision: 3 });
    assert.equal(warning.hidden, true);
});
