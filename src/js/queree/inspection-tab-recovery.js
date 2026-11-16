/*******************************************************************************

    Quer.ee inspection tab recovery
    Copyright (C) 2026-present Marcos
    SPDX-License-Identifier: GPL-3.0-or-later

*/

/* globals browser */

const marker = 'quereeInspection';

export function markInspectionTab(tabId) {
    return browser.sessions.setTabValue(tabId, marker, true);
}

export async function isMarkedInspectionTab(tabId) {
    return await browser.sessions.getTabValue(tabId, marker) === true;
}

export function startInspectionTabRecovery(isActive) {
    const check = async tabId => {
        if ( isActive(tabId) ) { return; }
        try {
            const tab = await browser.tabs.get(tabId);
            if ( tab.hidden !== true || isActive(tabId) ) { return; }
            if ( await isMarkedInspectionTab(tabId) === false ) {
                return;
            }
            for ( let attempt = 0; attempt < 2; attempt++ ) {
                const current = await browser.tabs.get(tabId);
                if ( current.hidden !== true || isActive(tabId) ) { return; }
                try {
                    await browser.tabs.remove(tabId);
                    return;
                } catch (reason) {
                    if ( attempt === 1 ) { throw reason; }
                }
            }
        } catch {
            // The tab may have closed while Firefox was restoring it.
        }
    };

    browser.tabs.onCreated.addListener(tab => {
        if ( tab.hidden !== true ) { return; }
        check(tab.id);
        setTimeout(( ) => check(tab.id), 500);
    });
    browser.tabs.onUpdated.addListener((tabId, changes, tab) => {
        if ( tab.hidden && (changes.hidden === true || changes.status) ) {
            check(tabId);
        }
    });
    const sweep = ( ) => {
        browser.tabs.query({ hidden: true }).then(tabs => {
            for ( const tab of tabs ) { check(tab.id); }
        }).catch(( ) => { });
    };
    sweep();
    return sweep;
}
