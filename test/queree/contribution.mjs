import {
    contributionDocument,
    contributionObservation,
    emptyState,
    enqueue,
    maxAge,
    maxBatchBytes,
    maxBatchEntries,
    maxDocumentBodyBytes,
    maxDocumentBytes,
    maxEntries,
    maxOutboxBytes,
    nextBatch,
    normalizeShareableURL,
    normalizeSharedReason,
    sanitizeState,
} from '../../src/js/queree/contribution-core.js';
import assert from 'node:assert/strict';
import { canonicalPageURL } from '../../src/js/queree/decision-cache.js';

const producer = suffix => ({
    extension_release: `test-${suffix}`,
    policy_revision: 'test-policy',
    ad_profile_digest: `sha256:${'a'.repeat(64)}`,
    deterministic_manifest_digest: `sha256:${'b'.repeat(64)}`,
});

const exclusionEntry = (id, url, suffix = 'a', observedAt = 1000) => ({
    id,
    ...contributionObservation({
        verdict: 'exclude', original_url: url,
        observed_at: new Date(observedAt).toISOString(),
        reasons: [ { kind: 'advertising', rule: '||ads.example^' } ],
        shared_compatibility: { advertising: `sha256:${'a'.repeat(64)}` },
    }, producer(suffix)),
});

assert.equal(
    normalizeShareableURL('HTTPS://Example.COM:443/Article'),
    'https://example.com/Article'
);
for ( const url of [
    'https://user@example.com/',
    'http://127.0.0.1/',
    'http://192.168.1.1/',
    'http://10.0.0.1/',
    'http://[fd00::1]/',
    'http://localhost/',
    'http://localhost.localdomain/',
    'https://LOCALHOST.LOCALDOMAIN.:8443/page',
    'http://www.localhost.localdomain/',
    'https://WWW.LOCALHOST.LOCALDOMAIN./',
    'http://intranet/',
    'http://router.local/',
    'http://router.home.arpa/',
    'http://home.arpa/',
    'http://router.local./',
    'https://www.routerlogin.net/',
    'https://tplinkwifi.net/',
] ) {
    assert.equal(normalizeShareableURL(url), undefined, url);
}
for ( const suffix of [ 'lan', 'localdomain', 'intranet', 'corp', 'home', 'private' ] ) {
    for ( const host of [ `router.${suffix}`, `sub.router.${suffix}`, `ROUTER.${suffix.toUpperCase()}.` ] ) {
        const url = `http://${host}:8080/admin`;
        assert.equal(normalizeShareableURL(url), undefined, url);
        assert.equal(contributionObservation({ verdict: 'exclude', original_url: url,
            observed_at: new Date().toISOString(), reasons: [ { kind: 'advertising' } ],
        }, producer('a')), undefined, 'Local page exclusions must not enter the shared outbox');
    }
    for ( const host of [ `${suffix}.example`, `router.${suffix}.example`, `router.not${suffix}` ] ) {
        const url = `https://${host}/page`;
        assert.equal(normalizeShareableURL(url), url, 'Match a complete local suffix, not public lookalikes');
    }
}
for ( const url of [
    'https://bad_host.example/page', 'https://-bad.example/', 'https://bad-.example/',
    'https://bad..example/', 'https://example.com../',
    `https://${'a'.repeat(64)}.example/`, `https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}/`,
    'https://example.com/#part\\tail', 'https://example.com/?q=part\\tail',
] ) {
    assert.equal(normalizeShareableURL(url), undefined, url);
}
for ( const url of [
    'https://a-b.example/path#route', 'https://example.com/#part%5Ctail',
    `https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}/`,
] ) {
    assert.equal(normalizeShareableURL(url), url);
}
assert.equal(normalizeShareableURL('https://b\u00fccher.example/caf\u00e9'),
    'https://xn--bcher-kva.example/caf%C3%A9', 'Send browser ASCII serialization to the server');
