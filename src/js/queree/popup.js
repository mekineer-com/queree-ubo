/*******************************************************************************

    Quer.ee popup control
    Copyright (C) 2026-present Marcos
    SPDX-License-Identifier: GPL-3.0-or-later

*/

import { i18n$ } from '../i18n.js';

const button = document.querySelector('#quereeSwitch');
let enabled;

async function readState() {
    const settings = await vAPI.messaging.send('queree', { what: 'getSettings' });
    if ( typeof settings?.enabled !== 'boolean' ) {
        throw new Error('Quer.ee settings unavailable');
    }
    return settings.enabled;
}

function render(value) {
    enabled = value;
    button.setAttribute('aria-pressed', String(value));
    button.title = i18n$(value ? 'popupQuereeTurnOff' : 'popupQuereeTurnOn');
    button.disabled = false;
}

function unavailable() {
    button.disabled = true;
    button.setAttribute('aria-pressed', 'false');
    button.title = i18n$('popupQuereeUnavailable');
}

button.addEventListener('click', async ( ) => {
    button.disabled = true;
    try {
        const value = !enabled;
        const reply = await vAPI.messaging.send('queree', {
            what: 'setUserSetting', name: 'quereeEnabled', value,
        });
        if ( reply?.value !== value ) { throw new Error('Quer.ee setting was not saved'); }
        render(value);
    } catch {
        unavailable();
    }
});

readState().then(render, unavailable);
