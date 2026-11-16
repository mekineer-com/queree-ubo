import { harness, run } from './mobile-inspection-fixture.mjs';
import assert from 'node:assert/strict';
import { createMobileInspectionTabs } from '../../src/js/queree/mobile-inspection-tabs.js';
import { mock } from 'node:test';
import { normalizeShareableURL } from '../../src/js/queree/contribution-core.js';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers';
import vm from 'node:vm';

const controller = readFileSync(new URL('../../src/js/queree/controller.js', import.meta.url), 'utf8');
const section = (from, to) => {
    const start = controller.indexOf(from);
    const end = controller.indexOf(to, start);
    assert.ok(start !== -1 && end > start, `Missing controller region: ${from} to ${to}`);
    return controller.slice(start, end);
};
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture({ mobile = false, debug = true, cancelled = false } = {}) {
    const timers = new Map();
    const calls = [];
    const results = [];
    const pages = new Set([ 10 ]);
    let nextTimer = 0;
    let nextTab = 11;
    const job = { tabId: 10, sourceTabId: 1, started: true, finished: false, cancelled,
        mobileTab: mobile, cookieStoreId: mobile ? undefined : 'isolated',
        resolve: result => results.push(result) };
    const state = {
        µb: { hiddenSettings: { quereeKeepUnresolvedTabs: debug } },
        vAPI: { tabs: { select: async id => { calls.push([ 'select', id ]); } } },
        inspectionTabGeneration: 0, activeJobs: 1, inspectionTabs: new Map([[ 10, job ]]), inspectionPopups: new Set(),
        sourceLocations: new Map(), cancelSource() {},
        pendingJobs: [], dispatchPaused: false, queueTimer: undefined,
        sessionMalware: new Map(), normalizeShareableURL, getMalwareGeneration: () => 0,
        queueStallTimeout: 100000, resourceCleanupTimeout: 5000,
        settings: () => ({ simultaneousInspections: 1 }),
        setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
        clearTimeout: id => timers.delete(id),
        clearRecovery() {}, detachFromSource() {}, cancelJobs() {},
        discardInspectionHistory: id => calls.push([ 'discard-history', id ]),
        finishInspectionHistory: async id => calls.push([ 'history', id ]),
        removeInspectionCookieStore: async id => { calls.push([ 'container', id ]); return true; },
        mobileTabs: { android: mobile, size: 1, available: 0,
            keep: id => { calls.push([ 'mobile-keep', id ]); state.mobileTabs.available = 1; },
            release: async id => {
                calls.push([ 'mobile-release', id ]);
                pages.delete(id);
                state.mobileTabs.available = 1;
                return true;
            },
        },
        browser: { tabs: {
            onRemoved: { addListener: listener => { state.onRemoved = listener; } },
            remove: async id => { pages.delete(id); calls.push([ 'close', id ]); },
            show: async id => { calls.push([ 'show', id ]); },
        } },
        start: next => {
            state.activeJobs += 1;
            next.tabId = nextTab++;
            next.started = true;
            next.mobileTab = mobile;
            next.resolve = result => results.push(result);
            state.inspectionTabs.set(next.tabId, next);
            pages.add(next.tabId);
            calls.push([ 'start', next.tabId ]);
            if ( mobile ) { state.mobileTabs.available -= 1; }
            assert.equal(state.activeJobs, 1, 'Extra retained tabs never increase concurrent inspections');
        },
    };
    const api = vm.runInNewContext(
        section('function rememberMalware(', 'function rememberExclusion(') +
        section('function releaseSlot(', 'function clearRecovery(') +
        section('function finish(', 'function scheduleCompletion(') +
        section('export async function openInspectionTab(', 'export async function filterInspectionPopup(').replace('export ', '') +
        section('function dispatch(', 'function enqueue(') +
        section('browser.tabs.onRemoved.addListener(', 'browser.storage.onChanged.addListener(') +
        ';({finish,dispatch,releaseKeptInspection,openInspectionTab})', state);
    return { state, api, job, calls, results, pages, timers };
}