for ( const escape of [ '%', '%2', '%GG', '%2G', '%G2', '%u0041', '%20%' ] ) {
    for ( const suffix of [
        `/path${escape}`, `/?q=${escape}`, `/#${escape}`,
        `/?utm_source=${escape}`, `/#:~:text=${escape}`,
    ] ) {
        const url = `https://example.com${suffix}`;
        assert.equal(normalizeShareableURL(url), undefined, url);
        assert.notEqual(canonicalPageURL(url), undefined,
            'Contribution validation must not restrict general inspection');
    }
}
for ( const url of [
    'https://example.org/',
    'https://localdomain.com/',
    'https://localhost.localdomain.com/',
    'https://notlocalhost.localdomain.com/',
    'https://example.com/a%2Fb%2fc%20d%25?q=%26%3D%ff#part%23%00',
    'https://example.com/%252G?q=%25GG#%252',
] ) {
    assert.equal(normalizeShareableURL(url), url);
}
assert.equal(
    canonicalPageURL('http://localhost.localdomain/'),
    'http://localhost.localdomain/',
    'Local pages remain available for general inspection'
);
let state = emptyState();
state.consent = true;
state.key = `qk_${'x'.repeat(43)}`;
state = enqueue(state, [
    exclusionEntry('old', 'https://old.example/', 'a', 2000),
], 1000);
state = enqueue(state, [
    exclusionEntry('duplicate', 'https://old.example/', 'b', 1000),
    exclusionEntry('new', 'https://new.example/', 'b', 2000),
], 2000);
assert.deepEqual(state.outbox.map(entry => entry.id), [ 'old', 'new' ]);
assert.equal(state.outbox[0].producer.extension_release, 'test-a');

state = sanitizeState(state, 1000 + maxAge + 1);
assert.deepEqual(state.outbox.map(entry => entry.id), [ 'new' ]);
assert.equal(state.discarded, 1, 'Expired entries count as discarded');
state = sanitizeState(state, 2000 + maxAge);
assert.equal(state.outbox.length, 0, 'Entries expire at the age limit');
assert.equal(state.discarded, 2);
assert.equal(sanitizeState(state, 2000 + maxAge).discarded, 2,
    'Repeated sanitization must not recount expired entries');

state = emptyState();
state = enqueue(state, Array.from({ length: maxEntries + 5 }, (_, index) =>
    exclusionEntry(String(index), `https://${index}.example/`)
), 3000);
assert.equal(state.outbox.length, maxEntries);
assert.equal(state.discarded, 5);

state = enqueue(emptyState(), Array.from({ length: maxEntries }, (_, index) =>
    exclusionEntry(String(index), `https://${index}.example/`, 'a', 1000)
), 3000);
state.outbox.forEach((entry, index) => { entry.addedAt += index; });
state = enqueue(state, [
    exclusionEntry('withdrawal', 'https://0.example/', 'a', 4000),
    exclusionEntry('replacement', 'https://1.example/', 'a', 4000),
    exclusionEntry('older', 'https://0.example/', 'a', 2000),
    exclusionEntry('overflow', 'https://overflow.example/', 'a', 4000),
], 4000);
assert.deepEqual(state.outbox.slice(-3).map(entry => entry.id), [ 'withdrawal', 'replacement', 'overflow' ],
    'Fresh replacements move to the tail, including multiple replacements in one enqueue');
assert.equal(state.outbox.some(entry => entry.id === '2'), false, 'Evict the oldest remaining observation');
assert.equal(state.discarded, 1);
// Retry rotation must not make an old blocked entry younger than a withdrawal.
state.outbox.push(state.outbox.shift());
state = enqueue(state, [ exclusionEntry('overflow-again', 'https://another.example/', 'a', 5000) ], 5000);
assert(state.outbox.some(entry => entry.id === 'withdrawal'));
assert.equal(state.outbox.some(entry => entry.id === '3'), false);
assert.equal(state.discarded, 2);

state = emptyState();
state = enqueue(state, Array.from({ length: 25 }, (_, index) =>
    exclusionEntry(String(index), `https://${index}.example/`, index === 1 ? 'b' : 'a')
), 4000);
const batch = nextBatch(state);
assert.equal(batch.entries.length, 20);
assert(batch.entries.every(entry => entry.producer.extension_release === 'test-a'));
assert.equal(batch.payload.schema, 2);
assert.deepEqual(batch.payload.exclusions.map(entry => entry.submission_id), batch.entries.map(entry => entry.id));
assert.deepEqual(batch.payload.exclusions.map(entry => entry.result.url), batch.entries.map(entry => entry.url));
state = enqueue(emptyState(), Array.from({ length: maxBatchEntries }, (_, index) =>
    exclusionEntry(String(index), `https://${index}.example/${'x'.repeat(1800)}`)
), 4000);
const byteBoundBatch = nextBatch(state);
assert(byteBoundBatch.entries.length > 0 && byteBoundBatch.entries.length < maxBatchEntries);
assert(new TextEncoder().encode(JSON.stringify(byteBoundBatch.payload)).length <= maxBatchBytes);

