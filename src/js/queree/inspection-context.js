/*******************************************************************************

    Quer.ee disposable inspection contexts
    Copyright (C) 2026-present Marcos
    SPDX-License-Identifier: GPL-3.0-or-later

*/

/* globals browser */

import { isMarkedInspectionTab } from './inspection-tab-recovery.js';

const storageKey = 'quereeInspectionCookieStoreIds';
const listeners = new Set();
const activeCookieStoreIds = new Set();
const ownedCookieStoreIds = new Set();
const removingCookieStoreIds = new Set();
const retryAttempts = new Map();
const operationTimeout = 5000;
const contextualIdentities = browser.contextualIdentities;
const supported =
    contextualIdentities instanceof Object &&
    typeof contextualIdentities.create === 'function' &&
    typeof contextualIdentities.get === 'function' &&
    typeof contextualIdentities.query === 'function' &&
    typeof contextualIdentities.remove === 'function';

let allowedCookieStoreIds = supported ? undefined : null;
let cleanupSerial = Promise.resolve();
let contextFailure;
let creatingContainers = 0;
let refreshSerial = Promise.resolve();
let retryTimer;

function bounded(promise, fallback) {
    return new Promise(resolve => {
        const timer = setTimeout(( ) => resolve(fallback), operationTimeout);
        Promise.resolve(promise).then(value => {
            clearTimeout(timer);
            resolve(value);
        }, ( ) => {
            clearTimeout(timer);
            resolve(fallback);
        });
    });
}

function notify() {
    for ( const listener of listeners ) { listener(); }
}

async function persistOwnedIds() {
    const ids = Array.from(ownedCookieStoreIds).sort();
    if ( ids.length === 0 ) {
        await browser.storage.local.remove(storageKey);
        return;
    }
    await browser.storage.local.set({ [storageKey]: ids });
}

async function refreshAllowedCookieStores() {
    try {
        const identities = await contextualIdentities.query({});
        const ids = [
            'firefox-default',
            ...identities.map(identity => identity.cookieStoreId),
        ].filter(id =>
            ownedCookieStoreIds.has(id) === false &&
            removingCookieStoreIds.has(id) === false
        );
        if ( await browser.extension.isAllowedIncognitoAccess() ) {
            ids.push('firefox-private');
        }
        ids.sort();
        contextFailure = undefined;
        if (
            allowedCookieStoreIds?.length === ids.length &&
            allowedCookieStoreIds.every((id, index) => id === ids[index])
        ) {
            return;
        }
        allowedCookieStoreIds = ids;
        notify();
    } catch (reason) {
        contextFailure = reason;
    }
}

async function ownedContextExists(cookieStoreId) {
    try {
        await contextualIdentities.get(cookieStoreId);
        return true;
    } catch {
    }
    try {
        const identities = await contextualIdentities.query({});
        return identities.some(identity =>
            identity.cookieStoreId === cookieStoreId
        );
    } catch {
    }
}

function refresh() {
    if ( supported === false ) { return refreshSerial; }
    refreshSerial = refreshSerial
        .catch(( ) => { })
        .then(refreshAllowedCookieStores);
    return refreshSerial;
}

async function removeOwnedContext(cookieStoreId) {
    const tabs = await browser.tabs.query({ cookieStoreId });
    if ( tabs.length !== 0 ) { return false; }
    removingCookieStoreIds.add(cookieStoreId);
    try {
        await contextualIdentities.remove(cookieStoreId);
    } catch {
        const exists = await ownedContextExists(cookieStoreId);
        if ( exists !== false ) {
            removingCookieStoreIds.delete(cookieStoreId);
            return false;
        }
    }
    setTimeout(( ) => removingCookieStoreIds.delete(cookieStoreId), 1000);
    ownedCookieStoreIds.delete(cookieStoreId);
    await persistOwnedIds();
    return true;
}

async function recoverOwnedContext(cookieStoreId) {
    const exists = await ownedContextExists(cookieStoreId);
    if ( exists === undefined ) { return false; }
    if ( exists === false ) {
        ownedCookieStoreIds.delete(cookieStoreId);
        await persistOwnedIds();
        return true;
    }
    const tabs = await browser.tabs.query({ cookieStoreId });
    const tabIds = [];
    for ( const tab of tabs ) {
        try {
            if ( await isMarkedInspectionTab(tab.id) ) { tabIds.push(tab.id); }
        } catch {
            // Container membership alone does not prove tab ownership.
        }
    }
    if ( tabIds.length !== 0 ) {
        await browser.tabs.remove(tabIds).catch(( ) => { });
    }
    return removeOwnedContext(cookieStoreId);
}

