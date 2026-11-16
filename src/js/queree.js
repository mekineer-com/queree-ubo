/*******************************************************************************

    Quer.ee dashboard pane
    Copyright (C) 2026-present Marcos

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*/

/* globals browser */

import { dom, qs$, qsa$ } from './dom.js';
import { validatePersonalCategories } from './queree/personal-categories.js';

const contributionDataPermissions = [
    'browsingActivity',
    'authenticationInfo',
    'technicalAndInteraction',
    'websiteContent',
];

let unavailable = false;
let contributionRefresh = 0;

function settingsUnavailable() {
    unavailable = true;
    for ( const control of qsa$('input, button, textarea, fieldset') ) {
        control.disabled = true;
    }
    for ( const id of [ '#quereeHistoryStatus', '#quereeContributionStatus', '#quereePersonalStatus' ] ) {
        qs$(id).textContent =
            'Settings unavailable. Changes could not be confirmed. Reload this pane to try again.';
    }
}

async function changeUserSetting(name, value) {
    try {
        const reply = await vAPI.messaging.send('queree', {
            what: 'setUserSetting', name, value,
        });
        if ( reply?.value === value && unavailable === false ) { return value; }
    } catch {
    }
    settingsUnavailable();
}

function updateCorporateIndicator(enabled) {
    const indicator = qs$('#quereeCorporateIndicator');
    indicator.classList.toggle('enabled', enabled);
    indicator.tabIndex = enabled ? 0 : -1;
}

function bindSettings(details) {
    for ( const checkbox of qsa$('[data-setting-type="bool"]') ) {
        const name = checkbox.dataset.settingName || '';
        if ( details[name] === undefined ) {
            dom.attr(checkbox.closest('.checkbox'), 'disabled', '');
            dom.attr(checkbox, 'disabled', '');
            continue;
        }
        checkbox.checked = details[name] === true;
        if ( name === 'quereeIncludeCommercialCorporate' ) {
            updateCorporateIndicator(checkbox.checked);
        }
        if ( name === 'quereeCleanHistory' ) {
            updateHistoryStatus(checkbox.checked);
        }
        dom.on(checkbox, 'change', async ( ) => {
            checkbox.disabled = true;
            const saved = await changeUserSetting(name, checkbox.checked);
            if ( saved !== undefined ) { details[name] = saved; }
            checkbox.checked = details[name] === true;
            checkbox.disabled = unavailable;
            if ( name === 'quereeIncludeCommercialCorporate' ) {
                updateCorporateIndicator(checkbox.checked);
            }
            if ( name === 'quereeCleanHistory' && unavailable === false ) {
                updateHistoryStatus(checkbox.checked);
            }
        });
    }
    const simultaneous = qs$('[data-setting-name="quereeSimultaneousInspections"]');
    simultaneous.value = details.quereeSimultaneousInspections;
    dom.on(simultaneous, 'change', async ( ) => {
        const value = Math.min(
            Math.max(Math.floor(Number.parseInt(simultaneous.value, 10) || 6), 1),
            8
        );
        simultaneous.value = value;
        simultaneous.disabled = true;
        const saved = await changeUserSetting('quereeSimultaneousInspections', value);
        if ( saved !== undefined ) { details.quereeSimultaneousInspections = saved; }
        simultaneous.value = details.quereeSimultaneousInspections;
        simultaneous.disabled = unavailable;
    });
}

function updateHistoryStatus(enabled) {
    qs$('#quereeHistoryStatus').textContent = enabled
        ? 'History cleanup is on'
        : 'History cleanup is off';
}