const capture = {
    verdict: 'candidate',
    original_url: 'https://example.com/article',
    observed_at: new Date(5000).toISOString(),
    document: {
        schema: 1,
        url: 'https://example.com/article',
        title: 'Personal garden',
        body: '🌱'.repeat(20000),
        extraction_version: 'rendered-text-v2',
        truncated: false,
        indexing_directives: { complete: true, meta_robots: [], x_robots_tag: [] },
    },
};
const document = contributionDocument(capture, producer('a'));
assert.equal(document.body, capture.document.body, 'Text beyond the old 32 KiB limit survives');
assert.equal(document.truncated, false);
const corporateCapture = { ...capture, source_categories: [ 'commercial_corporate' ] };
assert.equal(contributionDocument(corporateCapture, producer('a')), undefined);
assert.equal(contributionObservation(corporateCapture, producer('a')), undefined,
    'Showing a company result does not permit contributing its text');
const corporateExclusion = contributionObservation({ ...corporateCapture,
    verdict: 'exclude', reasons: [ { kind: 'advertising', list: 'fixture' } ],
}, producer('a'));
assert.equal(corporateExclusion.document, undefined);
assert.equal(corporateExclusion.decision.reasons[0].kind, 'advertising',
    'Independent page exclusions remain shareable on company pages');
const nulText = contributionObservation({ ...capture,
    result_title: '\0Result\0 title', result_description: 'Result\0 description\0',
    document: { ...capture.document, title: '\0Page\0 title', body: '\0Page\0 body\0' },
}, producer('a'));
assert.equal(nulText.document.title, 'Page title');
assert.equal(nulText.document.body, 'Page body');
assert.equal(nulText.document.truncated, false);
assert.equal(nulText.result.title, 'Result title');
assert.equal(nulText.result.description, 'Result description');
assert.equal(contributionObservation({ ...capture,
    document: { ...capture.document, body: '\0\0' },
}, producer('a')), undefined, 'NUL-only text cannot become an empty indexed document');
assert(new TextEncoder().encode(JSON.stringify({
    schema: 2, producer: producer('a'), document,
})).length <= maxDocumentBytes);
assert.equal(maxBatchBytes, 32 * 1024);
assert.equal(maxDocumentBodyBytes, 128 * 1024);
assert.equal(maxDocumentBytes, 160 * 1024);
assert.equal(maxOutboxBytes, 4 * 1024 * 1024);
const payloadBytes = payload => new TextEncoder().encode(JSON.stringify(payload)).length;
for ( const [ body, truncated, expected ] of [
    [ 'x'.repeat(maxDocumentBodyBytes), false, 'x'.repeat(maxDocumentBodyBytes) ],
    [ 'x'.repeat(maxDocumentBodyBytes + 1), false, 'x'.repeat(maxDocumentBodyBytes) ],
    [ 'x'.repeat(maxDocumentBodyBytes - 1) + '\u{1f331}', false, 'x'.repeat(maxDocumentBodyBytes - 1) ],
    [ '\u{1f331}'.repeat(maxDocumentBodyBytes / 4 + 1), false, '\u{1f331}'.repeat(maxDocumentBodyBytes / 4) ],
    [ 'Already cut', true, 'Already cut' ],
] ) {
    const observation = contributionObservation({ ...capture,
        document: { ...capture.document, body, truncated },
    }, producer('a'));
    const batch = nextBatch(enqueue(emptyState(), [{ id: 'bounded', ...observation }], 5000));
    assert.equal(batch.payload.document.body, expected);
    assert.equal(batch.payload.document.truncated, truncated || body !== expected);
    assert(payloadBytes(batch.payload) <= maxDocumentBytes);
}
const escapedBody = '"\\\n\u{1f331}'.repeat(18000);
const escaped = contributionObservation({ ...capture,
    result_title: '\u{1f331}'.repeat(512), result_description: '\u6c34'.repeat(1024),
    document: { ...capture.document, body: escapedBody },
}, producer('a'));
const escapedPayload = nextBatch(enqueue(emptyState(), [{ id: 'x'.repeat(128), ...escaped }], 5000)).payload;
assert.equal(escaped.document.truncated, true, 'JSON escaping must also mark truncation');
assert(escaped.document.body.isWellFormed());
assert(escapedBody.startsWith(escaped.document.body));
assert(new TextEncoder().encode(escaped.document.body).length < maxDocumentBodyBytes);
assert(payloadBytes(escapedPayload) <= maxDocumentBytes);
const nextCharacter = Array.from(escapedBody.slice(escaped.document.body.length))[0];
assert(payloadBytes({ ...escapedPayload, document: {
    ...escaped.document, body: escaped.document.body + nextCharacter,
} }) > maxDocumentBytes, 'Keep the longest Unicode prefix that fits the entire request');
assert.equal(contributionDocument({ ...capture, document: {
    ...capture.document, body: 'text',
} }, producer('a'), { extra: 'x'.repeat(maxDocumentBytes) }), undefined);
assert.equal(contributionObservation({ ...capture, verdict: 'exclude' }, producer('a')), undefined);
assert.equal(contributionObservation({ ...capture, verdict: 'uninspected' }, producer('a')), undefined,
    'A list-only Social decision is never an inspected page contribution');
