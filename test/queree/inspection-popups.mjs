import assert from 'node:assert/strict';
import { markInspectionTab } from '../../src/js/queree/inspection-tab-recovery.js';
import { needsCharacteristicChecks } from '../../src/js/queree/decision-cache.js';
import { personalDisplayRecord } from '../../src/js/queree/personal-categories.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../src/js/tab.js', import.meta.url), 'utf8');
const start = source.indexOf('    const onTabCreated = async function(');
const end = source.indexOf('    const gcPeriod =', start);
assert.ok(start !== -1 && end > start);

const active = new Set([ 1 ]);
const markers = new Map();
const tabs = new Set([ 10, 11, 12, 13, 14 ]);
const calls = [];
let tagFails = false;
let closeFails = false;
let retained = false;
const openingFrames = [];
globalThis.browser = {
    sessions: { setTabValue: async (id, key, value) => {
        calls.push([ 'tag', id ]);
        assert.equal(key, 'quereeInspection');
        if ( tagFails ) { throw new Error('marker write failed'); }
        markers.set(id, value);
        active.delete(1);
    } },
};

// Execute the native production hook without loading the filtering engines.
const onTabCreated = runInNewContext(`${source.slice(start, end)}\nonTabCreated;`, {
    isInspectionTab: id => active.has(id),
    filterInspectionPopup: (source, target, _url, frameId) => {
        calls.push([ 'inspect', source, target ]);
        openingFrames.push(frameId);
        return retained === false;
    },
    markInspectionTab,
    vAPI: { tabs: { remove: async id => {
        calls.push([ 'close', id ]);
        if ( closeFails === false ) { tabs.delete(id); }
    } } },
    popupCandidates: new Map(),
    webext: { webNavigation: { getFrame: async ({ tabId, frameId }) => {
        calls.push([ 'frame', tabId, frameId ]);
        return { url: 'https://ordinary.example/' };
    } } },
    PopupCandidate: class {
        constructor(details) { calls.push([ 'candidate', details.tabId ]); }
    },
    popupCandidateTest: id => calls.push([ 'filter', id ]),
});

await onTabCreated({ sourceTabId: 1, sourceFrameId: 0, tabId: 10 });
assert.deepEqual(calls, [ [ 'inspect', 1, 10 ], [ 'tag', 10 ], [ 'close', 10 ] ]);
assert.equal(markers.get(10), true);
assert.equal(tabs.has(10), false,
    'The popup closes even if the inspection finishes during the marker write');

calls.length = 0;
active.add(1);
tagFails = true;
await onTabCreated({ sourceTabId: 1, sourceFrameId: 0, tabId: 11 });
assert.deepEqual(calls, [ [ 'inspect', 1, 11 ], [ 'tag', 11 ], [ 'close', 11 ] ]);
assert.equal(tabs.has(11), false, 'A failed marker write still closes the popup');
assert.equal(markers.has(11), false);

calls.length = 0;
tagFails = false;
closeFails = true;
await onTabCreated({ sourceTabId: 1, sourceFrameId: 2, tabId: 12 });
assert.deepEqual(calls, [ [ 'inspect', 1, 12 ], [ 'tag', 12 ], [ 'close', 12 ] ]);
assert.equal(tabs.has(12), true);
assert.equal(markers.get(12), true, 'Failed native removal retains the recovery marker');
assert.deepEqual(openingFrames, [ 0, 0, 2 ], 'The native hook preserves the opening frame');
calls.length = 0;
retained = true;
active.add(1);
await onTabCreated({ sourceTabId: 1, sourceFrameId: 0, tabId: 15 });
assert.deepEqual(calls, [ [ 'inspect', 1, 15 ] ], 'Retained debug pages can open links without tagging or closing them');
retained = false;

for ( const sourceTabId of [ 2, undefined ] ) {
    calls.length = 0;
    const tabId = sourceTabId === 2 ? 13 : 14;
    await onTabCreated({ sourceTabId, sourceFrameId: 0, tabId,
        cookieStoreId: 'firefox-container-inspection' });
    assert.deepEqual(calls, [
        [ 'frame', sourceTabId, 0 ], [ 'frame', sourceTabId, 0 ],
        [ 'candidate', tabId ], [ 'filter', tabId ],
    ], 'An ordinary or absent source retains native popup handling, regardless of container');
    assert.equal(tabs.has(tabId), true);
    assert.equal(markers.has(tabId), false);
}

console.log('Passed: inspection popups are marked then closed, ordinary popups retain native handling');

