/*******************************************************************************

    Quer.ee decision cache
    Copyright (C) 2026-present Marcos

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*/

import { decisionPolicyRevision } from './policy.js';

const trackingParameter = /^(?:utm_.+|gclid|dclid|gbraid|wbraid|fbclid|msclkid|mc_cid|mc_eid|srsltid|_ga|_gl)$/i;
const cacheKeyPrefix = 'quereeDecision/1/';
const currentKeyPattern = /^quereeDecision\/1\/([0-9a-f]{64})\/([0-9a-f]{64})$/;
const allKeyPattern = /^quereeDecision\//;
const millisecondsPerDay = 24 * 60 * 60 * 1000;
const lifetimeDays = {
    candidate: 90,
    exclude: 180,
};
export const sharedReasonKinds = new Set([
    'advertising', 'affiliate_link', 'affiliate_publisher', 'affiliate_tracked_link', 'cross_site_tracking',
    'commercial_store', 'adult_domain', 'scam',
]);

export function needsCharacteristicChecks(decision, settings) {
    if ( decision?.personal_category !== undefined ||
        (decision?.verdict !== 'candidate' && decision?.verdict !== 'exclude') ) { return false; }
    const advertising = settings.excludeAdvertisingSignals !== false;
    const tracking = settings.excludeCrossSiteTracking !== false;
    const shopping = settings.excludeShoppingSignals !== false;
    if ( decision.verdict === 'exclude' ) {
        const reasons = decision.reasons || [];
        if ( reasons.length === 0 || reasons.some(reason => {
            switch ( reason.kind ) {
            case 'advertising': case 'search_advertising': case 'affiliate_link':
            case 'affiliate_publisher': case 'affiliate_tracked_link': return advertising;
            case 'cross_site_tracking': return tracking;
            case 'commercial_store': return shopping;
            default: return true;
            }
        }) ) { return false; }
    }
    if ( (shopping && decision.shopping_signals === true) ||
        (settings.requireSingleDomain === true && decision.single_domain === false) ) { return false; }
    return (decision.verdict === 'exclude' && decision.checks_complete !== true && (advertising || tracking)) ||
        (shopping && typeof decision.shopping_signals !== 'boolean') ||
        (settings.requireSingleDomain === true && typeof decision.single_domain !== 'boolean');
}

function reasonCodes(reasons = []) {
    const codes = new Set();
    for ( const reason of reasons ) {
        if ( sharedReasonKinds.has(reason?.kind) ) {
            codes.add(reason.kind);
        }
    }
    return Array.from(codes);
}

function cachedReason(code) {
    if ( sharedReasonKinds.has(code) ) { return { kind: code }; }
}

async function sha256(value) {
    const data = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest), byte =>
        byte.toString(16).padStart(2, '0')
    ).join('');
}

function currentDay(now) {
    return Math.floor(now() / millisecondsPerDay);
}

export function withoutTextDirective(rawURL) {
    const hash = rawURL.indexOf('#');
    const directive = hash === -1 ? -1 : rawURL.indexOf(':~:', hash);
    if ( directive === -1 ) { return rawURL; }
    return rawURL.slice(0, directive === hash + 1 ? hash : directive);
}

export function canonicalPageURL(rawURL) {
    let url;
    try {
        url = new URL(withoutTextDirective(rawURL));
    } catch {
        return;
    }
    if ( /^https?:$/.test(url.protocol) === false ) { return; }
    if (
        (
            /(^|\.)google\./.test(url.hostname) &&
            /^\/(?:goto|url)$/.test(url.pathname)
        ) || (
            url.hostname === 'www.bing.com' && url.pathname === '/ck/a'
        )
    ) {
        return;
    }
    if ( url.search === '' ) { return url.href; }
    const parts = url.search.slice(1).split('&');
    const kept = parts.filter(part => {
        const separator = part.indexOf('=');
        const rawName = separator === -1 ? part : part.slice(0, separator);
        let name;
        try {
            name = decodeURIComponent(rawName.replace(/\+/g, ' '));
        } catch {
            return true;
        }
        return trackingParameter.test(name) === false;
    });
    if ( kept.length === parts.length ) { return url.href; }
    const base = new URL(url.href);
    base.search = '';
    base.hash = '';
    return kept.length === 0
        ? `${base.href}${url.hash}`
        : `${base.href}?${kept.join('&')}${url.hash}`;
}