assert.equal(contributionObservation({ ...capture, document: {
    ...capture.document, url: 'https://example.com/article?secret=1',
} }, producer('a')).document.url, 'https://example.com/article?secret=1');
const redirectedCapture = contributionObservation({ ...capture,
    original_url: 'http://example.com/article',
    url: 'https://example.com/previous',
}, producer('a'));
assert.equal(redirectedCapture.result.url, 'http://example.com/article');
assert.equal(redirectedCapture.url, capture.document.url);
assert.equal(redirectedCapture.document.url, capture.document.url);
for ( const verdict of [ 'candidate', 'exclude' ] ) {
    const redirects = [ 'first', 'second' ].map(id => ({
        id,
        ...contributionObservation({ ...capture, verdict,
            original_url: `https://${id}.example/link`,
            final_url: capture.document.url,
            reasons: verdict === 'exclude' ? [ { kind: 'advertising' } ] : [],
        }, producer('a')),
    }));
    let queue = enqueue(emptyState(), redirects, 5000);
    queue = sanitizeState(JSON.parse(JSON.stringify(queue)), 5000);
    assert.deepEqual(queue.outbox.map(entry => entry.result.url), redirects.map(entry => entry.result.url),
        'Distinct redirect sources survive enqueue and restart even with a shared destination');
    assert(queue.outbox.every(entry => entry.url === capture.document.url));
    const newer = { id: 'updated-source', ...contributionObservation({ ...capture, verdict,
        original_url: redirects[0].result.url,
        final_url: 'https://changed.example/page',
        document: { ...capture.document, url: 'https://changed.example/page' },
        reasons: verdict === 'exclude' ? [ { kind: 'advertising' } ] : [],
    }, producer('a')) };
    queue = enqueue(queue, [ newer ], 6000);
    assert.deepEqual(queue.outbox.map(entry => entry.id), [ 'second', 'updated-source' ],
        'A changed destination replaces only the observation from the same source');
    assert.equal(queue.outbox.at(-1).url, 'https://changed.example/page');
    assert.equal(queue.discarded, 0);
    if ( verdict === 'exclude' ) {
        const sent = nextBatch(queue).payload.exclusions;
        assert.deepEqual(sent.map(entry => entry.result.url), queue.outbox.map(entry => entry.result.url));
        assert.equal(sent.at(-1).decision.final_url, newer.url);
    }
}
const captureWithoutOriginal = contributionObservation({ ...capture,
    original_url: undefined,
}, producer('a'));
assert.equal(captureWithoutOriginal.result.url, capture.document.url);
assert.equal(captureWithoutOriginal.document.url, capture.document.url);
assert.equal(contributionObservation({ ...capture, document: {
    ...capture.document, url: 'http://localhost/private',
} }, producer('a')), undefined, 'A shareable result cannot rescue an unshareable document');
for ( const directives of [
    undefined, null, {},
    { complete: false, meta_robots: [], x_robots_tag: [] },
    { complete: true, meta_robots: null, x_robots_tag: [] },
    { complete: true, meta_robots: [], x_robots_tag: null },
    { complete: true, meta_robots: [ null ], x_robots_tag: [] },
    { complete: true, meta_robots: [], x_robots_tag: [ 1 ] },
    { meta_robots: [ 'noindex' ], x_robots_tag: [] },
    { complete: 'false', meta_robots: [ 'noindex' ], x_robots_tag: [] },
    { complete: false, meta_robots: [ 'noindex' ], x_robots_tag: null },
    { complete: false, meta_robots: [ 'noindex' ], x_robots_tag: [ 1 ] },
    { complete: false, meta_robots: [ 'index, follow' ], x_robots_tag: [] },
    { complete: false, meta_robots: [], x_robots_tag: [ 'googlebot: noindex, none' ] },
] ) {
    assert.equal(contributionDocument({ ...capture, document: {
        ...capture.document, indexing_directives: directives,
    } }, producer('a')), undefined);
}
for ( const directives of [
    { complete: true, meta_robots: [ 'noindex, follow' ], x_robots_tag: [] },
    { complete: true, meta_robots: [ '\tnoindex\f' ], x_robots_tag: [] },
    { complete: true, meta_robots: [], x_robots_tag: [ 'queree: noindex' ] },
] ) {
    const noindex = contributionDocument({ ...capture, document: {
        ...capture.document, indexing_directives: directives,
    } }, producer('a'));
    assert.equal(noindex.body, '');
    assert.equal(noindex.title, '');
}
for ( const directives of [
    { complete: false, meta_robots: [ 'noindex, follow' ], x_robots_tag: [] },
    { complete: false, meta_robots: [ 'NONE' ], x_robots_tag: [] },
    { complete: false, meta_robots: [], x_robots_tag: [ 'noindex' ] },
    { complete: false, meta_robots: [], x_robots_tag: [ 'googlebot: index, queree: none' ] },
    { complete: false, meta_robots: [], x_robots_tag: [ 'max-snippet: 50, noindex' ] },
] ) {
    const source = { ...capture.document, indexing_directives: directives };
    const observation = contributionObservation({ ...capture, document: source }, producer('a'));
    assert.equal(observation.document.title, '');
    assert.equal(observation.document.body, '');
    assert.deepEqual(observation.document.indexing_directives,
        { complete: true, meta_robots: [ 'noindex' ], x_robots_tag: [] },
        'Incomplete captures carry only conclusive withdrawal evidence');
    assert.equal(source.indexing_directives.complete, false, 'The capture is not relabeled complete');
    assert.equal(source.body, capture.document.body, 'The original capture is not mutated');
    const queued = enqueue(emptyState(), [{ id: 'noindex', ...observation }], 5000);
    const payload = nextBatch(sanitizeState(queued, 5000)).payload;
    assert.deepEqual(payload.document, observation.document,
        'The text-free withdrawal survives queue persistence and upload serialization');
}
for ( const separator of [ '\uFEFF', '\x1c', '\x1d', '\x1e', '\x1f' ] ) {
    const document = contributionDocument({ ...capture, document: {
        ...capture.document, indexing_directives: {
            complete: true, meta_robots: [ `follow${separator}noindex` ], x_robots_tag: [],
        },
    } }, producer('a'));
    assert.notEqual(document.body, '', 'Robots tokens use the same ASCII separators on both sides');
}
assert.equal(normalizeSharedReason({ kind: 'advertising', rule: 'a'.repeat(255) + '\u{1F680}' }).rule,
    'a'.repeat(255), 'A truncated reason must remain valid Unicode');
