import assert from 'node:assert/strict';
import { normalizeShareableURL } from '../../src/js/queree/contribution-core.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const tabs = new Map([
    [ 1, { id: 1, hidden: true } ],
    [ 2, { id: 2, hidden: true } ],
    [ 3, { id: 3, hidden: true } ],
    [ 4, { id: 4, hidden: false } ],
]);
const markers = new Map([ [ 1, true ], [ 2, true ], [ 4, true ] ]);
const active = new Set([ 2 ]);
const removed = [];
let onCreated, onUpdated;
let deferMarker;

globalThis.browser = {
    sessions: {
        getTabValue: async id => id === 7
            ? new Promise(resolve => { deferMarker = resolve; })
            : markers.get(id),
        setTabValue: async (id, _key, value) => markers.set(id, value),
    },
    tabs: {
        get: async id => {
            if ( tabs.has(id) === false ) { throw new Error('closed'); }
            return tabs.get(id);
        },
        query: async ( ) => Array.from(tabs.values()).filter(tab => tab.hidden),
        remove: async id => { removed.push(id); tabs.delete(id); },
        onCreated: { addListener: listener => { onCreated = listener; } },
        onUpdated: { addListener: listener => { onUpdated = listener; } },
    },
};

const { markInspectionTab, startInspectionTabRecovery } = await import(
    '../../src/js/queree/inspection-tab-recovery.js'
);
const sweep = startInspectionTabRecovery(id => active.has(id));
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(removed, [ 1 ], 'Only the tagged, inactive hidden tab is closed');

tabs.set(5, { id: 5, hidden: true });
onCreated(tabs.get(5));
await markInspectionTab(5);
await new Promise(resolve => setTimeout(resolve, 550));
assert.deepEqual(removed, [ 1, 5 ], 'A late restored tag is detected');

tabs.set(6, { id: 6, hidden: true });
active.add(6);
await markInspectionTab(6);
onCreated(tabs.get(6));
onUpdated(6, { status: 'complete' }, tabs.get(6));
await new Promise(resolve => setTimeout(resolve, 550));
assert.deepEqual(removed, [ 1, 5 ], 'Active inspections are never closed');
assert.ok(tabs.has(2) && tabs.has(3) && tabs.has(4));

tabs.set(7, { id: 7, hidden: true });
onUpdated(7, { hidden: true }, tabs.get(7));
while ( deferMarker === undefined ) { await Promise.resolve(); }
active.add(7);
deferMarker(true);
await new Promise(resolve => setTimeout(resolve, 0));
assert.ok(tabs.has(7), 'A tab becoming active during a lookup is preserved');

tabs.set(8, { id: 8, hidden: true });
await markInspectionTab(8);
sweep();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(tabs.has(8), false, 'A later cleanup retries missed tabs');

for ( const result of [ 'transient', 'permanent', 'active', 'visible' ] ) {
    const id=9;
    tabs.set(id,{id,hidden:true});
    await markInspectionTab(id);
    const remove=browser.tabs.remove;
    let attempts=0;
    browser.tabs.remove=async tabId=>{
        if(tabId!==id) return remove(tabId);
        attempts++;
        if(attempts===1 || result==='permanent') {
            if(result==='active') active.add(id);
            if(result==='visible') tabs.get(id).hidden=false;
            throw Error('Close failed');
        }
        return remove(tabId);
    };
    try {
        sweep();
        await new Promise(resolve=>setTimeout(resolve,0));
        assert.equal(attempts,result==='active'||result==='visible'?1:2,'Retry once, rechecking ownership before closing');
        assert.equal(tabs.has(id),result!=='transient');
    } finally {
        browser.tabs.remove=remove;
        tabs.delete(id);
        active.delete(id);
    }
}

console.log('Passed: only abandoned tagged inspection tabs are closed');

