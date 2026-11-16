/* globals browser */

import {
    contributionObservation,
    enqueue,
    nextBatch,
    normalizeShareableURL,
    normalizeSharedReason,
    sanitizeState,
} from './contribution-core.js';
import { decisionPolicyRevision } from './policy.js';
import µb from '../background.js';

const endpoint = 'https://api.quer.ee/v1/discoveries';
const lookupEndpoint = new URL('/v1/exclusions', endpoint).href;
const storageKey = 'quereeContributionState';
const alarmName = 'quereeContributionRetry';
const keyPattern = /^qk_[A-Za-z0-9_-]{43}$/;
const backoff = [ 60e3, 5 * 60e3, 30 * 60e3, 2 * 60 * 60e3 ];
const rejectionCodes = new Set([
    'document', 'credentials', 'hostname', 'ip_literal', 'local_host',
    'malformed', 'not_string', 'scheme', 'too_long',
    'producer', 'envelope', 'schema', 'invalid_json',
    'extension_release', 'policy_revision', 'ad_profile_digest',
    'deterministic_manifest_digest',
]);

let serial = Promise.resolve();
let sending = false;
let pumpRequested = false;
let activeRequest;
let contributionAllowed = false;
let permissionGeneration = 0;
// Keep failed enqueues visible until a successful write can persist the count.
let pendingDiscards = 0;
let producerManifest;
let producerDigest;

function mutate(task, write = true) {
    const run = serial.then(async ( ) => {
        const bin = await browser.storage.local.get(storageKey);
        const raw = bin[storageKey];
        const state = sanitizeState(raw);
        const discarded = pendingDiscards;
        state.discarded += discarded;
        const result = await task(state);
        if ( write || state.outbox.length !== (raw?.outbox?.length || 0) ) {
            await browser.storage.local.set({ [storageKey]: state });
            pendingDiscards -= discarded;
        }
        return result;
    });
    serial = run.catch(( ) => { });
    return run;
}

function canContribute(state) {
    return state.consent && keyPattern.test(state.key) &&
        state.lastError !== 'authentication' && state.lastError !== 'quota_exhausted';
}

function clearConsent(state) {
    Object.assign(state, { consent: false, outbox: [], attempts: 0, retryAt: 0, lastError: '' });
    vAPI.alarms.clear(alarmName);
}

async function pauseContribution(reason) {
    contributionAllowed = false;
    permissionGeneration += 1;
    await mutate(state => {
        state.lastError = reason;
        state.retryAt = 0;
    });
    vAPI.alarms.clear(alarmName);
}

function hex(buffer) {
    return Array.from(new Uint8Array(buffer), byte =>
        byte.toString(16).padStart(2, '0')
    ).join('');
}

async function producer(decision) {
    const version = decision.profile?.version;
    if ( version === undefined && decision.verdict !== 'exclude' ) { return; }
    if ( version !== undefined && /^[0-9a-f]{64}$/.test(version) === false ) { return; }
    const deterministic = JSON.stringify(decision.deterministic_profile || {});
    if ( deterministic !== producerManifest ) {
        producerManifest = deterministic;
        producerDigest = crypto.subtle.digest(
            'SHA-256', new TextEncoder().encode(deterministic)
        ).then(hex);
    }
    const pending = producerDigest;
    let digest;
    try {
        digest = await pending;
    } catch (reason) {
        if ( pending === producerDigest ) { producerManifest = undefined; }
        throw reason;
    }
    return {
        extension_release: `${vAPI.app.version}+queree.1`,
        policy_revision: decisionPolicyRevision,
        ad_profile_digest: version === undefined ? null : `sha256:${version}`,
        deterministic_manifest_digest: `sha256:${digest}`,
    };
}

function postJSON(url, key, body, signal) {
    return fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body, signal, cache: 'no-store', credentials: 'omit',
        redirect: 'error', referrerPolicy: 'no-referrer',
    });
}

export async function enqueueObservations(decisions) {
    if ( contributionAllowed === false ) { return; }
    const generation = permissionGeneration;
    const entries = [];
    for ( const decision of decisions ) {
        if ( decision.contribution_epoch !== generation ) { continue; }
        if ( decision.cached || decision.server_sourced ) { continue; }
        const details = await producer(decision);
        if ( details === undefined ) { continue; }
        const observation = contributionObservation(decision, details);
        if ( observation === undefined ) { continue; }
        entries.push({ id: crypto.randomUUID(), ...observation });
    }
    if ( entries.length === 0 ) { return; }
    try {
        await mutate(state => {
            if (
                generation !== permissionGeneration ||
                contributionAllowed === false || canContribute(state) === false
            ) { return; }
            Object.assign(state, enqueue(state, entries));
        });
    } catch (reason) {
        pendingDiscards += entries.length;
        console.error('Quer.ee could not queue contributions', reason);
        throw reason;
    }
    if ( contributionAllowed ) { pump(); }
}