assert.equal(normalizeSharedReason({ kind: 'advertising', rule: '\uD800' }).rule, '\uFFFD');
{
    const malware = contributionObservation({
        verdict: 'exclude', original_url: 'https://page.example/',
        observed_at: new Date(5000).toISOString(),
        reasons: [ { kind: 'malware', request_url: 'https://bad.example/payload.js', rule: '||bad.example^' } ],
    }, producer('a'));
    assert.equal(malware.document, undefined, 'Malware withdrawals contain no page text');
    assert.equal(malware.decision.reasons[0].kind, 'malware');
    assert.equal(normalizeSharedReason(malware.decision.reasons[0]), undefined,
        'A malware withdrawal must not become a reusable shared verdict');
    const queued = enqueue(emptyState(), [{ id: 'malware', ...malware }], 5000);
    assert.equal(nextBatch(sanitizeState(queued, 5000)).payload.exclusions[0].decision.reasons[0].kind, 'malware');
}
assert(contributionDocument({ ...capture, document: {
    ...capture.document,
    indexing_directives: {
        complete: true, meta_robots: [], x_robots_tag: [ 'googlebot: noindex' ],
    },
} }, producer('a')));
state = emptyState();
const captured = contributionObservation(capture, producer('a'));
for ( const single_domain of [ true, false ] ) {
    const measured = contributionObservation({ ...capture, single_domain }, producer('a'));
    assert.equal(measured.decision.single_domain, single_domain);
    assert.equal(Object.hasOwn(measured.document, 'single_domain'), false);
    const queued = enqueue(emptyState(), [{ id: 'measured', ...measured }], 5000);
    const restored = sanitizeState(queued, 5000);
    assert.equal(nextBatch(restored).payload.decision.single_domain, single_domain);
    queued.outbox[0].decision.single_domain = 'true';
    assert.equal(sanitizeState(queued, 5000).outbox.length, 0);
}
assert.equal(Object.hasOwn(captured.decision, 'single_domain'), false);
state = enqueue(state, [{
    id: 'document', ...captured,
}], 5000);
assert.equal(nextBatch(state).payload.schema, 2);
assert.equal(nextBatch(state).payload.submission_id, 'document');
assert.equal(nextBatch(sanitizeState(JSON.parse(JSON.stringify(state)), 5000)).payload.submission_id, 'document');
assert.deepEqual(nextBatch(state).payload.document, captured.document);
for ( const id of [ '', 'bad id', 'x'.repeat(129), '\u6c34' ] ) {
    assert.equal(sanitizeState({ ...state, outbox: [ { ...state.outbox[0], id } ] }, 5000).outbox.length, 0);
}
state = enqueue(emptyState(), Array.from({ length: 20 }, (_, index) => {
    const url = `https://${index}.example/`;
    return { id: String(index), ...contributionObservation({
        ...capture, original_url: url, document: { ...capture.document, url },
    }, producer('a')) };
}), 7000);
assert.equal(state.outbox.length, 20);
assert.equal(state.discarded, 0);
const fullPages = Array.from({ length: 40 }, (_, index) => {
    const url = `https://${index}.example/`;
    return { id: String(index), ...contributionObservation({
        ...capture, original_url: url,
        document: { ...capture.document, url, body: 'x'.repeat(maxDocumentBodyBytes) },
    }, producer('a')) };
});
const boundedOutbox = enqueue(emptyState(), fullPages, 7000);
assert(boundedOutbox.discarded > 0);
assert.equal(boundedOutbox.outbox.length + boundedOutbox.discarded, fullPages.length);
assert(payloadBytes(boundedOutbox.outbox) <= maxOutboxBytes);
assert(payloadBytes([ fullPages[boundedOutbox.discarded - 1], ...boundedOutbox.outbox ]) > maxOutboxBytes);
assert.equal(boundedOutbox.outbox.at(-1).id, '39', 'Discard oldest pages, retaining fresh captures');