for ( const mobile of [ false, true ] ) {
    const f = fixture({ mobile });
    f.api.finish(f.job, { verdict: 'unresolved' });
    await settle();
    assert.equal(f.results[0].inspection_tab_id, 10, 'Only retained inspection results carry their tab ID');
    assert.equal(await f.api.openInspectionTab(1, 10), true);
    assert.equal(f.pages.size, 1, 'Opening evidence reuses its tab instead of creating another');
    assert.equal(f.calls.some(call => call[0] === 'show'), !mobile, 'Only desktop uses the tab-show API');
    assert.ok(f.calls.some(call => call[0] === 'select' && call[1] === 10));
    const before = f.calls.length;
    assert.equal(await f.api.openInspectionTab(2, 10), false, 'Other search tabs cannot select this result\'s evidence');
    assert.equal(await f.api.openInspectionTab(1, 999), false, 'Closed or unknown tabs are never recreated');
    f.state.µb.hiddenSettings.quereeKeepUnresolvedTabs = false;
    assert.equal(await f.api.openInspectionTab(1, 10), false);
    f.state.µb.hiddenSettings.quereeKeepUnresolvedTabs = true;
    f.job.kept = false;
    assert.equal(await f.api.openInspectionTab(1, 10), false, 'A reused working tab is not debug evidence');
    assert.equal(f.calls.length, before);
}

{
    const f = fixture();
    f.api.finish(f.job, { verdict: 'unresolved' });
    await settle();
    f.pages.delete(10);
    f.state.onRemoved(10);
    await settle();
    assert.equal(f.state.activeJobs, 0);
    assert.ok(f.calls.some(call => call[0] === 'container'),
        'Manually closing a retained desktop tab still removes its container');
}

{
    const f = fixture();
    f.api.finish(f.job, { verdict: 'unresolved' });
    await settle();
    f.state.pendingJobs.push({ finished: true });
    f.api.dispatch();
    await settle();
    assert.equal(f.job.kept, true, 'Canceled queued work must not evict retained evidence');
    assert.equal(f.state.pendingJobs.length, 0);
    assert.equal(f.state.activeJobs, 0);
}

for ( const mobile of [ false, true ] ) {
    const f = fixture({ mobile });
    Object.assign(f.job, {
        navigationId: 1, committedNavigationId: 1, loaded: true,
        destinationURL: 'https://evidence.example/',
        documentURLs: new Set([ 'https://evidence.example/' ]),
    });
    f.api.finish(f.job, { verdict: 'unresolved' });
    await settle();
    const before = { ...f.job, documentURLs: new Set(f.job.documentURLs) };
    const handlers = {};
    const noInspection = () => assert.fail('Finished evidence must not restart inspection');
    vm.runInNewContext(section('browser.tabs.onUpdated.addListener(', 'browser.tabs.onRemoved.addListener('), {
        inspectionTabs: f.state.inspectionTabs, sourceStates: new Map(),
        updateSourceLocation() {}, observeHistoryCommit() {},
        clearRecovery: noInspection, resetDestination: noInspection,
        resetScroll: noInspection, scheduleCompletion: noInspection,
        finishKnownDestination: noInspection, withoutTextDirective: url => url,
        browser: {
            tabs: {
                onUpdated: { addListener: callback => { handlers.updated = callback; } },
                executeScript: noInspection,
            },
            webNavigation: {
                onCommitted: { addListener: callback => { handlers.committed = callback; } },
                onHistoryStateUpdated: { addListener: callback => { handlers.history = callback; } },
            },
        },
    });
    handlers.updated(10, { url: 'https://evidence.example/#exploring', status: 'loading' });
    handlers.updated(10, { status: 'complete' });
    handlers.committed({ tabId: 10, frameId: 0, url: 'https://another.example/' });
    handlers.history({ tabId: 10, frameId: 0, url: 'https://another.example/route' });
    assert.deepEqual(f.job, before, 'Browsing retained evidence leaves the finished job untouched');
    assert.equal(f.pages.has(10), true);
    assert.equal(f.state.inspectionTabs.get(10), f.job);
    assert.equal(f.results.length, 1);
}

