/*******************************************************************************

    Quer.ee reusable Android inspection tabs
    Copyright (C) 2026-present Marcos
    SPDX-License-Identifier: GPL-3.0-or-later

*/

export function createMobileInspectionTabs({
    browser, enabled, limit, changed, wake = () => {},
    takenOver = () => {},
}) {
    const idleURL = browser.runtime.getURL('queree-inspection.html');
    const tabs = new Map();
    let android = false;
    let initialized, listenersRegistered = false, discovered = false;
    let preparing, checking, refilling, settingsReturn, pendingTopUp = false;
    let activeTabId, activationGeneration = 0, navigationGeneration = 0, revision = 0, published;
    let background = 'unchecked';

    function state() {
        const tabsReady = size() !== 0;
        return { mobile: android, tabsReady, background,
            replenishing: preparing !== undefined || refilling !== undefined,
            ready: tabsReady && background === 'running', revision };
    }

    function publish() {
        const snapshot = state();
        delete snapshot.revision;
        const current = JSON.stringify(snapshot);
        if ( current === published ) { return; }
        published = current;
        revision += 1;
        changed(state());
    }

    async function refresh() {
        const queryGeneration = navigationGeneration;
        const knownTabs = new Map(tabs);
        const current = await browser.tabs.query({});
        // Entry identity changes on every loan/return, even idle -> busy -> idle.
        for ( const [ id, entry ] of knownTabs ) {
            if ( tabs.get(id) !== entry ) { continue; }
            const tab = current.find(tab => tab.id === id && tab.incognito);
            if ( tab === undefined || (entry.busy === false && tab.url !== idleURL) ) { tabs.delete(id); }
        }
        if ( queryGeneration === navigationGeneration ) {
            activeTabId = current.find(tab => tab.active)?.id;
            // Recover waiting pages once at startup, not after keep() or a user's Back.
            // Live inspection pages after a background restart remain unrecoverable on Android.
            if ( discovered === false ) {
                for ( const tab of current ) {
                    if ( tab.incognito && tab.url === idleURL && tabs.has(tab.id) === false ) {
                        tabs.set(tab.id, { busy: false });
                    }
                }
                discovered = true;
            }
        }
        publish();
        wake();
        return current;
    }

    async function prepare(sourceId, refillRun = false) {
        await initialize();
        if ( android === false || enabled() === false ) { return state(); }
        const checkBackground = sourceId !== undefined;
        if ( checkBackground && checking !== undefined ) { return checking; }
        if ( preparing !== undefined ) {
            if ( checkBackground === false && refillRun === false ) { return preparing; }
            await preparing.catch(() => {});
            return prepare(sourceId, refillRun);
        }
        let source, activeId, shownTabId, problem;
        const stillActive = async () => {
            const generation = activationGeneration;
            const active = await browser.tabs.query({ active: true });
            return generation === activationGeneration && active.some(tab => tab.id === activeId);
        };
        const restoreSource = async () => {
            if ( source === undefined || activeId === source.id ) { return; }
            const generation = activationGeneration;
            const active = await browser.tabs.query({ active: true });
            if ( generation !== activationGeneration ) { return; }
            if ( active.length !== 0 ) {
                if ( active.some(tab => tab.id === activeId) === false ) { return; }
                if ( shownTabId === activeId && tabs.has(activeId) === false ) { return; }
            }
            await browser.tabs.update(source.id, { active: true }).catch(() => {});
            activeId = source.id;
        };
        const operation = (async () => {
            if ( await browser.extension.isAllowedIncognitoAccess() === false ) {
                problem = 'private_permission_needed';
                return;
            }
            const current = await refresh();
            source = sourceId === undefined ? current.find(tab => tab.active) :
                await browser.tabs.get(sourceId).catch(() => undefined);
            if ( source?.active !== true || (checkBackground && source.incognito) ) {
                problem = 'source_unavailable';
                return;
            }
            activeId = source.id;
            if ( checkBackground ) {
                const visible = await bounded(browser.tabs.executeScript(source.id, {
                    code: 'document.hidden === false',
                }), 7000).catch(() => []);
                if ( visible[0] !== true ) {
                    problem = 'source_unavailable';
                    return;
                }
                settingsReturn = undefined;
            }
            if ( size() < limit() ) {
                const target = current.find(tab => tab.incognito && tab.active) ||
                    current.find(tab => tab.incognito);
                if ( target === undefined ) { problem = 'private_tab_needed'; return; }
                if ( await stillActive() === false ) { problem = 'source_unavailable'; return; }
                if ( target.id !== activeId ) {
                    await browser.tabs.update(target.id, { active: true });
                    activeId = target.id;
                }
                // Fennec resolves tabs.update before its visible browsing mode changes.
                await delay(1000);
                let attempts = limit();
                while ( enabled() && size() < limit() && attempts-- > 0 && await stillActive() ) {
                    // Briefly show each new blank tab to initialize Android's viewport.
                    const tab = await browser.tabs.create({ active: true, url: 'about:blank' });
                    if ( tab.incognito !== true || enabled() === false ) {
                        await browser.tabs.remove(tab.id);
                        break;
                    }
                    activeId = tab.id;
                    // A failed initialization must not schedule its own retry.
                    tabs.set(tab.id, { busy: true, initializing: true });
                    shownTabId = tab.id;
                    await delay(500);
                    if ( tabs.has(tab.id) === false ) { break; }
                    await release(tab.id);
                }
            }
            await restoreSource();
            wake();
            if ( checkBackground && enabled() && size() !== 0 ) {
                if ( await stillActive() === false || activeId !== source.id ) {
                    problem = 'source_unavailable';
                    return;
                }
                // Diagnostics own a temporary tab, never an inspection slot or the refill lock.
                if ( preparing === operation ) { preparing = undefined; }
                runPendingTopUp();
                background = 'checking';
                publish();
                let probeId, probeTimer;
                try {
                    if ( await stillActive() === false ) { throw new Error('Source no longer active'); }
                    const probeTabs = await refresh();
                    const target = probeTabs.find(tab => tab.incognito && tab.active) ||
                        probeTabs.find(tab => tab.incognito);
                    if ( target === undefined ) { throw new Error('No private tab'); }
                    await browser.tabs.update(target.id, { active: true });
                    activeId = target.id;
                    await delay(1000);
                    if ( await stillActive() === false ) { throw new Error('Source no longer active'); }
                    const tab = await browser.tabs.create({ active: true, url: 'about:blank' });
                    if ( tab.incognito !== true || enabled() === false ) {
                        await browser.tabs.remove(tab.id);
                        throw new Error('Private probe unavailable');
                    }
                    probeId = tab.id;
                    tabs.set(probeId, { busy: true, disposable: true });
                    activeId = probeId;
                    shownTabId = probeId;
                    await navigate(probeId, 'https://quer.ee/favicon.svg', 15000);
                    await delay(500);
                    await restoreSource();
                    await delay(1000);
                    // Return as soon as the timer fires; only a suspended timer needs the deadline.
                    const timer = browser.tabs.executeScript(probeId, {
                        code: `new Promise(resolve => {
                            const check = window.__quereeBackgroundTimer = { hidden: document.hidden, fired: false };
                            const visible = () => { if (!document.hidden) check.hidden = false; };
                            document.addEventListener('visibilitychange', visible);
                            setTimeout(() => { check.fired = true;
                                document.removeEventListener('visibilitychange', visible);
                                resolve({ ...check, hidden: check.hidden && document.hidden }); }, 1000);
                        })`,
                        runAt: 'document_end',
                    });
                    const timeout = new Promise(resolve => {
                        probeTimer = setTimeout(resolve, 7000);
                    });
                    const completed = await Promise.race([ timer, timeout ]);
                    const result = completed ?? await bounded(browser.tabs.executeScript(probeId, {
                        code: '({ ...window.__quereeBackgroundTimer, hidden: window.__quereeBackgroundTimer.hidden && document.hidden })',
                        runAt: 'document_end',
                    }), 7000);
                    if ( result[0]?.hidden !== true || tabs.has(probeId) === false ) {
                        throw new Error('Probe visibility changed');
                    }
                    background = result[0].fired === true ? 'running' : 'paused';
                } catch {
                    background = 'unavailable';
                    problem = 'background_check_failed';
                } finally {
                    clearTimeout(probeTimer);
                    await restoreSource();
                    await release(probeId);
                }
            }
        })().finally(async () => {
            try {
                await restoreSource();
            } finally {
                if ( preparing === operation ) { preparing = undefined; }
                if ( checking === operation ) { checking = undefined; }
                if ( checkBackground && source !== undefined ) {
                    settingsReturn = background === 'paused' ? { id: source.id, visited: false } : undefined;
                }
                runPendingTopUp();
                publish();
                wake();
            }
        }).then(() => {
            if ( problem !== undefined ) { return { ...state(), problem }; }
            return size() === 0 ? { ...state(), problem: 'private_tab_needed' } : state();
        });
        preparing = operation;
        if ( checkBackground ) { checking = operation; }
        publish();
        return operation;
    }

    function initialize() {
        if ( initialized !== undefined ) { return initialized; }
        initialized = browser.runtime.getPlatformInfo().then(async ({ os }) => {
            android = os === 'android';
            if ( android === false ) { return; }
            if ( listenersRegistered === false ) {
                listenersRegistered = true;
                const setup = id => prepare(id).catch(reason => {
                    console.error('Quer.ee inspection tab setup failed', reason);
                });
                const check = async (id, activated = false) => {
                    if ( enabled() === false || preparing !== undefined || checking !== undefined ) { return; }
                    const tab = await browser.tabs.get(id).catch(() => undefined);
                    if ( tab?.active !== true ) { return; }
                    if ( settingsReturn !== undefined ) {
                        if ( tab.url?.startsWith('about:config') ||
                            tab.url?.startsWith('chrome://geckoview/content/config.xhtml') ) {
                            settingsReturn.visited = true;
                        } else if ( settingsReturn.visited && id === settingsReturn.id ) {
                            settingsReturn = undefined;
                            return setup(id);
                        }
                    }
                    if ( activated && size() === 0 && tab.incognito ) { return setup(); }
                };
                browser.tabs.onActivated.addListener(({ tabId }) => {
                    activeTabId = tabId;
                    activationGeneration += 1;
                    navigationGeneration += 1;
                    wake();
                    return check(tabId, true);
                });
                browser.tabs.onUpdated.addListener((id, changes) => {
                    if ( typeof changes.url === 'string' ) {
                        navigationGeneration += 1;
                        if ( tabs.get(id)?.busy === false && changes.url !== idleURL ) {
                            tabs.delete(id);
                            publish();
                            topUp(true);
                            wake();
                        }
                    }
                    if ( changes.status === 'complete' ) { return check(id); }
                });
                browser.tabs.onRemoved.addListener(id => {
                    navigationGeneration += 1;
                    if ( settingsReturn?.id === id ) { settingsReturn = undefined; }
                    const entry = tabs.get(id);
                    if ( tabs.delete(id) ) {
                        publish();
                        if ( entry.disposable !== true && entry.initializing !== true ) { topUp(true); }
                        wake();
                    }
                });
                browser.webNavigation.onCommitted.addListener(details => {
                    // Activation is observation. Only explicit address-bar/bookmark navigation
                    // is distinguishable here; links and redirects are ambiguous on Android.
                    if ( details.frameId !== 0 ||
                        [ 'typed', 'auto_bookmark', 'keyword' ].includes(details.transitionType) === false ) { return; }
                    const entry = tabs.get(details.tabId);
                    if ( entry === undefined ) { return; }
                    tabs.delete(details.tabId);
                    navigationGeneration += 1;
                    publish();
                    if ( entry.disposable !== true && entry.initializing !== true ) { topUp(true); }
                    takenOver(details.tabId);
                    wake();
                });
            }
            await refresh();
        }).catch(reason => { initialized = undefined; throw reason; });
        initialized.then(() => topUp()).catch(() => {});
        return initialized;
    }

    function acquire() {
        for ( const [ id, entry ] of tabs ) {
            if ( entry.busy || entry.disposable || id === activeTabId ) { continue; }
            tabs.set(id, { busy: true });
            return id;
        }
    }

    function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    async function bounded(promise, timeout) {
        let timer;
        try {
            return await Promise.race([ promise, new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('Inspection tab operation timed out')), timeout);
            }) ]);
        } finally { clearTimeout(timer); }
    }

    async function navigate(id, url, timeout = 5000) {
        const entry = tabs.get(id);
        let finish;
        const settled = new Promise(resolve => { finish = resolve; });
        const check = async tabId => {
            if ( tabId !== id ) { return; }
            const tab = await browser.tabs.get(id).catch(() => undefined);
            if ( tabs.get(id) !== entry ) { finish(false); return; }
            if ( tab?.url === url && tab.status === 'complete' ) { finish(true); }
        };
        const removed = tabId => { if ( tabId === id ) { finish(false); } };
        browser.tabs.onUpdated.addListener(check);
        browser.tabs.onRemoved.addListener(removed);
        try {
            await bounded((async () => {
                await browser.tabs.update(id, { url });
                await check(id);
                if ( await settled === false ) { throw new Error('Inspection tab did not finish navigation'); }
            })(), timeout);
        } finally {
            browser.tabs.onUpdated.removeListener(check);
            browser.tabs.onRemoved.removeListener(removed);
        }
    }

    function refill() {
        const refill = (refilling || Promise.resolve()).then(async () => {
            await checking?.catch(() => {});
            return prepare(undefined, true);
        })
            .catch(reason => { console.error('Quer.ee inspection tab refill failed', reason); })
            .finally(() => {
                if ( refilling === refill ) { refilling = undefined; }
                runPendingTopUp();
                publish();
                wake();
            });
        refilling = refill;
        publish();
        wake();
        return refill;
    }

    function topUp(allowEmpty = false) {
        if ( android === false || enabled() === false || (size() === 0 && allowEmpty === false) || size() >= limit() ) { return; }
        if ( preparing !== undefined || refilling !== undefined ) {
            pendingTopUp = true;
            return;
        }
        return refill();
    }

    function runPendingTopUp() {
        if ( pendingTopUp === false || preparing !== undefined || refilling !== undefined ) { return; }
        pendingTopUp = false;
        topUp(true);
    }

    function keep(id) {
        const entry = tabs.get(id);
        if ( entry === undefined || entry.disposable ) { return; }
        tabs.set(id, { busy: true, disposable: true });
        // Only a live replacement attempt counts as replenishing; failure needs a later trigger.
        return refill();
    }

    async function release(id) {
        const entry = tabs.get(id);
        if ( entry === undefined ) { return true; }
        if ( entry.disposable !== true ) {
            try {
                await navigate(id, idleURL);
                if ( tabs.get(id) === entry ) { tabs.set(id, { busy: false }); }
                wake();
                publish();
                return true;
            } catch {
                // Never close a tab relinquished during cleanup or a diagnostic.
                if ( tabs.get(id) !== entry ) { return true; }
            }
        }
        for ( let attempt = 0; attempt < 2; attempt++ ) {
            try {
                await browser.tabs.remove(id);
                tabs.delete(id);
                publish();
                wake();
                return true;
            } catch {
                if ( tabs.get(id) !== entry ) { return true; }
                const current = await browser.tabs.query({}).catch(() => undefined);
                if ( tabs.get(id) !== entry ) { return true; }
                if ( current?.some(tab => tab.id === id) === false ) {
                    tabs.delete(id);
                    publish();
                    wake();
                    return true;
                }
            }
        }
        tabs.delete(id);
        publish();
        wake();
        return false;
    }

    function size() {
        return Array.from(tabs.values()).filter(entry => entry.disposable !== true).length;
    }

    function available() {
        return Array.from(tabs).filter(([ id, entry ]) =>
            entry.disposable !== true && entry.busy === false && id !== activeTabId).length;
    }

    return {
        initialize, prepare, topUp, acquire, keep, release,
        async status() { await initialize(); if ( android ) { await refresh(); } return state(); },
        get android() { return android; },
        get replenishing() { return state().replenishing; },
        get size() { return size(); },
        get available() { return available(); },
    };
}
