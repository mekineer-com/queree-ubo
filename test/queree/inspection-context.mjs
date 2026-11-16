import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers';

const identities = new Map([
    [ 'firefox-container-old', {
        cookieStoreId: 'firefox-container-old',
        name: 'Quer.ee',
    } ],
]);
const listeners = {
    created: [],
    removed: [],
    updated: [],
};
const storage = {
    quereeInspectionCookieStoreIds: [ 'firefox-container-old' ],
};
const tabs = new Map([
    [ 71, { id: 71, hidden: false, cookieStoreId: 'firefox-container-old' } ],
    [ 72, { id: 72, hidden: false, cookieStoreId: 'firefox-container-old' } ],
    [ 73, { id: 73, hidden: true, cookieStoreId: 'firefox-container-old' } ],
    [ 74, { id: 74, hidden: true, cookieStoreId: 'firefox-container-old' } ],
]);
const markers = new Map([ [ 71, true ], [ 74, 'true' ] ]);
const removed = [];
const retries = [];
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => {
    if ( delay !== 30000 ) { return originalSetTimeout(callback, delay, ...args); }
    retries.push(callback);
    return callback;
};
let nextContainer = 1;
const getFailures = new Map([[ 'firefox-container-old', 1 ]]);

const event = name => ({
    addListener: listener => listeners[name].push(listener),
});

globalThis.browser = {
    sessions: {
        getTabValue: async (id, key) => {
            assert.equal(key, 'quereeInspection');
            if ( id === 73 ) { throw new Error('marker lookup failed'); }
            return markers.get(id);
        },
        setTabValue: async (id, key, value) => {
            assert.equal(key, 'quereeInspection');
            markers.set(id, value);
        },
    },
    contextualIdentities: {
        create: async details => {
            const identity = {
                ...details,
                cookieStoreId: `firefox-container-new-${nextContainer++}`,
            };
            identities.set(identity.cookieStoreId, identity);
            for ( const listener of listeners.created ) {
                listener({ contextualIdentity: identity });
            }
            return identity;
        },
        get: async id => {
            const failures = getFailures.get(id) || 0;
            if ( failures !== 0 ) {
                getFailures.set(id, failures - 1);
                throw new Error('temporary API failure');
            }
            if ( identities.has(id) === false ) { throw new Error('missing'); }
            return identities.get(id);
        },
        query: async ( ) => Array.from(identities.values()),
        remove: async id => {
            const identity = identities.get(id);
            if ( identity === undefined ) { throw new Error('missing'); }
            identities.delete(id);
            for ( const listener of listeners.removed ) {
                listener({ contextualIdentity: identity });
            }
            return identity;
        },
        onCreated: event('created'),
        onRemoved: event('removed'),
        onUpdated: event('updated'),
    },
    extension: {
        isAllowedIncognitoAccess: async ( ) => false,
    },
    storage: { local: {
        get: async keys => Object.fromEntries(
            keys.filter(key => storage[key] !== undefined).map(key => [ key, storage[key] ])
        ),
        remove: async keys => {
            for ( const key of Array.isArray(keys) ? keys : [ keys ]) {
                delete storage[key];
            }
        },
        set: async values => Object.assign(storage, values),
    } },
    tabs: {
        query: async ({ cookieStoreId }) => Array.from(tabs.values())
            .filter(tab => tab.cookieStoreId === cookieStoreId),
        remove: async ids => {
            for ( const id of Array.isArray(ids) ? ids : [ ids ]) {
                removed.push(id);
                tabs.delete(id);
            }
        },
    },
};

const {
    createInspectionCookieStore,
    ordinaryCookieStoreIds,
    removeInspectionCookieStore,
} = await import('../../src/js/queree/inspection-context.js');

const freshId = await createInspectionCookieStore();
await new Promise(resolve => setImmediate(resolve));
assert.equal(tabs.has(71), false);
assert.deepEqual(removed, [ 71 ], 'Restart closes only the marked inspection tab');
assert.ok(tabs.has(72), 'Preserve the unmarked user tab in the same container');
assert.ok(tabs.has(73), 'A failed marker lookup cannot authorize closing a tab');
assert.ok(tabs.has(74), 'Only a literal true marker proves ownership');
assert.equal(identities.has('firefox-container-old'), true);
assert.equal(storage.quereeInspectionCookieStoreIds.includes('firefox-container-old'), true);
assert.equal(ordinaryCookieStoreIds().includes('firefox-container-old'), false);
assert.equal(ordinaryCookieStoreIds().includes(freshId), false);
assert.equal(await removeInspectionCookieStore(freshId), true);
assert.equal(identities.has(freshId), false);

const { markInspectionTab } = await import('../../src/js/queree/inspection-tab-recovery.js');
tabs.set(75, { id: 75, hidden: false, cookieStoreId: 'firefox-container-old' });
await markInspectionTab(75);
assert.equal(retries.length, 1);
retries.shift()();
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(removed, [ 71, 75 ], 'Retry also closes a marked visible popup');
assert.ok(tabs.has(72) && tabs.has(73) && tabs.has(74),
    'Retry preserves tabs without proven per-tab ownership');
assert.equal(identities.has('firefox-container-old'), true);
assert.equal(storage.quereeInspectionCookieStoreIds.includes('firefox-container-old'), true);

// Only after the user closes the remaining tabs may recovery remove the container.
for ( const id of [ 72, 73, 74 ] ) { tabs.delete(id); }
assert.equal(retries.length, 1);
retries.shift()();
await new Promise(resolve => setImmediate(resolve));
assert.equal(identities.has('firefox-container-old'), false);
assert.equal(storage.quereeInspectionCookieStoreIds, undefined);
assert.deepEqual(removed, [ 71, 75 ]);
globalThis.setTimeout = originalSetTimeout;
console.log('Passed: restart and retry close marked tabs, preserving unmarked user tabs and their container');
