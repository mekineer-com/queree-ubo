import assert from 'node:assert/strict';

const deletedURLs = [];
let visitResponses = [];
let visitReads = 0;
let rejectDeletion = false;

globalThis.browser = {
    history: {
        deleteUrl: async ({ url }) => {
            deletedURLs.push(url);
            if ( rejectDeletion ) { throw new Error('History deletion failed'); }
        },
        getVisits: async ( ) => {
            visitReads += 1;
            const response = visitResponses.shift();
            return typeof response === 'function' ? response() : response;
        },
    },
};

const {
    beginInspectionHistory,
    discardInspectionHistory,
    finishInspectionHistory,
    observeHistoryCommit,
    setInspectionHistoryEnabled,
    trackInspectionRedirect,
} = await import('../../src/js/queree/inspection-history.js');

const baseURL = 'https://example.test/inspection-';
let tabId = 0;
const freshVisit = () => [ { visitTime: Date.now() } ];
const commit = (id, url) => observeHistoryCommit({ tabId: id, frameId: 0, url });

function deferredRead() {
    let resolve, started;
    const promise = new Promise(yes => { resolve = yes; });
    const reading = new Promise(yes => { started = yes; });
    return { resolve, reading, read: () => { started(); return promise; } };
}

async function run({ initial = [], final = [], inspect = true, ordinary = false }) {
    tabId += 1;
    const url = baseURL + tabId;
    visitResponses = [ initial, final ];
    setInspectionHistoryEnabled(true);
    await beginInspectionHistory(tabId, url, true);
    if ( inspect ) { commit(tabId, url); }
    if ( ordinary ) { commit(999, url); }
    await finishInspectionHistory(tabId);
    return url;
}

await run({ initial: [ { visitTime: Date.now() - 1000 } ] });
await run({ final: [ ...freshVisit(), ...freshVisit() ] });
await run({ final: freshVisit, ordinary: true });
await run({ final: freshVisit, inspect: false });
await run({ final: [ { visitTime: 0 } ] });
await run({ final: () => [ { visitTime: Date.now() + 10000 } ] });
assert.deepEqual(deletedURLs, []);

const ownedURL = await run({ final: freshVisit });
assert.deepEqual(deletedURLs, [ ownedURL ]);

tabId += 1;
const sourceURL = baseURL + `${tabId}-source`;
const targetURL = baseURL + `${tabId}-target`;
visitResponses = [ [], [], freshVisit ];
setInspectionHistoryEnabled(true);
await beginInspectionHistory(tabId, sourceURL, true);
await trackInspectionRedirect(tabId, targetURL);
commit(tabId, targetURL);
await finishInspectionHistory(tabId);
assert.deepEqual(deletedURLs, [ ownedURL, targetURL ],
    'Only the committed redirect target is eligible, not its uncommitted source');
console.log('Passed: cleanup requires a single, fresh, proven inspection commit');

for ( const enabled of [ false, true ] ) {
    tabId += 1;
    const readsBefore = visitReads;
    setInspectionHistoryEnabled(enabled === false);
    await beginInspectionHistory(tabId, baseURL + tabId, enabled);
    assert.equal(visitReads, readsBefore, 'Both cleanup setting gates are required');
    assert.equal(trackInspectionRedirect(tabId, baseURL + `${tabId}-late`), undefined);
}

for ( const interruption of [ 'finish', 'discard', 'disable' ] ) {
    tabId += 1;
    const id = tabId;
    const url = baseURL + id;
    const baseline = deferredRead();
    const deletesBefore = deletedURLs.length;
    visitResponses = [ baseline.read ];
    setInspectionHistoryEnabled(true);
    const beginning = beginInspectionHistory(id, url, true);
    await baseline.reading;
    const finishing = interruption === 'finish' ? finishInspectionHistory(id) : undefined;
    if ( interruption === 'discard' ) { discardInspectionHistory(id); }
    if ( interruption === 'disable' ) {
        setInspectionHistoryEnabled(false);
        setInspectionHistoryEnabled(true);
    }
    baseline.resolve([]);
    await beginning;
    await finishing;
    commit(id, url);
    await finishInspectionHistory(id);
    assert.equal(deletedURLs.length, deletesBefore,
        `${interruption}: a delayed baseline cannot revive cleanup`);
    assert.equal(trackInspectionRedirect(id, `${url}-late`), undefined,
        `${interruption}: no owner survives interrupted initialization`);
}
console.log('Passed: pending baseline reads cannot revive finished, discarded or disabled owners');