const excluded = contributionObservation({
    verdict: 'exclude', original_url: 'https://example.com/page?id=1#/chapter',
    observed_at: new Date().toISOString(),
    reasons: [{ kind: 'advertising', rule: '||ads.example^', request_url: 'https://ads.example/pixel?token=fictional' }],
    shared_compatibility: { advertising: `sha256:${'a'.repeat(64)}` },
}, producer('a'));
assert.equal(excluded.document, undefined);
assert.equal(contributionObservation({
    verdict: 'exclude', original_url: 'https://example.com/',
    observed_at: new Date().toISOString(), single_domain: true,
    reasons: [ { kind: 'advertising' } ],
}, producer('a')).decision.single_domain, true);
const invalidExclusion = enqueue(emptyState(), [{
    id: 'invalid', ...excluded, decision: { ...excluded.decision, single_domain: 'false' },
}], 5000);
assert.equal(sanitizeState(invalidExclusion, 5000).outbox.length, 0);
for ( const verdict of [ 'candidate', 'exclude' ] ) {
    for ( const flag of [ undefined, false, true ] ) {
        const shopping_evidence = { software: false, product_offer: true, purchase: verdict === 'exclude' };
        const observation = contributionObservation({
            ...capture, verdict, observed_at: new Date(5000).toISOString(),
            reasons: verdict === 'exclude' ? [ { kind: 'commercial_store' } ] : [],
            single_domain: flag, shopping_signals: flag, checks_complete: flag, shopping_evidence,
        }, producer('a'));
        const queued = enqueue(emptyState(), [ { id: `${verdict}-${flag}`, ...observation } ], 5000);
        const batch = nextBatch(sanitizeState(JSON.parse(JSON.stringify(queued)), 5000));
        const decision = verdict === 'candidate' ? batch.payload.decision : batch.payload.exclusions[0].decision;
        assert.equal(Object.hasOwn(decision, 'referral_signals'), false);
        assert.deepEqual(decision.shopping_evidence, shopping_evidence);
        for ( const field of [ 'single_domain', 'shopping_signals', 'checks_complete' ] ) {
            assert.equal(decision[field], flag);
            assert.equal(Object.hasOwn(decision, field), flag !== undefined);
        }
        if ( verdict === 'exclude' ) {
            assert.equal(batch.payload.exclusions[0].document, undefined,
                'Known shopping flags must not admit an excluded store into the index');
        }
    }
}
assert.equal(excluded.result.url, 'https://example.com/page?id=1#/chapter');
assert.deepEqual(excluded.decision.reasons, [{ kind: 'advertising', rule: '||ads.example^', host: 'ads.example' }]);
const invalidReasonHosts = [ '', 'bad_host.example', '-bad.example', 'bad-.example', 'bad..example',
    'ads.example\n', 'ads.example/path', 'b\u00fccher.example', '[invalid]', '[::1', '[fe80::1%25eth0]',
    `${'a'.repeat(64)}.example`, `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`,
];
for ( const metadata of [
    ...invalidReasonHosts.map(host => ({ matched_hostname: host })),
    ...[ 'https://bad_host.example/pixel', 'https://-bad.example/pixel', 'https://bad-.example/pixel',
        'https://bad..example/pixel', `https://${'a'.repeat(64)}.example/pixel`, 'not a URL',
    ].map(url => ({ request_url: url })),
] ) {
    const entry = contributionObservation({
        verdict: 'exclude', original_url: 'https://example.com/page', observed_at: new Date().toISOString(),
        reasons: [ { kind: 'advertising', rule: '||ads.example^', list: 'easylist', ...metadata } ],
    }, producer('a'));
    assert.ok(entry, 'Bad optional request metadata must not discard the page exclusion');
    assert.deepEqual(entry.decision.reasons, [ { kind: 'advertising', rule: '||ads.example^', list: 'easylist' } ]);
}
for ( const host of [ 'ADS.Example.', 'router.lan', 'printer', '127.0.0.1', '[::1]', '[2001:0db8:0:0:0:0:0:1]' ] ) {
    const entry = contributionObservation({
        verdict: 'exclude', original_url: 'https://example.com/page', observed_at: new Date().toISOString(),
        reasons: [ { kind: 'advertising', matched_hostname: host } ],
    }, producer('a'));
    assert.equal(entry.decision.reasons[0].host, host, 'Preserve request evidence allowed by the server');
}
const redirectExclusion = {
    verdict: 'exclude', original_url: 'https://forwarder.example/link',
    url: 'https://previous.example/page',
    observed_at: new Date(5000).toISOString(),
    reasons: [ { kind: 'advertising' } ],
};
for ( const final_url of [
    'https://destination.example/%GG',
    `https://destination.example/${'x'.repeat(2100)}`,
    'http://intranet/', 'http://192.168.1.1/',
    'http://localhost/', 'http://router.local/',
    'https://user:password@destination.example/',
    'file:///private', '', null,
] ) {
    assert.equal(contributionObservation({ ...redirectExclusion, final_url }, producer('a')),
        undefined, `Unshareable destination must not exclude the result or previous URL: ${final_url}`);
}
const redirectedExclusion = contributionObservation({ ...redirectExclusion,
    final_url: 'https://destination.example/current?id=1#/chapter',
}, producer('a'));
assert.equal(redirectedExclusion.url, 'https://destination.example/current?id=1#/chapter');
assert.equal(redirectedExclusion.decision.final_url, redirectedExclusion.url);
assert.deepEqual(redirectedExclusion.result, { url: redirectExclusion.original_url });
const upfrontExclusion = contributionObservation({ ...redirectExclusion,
    url: undefined,
}, producer('a'));
assert.equal(upfrontExclusion.url, redirectExclusion.original_url);
assert.equal(Object.hasOwn(upfrontExclusion.decision, 'final_url'), false);
const blockedExclusion = contributionObservation(redirectExclusion, producer('a'));
assert.equal(blockedExclusion.url, redirectExclusion.url);
const adult = contributionObservation({
    verdict: 'exclude', original_url: 'https://clean.example/article',
    url: 'https://listed.example/current?id=7', final_url: 'https://listed.example/current?id=7',
    observed_at: new Date().toISOString(),
    result_title: 'Must not send', result_description: 'Must not send',
    document: { url: 'https://old.example/previous', title: 'Must not send', body: 'Must not send' },
    reasons: [ { kind: 'adult_domain', list: 'hagezi_nsfw', matched_hostname: 'listed.example' } ],
    shared_compatibility: { adult_domain: `sha256:${'c'.repeat(64)}` },
    deterministic_profile: { adult_lists: [ {
        name: 'hagezi_nsfw', sha256: 'f3f3d79ec8c0ee23572469930a8113b86451abe97140f9d531f04ed366f419d6',
        retrieved_at: 'Must not send',
    } ], engine: 'Must not send' },
}, producer('a'));
assert.equal(adult.url, 'https://listed.example/current?id=7');
assert.deepEqual(adult.result, { url: 'https://clean.example/article' });
assert.equal(adult.decision.final_url, adult.url);
assert.deepEqual(adult.decision.reasons, [ {
    kind: 'adult_domain', list: 'hagezi_nsfw', host: 'listed.example',
} ]);
assert.equal(adult.decision.compatibility.adult_domain, `sha256:${'c'.repeat(64)}`);
assert.deepEqual(adult.decision.sender_profile, { adult_lists: [ {
    name: 'hagezi_nsfw', sha256: 'f3f3d79ec8c0ee23572469930a8113b86451abe97140f9d531f04ed366f419d6',
} ] });
assert.equal(adult.document, undefined);
assert.equal(JSON.stringify(adult).includes('Must not send'), false);
assert.equal(contributionObservation({ ...adult, cached: true }, producer('a')), undefined);
assert.equal(contributionObservation({ ...adult, server_sourced: true }, producer('a')), undefined);
const adultBatch = nextBatch(enqueue(emptyState(), [ { ...adult, id: 'adult' } ], Date.now()));
assert.equal(adultBatch.payload.schema, 2);
assert.equal(adultBatch.payload.exclusions[0].decision.reasons[0].kind, 'adult_domain');
assert.equal(adultBatch.payload.exclusions[0].document, undefined);
assert.equal(contributionObservation({ ...capture, cached: true }, producer('a')), undefined);
assert.equal(contributionObservation({ ...capture, server_sourced: true }, producer('a')), undefined);
state = enqueue(emptyState(), [
    { ...excluded, id: 'excluded' },
    { ...excluded, id: 'another', url: 'https://example.com/another', result: { url: 'https://example.com/another' } },
], Date.now());
assert.equal(nextBatch(state).payload.exclusions.length, 2);

