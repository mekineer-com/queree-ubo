import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function webdriverRequest(endpoint, path, body) {
    const response = await fetch(endpoint + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    if ( response.ok === false || result.value?.error ) {
        throw new Error(`${path}: ${JSON.stringify(result.value ?? result)}`);
    }
    return result.value;
}

export async function extensionUUID(profile, addonId = 'queree@mekineer.com') {
    for ( let attempt = 0; attempt < 100; attempt++ ) {
        const prefs = await readFile(resolve(profile, 'prefs.js'), 'utf8').catch(() => '');
        const line = prefs.match(/user_pref\("extensions\.webextensions\.uuids",\s*"(.+)"\);/);
        if ( line ) {
            const mapping = JSON.parse(JSON.parse(`"${line[1]}"`));
            if ( mapping[addonId] ) { return mapping[addonId]; }
        }
        await sleep(100);
    }
    throw new Error('Extension UUID unavailable');
}

export function navigate(endpoint, session, url) {
    return webdriverRequest(endpoint, `/session/${session}/url`, { url });
}

export function execute(endpoint, session, script) {
    return webdriverRequest(endpoint, `/session/${session}/execute/sync`, {
        script,
        args: [],
    });
}

export async function clickElement(endpoint, session, selector) {
    const element = await webdriverRequest(endpoint, `/session/${session}/element`, {
        using: 'css selector', value: selector,
    });
    const id = element['element-6066-11e4-a52e-4f735466cecf'];
    return webdriverRequest(endpoint, `/session/${session}/element/${id}/click`, {});
}