export async function lookupSharedObservations(rawURLs, compatibility) {
    if ( contributionAllowed === false ) { return []; }
    const generation = permissionGeneration;
    const key = await mutate(state => canContribute(state) ? state.key : '', false);
    if ( generation !== permissionGeneration || contributionAllowed === false || keyPattern.test(key) === false ) { return []; }
    const urls = Array.from(new Set(rawURLs.map(normalizeShareableURL).filter(Boolean)));
    const results = [];
    const encoder = new TextEncoder();
    for ( let offset = 0; offset < urls.length; ) {
        const group = urls.slice(offset, offset + 20);
        const payload = { schema: 1, policy_revision: decisionPolicyRevision, compatibility, urls: group };
        let requestBody = JSON.stringify(payload);
        while ( group.length > 1 && encoder.encode(requestBody).length > 32 * 1024 ) {
            group.pop();
            requestBody = JSON.stringify(payload);
        }
        offset += group.length;
        if ( encoder.encode(requestBody).length > 32 * 1024 ) { continue; }
        const controller = new AbortController();
        const timeout = setTimeout(( ) => controller.abort(), 1500);
        try {
            if ( contributionAllowed === false || generation !== permissionGeneration ) { return []; }
            const response = await postJSON(lookupEndpoint, key, requestBody, controller.signal);
            if ( contributionAllowed === false || generation !== permissionGeneration ) { return []; }
            if ( response.status === 401 || response.status === 403 ) {
                await pauseContribution('authentication');
                return [];
            }
            if ( response.ok === false ) { continue; }
            const raw = await response.text();
            if ( encoder.encode(raw).length > 32 * 1024 ) { continue; }
            const body = JSON.parse(raw);
            if ( body.schema !== 1 || Array.isArray(body.exclusions) === false || body.exclusions.length > 20 ) { continue; }
            if ( body.truncated === true ) {
                const returned = new Set(body.exclusions.map(item => item?.url));
                const omitted = group.filter(url => returned.has(url) === false);
                // Require progress so a malformed reply cannot retry forever.
                if ( omitted.length < group.length ) { urls.splice(offset, 0, ...omitted); }
            }
            for ( const item of body.exclusions ) {
                const stamp = Date.parse(item?.observed_at);
                if (
                    group.includes(item?.url) === false || Number.isFinite(stamp) === false ||
                    stamp > Date.now() + 300e3
                ) { continue; }
                if ( item.verdict === 'candidate' ) {
                    if ( stamp <= Date.now() - 90 * 864e5 ||
                        typeof item.shopping_signals !== 'boolean' ||
                        (item.single_domain !== undefined && typeof item.single_domain !== 'boolean') ) {
                        continue;
                    }
                    results.push({
                        url: item.url, observed_at: item.observed_at,
                        verdict: 'candidate', shopping_signals: item.shopping_signals,
                        ...(typeof item.single_domain === 'boolean'
                            ? { single_domain: item.single_domain } : {}),
                    });
                    continue;
                }
                if ( stamp <= Date.now() - 180 * 864e5 ||
                    Array.isArray(item.reasons) === false || item.reasons.length > 8 ) { continue; }
                const reasons = item.reasons.map(normalizeSharedReason).filter(Boolean);
                if ( reasons.length ) {
                    const decision = { url: item.url, observed_at: item.observed_at, verdict: 'exclude', reasons };
                    for ( const field of [ 'single_domain', 'shopping_signals', 'checks_complete' ] ) {
                        if ( typeof item[field] === 'boolean' ) { decision[field] = item[field]; }
                    }
                    results.push(decision);
                }
            }
        } catch { /* A lookup miss leaves local inspection running. */ }
        finally { clearTimeout(timeout); }
    }
    return contributionAllowed && generation === permissionGeneration ? results : [];
}

async function retry(reason, retryAfter = 0, blocked = []) {
    await mutate(state => {
        if ( contributionAllowed === false || state.consent === false ) { return; }
        state.attempts += 1;
        const delay = retryAfter || backoff[Math.min(
            state.attempts - 1, backoff.length - 1
        )];
        state.retryAt = Date.now() + delay;
        if ( blocked.length !== 0 ) {
            // Capacity waits follow entries across restarts, without renewing their age.
            const ids = new Set(blocked.map(entry => entry.id));
            for ( const entry of state.outbox ) {
                if ( ids.has(entry.id) ) { entry.retryAt = state.retryAt; }
            }
            state.outbox = [
                ...state.outbox.filter(entry => ids.has(entry.id) === false),
                ...state.outbox.filter(entry => ids.has(entry.id)),
            ];
        }
        if ( reason === 'inbox_full' ) {
            state.retryAt = capacityRetryAt(state);
        }
        state.lastError = reason;
        if ( state.retryAt ) { vAPI.alarms.create(alarmName, { when: state.retryAt }); }
    });
}