const observationTime = Date.UTC(2026, 10, 4, 12);
const newerExclusion = {
    ...excluded, id: 'newer-exclusion',
    decision: { ...excluded.decision, observed_at: new Date(observationTime).toISOString() },
};
const olderPass = {
    id: 'older-pass',
    ...contributionObservation({
        ...capture, original_url: newerExclusion.url,
        document: { ...capture.document, url: newerExclusion.url },
        observed_at: new Date(observationTime - 1).toISOString(),
    }, producer('a')),
};
state = enqueue(emptyState(), [ newerExclusion ], observationTime);
state = enqueue(state, [ olderPass ], observationTime + 1000);
assert.equal(state.outbox[0].id, 'newer-exclusion',
    'An older captured pass must not replace a newer queued exclusion');
assert.equal(state.outbox[0].addedAt, observationTime);
assert.equal(nextBatch(state).payload.exclusions[0].decision.verdict, 'exclude');
const equalPass = {
    ...olderPass, id: 'equal-pass',
    decision: { ...olderPass.decision, observed_at: newerExclusion.decision.observed_at },
};
state = enqueue(state, [ equalPass ], observationTime + 2000);
assert.equal(state.outbox[0].id, 'equal-pass', 'Equal timestamps still replace the queued entry');
state = enqueue(state, [ newerExclusion ], observationTime + 3000);
assert.equal(state.outbox[0].id, 'newer-exclusion', 'Equal-time exclusions can replace captures too');
const newerPass = {
    ...olderPass, id: 'newer-pass',
    decision: { ...olderPass.decision, observed_at: new Date(observationTime + 1).toISOString() },
};
state = enqueue(state, [ newerPass ], observationTime + 4000);
assert.equal(state.outbox[0].id, 'newer-pass');
state = enqueue(state, [ newerExclusion ], observationTime + 5000);
assert.equal(state.outbox[0].id, 'newer-pass', 'Older exclusions cannot replace newer captures either');