const controller = readFileSync(new URL('../../src/js/queree/controller.js', import.meta.url), 'utf8');
const section = (from, to) => {
    const start = controller.indexOf(from);
    const end = controller.indexOf(to, start);
    assert.ok(start !== -1 && end > start, `Missing controller region: ${from} to ${to}`);
    return controller.slice(start, end);
};
const ownedTabs = new Map();
const sourceLocations = new Map([[ 20, 'https://www.google.com/search?q=fixture' ]]);
let closeFails = false;
let removeContext = true;
let onRemoved;
const cleanupWarnings = [];
const lifecycle = vm.createContext({
    µb: { hiddenSettings: {} },
    console: { error: (...args) => cleanupWarnings.push(args) },
    mobileTabs: { android: false },
    inspectionTabs: ownedTabs, inspectionPopups: new Set(),
    sourceLocations,
    sessionMalware: new Map(), normalizeShareableURL, getMalwareGeneration: () => 0,
    browser: { tabs: {
        remove: async id => {
            if ( closeFails ) { throw new Error('close failed'); }
            tabs.delete(id);
        },
        query: async () => Array.from(tabs.values()),
        onRemoved: { addListener: listener => { onRemoved = listener; } },
    } },
    removeInspectionCookieStore: async () => removeContext,
    finishInspectionHistory: async () => { throw new Error('history unavailable'); },
    discardInspectionHistory: () => {},
    detachFromSource: () => {},
    cancelSource: () => {},
    record: (_job, verdict, reasons) => ({ verdict, reasons }),
    setTimeout, clearTimeout,
    resourceCleanupTimeout: 10,
});
vm.runInContext(`
    let activeJobs = 1;
    let dispatchPaused = false;
    let dispatched = 0;
    function dispatch() { dispatched += 1; }
    ${section('function rememberMalware(', 'function rememberExclusion(')}
    ${section('function releaseSlot(', 'function scheduleCompletion(')}
    ${section('browser.tabs.onRemoved.addListener(', 'browser.storage.onChanged.addListener(')}
`, lifecycle);
const drain = async () => { for ( let i = 0; i < 30; i++ ) { await Promise.resolve(); } };
const newJob = extra => ({
    started: true, finished: false, cookieStoreId: 'firefox-container-test',
    ...extra,
});

let verdict;
const stuckTab = newJob({ tabId: 20, resolve: value => { verdict = value; } });
tabs.set(20, { id: 20, hidden: true });
ownedTabs.set(20, stuckTab);
closeFails = true;
lifecycle.finish(stuckTab, { verdict: 'candidate' });
await drain();
assert.equal(verdict.verdict, 'candidate');
assert.equal(vm.runInContext('activeJobs', lifecycle), 1,
    'A tab that failed to close still occupies its inspection slot');
assert.ok(ownedTabs.has(20), 'Keep proven ownership until closure is confirmed');
tabs.delete(20);
onRemoved(20);
assert.equal(sourceLocations.has(20), false, 'Tab removal also clears its remembered search location');
await drain();
assert.equal(vm.runInContext('activeJobs', lifecycle), 0,
    'Later recovery closure releases the held slot');
onRemoved(20);
await drain();
assert.equal(vm.runInContext('activeJobs', lifecycle), 0, 'Never release a slot twice');

closeFails = false;
removeContext = false;
vm.runInContext('activeJobs = 1', lifecycle);
const dirtyContext = newJob({ resolve: value => { verdict = value; } });
lifecycle.finish(dirtyContext, { verdict: 'candidate' });
await drain();
assert.equal(verdict.verdict, 'candidate', 'Disposable-state cleanup does not change the inspection result');
assert.equal(vm.runInContext('activeJobs', lifecycle), 0, 'No live tab remains');

removeContext = true;
vm.runInContext('activeJobs = 1', lifecycle);
let createTab;
const delayedTab = newJob({
    tabPromise: new Promise(resolve => { createTab = resolve; }),
    resolve: value => { verdict = value; },
});
lifecycle.finish(delayedTab, { verdict: 'candidate' });
await new Promise(resolve => setTimeout(resolve, 25));
assert.equal(verdict.verdict, 'candidate', 'Cleanup timeout preserves the completed inspection');
assert.equal(vm.runInContext('activeJobs', lifecycle), 1,
    'An unresolved tab creation cannot free capacity early');
tabs.set(21, { id: 21, hidden: true });
createTab(tabs.get(21));
await drain();
assert.equal(tabs.has(21), false, 'A late-created tab is closed');
assert.equal(vm.runInContext('activeJobs', lifecycle), 0);
assert.equal(ownedTabs.size, 0);
vm.runInContext('activeJobs = 1', lifecycle);
const cleanTab = newJob({ tabId: 22, resolve: value => { verdict = value; } });
tabs.set(22, { id: 22, hidden: true });
ownedTabs.set(22, cleanTab);
lifecycle.finish(cleanTab, { verdict: 'candidate' });
await drain();
assert.equal(verdict.verdict, 'candidate', 'History cleanup remains best effort');
assert.equal(vm.runInContext('activeJobs', lifecycle), 0);
console.log('Passed: cleanup failures and late tab creation retain capacity until actual closure');

