import { harness, run } from './mobile-inspection-fixture.mjs';
import assert from 'node:assert/strict';
import { createMobileInspectionTabs } from '../../src/js/queree/mobile-inspection-tabs.js';
import { mock } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Advance browser delays without a device, real waits, or source-text extraction.
mock.timers.enable({ apis: [ 'setTimeout' ] });
const created = h => h.calls.filter(c => c[0] === 'create').length;
const probes = h => h.calls.filter(c => c[0] === 'probe').length;
const idleURL = 'moz-extension://fixture/queree-inspection.html';
const drain = h => run((async () => {
    while (h.pool.replenishing) { await new Promise(resolve => setTimeout(resolve, 250)); }
})());

try {
    {
        const h = harness({slots:6, firstId:10});
        for (let id = 3; id < 8; id++) {
            h.current.set(id, {id, incognito:true, active:false, url:idleURL});
        }
        await h.pool.initialize();
        await drain(h);
        assert.equal(h.pool.size, 6, 'Startup tops up five recovered tabs to the configured six');
        assert.equal(created(h), 1);
        assert.equal(probes(h), 0, 'Automatic startup refill is not a background diagnostic');
        assert.equal(h.current.get(1).active, true);
        assert.equal(h.current.get(2).url, 'https://personal.example/');
        const busy = h.pool.acquire();
        h.setSlots(3);
        h.pool.topUp();
        await drain(h);
        assert.equal(h.pool.size, 6, 'Reducing concurrency does not close idle or busy tabs');
        assert.equal(h.current.has(busy), true);
        h.setSlots(8);
        await run(h.pool.topUp());
        assert.equal(h.pool.size, 8, 'An increased limit fills only the missing slots');
        assert.equal(h.current.has(busy), true);
    }
    for (const loss of ['close', 'takeover']) {
        const h = harness({slots:2});
        await run(h.pool.prepare(1));
        const id = h.pool.acquire();
        await run(h.pool.release(id));
        const before = probes(h);
        if (loss === 'close') { await h.browser.tabs.remove(id); }
        else { await h.browser.tabs.update(id, {url:'https://personal.example/taken'}); }
        await drain(h);
        assert.equal(h.pool.size, 2, `${loss} replaces the missing working tab`);
        assert.equal(probes(h), before, 'Replacement never repeats the diagnostic');
        if (loss === 'takeover') {
            assert.equal(h.current.get(id).url, 'https://personal.example/taken');
            await h.browser.tabs.update(id, {url:idleURL});
            await h.pool.status();
            assert.notEqual(h.pool.acquire(), id, 'A user-owned tab is not recaptured');
        }
    }
    {
        const h = harness({slots:1});
        await run(h.pool.prepare(1));
        const id = h.pool.acquire();
        await h.browser.tabs.remove(id);
        await drain(h);
        assert.equal(h.pool.size, 1, 'Closing the last working tab replaces it when a private seed remains');
    }
    {
        const h = harness({slots:2});
        const update = h.browser.tabs.update;
        let increased = false;
        h.browser.tabs.update = async (id, details) => {
            if (id === 1 && details.active && !increased) {
                increased = true;
                h.setSlots(3);
                h.pool.topUp();
            }
            return update(id, details);
        };
        await run(h.pool.prepare());
        await drain(h);
        assert.equal(h.pool.size, 3, 'A limit increase during setup gets one follow-up refill');
    }
    for (const phase of ['prepare', 'refill']) {
        for (const trigger of ['close', 'increase']) {
            const h = harness({slots:phase === 'prepare' ? 2 : 1});
            if (phase === 'refill') {
                await run(h.pool.prepare());
                h.setSlots(2);
            } else {
                await h.pool.initialize();
            }
            const update = h.browser.tabs.update;
            let triggered = false;
            h.browser.tabs.update = async (id, details) => {
                if (id === 1 && details.active && !triggered) {
                    triggered = true;
                    if (trigger === 'close') {
                        await h.browser.tabs.remove(3);
                    } else {
                        h.setSlots(3);
                        h.pool.topUp();
                    }
                }
                return update(id, details);
            };
            await run(phase === 'prepare' ? h.pool.prepare() : h.pool.topUp());
            await drain(h);
            assert.equal(triggered, true);
            assert.equal(h.pool.size, trigger === 'close' ? 2 : 3,
                `${trigger} during ${phase} restoration gets a follow-up refill`);
        }
    }
    {
        const h = harness({slots:2});
        await h.pool.initialize();
        const update = h.browser.tabs.update;
        let increased = false;
        h.browser.tabs.update = async (id, details) => {
            if (details.url === idleURL && !increased) {
                increased = true;
                h.setSlots(3);
                h.pool.topUp();
            }
            return update(id, details);
        };
        await run(h.pool.prepare());
        await drain(h);
        assert.equal(increased, true);
        assert.equal(h.pool.size, 3, 'A limit increase during creation outlives the initial attempt limit');
    }
    {
        const h = harness({slots:1});
        await h.pool.initialize();
        const update = h.browser.tabs.update;
        let closed = false;
        h.browser.tabs.update = async (id, details) => {
            if (id === 1 && details.active && !closed) {
                closed = true;
                await h.browser.tabs.remove(3);
            }
            return update(id, details);
        };
        await run(h.pool.prepare());
        await drain(h);
        assert.equal(closed, true);
        assert.equal(h.pool.size, 1, 'Closing the last tab during setup still schedules a replacement');
    }
    {
        const h = harness({slots:1});
        await run(h.pool.prepare());
        const script = h.browser.tabs.executeScript;
        let checked = false;
        h.browser.tabs.executeScript = async (id, details) => {
            if (details.code.includes('__quereeBackgroundTimer')) {
                const before = created(h);
                h.setSlots(2);
                h.pool.topUp();
                assert.equal(h.pool.replenishing, true);
                return new Promise(resolve => setTimeout(() => {
                    assert.equal(created(h), before, 'An ordinary top-up waits for the diagnostic');
                    checked = true;
                    resolve([{hidden:true, fired:true}]);
                }, 1000));
            }
            return script(id, details);
        };
        await run(h.pool.prepare(1));
        await drain(h);
        assert.equal(checked, true);
        assert.equal(h.pool.size, 2, 'The ordinary top-up resumes after the diagnostic');
    }
    {
        const h = harness({slots:2});
        await run(h.pool.prepare(1));
        const id = h.pool.acquire();
        await run(h.pool.release(id));
        const create = h.browser.tabs.create;
        h.browser.tabs.create = async details => {
            const tab = await create(details);
            tab.incognito = false;
            return tab;
        };
        const before = created(h), diagnostic = probes(h);
        await h.browser.tabs.remove(id);
        await drain(h);
        assert.equal(created(h), before + 1, 'A failed refill makes one bounded attempt, not a focus loop');
        assert.equal(h.pool.size, 1);
        assert.notEqual(h.pool.acquire(), undefined, 'Remaining working capacity is still usable');
        assert.equal(probes(h), diagnostic);
        h.browser.tabs.create = create;
        await run(h.pool.topUp());
        assert.equal(h.pool.size, 2, 'A later demand can retry the failed refill');
    }
    {
        const h = harness({slots:1});
        await run(h.pool.prepare());
        const update = h.browser.tabs.update;
        h.browser.tabs.update = async (id, details) => {
            if (details.url === idleURL) { throw Error('Cannot initialize tab'); }
            return update(id, details);
        };
        const before = created(h);
        h.setSlots(2);
        await run(h.pool.topUp());
        await drain(h);
        assert.equal(created(h), before + 1, 'Failed initialization does not trigger another refill');
        assert.equal(h.pool.size, 1);
    }
    {
        const h = harness({ wrongMode: true });
        const remove = h.browser.tabs.remove;
        h.browser.tabs.remove = async id => {
            await remove(id);
            await h.activate(2);
        };
        await run(h.pool.prepare(1));
        assert.equal(h.current.get(1).active, true, 'Removing a wrong-mode fallback returns to the search, not its neighbour');
    }
    {
        const h = harness();
        const create = h.browser.tabs.create;
        let failed = false;
        h.browser.tabs.create = details => {
            if ( failed === false ) { failed = true; return Promise.reject(new Error('First setup failed')); }
            return create(details);
        };
        const outcomes = await run(Promise.allSettled([h.pool.prepare(1), h.pool.prepare(undefined, true)]));
        assert.equal(outcomes[0].status, 'rejected');
        assert.equal(outcomes[1].status, 'fulfilled', 'A waiting refill retries independently of a failed setup');
        assert.equal(h.pool.size, 2);
    }
    for ( const options of [{os:'linux'}, {allowed:false}, {privateTab:false}] ) {
        const h = harness(options);
        const result = await run(h.pool.prepare(1));
        assert.equal(result.ready, false);
        assert.equal(h.calls.length, 0, 'Missing setup must not disturb browsing');
        assert.equal(h.pool.replenishing, false);
    }
    {
        const h = harness();
        const [a, b] = await run(Promise.all([h.pool.prepare(1), h.pool.prepare(1)]));
        assert.equal(a.ready, true);
        assert.equal(b.ready, true);
        assert.equal(a.replenishing, false, 'Returned setup state is settled');
        assert.equal(created(h), 3, 'Concurrent Q requests share the pool and one temporary probe');
        assert.equal(h.current.size, 4, 'The temporary diagnostic tab closes after the check');
        assert.equal(probes(h), 1, 'The timer returns its result without a second read');
        assert.equal(h.current.get(1).active, true);
        assert.equal(h.current.get(2).url, 'https://personal.example/');
        const first = h.pool.acquire(), second = h.pool.acquire();
        assert.notEqual(first, second);
        assert.equal(h.pool.acquire(), undefined);
        await h.browser.tabs.update(first, { url: 'https://fixture.example/page' });
        assert.equal(await run(h.pool.release(first)), true);
        assert.equal(h.current.get(first).url, idleURL);
        assert.equal(h.pool.acquire(), first);
        await run(h.pool.release(first));
        await run(h.pool.release(second));
        h.disable();
        await run(h.pool.prepare(1));
        assert.equal(h.pool.size, 2, 'Disabling retains the reusable tabs');
        const recovered = createMobileInspectionTabs(h.options);
        await recovered.initialize();
        assert.equal(recovered.size, 2, 'Startup rediscovers waiting pages only');
        for ( const id of [first, second] ) { await h.browser.tabs.remove(id); }
        const empty = await h.pool.status();
        assert.equal(empty.tabsReady, false);
        assert.equal(empty.background, 'running', 'Pool emptying preserves the saved pass');
    }
    {
        const h = harness({slots:1});
        h.current.get(2).url = idleURL;
        await h.pool.initialize();
        const script = h.browser.tabs.executeScript;
        let visible = false;
        h.browser.tabs.executeScript = (id, details) => details.code === 'document.hidden === false'
            ? Promise.resolve([visible]) : script(id, details);
        const hidden = await run(h.pool.prepare(1));
        assert.equal(hidden.background, 'unchecked');
        assert.equal(hidden.problem, 'source_unavailable');
        assert.equal(h.calls.length, 0, 'An app-hidden source must not switch browsing modes or create a probe');
        visible = true;
        const ready = await run(h.pool.prepare(1));
        assert.equal(ready.background, 'running', 'Recovered tabs can be checked when the search becomes visible');
        assert.equal(h.pool.size, 1);
        assert.equal(created(h), 1, 'Startup reuses the pool and creates only its temporary probe');
        assert.equal(h.current.size, 2, 'The startup probe is removed');
    }
    {
        const h = harness({wrongMode:true, slots:1});
        h.current.get(2).url = idleURL;
        await h.pool.initialize();
        const result = await run(h.pool.prepare(1));
        assert.equal(result.background, 'unavailable', 'An attempted check is distinct from one never started');
        assert.equal(result.problem, 'background_check_failed');
        assert.equal(h.pool.size, 1, 'Wrong-mode diagnostics preserve the recovered inspection pool');
        assert.equal(h.current.size, 2, 'A nonprivate probe is removed without loading the test URL');
        assert.equal(h.calls.some(c => c[0] === 'update' && c[2].url), false);
    }
    for ( const wrongMode of [true, false] ) {
        const h = harness({wrongMode});
        if (!wrongMode) {
            const create = h.browser.tabs.create;
            h.browser.tabs.create = async details => { const tab = await create(details); h.disable(); return tab; };
        }
        await run(h.pool.prepare(1));
        assert.equal(h.pool.size, 0);
        assert.equal(h.current.size, 2, 'Wrong-context or disabled creation is cleaned up');
        assert.equal(h.calls.some(c => c[0] === 'update' && c[2].url), false);
    }
    console.log('Passed: bounded private setup, reuse, startup recovery and saved background pass');

    for ( const missedEvent of [false, true] ) {
        const h = harness();
        await run(h.pool.prepare(1));
        const id = h.pool.acquire();
        await run(h.pool.release(id));
        if (missedEvent) { h.current.get(id).url = 'https://personal.example/taken-over'; }
        else { await h.browser.tabs.update(id, { url: 'https://personal.example/taken-over' }); }
        await h.pool.status();
        assert.equal(h.pool.size, 1);
        const calls = h.calls.length;
        h.pool.keep(id);
        assert.equal(await h.pool.release(id), true);
        assert.equal(h.calls.length, calls, 'Unowned release/keep must not navigate or close');
        assert.notEqual(h.pool.acquire(), id);
        await h.browser.tabs.update(id, { url: idleURL });
        await h.pool.status();
        assert.equal(h.pool.size, 1, 'Back to idle must not re-adopt a user tab');
    }
    {
        const h = harness();
        await run(h.pool.prepare(1));
        const id = h.pool.acquire();
        await h.browser.tabs.update(id, { url: 'https://fixture.example/progress' });
        await h.activate(id);
        assert.equal(h.pool.size, 2, 'Looking at a busy inspection preserves ownership');
        assert.deepEqual(h.takeovers, []);
        await h.browser.webNavigation.onCommitted.emit({tabId:id, frameId:0, transitionType:'link'});
        await h.browser.webNavigation.onCommitted.emit({tabId:id, frameId:0, transitionType:'auto_subframe'});
        assert.equal(h.pool.size, 2, 'Ambiguous navigation is not fabricated user intent');
        await h.activate(1);
        await run(h.pool.release(id));
        await h.activate(id);
        assert.notEqual(h.pool.acquire(), id, 'An active idle page is not lent out');
        assert.equal(h.pool.size, 2, 'Looking at idle does not confiscate it');
    }
    for ( const transitionType of ['typed', 'auto_bookmark', 'keyword'] ) {
        const h = harness();
        await run(h.pool.prepare(1));
        const id = h.pool.acquire();
        await h.activate(id);
        await h.browser.webNavigation.onCommitted.emit({tabId:id, frameId:1, transitionType});
        assert.deepEqual(h.takeovers, [], 'Child-frame navigation cannot take over the tab');
        await h.browser.tabs.update(id, { url: 'https://personal.example/user-page' });
        await h.browser.webNavigation.onCommitted.emit({tabId:id, frameId:0, transitionType});
        assert.deepEqual(h.takeovers, [id]);
        assert.equal(h.pool.size, 1);
        const calls = h.calls.length;
        await h.pool.release(id);
        h.pool.keep(id);
        assert.equal(h.calls.length, calls, 'Cleanup cannot replace or close a taken-over page');
    }
    {
        const h = harness();
        await run(h.pool.prepare(1));
        const first = h.pool.acquire(), second = h.pool.acquire();
        // Retention includes failures still displaying the idle URL.
        const replacements = [h.pool.keep(first), h.pool.keep(second)];
        assert.equal(h.pool.size, 0, 'Retained evidence is outside working capacity');
        assert.equal(h.pool.replenishing, true, 'Queued work waits only for actual replacement attempts');
        await run(Promise.all(replacements));
        assert.equal(h.pool.replenishing, false);
        assert.equal(h.pool.size, 2, 'Retention automatically restores working capacity');
        assert.equal(h.current.get(1).active, true, 'Replacement restores the search without a manual switch');
        assert.equal(probes(h), 1, 'Refill does not repeat the diagnostic');
        assert.equal(h.current.get(first).url, idleURL);
        assert.equal(h.current.get(second).url, idleURL);
        assert.equal(created(h), 5);
        const replacement = h.pool.acquire();
        assert.equal([first,second].includes(replacement), false);
        await run(Promise.all([h.pool.release(first), h.pool.release(second)]));
        assert.equal(h.current.has(first) || h.current.has(second), false, 'Debug-off closes retained pages');
        await h.browser.tabs.remove(replacement);
        await drain(h);
        const before = created(h);
        await run(h.activate(2));
        assert.equal(h.pool.size, 2, 'Closing a replacement tops the working pool back up');
        assert.equal(created(h), before, 'Ordinary switches do not trigger another refill');
    }
    console.log('Passed: observation preserved, explicit navigation relinquishes, retained/user pages stay untouched');

    for ( const action of ['navigate', 'close', 'roundtrip'] ) {
        const h = harness();
        await run(h.pool.prepare(1));
        const id = h.pool.acquire();
        await run(h.pool.release(id));
        if (action === 'roundtrip') { h.current.get(id).url = 'https://fixture.example/stale'; }
        const query = h.browser.tabs.query;
        let resolveSnapshot, snapshotReady;
        const ready = new Promise(resolve => { snapshotReady = resolve; });
        h.browser.tabs.query = async options => {
            const snapshot = await query(options);
            if ( resolveSnapshot === undefined && !options.active ) {
                return new Promise(resolve => { resolveSnapshot = () => resolve(snapshot); snapshotReady(); });
            }
            return snapshot;
        };
        const stale = h.pool.status();
        await ready;
        if (action === 'close') { await h.browser.tabs.remove(id); }
        else if (action === 'navigate') { await h.browser.tabs.update(id, { url: 'https://personal.example/user-page' }); }
        else {
            assert.equal(h.pool.acquire(), id);
            await run(h.pool.release(id));
        }
        resolveSnapshot();
        await stale;
        assert.equal(h.pool.size, action === 'roundtrip' ? 2 : 1,
            'A stale snapshot cannot retire a loan returned since its query or recover a removed tab');
    }
    {
        const h = harness();
        const query = h.browser.tabs.query;
        let calls = 0;
        h.browser.tabs.query = async options => { if (++calls === 1) { throw Error('Discovery failed'); } return query(options); };
        await assert.rejects(h.pool.initialize(), /Discovery failed/);
        const counts = [h.browser.tabs.onActivated.size, h.browser.tabs.onUpdated.size, h.browser.webNavigation.onCommitted.size];
        await h.pool.initialize();
        assert.deepEqual([h.browser.tabs.onActivated.size, h.browser.tabs.onUpdated.size, h.browser.webNavigation.onCommitted.size], counts);
        assert.equal((await run(h.pool.prepare(1))).ready, true, 'Q recovers from initial discovery failure');
    }
    console.log('Passed: stale snapshots cannot erase reassigned entries; failed discovery retries without duplicate listeners');

    {
        const h = harness();
        const update = h.browser.tabs.update;
        h.browser.tabs.update = async (id, details) => {
            if (details.url) { throw Error('Waiting page navigation failed'); }
            return update(id, details);
        };
        const state = await run(h.pool.prepare(1));
        assert.equal(state.problem, 'private_tab_needed');
        assert.equal(h.pool.size, 0);
        assert.equal(h.pool.replenishing, false);
        assert.equal(h.current.size, 2, 'Failed blank-page initialization cleans up new tabs');
        assert.equal(h.current.get(1).active, true, 'Failed setup still restores its source');
        assert.ok(created(h) <= 2, 'Failed setup has bounded creation attempts');
    }

    for ( const failure of ['update', 'get', 'redirect', 'script', 'foreground', 'visibleLater', 'paused'] ) {
        const h = harness({backgroundRuns:failure !== 'paused'});
        const update = h.browser.tabs.update;
        const get = h.browser.tabs.get;
        const script = h.browser.tabs.executeScript;
        h.browser.tabs.update = async (id, details) => {
            if (details.url === 'https://quer.ee/favicon.svg') {
                if (failure === 'update') { return new Promise(() => {}); }
                if (failure === 'redirect') { return update(id, {url:'https://redirect.example/'}); }
            }
            return update(id, details);
        };
        h.browser.tabs.get = async id => {
            if (failure === 'get' && h.current.get(id)?.url === 'https://quer.ee/favicon.svg') { return new Promise(() => {}); }
            return get(id);
        };
        h.browser.tabs.executeScript = async (id, details) => {
            if (details.code === 'document.hidden === false') { return script(id, details); }
            if (failure === 'script') { throw Error('Injection unavailable'); }
            if (failure === 'foreground') { return [false]; }
            if (failure === 'visibleLater') { return [{hidden:false, fired:true}]; }
            return script(id, details);
        };
        const result = await run(h.pool.prepare(1));
        assert.equal(result.background, failure === 'paused' ? 'paused' : 'unavailable', failure);
        assert.equal(result.problem, failure === 'paused' ? undefined : 'background_check_failed', failure);
        assert.equal(h.pool.replenishing, false);
        assert.equal(h.pool.available, 2);
        assert.equal(h.current.get(1).active, true);
        assert.ok(h.states.some(s => s.background === 'checking'), 'Publish checking at the start');
    }
    console.log('Passed: probe hangs, redirects, injection failures and foreground timers remain retryable, not falsely paused');

    for ( const runs of [true, false] ) {
        const h = harness();
        const documents = new Map();
        let deadlineElapsed = false, deadline;
        h.browser.tabs.executeScript = async (id, details) => {
            if (!documents.has(id)) {
                documents.set(id, vm.createContext({window:{}, document:{
                    get hidden() { return h.current.get(id).active === false; },
                    addEventListener() {}, removeEventListener() {},
                }, setTimeout: callback => { if (runs) { setTimeout(callback, 1000); } }}));
            }
            if (details.code.includes('setTimeout')) {
                deadline = setTimeout(() => { deadlineElapsed = true; }, 6000);
            }
            return [await vm.runInContext(details.code, documents.get(id))];
        };
        assert.equal((await run(h.pool.prepare(1))).background, runs ? 'running' : 'paused',
            'The actual injected scripts distinguish a hidden timer firing from a suspended timer');
        assert.equal(deadlineElapsed, !runs, 'A working timer reports success before the failure deadline');
        clearTimeout(deadline);
    }

    {
        const h = harness({slots:1});
        await run(h.pool.prepare());
        const id = h.pool.acquire();
        assert.equal((await run(h.pool.prepare(1))).background, 'running', 'A busy pool does not postpone the diagnostic');
        assert.equal(h.pool.size, 1);
        await run(h.pool.release(id));
        const before = probes(h);
        await h.activate(2);
        assert.equal(probes(h), before, 'Ordinary tab switches do not restart the probe');
    }

    for ( const moment of ['permission', 'activation', 'creation'] ) {
        const h = harness();
        h.current.set(90, {id:90, incognito:false, active:false, url:'https://other.example/'});
        if (moment === 'permission') {
            h.browser.extension.isAllowedIncognitoAccess = async () => { await h.activate(90); return true; };
        } else if (moment === 'activation') {
            const update = h.browser.tabs.update;
            h.browser.tabs.update = async (id, details) => {
                const result = await update(id, details);
                if (id === 2 && details.active) { await h.activate(90); }
                return result;
            };
        } else {
            const create = h.browser.tabs.create;
            h.browser.tabs.create = async details => { const tab = await create(details); await h.activate(90); return tab; };
        }
        await run(h.pool.prepare(1));
        assert.equal(h.current.get(90).active, true, moment);
        assert.equal(probes(h), 0, 'Interrupted setup must not activate a probe');
        assert.equal(h.pool.replenishing, false, 'Abandoned setup leaves no pending refill');
        const before = h.calls.length;
        await h.browser.tabs.onUpdated.emit(1, {status:'complete'});
        assert.equal(h.calls.length, before, 'Normal-tab updates do not restart setup');
    }
    for ( const settingsURL of ['about:config?filter=dom.suspend_inactive.enabled', 'chrome://geckoview/content/config.xhtml'] ) {
        const h = harness({backgroundRuns:false});
        await run(h.pool.prepare(1));
        const before = probes(h);
        await h.activate(1);
        assert.equal(probes(h), before, 'Ordinary switches retain the check');
        h.current.get(1).url = settingsURL;
        await h.browser.tabs.onUpdated.emit(1, {status:'complete'});
        h.setBackgroundRuns(true);
        h.current.get(1).url = 'https://www.google.com/search?q=test&rewritten=1';
        await run(h.browser.tabs.onUpdated.emit(1, {status:'complete'}));
        assert.equal((await h.pool.status()).ready, true, 'Settings return tolerates a rewritten search URL');
        assert.equal(probes(h), before + 1);
    }
    console.log('Passed: interrupted setup respects user focus; Q settings returns retest by active source id');

    for ( const moment of ['seed', 'restore'] ) {
        const h = harness();
        h.current.set(90, {id:90, incognito:false, active:false, url:'https://other.example/'});
        const query = h.browser.tabs.query;
        let captured = false;
        h.browser.tabs.query = async options => {
            const snapshot = await query(options);
            if (options.active && !captured && (moment === 'seed' || created(h) !== 0)) {
                captured = true;
                await h.activate(90);
            }
            return snapshot;
        };
        await run(h.pool.prepare(1));
        assert.equal(captured, true);
        assert.equal(h.current.get(90).active, true, 'Stale focus-query replies cannot undo a newer user activation');
        assert.equal(probes(h), 0);
    }

    for ( const failure of ['interrupted', 'no_seed'] ) {
        const h = harness({slots:1});
        await run(h.pool.prepare());
        const id = h.pool.acquire();
        if (failure === 'no_seed') {
            const query = h.browser.tabs.query;
            let removed = false;
            h.browser.tabs.query = async options => {
                if (!removed) {
                    removed = true;
                    await h.browser.tabs.remove(2);
                    await h.browser.tabs.remove(id);
                }
                return query(options);
            };
        } else {
            const query = h.browser.tabs.query;
            h.browser.tabs.query = async options => {
                const snapshot = await query(options);
                if (options.active) { await h.activate(2); }
                return snapshot;
            };
        }
        await run(h.pool.keep(id));
        assert.equal(h.pool.replenishing, false, 'An unsuccessful replacement leaves no phantom wait');
    }

    for ( const phase of ['setup', 'probe'] ) {
        const h = harness();
        const create = h.browser.tabs.create, update = h.browser.tabs.update;
        if (phase === 'setup') {
            h.browser.tabs.create = async details => {
                const tab = await create(details);
                setTimeout(() => {
                    void update(tab.id, {url:'https://personal.example/typed'});
                    void h.browser.webNavigation.onCommitted.emit({tabId:tab.id, frameId:0, transitionType:'typed'});
                }, 250);
                return tab;
            };
        } else {
            h.browser.tabs.update = async (id, details) => {
                if (details.url === 'https://quer.ee/favicon.svg') {
                    await update(id, {url:'https://personal.example/typed'});
                    await h.browser.webNavigation.onCommitted.emit({tabId:id, frameId:0, transitionType:'typed'});
                    return {...h.current.get(id)};
                }
                return update(id, details);
            };
        }
        await run(h.pool.prepare(1));
        const id = h.takeovers[0];
        assert.notEqual(id, undefined);
        assert.equal(h.current.get(id).active, true, 'Setup must not restore focus away from a user navigation');
        assert.equal(h.current.get(id).url, 'https://personal.example/typed');
        if (phase === 'setup') { assert.equal(created(h), 1, 'User navigation interrupts the fill loop'); }
    }

    {
        const h = harness();
        await run(h.pool.prepare(1));
        const id = h.pool.acquire();
        const update = h.browser.tabs.update, remove = h.browser.tabs.remove;
        h.browser.tabs.update = async (id, details) => {
            if (details.url) { throw Error('Cannot blank'); }
            return update(id, details);
        };
        let attempts = 0;
        h.browser.tabs.remove = async id => { if (++attempts === 1) { throw Error('Transient close failure'); } return remove(id); };
        assert.equal(await run(h.pool.release(id)), true);
        assert.equal(attempts, 2, 'Retry close once after failed blanking');
    }
    {
        const h = harness();
        await run(h.pool.prepare(1));
        const id = h.pool.acquire();
        h.browser.tabs.update = async () => { throw Error('Cannot blank'); };
        h.browser.tabs.remove = async () => { throw Error('Cannot close'); };
        assert.equal(await run(h.pool.release(id)), false, 'Report permanent cleanup failure');
        assert.equal(h.pool.size, 1, 'A failed cleanup is not usable capacity');
    }
    {
        const h = harness();
        await run(h.pool.prepare(1));
        const id = h.pool.acquire();
        const update = h.browser.tabs.update;
        h.browser.tabs.update = async (target, details) => {
            if (target === id && details.url === idleURL) {
                await h.browser.webNavigation.onCommitted.emit({tabId:id, frameId:0, transitionType:'typed'});
                throw Error('User navigated during cleanup');
            }
            return update(target, details);
        };
        const calls = h.calls.length;
        assert.equal(await run(h.pool.release(id)), true);
        assert.equal(h.calls.slice(calls).some(c => c[0] === 'remove'), false,
            'A relinquished tab cannot be closed by failed cleanup');
    }
    {
        const h = harness();
        await run(h.pool.prepare(1));
        const first = h.pool.acquire(), second = h.pool.acquire();
        const before = h.states.length, wakes = h.wakes;
        await run(h.pool.release(first));
        await run(h.pool.release(second));
        assert.equal(h.states.length, before, 'Slot return does not rebroadcast unchanged Q state');
        assert.ok(h.wakes > wakes, 'Slot return still wakes dispatch');
        for (let i = 1; i < h.states.length; i++) {
            assert.ok(h.states[i].revision > h.states[i - 1].revision);
        }
        assert.equal((await h.pool.status()).revision, h.states.at(-1).revision);
    }
    console.log('Passed: bounded cleanup retries, takeover during cleanup, deduplicated state revisions and dispatch wakeups');
} finally {
    mock.timers.reset();
}

{
    const script = readFileSync(new URL('../../src/js/queree/inspection-navigation.js', import.meta.url), 'utf8');
    const html = readFileSync(new URL('../../src/queree-inspection.html', import.meta.url), 'utf8');
    assert.ok(html.includes('src="js/queree/inspection-navigation.js"'));
    for ( const target of [null, 'https://fixture.example/post?a=b%26c#part', 'http://fixture.example/',
        'javascript:alert(1)', 'intent://fixture.example/'] ) {
        const visited = [];
        vm.runInNewContext(script, {
            URLSearchParams,
            window: { location: { search: target === null ? '' : '?url=' + encodeURIComponent(target),
                replace: url => visited.push(url) } },
        });
        assert.deepEqual(visited, target !== null && /^https?:\/\//.test(target) ? [target] : [],
            'Waiting-page navigation preserves web addresses and rejects non-web destinations');
    }
}
console.log('Passed: waiting-page navigation preserves web addresses and rejects non-web destinations');
