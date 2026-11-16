/*******************************************************************************

    Quer.ee messaging
    Copyright (C) 2026-present Marcos
    SPDX-License-Identifier: GPL-3.0-or-later

*/

/* globals browser */

import {
    clearDecisionCache,
    getDecisionCacheState,
    getMobileInspectionState,
    inspectResults,
    openInspectionTab,
    prepareMobileInspections,
    settingsSnapshot,
    toggleKeepUnresolvedTabs,
} from './controller.js';
import {
    getContributionState,
    setContributionConsent,
    setContributionKey,
} from './contribution.js';
import { validatePersonalCategories } from './personal-categories.js';
import µb from '../background.js';

let settingWrite = Promise.resolve();

const onMessage = function(request, sender, callback) {
    const extensionPage = sender.privileged === true;
    switch ( request.what ) {
    case 'clearDecisionCache':
        if ( extensionPage === false ) { return vAPI.messaging.UNHANDLED; }
        return clearDecisionCache().then(callback);
    case 'getDecisionCacheState':
        if ( extensionPage === false ) { return vAPI.messaging.UNHANDLED; }
        return getDecisionCacheState().then(callback);
    case 'getContributionState':
        if ( extensionPage === false ) { return vAPI.messaging.UNHANDLED; }
        return getContributionState().then(callback, ( ) => callback());
    case 'getSettings':
        return µb.isReadyPromise.then(async ( ) => {
            // A failed Android discovery must not make the ordinary switch unusable.
            const mobileInspection = await getMobileInspectionState().catch(() => undefined);
            callback({ ...settingsSnapshot(), mobileInspection });
        });
    case 'setUserSetting':
        if ( extensionPage === false ) { return vAPI.messaging.UNHANDLED; }
        settingWrite = settingWrite.then(( ) => µb.isReadyPromise).then(async ( ) => {
            const { name, value } = request;
            if ( typeof name !== 'string' || name.startsWith('queree') === false ||
                Object.hasOwn(µb.userSettingsDefault, name) === false ||
                typeof value !== typeof µb.userSettingsDefault[name] ||
                (typeof value !== 'boolean' &&
                    (name !== 'quereeSimultaneousInspections' ||
                        Number.isInteger(value) === false || value < 1 || value > 8)) ) {
                callback({ error: 'Invalid Quer.ee setting.' });
                return;
            }
            const previous = µb.userSettings[name];
            µb.userSettings[name] = value;
            try {
                await browser.storage.local.set({ [name]: value });
                callback({ value });
            } catch (reason) {
                µb.userSettings[name] = previous;
                callback({ error: reason.message });
            }
        });
        return settingWrite;
    case 'setPersonalCategories':
        if ( extensionPage === false ) { return vAPI.messaging.UNHANDLED; }
        settingWrite = settingWrite.then(( ) => µb.isReadyPromise).then(async ( ) => {
            const previous = µb.userSettings.quereePersonalCategories;
            let categories;
            try {
                categories = validatePersonalCategories(request.categories);
                // Await the native storage write before confirming the editor save.
                µb.userSettings.quereePersonalCategories = categories;
                await browser.storage.local.set({ quereePersonalCategories: categories });
                callback({ categories });
            } catch (reason) {
                if ( µb.userSettings.quereePersonalCategories === categories ) {
                    µb.userSettings.quereePersonalCategories = previous;
                }
                callback({ error: reason.message });
            }
        });
        return settingWrite;
    case 'toggleKeepUnresolvedTabs':
        return toggleKeepUnresolvedTabs().then(callback);
    case 'openInspectionTab':
        return openInspectionTab(sender.tabId, request.tabId).then(callback);
    case 'prepareMobileInspections':
        return prepareMobileInspections(sender.tabId).then(callback,
            reason => callback({ problem: String(reason) }));
    case 'inspectResults':
        // A port's frameURL is fixed at connection time; the scan URL is checked against the live tab.
        return inspectResults(
            sender.tabId,
            request.items,
            request.batchId,
            request.sourceURL
        ).then(callback, ( ) => callback());
    case 'setContributionConsent':
        if ( extensionPage === false ) { return vAPI.messaging.UNHANDLED; }
        return setContributionConsent(request.consent).then(callback, ( ) => callback());
    case 'setContributionKey':
        if ( extensionPage === false ) { return vAPI.messaging.UNHANDLED; }
        return setContributionKey(request.key).then(callback, ( ) => callback());
    default:
        return vAPI.messaging.UNHANDLED;
    }
};

export function registerQuereeMessaging() {
    vAPI.messaging.listen({
        name: 'queree',
        listener: onMessage,
    });
}