async function setupPersonalCategories() {
    const settings = await vAPI.messaging.send('queree', { what: 'getSettings' });
    let categories = validatePersonalCategories(settings.personalCategories);
    const controls = qs$('#quereePersonalControls');
    const listControls = qs$('#quereePersonalListControls');
    const list = qs$('#quereePersonalList');
    const editor = qs$('#quereePersonalEditor');
    const name = qs$('#quereeCategoryName');
    const entries = qs$('#quereeCategoryEntries');
    const status = qs$('#quereePersonalStatus');
    let editingIndex = -1;

    function showError(message) {
        status.textContent = message;
        status.classList.toggle('error', true);
    }

    function closeEditor() {
        editor.hidden = true;
        listControls.disabled = false;
        status.textContent = '';
        status.classList.toggle('error', false);
    }

    function editCategory(index) {
        editingIndex = index;
        name.value = index === -1 ? '' : categories[index].name;
        entries.value = index === -1 ? '' : categories[index].entries.join('\n');
        editor.hidden = false;
        listControls.disabled = true;
        status.textContent = '';
        status.classList.toggle('error', false);
        name.focus();
    }

    async function saveCategories(value, message = 'Personal categories saved.') {
        let normalized;
        try {
            normalized = validatePersonalCategories(value);
        } catch ( error ) {
            showError(error.message);
            return false;
        }
        controls.disabled = true;
        try {
            const reply = await vAPI.messaging.send('queree', {
                what: 'setPersonalCategories', categories: normalized,
            });
            if ( unavailable ) { return false; }
            if ( typeof reply?.error === 'string' ) {
                showError(reply.error);
                return false;
            }
            categories = validatePersonalCategories(reply.categories);
            renderCategories();
            closeEditor();
            status.textContent = message;
            return true;
        } catch {
            settingsUnavailable();
            return false;
        } finally {
            controls.disabled = unavailable;
        }
    }

    function renderCategories() {
        dom.clear(list);
        categories.forEach((category, index) => {
            const row = qs$('#quereePersonalRow').content.firstElementChild.cloneNode(true);
            const checkbox = qs$(row, 'input');
            const edit = qs$(row, '.queree-category-edit');
            const remove = qs$(row, '.queree-category-delete');
            qs$(row, '.queree-category-name').textContent = category.name;
            checkbox.checked = category.enabled;
            dom.attr(edit, 'aria-label', `Edit ${category.name}`);
            dom.attr(remove, 'aria-label', `Delete ${category.name}`);
            dom.on(checkbox, 'change', async ( ) => {
                const next = categories.map((item, i) => i === index
                    ? { ...item, enabled: checkbox.checked }
                    : item);
                if ( await saveCategories(next, '') === false ) {
                    checkbox.checked = categories[index].enabled;
                } else {
                    qs$(list.children[index], 'input').focus();
                }
            });
            dom.on(edit, 'click', ( ) => editCategory(index));
            dom.on(remove, 'click', async ( ) => {
                if ( await saveCategories(categories.filter((item, i) => i !== index)) ) {
                    qs$('#quereeAddCategory').focus();
                }
            });
            list.append(row);
        });
    }

    dom.on('#quereeAddCategory', 'click', ( ) => editCategory(-1));
    dom.on('#quereeCancelCategory', 'click', ( ) => {
        closeEditor();
        qs$('#quereeAddCategory').focus();
    });
    dom.on(editor, 'submit', async ev => {
        ev.preventDefault();
        const category = {
            name: name.value,
            enabled: editingIndex === -1 ? true : categories[editingIndex].enabled,
            entries: entries.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean),
        };
        const next = categories.slice();
        if ( editingIndex === -1 ) {
            next.push(category);
        } else {
            next[editingIndex] = category;
        }
        if ( await saveCategories(next) ) { qs$('#quereeAddCategory').focus(); }
    });
    self.hasUnsavedData = ( ) => editor.hidden === false && (
        name.value !== (editingIndex === -1 ? '' : categories[editingIndex].name) ||
        entries.value !== (editingIndex === -1 ? '' : categories[editingIndex].entries.join('\n'))
    );
    renderCategories();
    controls.disabled = unavailable;
}