function capacityRetryAt(state) {
    const deadlines = state.outbox.map(entry => entry.retryAt).filter(time => time > Date.now());
    return deadlines.length === 0 ? 0 : Math.min(...deadlines);
}

function clearBatchRetry(state, error = '') {
    const deadline = capacityRetryAt(state);
    if ( deadline ) {
        Object.assign(state, { attempts: 0, retryAt: deadline, lastError: 'inbox_full' });
        return;
    }
    Object.assign(state, { attempts: 0, retryAt: 0, lastError: error });
}

async function send(snapshot) {
    if ( contributionAllowed === false ) { return false; }
    const request = activeRequest = new AbortController();
    const timeout = setTimeout(( ) => request.abort('timeout'), 30000);
    let response;
    let body;
    try {
        response = await postJSON(endpoint, snapshot.key, JSON.stringify(snapshot.batch.payload), request.signal);
        if ( response.ok ) {
            body = await response.json();
        } else if ( [ 400, 401, 429, 503 ].includes(response.status) ) {
            body = await response.json().catch(( ) => undefined);
        }
    } finally {
        clearTimeout(timeout);
    }
    if ( contributionAllowed === false || snapshot.generation !== permissionGeneration ) {
        return false;
    }
    if (
        (response.status === 400 && body?.schema === 1 && rejectionCodes.has(body.error)) ||
        response.status === 413 || response.status === 415
    ) {
        const rejected = new Set(snapshot.batch.entries.map(entry => entry.id));
        await mutate(state => {
            state.discarded += state.outbox.filter(entry => rejected.has(entry.id)).length;
            state.outbox = state.outbox.filter(entry => rejected.has(entry.id) === false);
            clearBatchRetry(state, 'Some pages could not be contributed');
        });
        return true;
    }
    if ( [ 401, 429, 503 ].includes(response.status) &&
        snapshot.batch.payload.exclusions !== undefined && body?.results !== undefined ) {
        await acknowledge(snapshot, body, true);
        if ( contributionAllowed === false || snapshot.generation !== permissionGeneration ) { return false; }
    }
    if ( response.status === 401 || response.status === 403 ||
        (response.status === 429 && body?.error === 'quota_exhausted') ) {
        await pauseContribution(response.status === 429 ? 'quota_exhausted' : 'authentication');
        return false;
    }
    if ( response.status === 429 || response.status >= 500 ) {
        const seconds = Number.parseInt(response.headers.get('Retry-After'), 10);
        const retryAfter = Number.isFinite(seconds)
            ? Math.min(Math.max(seconds * 1000, 60e3), 2 * 60 * 60e3)
            : 0;
        const inboxFull = response.status === 503 && body?.schema === 2 && body.error === 'inbox_full';
        await retry(inboxFull ? 'inbox_full' : 'temporary', retryAfter,
            inboxFull ? snapshot.batch.entries : []);
        return inboxFull;
    }
    if ( response.ok === false ) {
        await retry(`server_${response.status}`, backoff.at(-1));
        return false;
    }
    const removed = await acknowledge(snapshot, body);
    if ( removed === undefined ) {
        await retry('invalid_response');
        return false;
    }
    return removed !== 0;
}

async function acknowledge(snapshot, body, partial = false) {
    const remove = new Set();
    const invalid = new Set();
    if ( snapshot.batch.payload.document !== undefined ) {
        if ( body?.schema !== 2 || body.status !== 'acknowledged' ) {
            return;
        }
        remove.add(snapshot.batch.entries[0].id);
    } else {
        if ( body?.schema !== 2 || Array.isArray(body.results) === false ) {
            return;
        }
        for ( const result of body.results ) {
            if ( Number.isInteger(result?.index) === false ||
                [ 'acknowledged', 'invalid' ].includes(result.status) === false ) { return; }
            const entry = snapshot.batch.entries[result.index];
            if ( entry === undefined || remove.has(entry.id) ) { return; }
            remove.add(entry.id);
            if ( result.status === 'invalid' ) { invalid.add(entry.id); }
        }
        if ( partial === false && remove.size !== snapshot.batch.entries.length ) { return; }
    }
    if ( remove.size === 0 ) { return 0; }
    await mutate(state => {
        state.discarded += state.outbox.filter(entry => invalid.has(entry.id)).length;
        state.outbox = state.outbox.filter(entry => remove.has(entry.id) === false);
        clearBatchRetry(state, invalid.size ? 'Some pages could not be contributed' : '');
    });
    return remove.size;
}

