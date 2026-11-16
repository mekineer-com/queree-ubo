import { adultSourceProfile, canonicalPageURL, sharedReasonKinds } from './decision-cache.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const maxEntries = 100;
export const maxOutboxBytes = 4 * 1024 * 1024;
export const maxBatchEntries = 20;
export const maxBatchBytes = 32 * 1024;
export const maxDocumentBodyBytes = 128 * 1024;
export const maxDocumentBytes = 160 * 1024;
export const maxAge = 24 * 60 * 60 * 1000;

const bytes = value => encoder.encode(JSON.stringify(value)).length;
const submissionID = /^[A-Za-z0-9._:+-]{1,128}$/;
const contributionReasonKinds = new Set([ ...sharedReasonKinds, 'malware' ]);
const localSuffixes = [
    '.localhost', '.local', '.home.arpa', '.internal',
    '.lan', '.localdomain', '.intranet', '.corp', '.home', '.private',
];

function validHostname(hostname) {
    return hostname.length <= 253 && /[^a-z\d.-]/i.test(hostname) === false &&
        hostname.split('.').every(label => label.length > 0 && label.length <= 63 &&
            label.startsWith('-') === false && label.endsWith('-') === false);
}

function validReasonHost(host) {
    if ( typeof host !== 'string' || host.length > 253 ) { return false; }
    // Request evidence may name local hosts and IP literals, unlike shared page URLs.
    if ( host.startsWith('[') && host.endsWith(']') ) {
        try { return new URL(`http://${host}/`).hostname.startsWith('['); }
        catch { return false; }
    }
    return validHostname(host.replace(/\.$/, ''));
}

export function emptyState() {
    return {
        schema: 1,
        consent: false,
        key: '',
        outbox: [],
        discarded: 0,
        attempts: 0,
        retryAt: 0,
        lastError: '',
    };
}

export function normalizeShareableURL(raw) {
    if ( typeof raw !== 'string' || /%(?![0-9a-f]{2})/i.test(raw) ) {
        return;
    }
    let url;
    try { url = new URL(raw); } catch { return; }
    if ( /^https?:$/.test(url.protocol) === false ) { return; }
    if ( url.username || url.password ) { return; }
    if ( url.href.includes('\\') ) { return; }
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    if (
        validHostname(hostname) === false ||
        hostname === 'localhost' ||
        localSuffixes.some(suffix => hostname === suffix.slice(1) || hostname.endsWith(suffix)) ||
        [ 'routerlogin.net', 'routerlogin.com', 'tplinkwifi.net' ].includes(hostname.replace(/^www\./, '')) ||
        hostname.includes('.') === false ||
        /^\d+(?:\.\d+){3}$/.test(hostname)
    ) {
        return;
    }
    url.hostname = hostname;
    const normalized = canonicalPageURL(url.href);
    if ( normalized === undefined ) { return; }
    if ( encoder.encode(normalized).length > 2048 ) { return; }
    return normalized;
}

function hasNoIndex(value) {
    return /(?:^|[\t\n\f\r ,])(?:noindex|none)(?=$|[\t\n\f\r ,])/i.test(value);
}

function mayIndex(directives) {
    if ( directives.meta_robots.some(hasNoIndex) ) { return false; }
    const valueDirectives = new Set([
        'max-image-preview', 'max-snippet', 'max-video-preview', 'unavailable_after',
    ]);
    for ( const header of directives.x_robots_tag ) {
        let scope;
        for ( const part of header.toLowerCase().split(',') ) {
            let directive = part.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
            const colon = directive.indexOf(':');
            if ( colon !== -1 ) {
                const prefix = directive.slice(0, colon).replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
                if ( valueDirectives.has(prefix) === false ) {
                    scope = prefix;
                    directive = directive.slice(colon + 1).replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
                }
            }
            if ( (scope === undefined || scope === 'queree') && hasNoIndex(directive) ) {
                return false;
            }
        }
    }
    return true;
}