function liveEntry(value, now) {
    return Array.isArray(value) &&
        ((value[0] === 'p' && value.length === 5 &&
            [ value[3], value[4] ].every(item => item === null || typeof item === 'boolean')) ||
            (value[0] === 'x' && (value.length === 6 || (value.length === 7 && value[6] === true)) &&
                Array.isArray(value[3]) &&
                value[3].length <= sharedReasonKinds.size &&
                new Set(value[3]).size === value[3].length &&
                Array.from(value[3]).every(code => cachedReason(code) !== undefined) &&
                value.slice(4).every(item => item === null || typeof item === 'boolean'))) &&
        Number.isInteger(value[1]) &&
        value[1] > Math.floor(now / millisecondsPerDay) &&
        Number.isFinite(value[2]) &&
        Math.abs(value[2]) <= 8.64e15 &&
        value[2] <= now;
}

function report(onError, reason) {
    try {
        onError(reason);
    } catch {
    }
}

export async function decisionPolicyFingerprint(deterministicProfile) {
    return sha256(JSON.stringify([
        1,
        decisionPolicyRevision,
        deterministicProfile,
    ]));
}

export function adultSourceProfile(profile = {}) {
    const adult_lists = (profile.adult_lists || []).map(({ name, sha256 }) => ({ name, sha256 }));
    adult_lists.sort((a, b) => {
        if ( a.name !== b.name ) { return a.name < b.name ? -1 : 1; }
        return a.sha256 === b.sha256 ? 0 : a.sha256 < b.sha256 ? -1 : 1;
    });
    return { adult_lists };
}

export async function sharedDecisionCompatibility(profile) {
    const inputs = {
        advertising: [ profile.url_pattern_matcher, profile.promotion_lists ],
        affiliate_publisher: [ profile.url_pattern_matcher, profile.promotion_lists ],
        cross_site_tracking: [ profile.tracking_lists ],
        affiliate_link: [],
        affiliate_tracked_link: [ profile.url_pattern_matcher, profile.affiliate_link_lists ],
        // Routine ad-list updates use expiry, not platform-specific compilation.
        page_observation: [ `sha256:${await sha256(JSON.stringify(profile))}` ],
        commercial_store: [ profile.shopping_lists, profile.fingerprints ],
        scam: [ profile.scam_lists ],
    };
    const compatibility = Object.fromEntries(await Promise.all(Object.entries(inputs).map(async ([kind, data]) =>
        [ kind, `sha256:${await sha256(JSON.stringify([ decisionPolicyRevision, kind, ...data ]))}` ]
    )));
    compatibility.adult_domain = `sha256:${await sha256(JSON.stringify(adultSourceProfile(profile)))}`;
    return compatibility;
}

async function decisionKey(rawURL, policyFingerprint) {
    const canonicalURL = canonicalPageURL(rawURL);
    if ( canonicalURL === undefined ) { return; }
    const urlHash = await sha256(canonicalURL);
    return `${cacheKeyPrefix}${policyFingerprint}/${urlHash}`;
}

class DecisionCache {
    constructor(storage, options = {}) {
        this.storage = storage;
        this.now = options.now || Date.now;
        this.onError = options.onError || (( ) => { });
        this.maxEntries = options.maxEntries || 10000;
        this.entriesPromise = undefined;
        this.serial = Promise.resolve();
        this.writeGeneration = 0;
    }

    async load() {
        if ( this.entriesPromise !== undefined ) { return this.entriesPromise; }
        const promise = (async ( ) => {
            const keys = Array.from(await this.storage.keys(allKeyPattern));
            const bin = keys.length === 0
                ? {}
                : await this.storage.get(keys);
            if ( keys.length !== 0 && bin === undefined ) {
                throw new Error('Quer.ee decision cache could not be read');
            }
            const entries = new Map();
            const remove = [];
            for ( const key of keys ) {
                if ( currentKeyPattern.test(key) === false ) {
                    remove.push(key);
                    continue;
                }
                if ( Object.hasOwn(bin || {}, key) === false ) { continue; }
                entries.set(key, bin[key]);
            }
            remove.push(...this.prune(entries));
            if ( remove.length !== 0 ) { await this.storage.remove(remove); }
            return entries;
        })();
        this.entriesPromise = promise;
        try {
            return await promise;
        } catch (reason) {
            if ( this.entriesPromise === promise ) {
                this.entriesPromise = undefined;
            }
            throw reason;
        }
    }

    prune(entries) {
        const keys = [];
        const now = this.now();
        for ( const [ key, value ] of entries ) {
            if ( liveEntry(value, now) ) { continue; }
            entries.delete(key);
            keys.push(key);
        }
        const excess = entries.size - this.maxEntries;
        if ( excess <= 0 ) { return keys; }
        const overflow = Array.from(entries.entries())
            .sort((a, b) => a[1][1] - b[1][1] || a[0].localeCompare(b[0]))
            .slice(0, excess)
            .map(entry => entry[0]);
        for ( const key of overflow ) { entries.delete(key); }
        return keys.concat(overflow);
    }