function scheduleCleanupRetry() {
    if ( retryTimer !== undefined || ownedCookieStoreIds.size === 0 ) { return; }
    retryTimer = setTimeout(( ) => {
        retryTimer = undefined;
        for ( const id of Array.from(ownedCookieStoreIds) ) {
            if ( activeCookieStoreIds.has(id) ) { continue; }
            const attempts = retryAttempts.get(id) || 0;
            if ( attempts >= 3 ) { continue; }
            retryAttempts.set(id, attempts + 1);
            const cleanup = cleanupSerial
                .catch(( ) => false)
                .then(( ) => bounded(recoverOwnedContext(id), false));
            cleanupSerial = cleanup.then(( ) => true);
            cleanup.then(removed => {
                if ( removed ) {
                    retryAttempts.delete(id);
                } else {
                    scheduleCleanupRetry();
                }
            });
        }
    }, 30000);
}

const ready = (async ( ) => {
    if ( supported === false ) { return; }
    const stored = await browser.storage.local.get([ storageKey ]);
    const ids = Array.isArray(stored?.[storageKey])
        ? stored[storageKey]
        : [];
    for ( const id of ids ) {
        if ( typeof id === 'string' ) { ownedCookieStoreIds.add(id); }
    }
    await refresh();
    for ( const id of Array.from(ownedCookieStoreIds) ) {
        bounded(recoverOwnedContext(id), false).then(removed => {
            if ( removed === false ) { scheduleCleanupRetry(); }
        });
    }
})();

export function ordinaryCookieStoreIds() {
    return Array.isArray(allowedCookieStoreIds)
        ? allowedCookieStoreIds.slice()
        : allowedCookieStoreIds;
}

export function onOrdinaryCookieStoresChanged(listener) {
    listeners.add(listener);
}

export async function createInspectionCookieStore() {
    await ready;
    if ( supported === false ) {
        throw new Error('Firefox container API is unavailable');
    }
    await refresh();
    if ( contextFailure !== undefined ) { throw contextFailure; }
    creatingContainers += 1;
    let identity;
    try {
        identity = await contextualIdentities.create({
            name: 'Quer.ee inspection',
            color: 'blue',
            icon: 'fingerprint',
        });
        ownedCookieStoreIds.add(identity.cookieStoreId);
        activeCookieStoreIds.add(identity.cookieStoreId);
        await persistOwnedIds();
    } catch (reason) {
        if ( identity !== undefined ) {
            ownedCookieStoreIds.add(identity.cookieStoreId);
            await persistOwnedIds().catch(( ) => { });
            await removeInspectionCookieStore(identity.cookieStoreId).catch(( ) => { });
        }
        throw reason;
    } finally {
        creatingContainers -= 1;
    }
    await refresh();
    if ( contextFailure !== undefined ) {
        const reason = contextFailure;
        await removeInspectionCookieStore(identity.cookieStoreId).catch(( ) => { });
        throw reason;
    }
    return identity.cookieStoreId;
}

export function removeInspectionCookieStore(cookieStoreId) {
    if ( typeof cookieStoreId !== 'string' ) { return Promise.resolve(true); }
    activeCookieStoreIds.delete(cookieStoreId);
    const cleanup = cleanupSerial
        .catch(( ) => false)
        .then(( ) => bounded(removeOwnedContext(cookieStoreId), false));
    cleanupSerial = cleanup.then(( ) => true);
    return cleanup.then(removed => {
        if ( removed ) {
            retryAttempts.delete(cookieStoreId);
        } else {
            retryAttempts.set(cookieStoreId, 0);
            scheduleCleanupRetry();
        }
        return removed;
    });
}

if ( supported ) {
    contextualIdentities.onCreated.addListener(( ) => {
        if ( creatingContainers === 0 ) { refresh(); }
    });
    contextualIdentities.onRemoved.addListener(details => {
        const id = details?.contextualIdentity?.cookieStoreId;
        activeCookieStoreIds.delete(id);
        if ( removingCookieStoreIds.delete(id) ) { return; }
        if ( ownedCookieStoreIds.delete(id) ) {
            persistOwnedIds().catch(( ) => { });
            return;
        }
        refresh();
    });
    contextualIdentities.onUpdated.addListener(( ) => refresh());
}