export function contributionDocument(decision, producer, metadata = {}) {
    if ( decision?.source_categories?.includes('commercial_corporate') ) { return; }
    const source = decision?.document;
    const url = normalizeShareableURL(source?.url);
    if (
        url === undefined ||
        source?.schema !== 1 ||
        typeof source.title !== 'string' ||
        typeof source.body !== 'string' ||
        typeof source.extraction_version !== 'string' ||
        typeof source.truncated !== 'boolean' ||
        typeof source.indexing_directives?.complete !== 'boolean' ||
        Array.isArray(source.indexing_directives.meta_robots) === false ||
        Array.isArray(source.indexing_directives.x_robots_tag) === false ||
        source.indexing_directives.meta_robots.some(value => typeof value !== 'string') ||
        source.indexing_directives.x_robots_tag.some(value => typeof value !== 'string')
    ) { return; }
    let directives = source.indexing_directives;
    const indexable = mayIndex(directives);
    if ( directives.complete === false ) {
        if ( indexable ) { return; }
        // Omitted directives cannot undo a retained noindex; send only that evidence.
        directives = { complete: true, meta_robots: [ 'noindex' ], x_robots_tag: [] };
    }
    const document = {
        schema: 1,
        url,
        title: indexable ? decoder.decode(encoder.encode(source.title.replace(/\0/g, ''))) : '',
        body: indexable ? decoder.decode(encoder.encode(source.body.replace(/\0/g, ''))) : '',
        extraction_version: source.extraction_version,
        truncated: source.truncated,
        indexing_directives: directives,
    };
    if ( indexable && document.body === '' ) { return; }
    const { read } = encoder.encodeInto(
        document.body, new Uint8Array(maxDocumentBodyBytes)
    );
    document.truncated ||= read < document.body.length;
    document.body = document.body.slice(0, read);
    // Reserve the full ID allowance before the outbox assigns its stable ID.
    const payload = { schema: 2, submission_id: 'x'.repeat(128), producer, ...metadata, document };
    if ( bytes(payload) <= maxDocumentBytes ) { return document; }
    const characters = Array.from(document.body);
    let low = 0;
    let high = characters.length;
    document.truncated = true;
    while ( low < high ) {
        const middle = Math.ceil((low + high) / 2);
        document.body = characters.slice(0, middle).join('');
        if ( bytes(payload) <= maxDocumentBytes ) { low = middle; }
        else { high = middle - 1; }
    }
    document.body = characters.slice(0, low).join('');
    if ( document.body === '' || bytes(payload) > maxDocumentBytes ) { return; }
    return document;
}

export { sharedReasonKinds };

function normalizeContributionReason(reason) {
    if ( contributionReasonKinds.has(reason?.kind) === false ) { return; }
    const clean = { kind: reason.kind };
    for ( const name of [ 'rule', 'list' ] ) {
        if ( typeof reason[name] === 'string' ) {
            clean[name] = reason[name].toWellFormed().slice(0, 256).replace(/[\uD800-\uDBFF]$/, '');
        }
    }
    if ( validReasonHost(reason.host) ) { clean.host = reason.host; }
    return clean;
}

export function normalizeSharedReason(reason) {
    if ( sharedReasonKinds.has(reason?.kind) ) { return normalizeContributionReason(reason); }
}

export function contributionObservation(value, producer) {
    if ( value.cached || value.server_sourced ) { return; }
    const observed = Date.parse(value.observed_at);
    if ( Number.isFinite(observed) === false ) { return; }
    const finalURL = normalizeShareableURL(value.verdict === 'exclude'
        ? (value.final_url === undefined ? value.url : value.final_url)
        : value.document?.url || value.url);
    if ( value.verdict === 'exclude' && value.final_url !== undefined && finalURL === undefined ) { return; }
    const resultURL = normalizeShareableURL(value.original_url) || finalURL;
    if ( resultURL === undefined ) { return; }
    const result = { url: resultURL };
    const decision = {
        verdict: value.verdict, observed_at: value.observed_at,
        compatibility: value.shared_compatibility || {}, reasons: [],
    };
    if ( value.shopping_evidence !== undefined ) {
        decision.shopping_evidence = value.shopping_evidence;
    }
    for ( const field of [ 'single_domain', 'shopping_signals', 'checks_complete' ] ) {
        if ( typeof value[field] === 'boolean' ) { decision[field] = value[field]; }
    }
    if ( value.verdict === 'exclude' ) {
        for ( const reason of value.reasons || [] ) {
            let host = reason.matched_hostname;
            if ( host === undefined && reason.request_url ) {
                try { host = new URL(reason.request_url).hostname; } catch { }
            }
            const clean = normalizeContributionReason({ ...reason, host });
            if ( clean === undefined ) { continue; }
            decision.reasons.push(clean);
            if ( decision.reasons.length === 8 ) { break; }
        }
        if ( decision.reasons.length === 0 ) { return; }
        if ( decision.reasons.some(reason => reason.kind === 'adult_domain') ) {
            decision.sender_profile = adultSourceProfile(value.deterministic_profile);
        }
        if ( value.final_url && finalURL ) { decision.final_url = finalURL; }
        return { url: finalURL || resultURL, result, decision, producer };
    }
    if ( value.verdict !== 'candidate' ) { return; }
    for ( const [name, field, limit] of [
        [ 'title', 'result_title', 512 ], [ 'description', 'result_description', 1024 ],
    ] ) {
        if ( typeof value[field] === 'string' && value[field] !== '' ) {
            result[name] = Array.from(value[field].replace(/\0/g, '')).slice(0, limit).join('');
        }
    }
    const document = contributionDocument(value, producer, { result, decision });
    if ( document === undefined ) { return; }
    return { url: document.url, result, decision, document, producer };
}