const persisted = { ...captured, id: 'captured', addedAt: observationTime };
const persistedExclusion = { ...adult, id: 'adult', addedAt: observationTime };
const malformed = [
    null, {},
    { id: 'retired', url: captured.url, producer: producer('a'), addedAt: observationTime },
    { ...persisted, id: '' },
    { ...persistedExclusion, url: '' },
    { ...persisted, producer: {} },
    { ...persisted, result: undefined },
    { ...persisted, decision: undefined },
    { ...persisted, decision: { ...persisted.decision, observed_at: 'invalid' } },
    { ...persisted, document: undefined },
    { ...persisted, document: { ...persisted.document, schema: 2 } },
    { ...persistedExclusion, document: captured.document },
    { ...persistedExclusion, decision: { ...adult.decision, verdict: 'unresolved' } },
    { ...persistedExclusion, decision: { ...adult.decision, reasons: [] } },
    { ...persistedExclusion, decision: { ...adult.decision, reasons: [ null ] } },
];
state = sanitizeState({
    consent: true, key: `qk_${'x'.repeat(43)}`,
    discarded: 3,
    outbox: [ ...malformed, persisted, persistedExclusion ],
}, observationTime);
assert.deepEqual(state.outbox, [ persisted, persistedExclusion ],
    'Loading discards unsupported shapes without changing current queued source evidence');
assert.equal(state.consent, true);
assert.equal(state.key, `qk_${'x'.repeat(43)}`);
assert.equal(state.discarded, 3 + malformed.length, 'Invalid entries add to the existing discard count');
assert.equal(sanitizeState(state, observationTime).discarded, state.discarded,
    'Retained entries must not be counted as discarded on reload');
assert.equal(nextBatch(state).entries.length, 1, 'Documents still upload individually');
state.outbox.reverse();
assert.equal(nextBatch(state).payload.exclusions.length, 1, 'Exclusion batches skip captured documents');
console.log('Passed: bounded document and exclusion contribution queue');