for ( const outcome of [ 'retry', 'failed', 'query_failed', 'already_closed' ] ) {
    const f = fixture({ debug: false });
    const errors = [];
    f.state.console = { error: message => errors.push(message) };
    let attempts = 0;
    let queries = 0;
    let releaseRetry;
    f.state.browser.tabs.remove = async id => {
        attempts += 1;
        if ( outcome === 'already_closed' ) { f.pages.delete(id); }
        if ( attempts === 2 && outcome === 'retry' ) {
            await new Promise(resolve => { releaseRetry = resolve; });
            f.pages.delete(id);
            return;
        }
        throw new Error('Close failed');
    };
    f.state.browser.tabs.query = async () => {
        queries += 1;
        if ( outcome === 'query_failed' ) { throw new Error('Query failed'); }
        return Array.from(f.pages, id => ({ id }));
    };
    const next = { finished: false };
    f.state.pendingJobs.push(next);
    f.api.finish(f.job, { verdict: 'candidate' });
    await settle();
    assert.equal(f.results.length, 1, 'Cleanup does not replace or delay the inspection verdict');
    assert.equal(attempts, outcome === 'already_closed' ? 1 : 2);
    if ( outcome === 'retry' ) {
        assert.equal(queries, 1);
        assert.equal(f.state.inspectionTabs.get(10), f.job);
        assert.equal(f.job.slotReleased, undefined, 'Keep capacity until the retry really closes the tab');
        assert.equal(next.started, undefined);
        releaseRetry();
        await settle();
    }
    const closed = outcome === 'retry' || outcome === 'already_closed';
    assert.equal(f.pages.has(10), !closed);
    assert.equal(f.state.inspectionTabs.has(10), !closed);
    assert.equal(f.job.slotReleased === true, closed);
    assert.equal(next.started === true, closed, 'Only a confirmed close frees capacity for queued work');
    assert.equal(f.state.activeJobs, 1);
    assert.equal(errors.length, closed ? 0 : 1, 'Permanent cleanup failure is reported separately');
    assert.ok(f.calls.some(call => call[0] === 'container'));
    assert.equal(f.calls.some(call => call[0] === 'history'), closed);
}

for ( const mobile of [ false, true ] ) {
    const f = fixture({ mobile });
    f.api.finish(f.job, { verdict: 'unresolved' });
    await settle();
    assert.equal(f.job.kept, true);
    assert.equal(f.state.activeJobs, 0, 'Retained evidence is outside working capacity');
    assert.equal(f.state.inspectionTabs.get(10), f.job);
    assert.equal(f.results.length, 1, 'Keeping the page does not delay its result');
    assert.deepEqual(f.calls, mobile ? [[ 'discard-history', 10 ], [ 'mobile-keep', 10 ]] : [[ 'discard-history', 10 ]]);
    const second = { finished: false };
    f.state.pendingJobs.push(second);
    f.api.dispatch();
    await settle();
    assert.equal(f.job.kept, true);
    assert.equal(f.state.activeJobs, 1);
    assert.equal(f.state.pendingJobs.length, 0);
    assert.equal(f.pages.size, 2, 'The next inspection uses a different tab');
    assert.equal(f.state.inspectionTabs.get(10), f.job);
    f.api.finish(second, { verdict: 'unresolved' });
    await settle();
    assert.equal(f.state.activeJobs, 0);
    assert.equal(f.pages.size, 2, 'Two unresolved pages pile up untouched');
    assert.equal(f.results.length, 2, 'Each result is reported once');
    assert.ok(f.calls.every(call => call[0] !== 'close' && call[0] !== 'mobile-release'));
    f.api.releaseKeptInspection(f.job);
    f.api.releaseKeptInspection(second);
    await settle();
    assert.equal(f.state.activeJobs, 0, 'Closing evidence never releases a working slot twice');
    assert.equal(f.pages.size, 0);
    assert.equal(f.state.inspectionTabs.size, 0);
}