async function refreshContribution(message = { what: 'getContributionState' }) {
    const refresh = ++contributionRefresh;
    let state;
    try {
        state = await vAPI.messaging.send('queree', message);
    } catch {
    }
    if ( refresh !== contributionRefresh ) { return state; }
    if (
        typeof state?.hasKey !== 'boolean' ||
        typeof state?.consent !== 'boolean' || unavailable
    ) {
        settingsUnavailable();
        return;
    }
    const checkbox = qs$('#quereeContribute');
    checkbox.checked = state.hasKey && state.consent === true;
    checkbox.disabled = state.hasKey === false;
    qs$('#quereeRequestKey').hidden = state.hasKey;
    const parts = state.hasKey ? [ 'Invitation key saved' ] : [];
    if ( state.queued ) { parts.push(`${state.queued} waiting to send`); }
    if ( state.discarded ) { parts.push(`${state.discarded} discarded`); }
    if ( state.lastError ) {
        const errors = {
            key_required: 'An invitation key is required to contribute',
            authentication: 'The invitation key was not accepted. Save a valid key to resume contributions',
            quota_exhausted: 'The invitation key quota is exhausted. Save a replacement key to resume contributions',
            temporary: 'Quer.ee is temporarily unavailable. Contributions will retry automatically',
            inbox_full: 'Excluded pages are waiting for room on Quer.ee. Other pages can still be contributed',
            timeout: 'Quer.ee did not respond in time. Contributions will retry automatically',
            transport: 'Could not connect to Quer.ee. Contributions will retry automatically',
            invalid_response: 'Quer.ee returned an unreadable reply. Contributions will retry automatically',
            'Some pages could not be contributed': 'Some pages could not be contributed',
        };
        parts.push(errors[state.lastError] || (state.lastError.startsWith('server_')
            ? 'Quer.ee rejected the upload. Contributions will retry automatically'
            : 'Quer.ee could not accept contributions'));
    }
    qs$('#quereeContributionStatus').textContent = parts.join(' · ');
    return state;
}

function setupContribution() {
    browser.storage.onChanged.addListener((changes, area) => {
        if ( area === 'local' && changes.quereeContributionState !== undefined ) {
            refreshContribution();
        }
    });
    dom.on('#quereeContribute', 'change', async ev => {
        const checked = ev.target.checked;
        if ( checked ) {
            let granted = false;
            try {
                granted = await browser.permissions.request({
                    data_collection: contributionDataPermissions,
                });
            } catch {
            }
            if ( granted === false ) {
                ev.target.checked = false;
                qs$('#quereeContributionStatus').textContent =
                    'Firefox data permission is required to contribute';
                return;
            }
        }
        const state = await refreshContribution({
            what: 'setContributionConsent',
            consent: checked,
        });
        if ( state === undefined ) {
            ev.target.checked = !checked;
            return;
        }
        if ( state.consent === false ) {
            browser.permissions.remove({
                data_collection: contributionDataPermissions,
            }).catch(( ) => { });
        }
    });
    dom.on('#quereeSaveKey', 'click', async ( ) => {
        const input = qs$('#quereeInvitationKey');
        const key = input.value.trim();
        if ( /^qk_[A-Za-z0-9_-]{43}$/.test(key) === false ) {
            qs$('#quereeContributionStatus').textContent = 'Invitation key is invalid';
            return;
        }
        const state = await refreshContribution({
            what: 'setContributionKey', key,
        });
        if ( state?.hasKey === true ) { input.value = ''; }
    });
    dom.on('#quereeClearKey', 'click', async ( ) => {
        const state = await refreshContribution({
            what: 'setContributionKey', key: '',
        });
        if ( state?.hasKey === false ) { qs$('#quereeInvitationKey').value = ''; }
    });
    refreshContribution();
}

self.hasUnsavedData = ( ) => false;

async function loadSettings() {
    try {
        const details = await vAPI.messaging.send('dashboard', { what: 'userSettings' });
        if ( typeof details !== 'object' || details === null ) {
            settingsUnavailable();
            return;
        }
        bindSettings(details);
        setupContribution();
        await setupPersonalCategories();
    } catch {
        settingsUnavailable();
    }
}

loadSettings();