    async getObservation(rawURL, policyFingerprint) {
        try {
            const key = await decisionKey(rawURL, policyFingerprint);
            if ( key === undefined ) { return; }
            const run = this.serial.then(async ( ) => {
                const entries = await this.load();
                const value = entries.get(key);
                if ( value === undefined ) { return; }
                if ( liveEntry(value, this.now()) === false ) {
                    entries.delete(key);
                    await this.storage.remove(key);
                    return;
                }
                return {
                    verdict: value[0] === 'p' ? 'candidate' : 'exclude',
                    observed_at: new Date(value[2]).toISOString(),
                    ...Object.fromEntries([ 'single_domain', 'shopping_signals' ]
                        .map((field, index) => [ field, value[index + (value[0] === 'p' ? 3 : 4)] ])
                        .filter(([ , measured ]) => typeof measured === 'boolean')),
                    ...(value[0] === 'x' && value[3].length !== 0 ? { reasons: value[3].map(cachedReason) } : {}),
                    ...(value[0] === 'x' && value[6] ? { checks_complete: true } : {}),
                };
            });
            this.serial = run.catch(( ) => { });
            return await run;
        } catch (reason) {
            report(this.onError, reason);
        }
    }

    async put(decisions, policyFingerprint) {
        const writtenAt = this.now();
        this.writeGeneration += 1;
        const run = this.serial.then(async ( ) => {
            const entries = await this.load();
            const day = currentDay(this.now);
            const additions = {};
            for ( const decision of decisions ) {
                if ( decision.reasons?.some(reason => reason.kind === 'malware') ) { continue; }
                // Category checkboxes choose a view; they are not page observations.
                if ( decision.reasons?.length && decision.reasons.every(reason =>
                    reason.kind === 'source_category'
                ) ) { continue; }
                const lifetime = lifetimeDays[decision.verdict];
                if ( lifetime === undefined ) { continue; }
                const key = await decisionKey(decision.url, policyFingerprint);
                if ( key === undefined ) { continue; }
                const parsed = Date.parse(decision.observed_at);
                const observed = Math.min(Number.isFinite(parsed) ? parsed : writtenAt, writtenAt, this.now());
                const value = [
                    decision.verdict === 'candidate' ? 'p' : 'x',
                    Math.min(day, Math.floor(observed / millisecondsPerDay)) + lifetime,
                    observed,
                ];
                if ( decision.verdict === 'exclude' ) {
                    value.push(reasonCodes(decision.reasons));
                }
                value.push(...[ 'single_domain', 'shopping_signals' ]
                    .map(field => typeof decision[field] === 'boolean' ? decision[field] : null));
                if ( decision.verdict === 'exclude' && decision.checks_complete === true ) { value.push(true); }
                if ( value[1] <= day ) { continue; }
                const stored = entries.get(key);
                const previous = liveEntry(stored, this.now()) ? stored : undefined;
                if ( previous !== undefined && observed < previous[2] ) { continue; }
                if ( previous !== undefined && observed === previous[2] &&
                    value[0] === 'x' && previous[0] === 'x' ) {
                    value[3] = Array.from(new Set([ ...previous[3], ...value[3] ]));
                    // Equal-time partial reports cannot erase completed checks.
                    if ( previous[6] === true && value.length === 6 ) { value.push(true); }
                }
                entries.set(key, value);
                additions[key] = value;
            }
            const remove = this.prune(entries);
            if ( remove.length !== 0 ) {
                for ( const key of remove ) { delete additions[key]; }
                await this.storage.remove(remove);
            }
            if ( Object.keys(additions).length !== 0 ) {
                await this.storage.set(additions);
            }
        });
        this.serial = run.catch(reason => report(this.onError, reason));
        return run;
    }

    async count() {
        try {
            await this.serial;
            const entries = await this.load();
            const remove = this.prune(entries);
            if ( remove.length !== 0 ) { await this.storage.remove(remove); }
            return entries.size;
        } catch (reason) {
            report(this.onError, reason);
            return 0;
        }
    }

    async remove(rawURL, policyFingerprint) {
        this.writeGeneration += 1;
        const run = this.serial.then(async () => {
            const key = await decisionKey(rawURL, policyFingerprint);
            if ( key === undefined ) { return; }
            const entries = await this.load();
            entries.delete(key);
            await this.storage.remove(key);
        });
        this.serial = run.catch(reason => report(this.onError, reason));
        return run;
    }

    async clear() {
        this.writeGeneration += 1;
        const run = this.serial.then(async ( ) => {
            const entries = await this.load();
            const keys = Array.from(await this.storage.keys(allKeyPattern));
            entries.clear();
            if ( keys.length !== 0 ) { await this.storage.remove(keys); }
        });
        this.serial = run.catch(reason => report(this.onError, reason));
        return run;
    }
}

export function createDecisionCache(storage, options) {
    return new DecisionCache(storage, options);
}