async function pump() {
    if ( contributionAllowed === false ) { return; }
    if ( sending ) {
        pumpRequested = true;
        return;
    }
    sending = true;
    try {
        for (;;) {
            const snapshot = await mutate(state => {
                if (
                    contributionAllowed === false ||
                    canContribute(state) === false
                ) {
                    return;
                }
                const waiting = state.retryAt > Date.now() && state.lastError !== 'inbox_full';
                const deadline = waiting ? state.retryAt : capacityRetryAt(state);
                if ( deadline ) { vAPI.alarms.create(alarmName, { when: deadline }); }
                if ( waiting ) { return; }
                const batch = nextBatch(state);
                return batch && { batch, key: state.key, generation: permissionGeneration };
            }, false);
            if ( snapshot === undefined ) { break; }
            if ( contributionAllowed === false ) { break; }
            let progressed;
            try {
                progressed = await send(snapshot);
            } catch (reason) {
                if ( contributionAllowed === false || snapshot.generation !== permissionGeneration ) { break; }
                if ( activeRequest?.signal.reason === 'timeout' ) {
                    await retry('timeout');
                } else if ( reason?.name !== 'AbortError' ) {
                    await retry('transport');
                }
                break;
            } finally {
                activeRequest = undefined;
            }
            if ( progressed === false ) { break; }
        }
    } catch (reason) {
        console.error('Quer.ee could not access contribution state', reason);
    } finally {
        sending = false;
        if ( pumpRequested ) {
            pumpRequested = false;
            pump();
        }
    }
}

export function getContributionState() {
    return mutate(state => ({
        consent: state.consent,
        hasKey: keyPattern.test(state.key),
        queued: state.outbox.length,
        discarded: state.discarded,
        lastError: state.lastError,
    }), false);
}

export async function setContributionConsent(consent) {
    const generation = ++permissionGeneration;
    if ( consent === false ) {
        contributionAllowed = false;
        activeRequest?.abort();
    } else {
        const permissions = await browser.permissions.getAll().catch(( ) => ({}));
        if ( generation !== permissionGeneration ) { return getContributionState(); }
        if ( hasContributionDataPermissions(permissions) === false ) {
            consent = false;
        }
    }
    const allowed = await mutate(state => {
        if ( generation !== permissionGeneration ) { return false; }
        state.consent = consent === true && keyPattern.test(state.key);
        if ( state.consent === false ) { clearConsent(state); }
        return canContribute(state);
    });
    if ( generation !== permissionGeneration ) { return getContributionState(); }
    contributionAllowed = allowed;
    if ( contributionAllowed ) { pump(); }
    return getContributionState();
}

const contributionDataPermissions = new Set([
    'browsingActivity',
    'authenticationInfo',
    'technicalAndInteraction',
    'websiteContent',
]);

export function getContributionEpoch() {
    return contributionAllowed ? permissionGeneration : undefined;
}

function hasContributionDataPermissions(permissions) {
    const granted = new Set(permissions?.data_collection || []);
    return Array.from(contributionDataPermissions).every(value => granted.has(value));
}

export async function setContributionKey(key) {
    if ( key !== '' && keyPattern.test(key) === false ) {
        throw new Error('Invitation key is invalid');
    }
    contributionAllowed = false;
    permissionGeneration += 1;
    activeRequest?.abort();
    const consent = await mutate(state => {
        state.key = key;
        if ( key === '' ) {
            state.consent = false;
            state.outbox = [];
            vAPI.alarms.clear(alarmName);
        }
        state.attempts = 0;
        state.retryAt = 0;
        state.lastError = key === '' ? 'key_required' : '';
        return state.consent;
    });
    if ( key === '' ) {
        browser.permissions.remove({
            data_collection: Array.from(contributionDataPermissions),
        }).catch(( ) => { });
    }
    if ( key !== '' && consent ) { return setContributionConsent(true); }
    return getContributionState();
}

vAPI.alarms.onAlarm.addListener(alarm => {
    if ( alarm.name === alarmName ) { pump(); }
});

browser.permissions.onRemoved.addListener(permissions => {
    if (
        permissions.data_collection?.some(value =>
            contributionDataPermissions.has(value)
        )
    ) {
        setContributionConsent(false).catch(( ) => { });
    }
});

µb.isReadyPromise.then(async ( ) => {
    const generation = permissionGeneration;
    const consent = await mutate(state => canContribute(state), false);
    const permissions = await browser.permissions.getAll().catch(( ) => ({}));
    if ( generation !== permissionGeneration ) { return; }
    if ( hasContributionDataPermissions(permissions) === false ) {
        await mutate(state => {
            if ( generation !== permissionGeneration ) { return; }
            clearConsent(state);
        });
        return;
    }
    contributionAllowed = consent;
    if ( contributionAllowed ) { pump(); }
}).catch(reason => {
    console.error('Quer.ee could not load contribution state', reason);
});
