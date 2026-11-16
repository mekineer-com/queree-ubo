import assert from 'node:assert/strict';
import { createMobileInspectionTabs } from '../../src/js/queree/mobile-inspection-tabs.js';
import { mock } from 'node:test';
import { setImmediate } from 'node:timers';

export const settle = () => new Promise(resolve => setImmediate(resolve));
export async function run(promise) {
    let done = false, value, failure;
    Promise.resolve(promise).then(result => { value = result; done = true; }, error => { failure = error; done = true; });
    for ( let i = 0; done === false && i < 240; i++ ) {
        await settle();
        if ( done === false ) { mock.timers.tick(250); }
    }
    assert.equal(done, true, 'The operation must settle within its bounded delays');
    if ( failure ) { throw failure; }
    return value;
}

function event() {
    const listeners = new Set();
    return {
        addListener: f => listeners.add(f), removeListener: f => listeners.delete(f),
        emit: (...args) => Promise.all([...listeners].map(f => f(...args))),
        get size() { return listeners.size; },
    };
}

export function harness({ slots = 2, firstId = 3, os = 'android', allowed = true, privateTab = true, wrongMode = false, backgroundRuns = true } = {}) {
    const current = new Map([[1, { id: 1, incognito: false, active: true, url: 'https://www.google.com/search?q=test' }]]);
    if ( privateTab ) { current.set(2, { id: 2, incognito: true, active: false, url: 'https://personal.example/' }); }
    const calls = [], states = [], takeovers = [];
    let nextId = firstId, enabled = true, wakes = 0;
    const browser = {
        runtime: { getURL: path => `moz-extension://fixture/${path}`, getPlatformInfo: async () => ({ os }) },
        extension: { isAllowedIncognitoAccess: async () => allowed },
        webNavigation: { onCommitted: event() },
        tabs: {
            onUpdated: event(), onRemoved: event(), onActivated: event(),
            executeScript: async (id, details) => {
                if ( details.code === 'document.hidden === false' ) {
                    return [current.get(id)?.active === true];
                }
                calls.push(['probe', id, details]);
                if (details.code.includes('setTimeout')) {
                    return new Promise(resolve => {
                        if (backgroundRuns) { setTimeout(() => resolve([{hidden:true, fired:true}]), 1000); }
                    });
                }
                return [{ hidden: true, fired: backgroundRuns }];
            },
            query: async query => [...current.values()].filter(t => !query.active || t.active).map(t => ({ ...t })),
            get: async id => { if (!current.has(id)) { throw Error('Closed'); } return { ...current.get(id) }; },
            create: async details => {
                calls.push(['create', details]);
                const tab = { ...details, id: nextId++, incognito: !wrongMode, status: 'complete' };
                if (details.active) { for (const t of current.values()) { t.active = false; } }
                current.set(tab.id, tab);
                if (details.active) { void browser.tabs.onActivated.emit({ tabId: tab.id }); }
                return { ...tab };
            },
            update: async (id, details) => {
                if (!current.has(id)) { throw Error('Closed'); }
                calls.push(['update', id, details]);
                if (details.active) { for (const t of current.values()) { t.active = false; } }
                const tab = current.get(id);
                Object.assign(tab, details, { status: 'complete' });
                if (details.active) { void browser.tabs.onActivated.emit({ tabId: id }); }
                if (details.url) { void browser.tabs.onUpdated.emit(id, {status:'complete',url:details.url}, { ...tab }); }
                return { ...tab };
            },
            remove: async id => {
                calls.push(['remove', id]);
                if (!current.delete(id)) { throw Error('Closed'); }
                void browser.tabs.onRemoved.emit(id);
            },
        },
    };
    const options = { browser, enabled: () => enabled, limit: () => slots,
        changed: state => states.push(state), takenOver: id => takeovers.push(id),
        wake: () => { wakes++; } };
    const pool = createMobileInspectionTabs(options);
    const activate = async id => {
        for (const tab of current.values()) { tab.active = tab.id === id; }
        await browser.tabs.onActivated.emit({ tabId: id });
    };
    return { pool, options, browser, current, calls, states, takeovers, activate,
        disable: () => { enabled = false; },
        setSlots: value => { slots = value; },
        get wakes() { return wakes; },
        setBackgroundRuns: value => { backgroundRuns = value; } };
}
