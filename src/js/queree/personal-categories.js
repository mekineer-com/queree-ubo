/* Quer.ee personal categories; GPL-3.0-or-later. */

import { communityDomains } from './community-domains.js';
import { withoutTextDirective } from './decision-cache.js';

export const defaultPersonalCategories = [ {
    name: 'Social platforms', enabled: true,
    entries: communityDomains.map(domain => `${domain}/*`),
} ];

function pageURL(raw) {
    const url = new URL(withoutTextDirective(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`));
    if ( [ 'http:', 'https:' ].includes(url.protocol) === false ||
        url.username !== '' || url.password !== '' || url.hostname === '' ) {
        throw Error('Enter a page address or site.com/*.');
    }
    url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    return url;
}

function parseEntry(raw) {
    if ( typeof raw !== 'string' || raw.trim() === '' ) {
        throw Error('Enter a page address or site.com/*.');
    }
    raw = raw.trim();
    const site = raw.endsWith('/*');
    let url;
    try { url = pageURL(site ? raw.slice(0, -1) : raw); }
    catch { throw Error('Enter a page address or site.com/*.'); }
    if ( raw.slice(0, site ? -1 : undefined).includes('*') ||
        (site && (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.port !== '')) ) {
        throw Error('Enter a page address or site.com/*.');
    }
    return site ? { site: url.hostname, value: `${url.hostname}/*` }
        : { url, value: url.href };
}

function siteContains(site, hostname) {
    return hostname === site || hostname.endsWith(`.${site}`);
}

function overlap(a, b) {
    if ( a.site && b.site ) {
        return siteContains(a.site, b.site) || siteContains(b.site, a.site);
    }
    if ( a.site ) { return siteContains(a.site, b.url.hostname); }
    if ( b.site ) { return siteContains(b.site, a.url.hostname); }
    return a.value === b.value;
}

export function validatePersonalCategories(value) {
    if ( Array.isArray(value) === false ) { throw Error('Enter personal categories.'); }
    const previous = [];
    const names = new Set();
    return value.map(category => {
        if ( typeof category?.name !== 'string' || category.name.trim() === '' ) {
            throw Error('Enter a category name.');
        }
        const name = category.name.trim();
        if ( names.has(name.toLowerCase()) ) { throw Error('Category name already used.'); }
        names.add(name.toLowerCase());
        if ( typeof category.enabled !== 'boolean' || Array.isArray(category.entries) === false ) {
            throw Error('Enter a category checkbox and page/site entries.');
        }
        const entries = [];
        for ( const raw of category.entries ) {
            const entry = parseEntry(raw);
            const existing = previous.find(other => overlap(other.entry, entry));
            if ( existing ) { throw Error(`Page already in ${existing.name}.`); }
            if ( entries.some(other => other.value === entry.value) ) { continue; }
            entries.push(entry);
        }
        previous.push(...entries.map(entry => ({ name, entry })));
        return { name, enabled: category.enabled, entries: entries.map(entry => entry.value) };
    });
}

export function matchPersonalCategory(rawURL, categories) {
    let url;
    try { url = pageURL(rawURL); } catch { return; }
    return categories.find(category => category.entries.some(raw => {
        // Entries are canonicalized by the editor's privileged save boundary.
        return raw.endsWith('/*') ? siteContains(raw.slice(0, -2), url.hostname) : raw === url.href;
    }));
}

export function personalDisplayRecord(result, categories) {
    const match = matchPersonalCategory(result.original_url || result.url, categories);
    return { ...result, personal_category: match && { name: match.name, enabled: match.enabled } };
}