export function sanitizeState(raw, now = Date.now()) {
    const state = emptyState();
    if ( raw instanceof Object ) {
        state.consent = raw.consent === true;
        state.key = typeof raw.key === 'string' ? raw.key : '';
        state.discarded = Number.isInteger(raw.discarded) ? raw.discarded : 0;
        state.attempts = Number.isInteger(raw.attempts) ? raw.attempts : 0;
        state.retryAt = Number.isFinite(raw.retryAt) ? raw.retryAt : 0;
        state.lastError = typeof raw.lastError === 'string' ? raw.lastError : '';
        if ( Array.isArray(raw.outbox) ) {
            state.outbox = raw.outbox.filter(entry =>
                entry instanceof Object &&
                typeof entry.id === 'string' && submissionID.test(entry.id) &&
                typeof entry.url === 'string' && entry.url !== '' &&
                Number.isFinite(entry.addedAt) &&
                entry.addedAt > now - maxAge &&
                [ 'extension_release', 'policy_revision', 'deterministic_manifest_digest' ].every(name =>
                    typeof entry.producer?.[name] === 'string' && entry.producer[name] !== ''
                ) &&
                ((entry.producer.ad_profile_digest === null && entry.decision?.verdict === 'exclude') ||
                    (typeof entry.producer.ad_profile_digest === 'string' && entry.producer.ad_profile_digest !== '')) &&
                typeof entry.result?.url === 'string' && entry.result.url !== '' &&
                typeof entry.decision?.observed_at === 'string' &&
                Number.isFinite(Date.parse(entry.decision.observed_at)) &&
                [ 'single_domain', 'shopping_signals', 'checks_complete' ].every(field =>
                    entry.decision[field] === undefined || typeof entry.decision[field] === 'boolean'
                ) &&
                (
                    (entry.decision.verdict === 'candidate' &&
                        entry.document?.schema === 1 && entry.document.url === entry.url &&
                        typeof entry.document.title === 'string' &&
                        typeof entry.document.body === 'string') ||
                    (entry.decision.verdict === 'exclude' && entry.document === undefined &&
                        Array.isArray(entry.decision.reasons) &&
                        entry.decision.reasons.length > 0 && entry.decision.reasons.length <= 8 &&
                        entry.decision.reasons.every(reason => contributionReasonKinds.has(reason?.kind)))
                )
            );
            state.discarded += raw.outbox.length - state.outbox.length;
        }
    }
    const seen = new Set();
    state.outbox = state.outbox.filter(entry => {
        if ( seen.has(entry.result.url) ) { return false; }
        seen.add(entry.result.url);
        return true;
    });
    while (
        state.outbox.length > maxEntries ||
        bytes(state.outbox) > maxOutboxBytes
    ) {
        // Full-inbox retries rotate entries without renewing their age.
        const oldest = state.outbox.reduce((index, entry, current) =>
            entry.addedAt < state.outbox[index].addedAt ? current : index, 0);
        state.outbox.splice(oldest, 1);
        state.discarded += 1;
    }
    return state;
}

export function enqueue(state, entries, now = Date.now()) {
    const existing = new Map(state.outbox.map(entry => [ entry.result.url, entry ]));
    for ( const entry of entries ) {
        const previous = existing.get(entry.result.url);
        if ( previous !== undefined ) {
            if ( Date.parse(entry.decision.observed_at) < Date.parse(previous.decision.observed_at) ) { continue; }
            state.outbox.splice(state.outbox.indexOf(previous), 1);
        }
        const fresh = { ...entry, addedAt: now };
        existing.set(entry.result.url, fresh);
        state.outbox.push(fresh);
    }
    return sanitizeState(state, now);
}

export function nextBatch(state, now = Date.now()) {
    const ready = entry => (entry.retryAt || 0) <= now;
    const first = state.outbox.find(ready);
    if ( first === undefined ) { return; }
    if ( first.document !== undefined ) {
        return {
            entries: [ first ],
            payload: {
                schema: 2, submission_id: first.id, producer: first.producer, result: first.result,
                decision: first.decision, document: first.document,
            },
        };
    }
    const entries = [];
    const payload = { schema: 2, producer: first.producer, exclusions: [] };
    const producerKey = JSON.stringify(first.producer);
    for ( const entry of state.outbox ) {
        if ( entries.length === maxBatchEntries ) { break; }
        if ( ready(entry) === false || entry.decision.verdict !== 'exclude' || JSON.stringify(entry.producer) !== producerKey ) { continue; }
        const exclusions = [ ...payload.exclusions, {
            submission_id: entry.id, result: entry.result, decision: entry.decision,
        } ];
        if ( bytes({ ...payload, exclusions }) > maxBatchBytes ) { break; }
        payload.exclusions = exclusions;
        entries.push(entry);
    }
    return { entries, payload };
}