const controller = readFileSync(new URL('../../src/js/queree/controller.js', import.meta.url), 'utf8');
const section = (start, end) => {
    const from = controller.indexOf(start);
    const to = controller.indexOf(end, from);
    assert.ok(from !== -1 && to > from, `Missing controller region: ${start} to ${end}`);
    return controller.slice(from, to).replace(/^export /gm, '');
};
for ( const mode of [ 'allow', 'advertising', 'malware', 'tracking', 'blank-advertising' ] ) {
    const results = [];
    const popups = new Set();
    const job = { url: 'https://publisher.example/article', finished: false };
    const target = mode === 'blank-advertising' ? 'about:blank' : 'https://popup.example/offer';
    const hooks = runInNewContext(
        section('export function isInspectionTab(', 'export async function getDecisionCacheState(') +
        section('export function filterInspectionRequest(', 'function resetDestination(') +
        section('function rememberExclusion(', 'function malwareDecision(') +
        ';({ isInspectionTab, filterInspectionPopup, filterInspectionRequest, filterInspectionHeaders })', {
            URL, inspectionTabs: new Map([[ 1, job ]]), inspectionPopups: popups,
            needsCharacteristicChecks, personalDisplayRecord, settings: () => ({ personalCategories: [] }),
            matchMalwareRequest: details => {
                assert.equal(details.type, 'main_frame');
                assert.equal(details.originURL, target);
                return { result: mode === 'malware' ? 1 : 0, raw: 'malware-rule' };
            },
            policyCommand: () => ({ result: mode.endsWith('advertising') ? 1 : 0, raw: 'ad-rule' }),
            matchTrackingRequest: () => ({ result: mode === 'tracking' ? 1 : 0, raw: 'tracking-rule' }),
            trackingReason: (details, match) => ({ kind: 'cross_site_tracking', request_url: details.url,
                request_type: details.type, rule: match.raw }),
            advertisingReason: () => ({ kind: 'advertising' }),
            malwareReason: (url, match, type) => ({ kind: 'malware', request_url: url, request_type: type, rule: match.raw }),
            record: (_job, verdict, reasons) => ({ verdict, reasons }),
            exclusionRecord: (_job, reasons) => ({ verdict: 'exclude', reasons: [ ...(_job.exclusionReasons || []), ...reasons ] }),
            finish: (_job, result) => results.push(result),
            cancelAdvertisingRequest: (_job, details, match) => results.push({ verdict: 'exclude', reasons: [ {
                kind: 'advertising', request_url: details.url, request_type: details.type, rule: match.raw,
            } ] }),
        });
    await hooks.filterInspectionPopup(1, 10, target);
    assert.equal(hooks.isInspectionTab(10), true, 'Ownership is registered before asynchronous marker/close work');
    assert.equal(hooks.filterInspectionRequest({ tabId: 10 }, {}).cancel, true);
    assert.equal(hooks.filterInspectionHeaders({ tabId: 10 }, [], [], 200, undefined, {}).cancel, true);
    assert.equal(results.length, mode === 'allow' ? 0 : 1, 'Closing a popup alone is not advertising evidence');
    if ( results.length ) {
        assert.equal(results[0].reasons[0].kind, mode === 'tracking' ? 'cross_site_tracking'
            : mode === 'blank-advertising' ? 'advertising' : mode);
        assert.equal(results[0].reasons[0].request_url, target);
        assert.equal(results[0].reasons[0].request_type, 'popup');
    }
    job.finished = true;
    await hooks.filterInspectionPopup(1, 11, target);
    assert.equal(results.length, mode === 'allow' ? 0 : 1, 'Retained debug pages do not restart classification');
}

for ( const mode of [ 'iframe', 'stale', 'missing', 'kept', 'blank' ] ) {
    const popups = new Set();
    const job = { url: 'https://publisher.example/article', navigationId: 1, kept: mode === 'kept' };
    const calls = [];
    let release;
    const filter = runInNewContext(
        section('export async function filterInspectionPopup(', 'export async function getDecisionCacheState(') +
        ';filterInspectionPopup', {
            URL, inspectionTabs: new Map([[ 1, job ]]), inspectionPopups: popups,
            browser: { webNavigation: { getFrame: async details => {
                assert.equal(details.tabId, 1);
                assert.equal(details.frameId, 3);
                if ( mode === 'missing' ) { throw new Error('frame disappeared'); }
                await new Promise(resolve => { release = resolve; });
                return { url: 'https://embedded.example/frame' };
            } } },
            matchMalwareRequest: () => ({ result: 0 }),
            matchTrackingRequest: () => ({ result: 0 }),
            policyCommand: command => { calls.push(command.details); return { result: 0 }; },
            finish: () => assert.fail('No synthetic popup is excluded'),
        });
    const pending = filter(1, 10, mode === 'blank' ? 'about:blank' : 'https://popup.example/', 3);
    if ( mode === 'iframe' || mode === 'stale' || mode === 'blank' ) {
        if ( mode === 'stale' ) { job.navigationId += 1; }
        release();
    }
    assert.equal(await pending, mode !== 'kept');
    assert.equal(popups.has(10), mode !== 'kept');
    assert.equal(calls.length, mode === 'iframe' || mode === 'blank' ? 1 : 0);
    if ( mode === 'iframe' ) {
        assert.equal(calls[0].originURL, 'https://embedded.example');
        assert.equal(calls[0].tabOriginURL, 'https://publisher.example');
    }
}
console.log('Passed: iframe popup origins, stale opening frames and retained-tab exploration keep distinct ownership');
