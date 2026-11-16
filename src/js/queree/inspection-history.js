/*******************************************************************************

    Quer.ee guarded inspection-history cleanup
    Copyright (C) 2026-present Marcos
    SPDX-License-Identifier: GPL-3.0-or-later

*/

/* globals browser */

const records = new Map();
const apiTimeout = 3000;
let cleanupEnabled = false;

function bounded(promise) {
    return new Promise(resolve => {
        const timer = setTimeout(( ) => resolve(), apiTimeout);
        Promise.resolve(promise).then(value => {
            clearTimeout(timer);
            resolve(value);
        }, ( ) => {
            clearTimeout(timer);
            resolve();
        });
    });
}

function normalizedURL(rawURL) {
    let url;
    try {
        url = new URL(rawURL);
    } catch {
        return;
    }
    if ( url.protocol !== 'http:' && url.protocol !== 'https:' ) { return; }
    return url.href;
}

export function setInspectionHistoryEnabled(enabled) {
    cleanupEnabled = enabled === true;
    // Invalidate pending reads too, even if cleanup is enabled again later.
    if ( cleanupEnabled === false ) { records.clear(); }
}

async function trackURL(record, rawURL) {
    const url = normalizedURL(rawURL);
    if ( url === undefined || record.urls.has(url) ) { return; }
    const entry = {
        url,
        inspectionCommitted: false,
        navigationObserved: false,
        protected: true,
    };
    record.urls.set(url, entry);
    const pending = bounded(browser.history.getVisits({ url })).then(visits => {
        if ( Array.isArray(visits) === false ) { return; }
        if ( visits.length !== 0 || entry.navigationObserved ) { return; }
        entry.protected = false;
    }).catch(( ) => { });
    record.pending.add(pending);
    pending.finally(( ) => record.pending.delete(pending));
    await pending;
}

export async function beginInspectionHistory(tabId, url, enabled) {
    if ( enabled !== true || cleanupEnabled === false ) { return; }
    const record = {
        startedAt: Date.now(),
        pending: new Set(),
        urls: new Map(),
    };
    records.set(tabId, record);
    await trackURL(record, url);
}

export function trackInspectionRedirect(tabId, url) {
    const record = records.get(tabId);
    if ( record !== undefined ) { return trackURL(record, url); }
}

export function observeHistoryCommit(details) {
    if ( details.frameId !== 0 ) { return; }
    const url = normalizedURL(details.url);
    if ( url === undefined ) { return; }
    const inspection = records.get(details.tabId);
    if ( inspection !== undefined ) {
        const entry = inspection.urls.get(url);
        if ( entry !== undefined ) {
            entry.navigationObserved = true;
            entry.inspectionCommitted = true;
        }
        return;
    }
    for ( const record of records.values() ) {
        const entry = record.urls.get(url);
        if ( entry === undefined ) { continue; }
        entry.navigationObserved = true;
        entry.protected = true;
    }
}

export async function finishInspectionHistory(tabId) {
    const record = records.get(tabId);
    if ( record === undefined ) { return; }
    try {
        await Promise.all(Array.from(record.pending));
        const deadline = Date.now() + apiTimeout;
        for ( const entry of record.urls.values() ) {
            if ( cleanupEnabled === false || records.get(tabId) !== record ) {
                break;
            }
            if ( Date.now() >= deadline ) { break; }
            if ( entry.protected || entry.inspectionCommitted === false ) {
                continue;
            }
            let visits;
            try {
                visits = await bounded(
                    browser.history.getVisits({ url: entry.url })
                );
            } catch {
                continue;
            }
            if (
                Array.isArray(visits) === false || visits.length !== 1 ||
                visits[0].visitTime < record.startedAt ||
                visits[0].visitTime > Date.now()
            ) {
                continue;
            }
            if (
                cleanupEnabled === false || entry.protected ||
                records.get(tabId) !== record
            ) {
                continue;
            }
            await bounded(browser.history.deleteUrl({ url: entry.url }));
        }
    } finally {
        if ( records.get(tabId) === record ) { records.delete(tabId); }
    }
}

export function discardInspectionHistory(tabId) {
    records.delete(tabId);
}