{
    const f = fixture({ mobile: true });
    f.api.finish(f.job, { verdict: 'unresolved' });
    await settle();
    let release;
    f.state.mobileTabs.release = () => new Promise(resolve => { release = resolve; });
    f.api.releaseKeptInspection(f.job);
    f.timers.values().next().value();
    await settle();
    release(false);
    await settle();
    assert.equal(f.state.inspectionTabs.has(10), false, 'The controller releases a tab the Android pool has disowned');
    assert.equal(f.state.activeJobs, 0, 'A failed evidence-tab close never stalls working inspections');
    assert.equal(f.job.slotReleased, true);
}

{
    const f = fixture({ mobile: true });
    f.api.finish(f.job, { verdict: 'unresolved' });
    await settle();
    f.state.mobileTabs.size = 0;
    f.state.mobileTabs.available = 0;
    f.state.mobileTabs.replenishing = true;
    const next = { finished: false };
    f.state.pendingJobs.push(next);
    f.api.dispatch();
    assert.equal(f.state.pendingJobs.length, 1, 'Wait for replacement tabs instead of inventing failed inspections');
    assert.equal(f.state.activeJobs, 0);
    assert.equal(f.state.queueTimer, undefined, 'Waiting for private-tab replacement is not a stalled page');
    f.state.mobileTabs.available = 1;
    f.state.mobileTabs.size = 1;
    f.state.mobileTabs.replenishing = false;
    f.api.dispatch();
    assert.equal(f.state.pendingJobs.length, 0);
    assert.equal(f.state.activeJobs, 1);
}

{
    const f = fixture();
    f.state.inspectionTabs.delete(10);
    f.pages.delete(10);
    f.api.finish(f.job, { verdict: 'unresolved' });
    await settle();
    assert.equal(f.job.kept, false, 'A closed tab cannot be retained');
    assert.ok(f.calls.some(call => call[0] === 'container'), 'Closed-tab failure still removes its container');
}

for ( const [ debug, verdict, cancelled ] of [
    [ false, 'unresolved', false ], [ true, 'candidate', false ],
    [ true, 'exclude', false ], [ true, 'unresolved', true ],
] ) {
    const f = fixture({ debug, cancelled });
    f.api.finish(f.job, { verdict });
    await settle();
    assert.equal(f.job.kept, false);
    assert.equal(f.state.activeJobs, 0);
    assert.equal(f.pages.size, 0);
}

for ( const mobile of [ false, true ] ) {
    const f = fixture({ mobile });
    f.api.finish(f.job, { verdict: 'unresolved' });
    await settle();
    f.api.releaseKeptInspection(f.job);
    await settle();
    assert.equal(f.state.activeJobs, 0);
    assert.equal(f.state.inspectionTabs.size, 0);
    if ( mobile ) { assert.deepEqual(f.calls.at(-1), [ 'mobile-release', 10 ]); }
}

{
    const job = { finished: true, kept: true };
    const api = vm.runInNewContext(section('export function filterInspectionRequest(', 'function resetDestination(')
        .replace(/^export /gm, '') + ';({filterInspectionRequest,filterInspectionHeaders})', {
        inspectionTabs: new Map([[ 10, job ]]), inspectionPopups: new Set(),
    });
    for ( const fn of [
        context => api.filterInspectionRequest(context, {}),
        context => api.filterInspectionHeaders(context, [], [], 200, {}, {}),
    ] ) {
        assert.equal(Object.keys(fn({ tabId: 10 }, {})).length, 0,
            'A retained failure may continue loading or be explored manually');
        job.kept = false;
        assert.equal(fn({ tabId: 10 }, {}).cancel, true);
        job.kept = true;
    }
}