for ( const interruption of [ 'disable', 'discard', 'ordinary', 'replace' ] ) {
    tabId += 1;
    const id = tabId;
    const url = baseURL + id;
    const final = deferredRead();
    const deletesBefore = deletedURLs.length;
    visitResponses = [ [], final.read ];
    setInspectionHistoryEnabled(true);
    await beginInspectionHistory(id, url, true);
    commit(id, url);
    const finishing = finishInspectionHistory(id);
    await final.reading;
    if ( interruption === 'disable' ) {
        setInspectionHistoryEnabled(false);
        setInspectionHistoryEnabled(true);
    }
    if ( interruption === 'discard' ) { discardInspectionHistory(id); }
    if ( interruption === 'ordinary' ) { commit(999, url); }
    if ( interruption === 'replace' ) {
        visitResponses = [ [] ];
        await beginInspectionHistory(id, `${url}-replacement`, true);
    }
    final.resolve(freshVisit());
    await finishing;
    assert.equal(deletedURLs.length, deletesBefore,
        `${interruption}: a delayed final read cannot authorize deletion`);
    if ( interruption === 'replace' ) {
        visitResponses = [ [] ];
        assert.ok(trackInspectionRedirect(id, `${url}-late`) instanceof Promise,
            'An old finish must not remove the replacement owner');
        await finishInspectionHistory(id);
    } else {
        assert.equal(trackInspectionRedirect(id, `${url}-late`), undefined);
    }
}
console.log('Passed: final reads recheck cleanup, ownership and ordinary navigation');

for ( const ordinary of [ false, true ] ) {
    tabId += 1;
    const url = baseURL + tabId;
    const baseline = deferredRead();
    const deletesBefore = deletedURLs.length;
    visitResponses = [ baseline.read ];
    setInspectionHistoryEnabled(true);
    const beginning = beginInspectionHistory(tabId, url, true);
    await baseline.reading;
    commit(ordinary ? 999 : tabId, url);
    baseline.resolve([]);
    await beginning;
    commit(tabId, url);
    await finishInspectionHistory(tabId);
    assert.equal(deletedURLs.length, deletesBefore,
        'A late baseline read cannot unprotect an observed navigation');
}
console.log('Passed: navigation during the initial history read remains protected');

const rejectVisits = () => Promise.reject(new Error('History lookup failed'));
for ( const responses of [ [ rejectVisits ], [ [], rejectVisits ] ] ) {
    const deletesBefore = deletedURLs.length;
    await run({ initial: responses[0], final: responses[1] });
    assert.equal(deletedURLs.length, deletesBefore, 'Rejected lookups preserve history');
    assert.equal(trackInspectionRedirect(tabId, baseURL + `${tabId}-late`), undefined);
}
rejectDeletion = true;
const failedURL = await run({ final: freshVisit });
rejectDeletion = false;
assert.equal(deletedURLs.at(-1), failedURL, 'The rejected deletion was attempted');
const attemptsBefore = deletedURLs.length;
await finishInspectionHistory(tabId);
assert.equal(deletedURLs.length, attemptsBefore, 'Failed deletion releases its owner without retry');
assert.equal(trackInspectionRedirect(tabId, baseURL + `${tabId}-late`), undefined);
const subsequentURL = await run({ final: freshVisit });
assert.equal(deletedURLs.at(-1), subsequentURL, 'Later cleanup survives rejected history APIs');
console.log('Passed: rejected history reads fail closed and rejected deletion releases ownership');