closeFails = true;
vm.runInContext('activeJobs = 1', lifecycle);
const malwareTab = newJob({ tabId: 23, resolve: value => { verdict = value; } });
tabs.set(23, { id: 23, hidden: true });
ownedTabs.set(23, malwareTab);
const malwareResult = { verdict: 'exclude', reasons: [ { kind: 'malware' } ] };
lifecycle.finish(malwareTab, malwareResult);
await drain();
assert.equal(verdict, malwareResult, 'Cleanup cannot turn a malware exclusion into unresolved');
assert.ok(cleanupWarnings.length > 0, 'Cleanup failures remain visible in the console');
assert.equal(vm.runInContext('activeJobs', lifecycle), 1);
tabs.delete(23);
onRemoved(23);
await drain();
assert.equal(vm.runInContext('activeJobs', lifecycle), 0);
closeFails = false;

let createContext;
lifecycle.createInspectionCookieStore = () => new Promise(resolve => { createContext = resolve; });
lifecycle.inspectionTimeout = 5;
vm.runInContext(section('async function start(', 'function dispatch('), lifecycle);
vm.runInContext('activeJobs = 0', lifecycle);
const stalledContext = newJob({ started: false, resolve: value => { verdict = value; } });
delete stalledContext.cookieStoreId;
const started = lifecycle.start(stalledContext);
await new Promise(resolve => setTimeout(resolve, 30));
assert.equal(verdict.verdict, 'unresolved');
assert.equal(vm.runInContext('activeJobs', lifecycle), 0,
    'Stalled pre-tab context creation must not permanently consume tab capacity');
createContext('firefox-container-late');
await started;
await drain();
assert.equal(stalledContext.tabPromise, undefined, 'A late context cannot create a tab for a finished job');
assert.equal(vm.runInContext('activeJobs', lifecycle), 0);
console.log('Passed: stalled pre-tab context creation settles without blocking later inspections');

for ( const failure of [ '', 'context', 'create', 'tag', 'hide', 'not-hidden' ] ) {
    const calls = [];
    const failAt = step => {
        calls.push(step);
        if ( failure === step ) { throw new Error(`Failed ${step}`); }
    };
    lifecycle.inspectionTimeout = 1000;
    lifecycle.createInspectionCookieStore = async () => {
        failAt('context');
        return 'firefox-container-order';
    };
    lifecycle.browser.tabs.create = async options => {
        failAt('create');
        assert.equal(options.active, false);
        assert.equal(options.cookieStoreId, 'firefox-container-order');
        assert.equal(options.url, 'about:blank', 'No site loads before privacy setup');
        tabs.set(30, { id: 30, hidden: false });
        return tabs.get(30);
    };
    lifecycle.markInspectionTab = async () => failAt('tag');
    lifecycle.browser.tabs.hide = async () => {
        failAt('hide');
        return failure === 'not-hidden' ? [] : [ 30 ];
    };
    lifecycle.beginInspectionHistory = async () => failAt('history');
    lifecycle.browser.tabs.update = async () => failAt('navigate');
    verdict = undefined;
    const job = newJob({
        started: false, cookieStoreId: undefined, url: 'https://personal.example/',
        resolve: value => { verdict = value; },
    });
    await lifecycle.start(job);
    if ( failure === '' ) {
        assert.deepEqual(calls, [ 'context', 'create', 'tag', 'hide', 'history', 'navigate' ]);
        lifecycle.finish(job, { verdict: 'candidate' });
    }
    await drain();
    const expected = failure === 'context' ? 'inspection_context_failed'
        : failure === 'create' ? 'navigation_failed'
            : failure === 'tag' ? 'inspection_tag_failed' : 'inspection_hide_failed';
    assert.equal(verdict.verdict, failure === '' ? 'candidate' : 'unresolved');
    if ( failure !== '' ) {
        assert.equal(verdict.reasons[0].kind, expected);
        assert.equal(calls.includes('navigate'), false, 'A setup failure cannot open the site');
    }
    assert.equal(tabs.has(30), false);
    assert.equal(ownedTabs.size, 0);
    assert.equal(vm.runInContext('activeJobs', lifecycle), 0);
}
console.log('Passed: setup failures never navigate and release inspection resources');