{
    const µb = { isReadyPromise: Promise.resolve(), hiddenSettings: { unrelated: 42 },
        changeHiddenSettings(settings) { this.hiddenSettings = settings; } };
    const toggle = vm.runInNewContext(section('export async function toggleKeepUnresolvedTabs(', 'function contextDetails(')
        .replace('export ', '') + ';toggleKeepUnresolvedTabs', { µb });
    assert.equal((await toggle()).keepUnresolvedTabs, true);
    assert.equal((await toggle()).keepUnresolvedTabs, false);
    assert.equal(µb.hiddenSettings.unrelated, 42);

    const commands = readFileSync(new URL('../../src/js/commands.js', import.meta.url), 'utf8');
    const manifest = JSON.parse(readFileSync(new URL('../../platform/firefox/manifest.json', import.meta.url), 'utf8'));
    assert.doesNotMatch(commands, /toggleKeepUnresolvedTabs/);
    assert.equal(manifest.commands['queree-toggle-keep-unresolved'], undefined);
}

{
    const source = readFileSync(new URL('../../src/js/queree/search-results.js', import.meta.url), 'utf8');
    const calls = [];
    let click;
    const heading = { addEventListener(type, listener) { assert.equal(type, 'click'); click = listener; } };
    const state = { keepUnresolvedTabs: true, panel: { querySelector: () => heading },
        document: { querySelectorAll: () => [] },
        vAPI: { messaging: { send: (...args) => calls.push(args) } },
    };
    const api = vm.runInNewContext(
        source.slice(source.indexOf('    function renderInspectionDebugMode('), source.indexOf('    function setMobileInspection(')) +
        source.slice(source.indexOf('    function bindDebugGesture('), source.indexOf('    async function onPageShow(')) +
        ';({renderInspectionDebugMode,bindDebugGesture})', state);
    api.renderInspectionDebugMode();
    assert.equal(heading.textContent, 'Quer.ee (debug)');
    state.keepUnresolvedTabs = false;
    api.renderInspectionDebugMode();
    assert.equal(heading.textContent, 'Quer.ee');
    api.bindDebugGesture(heading);
    const tap = (timeStamp, isTrusted = true) => click({ timeStamp, isTrusted });
    for ( let i = 0; i < 4; i++ ) { tap(i * 150); }
    assert.equal(calls.length, 0, 'Four taps do not toggle debug');
    tap(600, false);
    assert.equal(calls.length, 0, 'Programmatic clicks do not count');
    tap(750);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].what, 'toggleKeepUnresolvedTabs');
    for ( let i = 0; i < 5; i++ ) { tap(900 + i * 150); }
    assert.equal(calls.length, 2, 'Another five clicks toggle back without an extra sixth click');
    for ( let i = 0; i < 4; i++ ) { tap(2000 + i * 150); }
    tap(6000);
    assert.equal(calls.length, 2, 'A pause breaks the sequence');
    for ( let i = 1; i < 5; i++ ) { tap(6000 + i * 150); }
    assert.equal(calls.length, 3);
    assert.match(source, /bindDebugGesture\(panel\.querySelector\('strong'\)\)/);
    assert.doesNotMatch(source, /onDebugShortcut|addEventListener\('keydown'/);
}

// Connect the real pool to the controller's actual wiring, start, dispatch and cleanup.
async function integratedMobileFixture(slots = 1) {
    const f = fixture({ mobile: true });
    const h = harness({ slots, firstId: 10 });
    Object.assign(f.state, {
        browser: h.browser, createMobileInspectionTabs, queueMicrotask,
        mobileStateRevision: 0, inspectionTimeout: 90000,
        settings: () => ({ enabled: true, simultaneousInspections: slots }),
        record: (_job, verdict, reasons) => ({ verdict, reasons }),
        cancelJobs: (jobs, kind) => {
            for (const job of jobs) { f.api.finish(job, {verdict:'unresolved', reasons:[{kind}]}); }
        },
    });
    h.browser.tabs.sendMessage = async () => {};
    h.browser.tabs.onRemoved.addListener(f.state.onRemoved);
    Object.assign(f.state, {
        observeHistoryCommit() {}, updateSourceLocation() {},
        resetDestination: () => assert.fail('A user takeover must not become an inspection destination'),
        finishKnownDestination: () => assert.fail('A user takeover must not be inspected'),
    });
    vm.runInNewContext(section('browser.webNavigation.onCommitted.addListener(',
        'browser.webNavigation.onHistoryStateUpdated.addListener('), f.state);
    h.pool = vm.runInNewContext(
        section('const mobileTabs = createMobileInspectionTabs(', 'export async function getMobileInspectionState(') +
        ';mobileTabs', f.state);
    f.state.mobileTabs = h.pool;
    vm.runInNewContext(section('async function start(', 'function dispatch('), f.state);
    await run(h.pool.prepare());
    assert.equal(h.pool.acquire(), f.job.tabId);
    const flush = () => run((async () => {
        while (h.pool.replenishing) { await settle(); }
        await settle();
    })());
    return { f, h, flush };
}

mock.timers.enable({ apis: ['setTimeout'] });
try {
    {
        const { f, h, flush } = await integratedMobileFixture(2);
        f.state.settings = () => ({ enabled: true, simultaneousInspections: 3 });
        const create = h.browser.tabs.create;
        h.browser.tabs.create = async details => ({ ...await create(details), incognito:false });
        h.pool.topUp();
        const next = {url:'https://inspection.example/working', started:false, finished:false,
            resolve: result => f.results.push(result)};
        f.state.pendingJobs.push(next);
        f.api.dispatch();
        assert.equal(next.started, true, 'Existing idle capacity starts work during a top-up');
        await flush();
        assert.equal(h.pool.size, 2, 'A rejected nonprivate replacement preserves both working slots');
        assert.equal(f.job.finished, false);
        assert.equal(next.finished, false, 'A failed top-up does not fail working inspections');
        f.api.finish(f.job, {verdict:'candidate'});
        f.api.finish(next, {verdict:'candidate'});
        await flush();
    }
    for ( const transitionType of [ 'typed', 'auto_bookmark', 'keyword' ] ) {
        const { f, h, flush } = await integratedMobileFixture();
        const probes = h.calls.filter(call => call[0] === 'probe').length;
        await h.browser.webNavigation.onCommitted.emit({
            tabId: 10, frameId: 0, transitionType, url: 'https://personal.example/chosen',
        });
        await flush();
        assert.equal(f.job.finished, true, 'The later pool listener releases the controller job');
        assert.equal(f.results[0].reasons[0].kind, 'inspection_taken_over');
        assert.equal(f.state.inspectionTabs.has(10), false);
        assert.equal(h.current.has(10), true, 'The user keeps the tab');
        assert.equal(h.calls.filter(call => call[0] === 'probe').length, probes,
            'No controller scripts are injected into the user-selected destination');
        assert.equal(h.calls.some(call => call[0] === 'remove' && call[1] === 10), false);
    }
    {
        const { f, h, flush } = await integratedMobileFixture();
        await h.browser.tabs.update(10, {url:'https://evidence.example/first'});
        await h.activate(10);
        assert.equal(f.job.finished, false, 'Watching an inspection does not cancel or transfer it');
        const next = {url:'https://evidence.example/second', started:false, finished:false,
            resolve: result => f.results.push(result)};
        f.state.pendingJobs.push(next);
        f.api.finish(f.job, {verdict:'unresolved'});
        assert.equal(h.pool.replenishing, true);
        assert.equal(h.pool.size, 0);
        await flush();
        assert.equal(next.started, true, 'Queued work starts automatically on a replacement tab');
        assert.notEqual(next.tabId, 10);
        assert.equal(f.state.activeJobs, 1);
        assert.equal(h.pool.size, 1);
        assert.equal(h.current.get(10).url, 'https://evidence.example/first');
        assert.equal(h.current.get(10).active, true, 'Replacement restores the retained tab being watched');
        assert.equal(h.calls.some(call => call[0] === 'probe'), false, 'Replacement does not retest background execution');
        f.api.finish(next, {verdict:'unresolved'});
        await flush();
        assert.equal(f.state.activeJobs, 0);
        assert.equal(f.state.inspectionTabs.size, 2);
        assert.equal(h.pool.size, 1, 'Repeated failures retain evidence without draining capacity');
        f.api.releaseKeptInspection(f.job);
        f.api.releaseKeptInspection(next);
        await flush();
        assert.equal(h.current.has(10) || h.current.has(next.tabId), false, 'Debug-off actually closes both retained tabs');
        assert.equal(f.state.inspectionTabs.size, 0);
        assert.equal(h.pool.size, 1, 'Retained cleanup leaves replacement capacity intact');
        assert.equal(h.current.get(1).url, 'https://www.google.com/search?q=test');
        assert.equal(h.current.get(2).url, 'https://personal.example/');
        assert.equal(f.results.length, 2, 'Retention and cleanup do not emit duplicate results');
    }
    {
        const { f, h, flush } = await integratedMobileFixture();
        // Return the fixture's initial job so the diagnostic starts with one idle slot.
        f.api.finish(f.job, {verdict:'candidate'});
        await flush();
        const script = h.browser.tabs.executeScript;
        let next, probeId;
        h.browser.tabs.executeScript = async (id, details) => {
            if (next === undefined && details.code.includes('__quereeBackgroundTimer')) {
                probeId = id;
                assert.equal(h.pool.replenishing, false, 'The diagnostic does not hold the replacement lock');
                next = {url:'https://inspection.example/new', started:false, finished:false,
                    resolve: result => f.results.push(result)};
                f.state.pendingJobs.push(next);
                f.api.dispatch();
                assert.equal(next.started, true, 'Work arriving during a probe starts immediately at a one-slot limit');
                assert.notEqual(next.tabId, probeId);
                assert.equal(f.state.activeJobs, 1);
                f.api.finish(next, {verdict:'unresolved'});
                assert.equal(h.pool.replenishing, true, 'Retention queues its replacement without foregrounding the probe');
            }
            return script(id, details);
        };
        assert.equal((await run(h.pool.prepare(1))).background, 'running');
        await flush();
        assert.equal((await h.pool.status()).ready, true, 'Replacement resumes after the background check');
        assert.equal(h.current.has(probeId), false, 'The dedicated diagnostic tab is temporary');
        assert.equal(h.current.has(next.tabId), true, 'Probe cleanup cannot close retained inspection evidence');
        f.api.releaseKeptInspection(next);
        await flush();
        assert.equal(h.current.has(next.tabId), false);
    }
} finally {
    mock.timers.reset();
}

console.log('Passed: unresolved tabs accumulate outside working capacity; real mobile pool/controller replacement, diagnostics and cleanup stay intact');

{
    const queries = [], messages = [];
    let changed;
    const kept = { kept: true };
    const state = {
        µb: { hiddenSettings: { quereeKeepUnresolvedTabs: false } },
        inspectionTabGeneration: 0, settingsRevision: 0, inspectionTabs: new Map([[10, kept]]),
        settings: () => ({ enabled: true }),
        settingsSnapshot: () => ({ inspectionTabGeneration: state.inspectionTabGeneration, revision: state.settingsRevision }),
        releaseKeptInspection: job => { job.kept = false; },
        browser: { tabs: { query: () => new Promise(resolve => queries.push(resolve)),
            sendMessage: async (_id, message) => { messages.push(message); } } },
        onBroadcast: listener => { changed = listener; },
    };
    vm.runInNewContext(section('async function notifyEnabledChanged(', 'async function refreshProfile(') +
        section('onBroadcast(message => {', 'const recoverInspectionTabs ='), state);
    changed({what:'hiddenSettingsChanged'});
    state.µb.hiddenSettings.quereeKeepUnresolvedTabs = true;
    changed({what:'hiddenSettingsChanged'});
    queries.forEach(resolve => resolve([{id:1}]));
    await settle();
    assert.equal(kept.kept, false);
    assert.equal(messages.length, 1, 'The earlier off notice can be coalesced');
    assert.equal(messages[0].inspectionTabGeneration, 1, 'The surviving on notice still invalidates old retained-tab links');
}
