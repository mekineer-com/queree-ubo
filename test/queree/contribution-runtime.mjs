import { adultSourceProfile, canonicalPageURL, sharedReasonKinds } from '../../src/js/queree/decision-cache.js';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers';
import vm from 'node:vm';
const root = fileURLToPath(new URL('../..', import.meta.url));
let stored = JSON.stringify({ schema: 1, consent: false, key: 'qk_' + 'a'.repeat(43), outbox: [] });
let releaseDigest, signalDigest;
let holdDigest = true;
const digestStarted = new Promise(resolve => { signalDigest = resolve; });
const sent = [];
const lookupRequests = [];
let sharedShopping;
let sharedFlags = {};
const sharedStamp = new Date(Date.now() - 170 * 864e5).toISOString();
let sharedKind = 'advertising';
let nextId = 0;
let uploadStatus = 202;
let retryAlarm;
let permissionRemoved;
let uploadReply;
let holdUpload = false;
let uploadSignal;
const ctx = {
    URL, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout, canonicalPageURL, adultSourceProfile,
    decisionPolicyRevision: 'policy-3',
    crypto: {
        randomUUID: () => `temporary-id-${++nextId}`,
        subtle: { digest: () => {
            if ( holdDigest === false ) return Promise.resolve(new ArrayBuffer(32));
            signalDigest(); return new Promise(resolve => { releaseDigest = resolve; });
        } },
    },
    browser: { storage: { local: {
        get: async key => { ctx._read = JSON.stringify({ [key]: JSON.parse(stored) }); return vm.runInContext('JSON.parse(_read)', ctx); },
        set: async value => { stored = JSON.stringify(value.quereeContributionState); },
    } }, permissions: {
        getAll: async () => ({ data_collection: [
            'browsingActivity', 'authenticationInfo', 'technicalAndInteraction', 'websiteContent',
        ] }),
        remove: async () => true,
        onRemoved: { addListener(listener) { permissionRemoved = listener; } },
    } },
    vAPI: {
        app: { version: '2.0.0' },
        alarms: { create() {}, clear() {}, onAlarm: { addListener(listener) { retryAlarm = listener; } } },
    },
    µb: { isReadyPromise: new Promise(() => {}) },
    fetch: async (_url, options) => {
        const payload = JSON.parse(options.body);
        if ( _url.endsWith('/exclusions') ) {
            assert.equal(payload.schema, 1);
            lookupRequests.push(payload);
            if ( sharedShopping !== undefined ) {
                return { ok: true, text: async () => JSON.stringify({ schema: 1, exclusions: [{
                    url: payload.urls[0], observed_at: new Date().toISOString(),
                    verdict: 'candidate', shopping_signals: sharedShopping, single_domain: false,
                }] }) };
            }
            return { ok: true, text: async () => JSON.stringify({ schema: 1, exclusions: [{
                url: payload.urls[0], observed_at: sharedStamp, reasons: [{ kind: sharedKind }], ...sharedFlags,
            }] }) };
        }
        assert.equal(payload.schema, 2);
        sent.push(payload);
        if ( holdUpload ) {
            uploadSignal = options.signal;
            return new Promise((_resolve, reject) => {
                uploadSignal.addEventListener('abort', () =>
                    reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
                );
            });
        }
        if ( uploadStatus !== 202 ) {
            return { ok: false, status: uploadStatus, headers: { get: () => '60' }, json: async () => ({}) };
        }
        if ( uploadReply !== undefined ) {
            return { ok: true, status: 202, json: async () => uploadReply };
        }
        if ( payload.exclusions ) {
            return { ok: true, status: 202, json: async () => ({ schema: 2, results: payload.exclusions.map((_,index)=>({ index, status:'acknowledged' })) }) };
        }
        if ( payload.document.url.endsWith('/poison') ) {
            return { ok: false, status: 400, json: async () => ({ schema: 1, error: 'document' }) };
        }
        return { ok: true, status: 202, json: async () => ({ schema: 2, status: 'acknowledged' }) };
    },
};
const coreSource = readFileSync(root + '/src/js/queree/contribution-core.js', 'utf8').replace(/^import .*\n/gm, '').replace(/^export /gm, '');
const source = readFileSync(root + '/src/js/queree/contribution.js', 'utf8');
// Run the real module body, replacing only its browser/background dependencies.
function loadRuntime(context) {
    context.sharedReasonKinds = sharedReasonKinds;
    vm.createContext(context);
    vm.runInContext(coreSource, context);
    vm.runInContext(source.slice(source.indexOf('const endpoint =')).replace(/^export /gm, '') +
        '\nthis.api = { setContributionConsent, setContributionKey, enqueueObservations, getContributionEpoch, getContributionState, lookupSharedObservations };', context);
}
async function waitFor(predicate, message) {
    for ( let i = 0; i < 200; i++ ) {
        if ( predicate() ) { return; }
        await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.fail(`Timed out: ${message}`);
}
loadRuntime(ctx);
await ctx.api.setContributionConsent(true);
const decision = {
    verdict: 'candidate', original_url: 'https://example.net/page',
    observed_at: new Date().toISOString(),
    profile: { version: 'a'.repeat(64) }, deterministic_profile: {},
    contribution_epoch: ctx.api.getContributionEpoch(),
    document: {
        schema: 1, url: 'https://example.net/page', title: 'Fictional', body: 'Private test text',
        extraction_version: 'rendered-text-v2', truncated: false,
        indexing_directives: { complete: true, meta_robots: [], x_robots_tag: [] },
    },
};
ctx._input = JSON.stringify([decision]);
const pending = ctx.api.enqueueObservations(vm.runInContext('JSON.parse(_input)', ctx));
await digestStarted;
await ctx.api.setContributionConsent(false);
await ctx.api.setContributionConsent(true);
holdDigest = false;
releaseDigest(new ArrayBuffer(32));
await pending;
assert.equal(JSON.parse(stored).outbox.length, 0);
assert.equal(sent.length, 0);
await ctx.api.enqueueObservations(vm.runInContext('JSON.parse(_input)', ctx));
assert.equal(sent.length, 0);
decision.contribution_epoch = ctx.api.getContributionEpoch();
ctx._input = JSON.stringify([decision]);
await ctx.api.enqueueObservations(vm.runInContext('JSON.parse(_input)', ctx));
for (let i=0; i<100 && sent.length===0; i++) await new Promise(resolve => setTimeout(resolve, 1));
assert.equal(sent.length, 1);
assert.equal(sent[0].document.body, 'Private test text');
console.log('Passed: consent generation: old consent-epoch data is not sent; fresh consent works.');
const poison = structuredClone(decision);
poison.original_url = poison.document.url = 'https://example.net/poison';
const later = structuredClone(decision);
later.original_url = later.document.url = 'https://example.net/later';
ctx._input = JSON.stringify([poison, later]);
await ctx.api.enqueueObservations(vm.runInContext('JSON.parse(_input)', ctx));
for (let i=0; i<100 && sent.length<3; i++) await new Promise(resolve => setTimeout(resolve, 1));
assert.equal(sent.length, 3);
assert.equal(sent[2].document.url, 'https://example.net/later');
assert.equal(JSON.parse(stored).discarded, 1);
console.log('Passed: queue recovery: one rejected document does not block later pages.');
const hits = await ctx.api.lookupSharedObservations(['https://example.net/shared?id=4#/part'], { advertising: `sha256:${'a'.repeat(64)}` });
assert.equal(hits.length, 1);
assert.equal(hits[0].observed_at, sharedStamp);
assert.equal(lookupRequests[0].urls[0], 'https://example.net/shared?id=4#/part');
const adultDecision = {
    ...decision, verdict: 'exclude', original_url: 'https://example.net/clean',
    profile: undefined,
    url: 'https://listed.example/current?id=3', final_url: 'https://listed.example/current?id=3',
    reasons: [ { kind: 'adult_domain', list: 'hagezi_nsfw', matched_hostname: 'listed.example' } ],
    shared_compatibility: { adult_domain: `sha256:${'b'.repeat(64)}` },
    deterministic_profile: { adult_lists: [ {
        name: 'hagezi_nsfw', sha256: 'f3f3d79ec8c0ee23572469930a8113b86451abe97140f9d531f04ed366f419d6',
    } ] },
    result_title: 'Must not send', result_description: 'Must not send',
};
ctx._input = JSON.stringify([adultDecision]);
await ctx.api.enqueueObservations(vm.runInContext('JSON.parse(_input)', ctx));
for (let i=0; i<100 && sent.length<4; i++) await new Promise(resolve => setTimeout(resolve, 1));
assert.equal(sent.length, 4);
assert.equal(sent[3].producer.ad_profile_digest, null, 'An upfront exclusion did not use an ad profile');
assert.equal(sent[3].exclusions[0].decision.final_url, adultDecision.final_url);
assert.equal(sent[3].exclusions[0].decision.reasons[0].kind, 'adult_domain');
assert.equal(sent[3].exclusions[0].decision.compatibility.adult_domain, `sha256:${'b'.repeat(64)}`);
assert.deepEqual(sent[3].exclusions[0].decision.sender_profile, adultDecision.deterministic_profile);
assert.equal(JSON.stringify(sent[3]).includes('Must not send'), false);
assert.equal(JSON.stringify(sent[3]).includes('Private test text'), false);
sharedKind = 'adult_domain';
const adultHits = await ctx.api.lookupSharedObservations([adultDecision.url], adultDecision.shared_compatibility);
assert.equal(adultHits.length, 1);
assert.equal(adultHits[0].observed_at, sharedStamp);
assert.equal(adultHits[0].reasons[0].kind, 'adult_domain');
assert.equal(lookupRequests[1].compatibility.adult_domain, `sha256:${'b'.repeat(64)}`);
for ( const reused of [ { cached: true }, { server_sourced: true } ] ) {
    ctx._input = JSON.stringify([ { ...adultDecision, ...reused, observed_at: sharedStamp } ]);
    await ctx.api.enqueueObservations(vm.runInContext('JSON.parse(_input)', ctx));
}
assert.equal(sent.length, 4, 'Reused adult evidence must not be uploaded as a new observation');
console.log('Passed: adult URL-only upload, compatibility, shared lookup and no re-upload.');

const retryDecision = structuredClone(decision);
retryDecision.original_url = retryDecision.document.url = 'https://example.net/retry';
uploadStatus = 503;
ctx._input = JSON.stringify([retryDecision, adultDecision]);
await ctx.api.enqueueObservations(vm.runInContext('JSON.parse(_input)', ctx));
for (let i=0; i<100 && JSON.parse(stored).lastError !== 'temporary'; i++) await new Promise(resolve => setTimeout(resolve, 1));
const waiting = JSON.parse(stored);
assert.equal(waiting.outbox.length, 2);
assert.equal(waiting.attempts, 1);
assert(waiting.retryAt > Date.now());
ctx.decisionPolicyRevision = 'policy-next-source-data';
uploadStatus = 202;
stored = JSON.stringify({ ...waiting, retryAt: 0 });
retryAlarm({ name: 'quereeContributionRetry' });
for (let i=0; i<100 && JSON.parse(stored).outbox.length; i++) await new Promise(resolve => setTimeout(resolve, 1));
assert.equal(JSON.parse(stored).outbox.length, 0);
assert.equal(sent.length, 7);
assert.deepEqual(sent[4], sent[5], 'Retry preserves the queued capture and its original producer');
assert.deepEqual(sent[6].producer, waiting.outbox[1].producer);
assert.deepEqual(sent[6].exclusions[0].decision, waiting.outbox[1].decision);
assert.equal(sent[5].producer.policy_revision, 'policy-3');
assert.equal(JSON.parse(stored).consent, true);
assert.equal(JSON.parse(stored).key, 'qk_' + 'a'.repeat(43));
console.log('Passed: transient failures and source-policy changes preserve queued captures and exclusions.');

await ctx.api.setContributionConsent(false);
assert.equal((await ctx.api.lookupSharedObservations(['https://example.net/other'], {})).length, 0);
assert.equal(lookupRequests.length, 2);
console.log('Passed: shared lookup preserves observation time and requires opt-in.');

const restartState = {
    schema: 1, consent: true, key: 'qk_' + 'a'.repeat(43),
    outbox: [
        { id: 'page', url: sent[0].document.url, producer: sent[0].producer,
            result: sent[0].result, decision: sent[0].decision,
            document: sent[0].document, addedAt: Date.now() },
        { id: 'exclusion', url: adultDecision.final_url, producer: sent[3].producer,
            ...sent[3].exclusions[0], addedAt: Date.now() },
    ],
};
for ( const interruption of [ 'missing', 'consent', 'permission', 'ready' ] ) {
    let restartStored = JSON.stringify({
        ...restartState, outbox: interruption === 'ready' ? [] : restartState.outbox,
    });
    let resolvePermissions, revokePermission;
    const permissions = ctx.browser.permissions.getAll;
    const restarted = {
        ...ctx,
        browser: { storage: { local: {
            get: async key => { restarted._read = JSON.stringify({ [key]: JSON.parse(restartStored) }); return vm.runInContext('JSON.parse(_read)', restarted); },
            set: async value => { restartStored = JSON.stringify(value.quereeContributionState); },
        } }, permissions: {
            getAll: () => new Promise(resolve => { resolvePermissions = resolve; }),
            remove: async () => true,
            onRemoved: { addListener(listener) { revokePermission = listener; } },
        } },
        vAPI: {
            ...ctx.vAPI,
            alarms: { ...ctx.vAPI.alarms, onAlarm: { addListener() {} } },
        },
        µb: { isReadyPromise: Promise.resolve() },
    };
    loadRuntime(restarted);
    await waitFor(() => resolvePermissions !== undefined, 'startup reaches the permission check');
    if ( interruption === 'consent' ) { await restarted.api.setContributionConsent(false); }
    if ( interruption === 'permission' ) {
        revokePermission({ data_collection: [ 'websiteContent' ] });
        assert.equal(restarted.api.getContributionEpoch(), undefined);
        await restarted.api.getContributionState();
    }
    resolvePermissions(interruption === 'missing' ? { data_collection: [
        'browsingActivity', 'authenticationInfo', 'technicalAndInteraction',
    ] } : await permissions());
    if ( interruption === 'ready' ) {
        for (let i=0; i<100 && restarted.api.getContributionEpoch() === undefined; i++) await new Promise(resolve => setTimeout(resolve, 1));
        assert.notEqual(restarted.api.getContributionEpoch(), undefined);
        assert.equal(JSON.parse(restartStored).consent, true);
        revokePermission({ data_collection: [ 'websiteContent' ] });
        assert.equal(restarted.api.getContributionEpoch(), undefined);
    }
    for (let i=0; i<100 && JSON.parse(restartStored).consent; i++) await new Promise(resolve => setTimeout(resolve, 1));
    await restarted.api.getContributionState();
    assert.equal(JSON.parse(restartStored).consent, false);
    assert.deepEqual(JSON.parse(restartStored).outbox, []);
    assert.equal(JSON.parse(restartStored).key, 'qk_' + 'a'.repeat(43));
    assert.equal(sent.length, 7);
}
console.log('Passed: startup permissions cannot revive revoked consent; a permitted restart still enables contribution.');

const firstExclusion = waiting.outbox[1];
const secondExclusion = {
    ...firstExclusion, id: 'second-exclusion', url: 'https://listed.example/second',
    result: { url: 'https://listed.example/second' },
    decision: { ...firstExclusion.decision, final_url: 'https://listed.example/second' },
};
for ( const [ entries, replies, acknowledged ] of [
    [ [ waiting.outbox[0] ], [ {}, { schema: 1, status: 'acknowledged' },
        { schema: 2, status: 'invalid' } ], { schema: 2, status: 'acknowledged' } ],
    [ [ firstExclusion, secondExclusion ], [ {}, { schema: 2, results: [] },
        { schema: 2, results: [ { index: 0, status: 'acknowledged' } ] },
        { schema: 2, results: [ { index: 0, status: 'acknowledged' }, { index: 0, status: 'invalid' } ] },
        { schema: 2, results: [ { index: 0, status: 'acknowledged' }, { index: 2, status: 'acknowledged' } ] },
        { schema: 2, results: [ { index: 0, status: 'acknowledged' }, { index: 1, status: 'pending' } ] },
    ], { schema: 2, results: [ { index: 1, status: 'invalid' }, { index: 0, status: 'acknowledged' } ] } ],
] ) {
    stored = JSON.stringify({ ...restartState, outbox: entries });
    let attempts = 0;
    for ( const reply of replies ) {
        uploadReply = reply;
        attempts += 1;
        stored = JSON.stringify({ ...JSON.parse(stored), retryAt: 0 });
        await ctx.api.setContributionConsent(true);
        for (let i=0; i<100 && JSON.parse(stored).attempts !== attempts; i++) await new Promise(resolve => setTimeout(resolve, 1));
        const state = JSON.parse(stored);
        assert.equal(state.attempts, attempts);
        assert.equal(state.lastError, 'invalid_response');
        assert.equal(state.discarded, 0, 'Malformed replies are retried, not counted as discarded');
        assert(state.retryAt > Date.now());
        assert.deepEqual(state.outbox, entries, 'Malformed or partial acknowledgements leave the entire batch queued');
    }
    uploadReply = acknowledged;
    stored = JSON.stringify({ ...JSON.parse(stored), retryAt: 0 });
    retryAlarm({ name: 'quereeContributionRetry' });
    for (let i=0; i<100 && JSON.parse(stored).outbox.length; i++) await new Promise(resolve => setTimeout(resolve, 1));
    const state = JSON.parse(stored);
    assert.deepEqual(state.outbox, []);
    assert.equal(state.attempts, 0);
    assert.equal(state.retryAt, 0);
    assert.equal(state.lastError, entries.length === 2 ? 'Some pages could not be contributed' : '');
    assert.equal(state.discarded, entries.length === 2 ? 1 : 0);
}
console.log('Passed: document/batch acknowledgement validation preserves retries and shares successful cleanup.');

holdUpload = true;
ctx._input = JSON.stringify([ { ...decision, contribution_epoch: ctx.api.getContributionEpoch() } ]);
await ctx.api.enqueueObservations(vm.runInContext('JSON.parse(_input)', ctx));
for (let i=0; i<100 && uploadSignal === undefined; i++) await new Promise(resolve => setTimeout(resolve, 1));
assert(uploadSignal);
permissionRemoved({ data_collection: [ 'websiteContent' ] });
assert.equal(ctx.api.getContributionEpoch(), undefined, 'Revocation disables contributions before awaiting storage');
assert.equal(uploadSignal.aborted, true, 'Revocation aborts the in-flight upload synchronously');
for (let i=0; i<100 && JSON.parse(stored).outbox.length; i++) await new Promise(resolve => setTimeout(resolve, 1));
assert.deepEqual(JSON.parse(stored).outbox, []);
assert.equal(JSON.parse(stored).attempts, 0);
assert.equal(JSON.parse(stored).retryAt, 0);
assert.equal(JSON.parse(stored).lastError, '');
console.log('Passed: permission removal aborts an active upload without retrying revoked data.');

holdUpload = false;
await ctx.api.setContributionConsent(true);
for ( const value of [ false, true ] ) {
    sharedShopping = value;
    const observations = await ctx.api.lookupSharedObservations(['https://example.net/shopping'], {
        page_observation: `sha256:${'c'.repeat(64)}`,
    });
    assert.equal(observations.length, 1);
    assert.equal(observations[0].verdict, 'candidate');
    assert.equal(observations[0].shopping_signals, value);
    assert.equal(observations[0].single_domain, false);
    assert.equal(observations[0].reasons, undefined, 'Shopping facts are not intrinsic exclusion reasons');
}
sharedShopping = 'not a boolean';
assert.equal((await ctx.api.lookupSharedObservations(['https://example.net/shopping'], {})).length, 0);
console.log('Passed: shared shopping observations retain both boolean values without becoming exclusions.');
sharedShopping = undefined;
sharedKind = 'commercial_store';
for ( const value of [ undefined, false, true ] ) {
    sharedFlags = value === undefined ? {} : { single_domain: value, shopping_signals: value, checks_complete: value };
    const observations = await ctx.api.lookupSharedObservations(['https://example.net/store'], {});
    assert.equal(observations.length, 1);
    assert.equal(observations[0].verdict, 'exclude');
    assert.equal(observations[0].reasons[0].kind, 'commercial_store');
    for ( const field of [ 'single_domain', 'shopping_signals', 'checks_complete' ] ) {
        assert.equal(observations[0][field], value);
        assert.equal(Object.hasOwn(observations[0], field), value !== undefined);
    }
}
console.log('Passed: shared store exclusions retain optional flags without manufacturing false values.');

function createRuntime(initialState = {}) {
    let saved = JSON.stringify({
        ...restartState, outbox: [], discarded: 0, attempts: 0, retryAt: 0,
        lastError: '', ...initialState,
    });
    let ready, alarm;
    const fixture = {
        now: Date.now(), reads: 0, writes: 0, digests: 0,
        requests: [], alarms: [], cleared: [], removed: [], errors: [], pending: [], pendingErrors: [],
        status: 202, body: undefined, retryAfter: null, invalidJSON: false,
        lookupStatus: 200, holdLookups: false, holdUploads: false,
        lookupReply: undefined, replies: [],
        readError: undefined, writeError: undefined, digestError: undefined,
        get state() { return JSON.parse(saved); },
    };
    const context = {
        URL, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout,
        canonicalPageURL, adultSourceProfile, decisionPolicyRevision: 'policy-3',
        Date: class extends Date { static now() { return fixture.now; } },
        console: { error: (...args) => fixture.errors.push(args) },
        crypto: {
            randomUUID: () => `fixture-id-${++nextId}`,
            subtle: { digest: async () => {
                fixture.digests += 1;
                if ( fixture.digestError ) { throw fixture.digestError; }
                return new ArrayBuffer(32);
            } },
        },
        browser: {
            storage: { local: {
                get: async key => {
                    fixture.reads += 1;
                    if ( fixture.readError ) { throw fixture.readError; }
                    context._read = JSON.stringify({ [key]: JSON.parse(saved) });
                    return vm.runInContext('JSON.parse(_read)', context);
                },
                set: async value => {
                    fixture.writes += 1;
                    if ( fixture.writeError ) { throw fixture.writeError; }
                    if ( fixture.beforeWrite !== undefined ) {
                        await fixture.beforeWrite(value.quereeContributionState);
                    }
                    saved = JSON.stringify(value.quereeContributionState);
                },
            } },
            permissions: {
                getAll: ctx.browser.permissions.getAll,
                remove: async value => { fixture.removed.push(JSON.parse(JSON.stringify(value))); return true; },
                onRemoved: { addListener() {} },
            },
        },
        vAPI: {
            app: ctx.vAPI.app,
            alarms: {
                create: (name, options) => fixture.alarms.push({ name, when: options.when }),
                clear: name => fixture.cleared.push(name),
                onAlarm: { addListener(listener) { alarm = listener; } },
            },
        },
        µb: { isReadyPromise: new Promise(resolve => { ready = resolve; }) },
        fetch: async (url, options) => {
            const payload = JSON.parse(options.body);
            fixture.requests.push({ url, payload, options });
            if ( url.endsWith('/exclusions') ) {
                const status = fixture.lookupStatus;
                const response = { ok: status === 200, status,
                    text: async () => JSON.stringify(fixture.lookupReply?.(payload) ?? { schema: 1, exclusions: [] }) };
                if ( fixture.holdLookups ) {
                    return new Promise(resolve => fixture.pending.push(() => resolve(response)));
                }
                return response;
            }
            const reply = fixture.replies.shift();
            const status = reply?.status ?? fixture.status;
            const body = reply?.body ?? fixture.body ?? (payload.exclusions
                ? { schema: 2, results: payload.exclusions.map((_, index) => ({ index, status: 'acknowledged' })) }
                : { schema: 2, status: 'acknowledged' });
            const invalidJSON = reply?.invalidJSON ?? fixture.invalidJSON;
            const response = {
                ok: status >= 200 && status < 300, status,
                headers: { get: () => fixture.retryAfter },
                json: async () => {
                    if ( invalidJSON ) { throw new SyntaxError('HTML response, not JSON'); }
                    return body;
                },
            };
            // A response can already be in flight when abort/key replacement happens.
            if ( fixture.holdUploads ) {
                return new Promise((resolve, reject) => {
                    fixture.pending.push(() => resolve(response));
                    fixture.pendingErrors.push(reject);
                });
            }
            return response;
        },
    };
    loadRuntime(context);
    return Object.assign(fixture, {
        api: context.api,
        async settle() {
            await new Promise(resolve => setImmediate(resolve));
        },
        async start() { ready(); await fixture.settle(); },
        async fireAlarm(name = 'quereeContributionRetry') {
            alarm({ name }); await fixture.settle();
        },
        async enqueue(value) {
            context._input = JSON.stringify([value]);
            await context.api.enqueueObservations(vm.runInContext('JSON.parse(_input)', context));
            await fixture.settle();
        },
    });
}

{
    const fixture = createRuntime();
    await fixture.start();
    const body = '\u{1f331}'.repeat(128 * 1024 / 4);
    const captured = vm.runInNewContext(readFileSync(
        root + '/src/js/queree/document-capture.js', 'utf8'
    ), {
        TextEncoder,
        document: { contentType: 'text/html', title: 'Fictional long page', body: { innerText: body }, querySelectorAll: () => [] },
        location: { href: decision.document.url },
    });
    for ( const truncated of [ false, true ] ) {
        await fixture.enqueue({ ...decision,
            contribution_epoch: fixture.api.getContributionEpoch(),
            document: { ...captured, truncated },
        });
        const request = fixture.requests.at(-1);
        assert.equal(request.payload.document.body, body, 'The real capture, outbox and pump retain 128 KiB of Unicode');
        assert.equal(request.payload.document.truncated, truncated);
        const bytes = new TextEncoder().encode(request.options.body).length;
        assert(bytes > 32 * 1024 && bytes <= 160 * 1024);
        assert.equal(fixture.state.outbox.length, 0, 'The full document acknowledgement drains the outbox');
    }
    assert.equal(fixture.requests.length, 2);
    const plaintext = vm.runInNewContext(readFileSync(root + '/src/js/queree/document-capture.js', 'utf8'), {
        document: { contentType: 'text/plain', body: { innerText: 'Not an HTML page' } },
    });
    assert.equal(plaintext, undefined);
    await fixture.enqueue({ ...decision, contribution_epoch: fixture.api.getContributionEpoch(), document: plaintext });
    assert.equal(fixture.requests.length, 2, 'A non-HTML document cannot reach the upload pump');
}
console.log('Passed: full-size Unicode captures survive serialization and the actual upload pump.');

{
    const fixture = createRuntime();
    await fixture.start();
    const fresh = { ...decision, contribution_epoch: fixture.api.getContributionEpoch() };
    await fixture.enqueue(fresh);
    await fixture.enqueue({ ...fresh, profile: { version: 'b'.repeat(64) }, deterministic_profile: {} });
    assert.equal(fixture.digests, 1, 'Reuse the constant manifest digest across decisions and ad profiles');
    assert.equal(fixture.requests.at(-1).payload.producer.ad_profile_digest, `sha256:${'b'.repeat(64)}`);
    const changed = { ...fresh, deterministic_profile: { schema: 2 } };
    fixture.digestError = new Error('digest unavailable');
    await assert.rejects(fixture.enqueue(changed), error => error === fixture.digestError);
    assert.equal(fixture.digests, 2, 'A changed manifest must be hashed again');
    fixture.digestError = undefined;
    await fixture.enqueue(changed);
    assert.equal(fixture.digests, 3, 'A failed digest must not poison later contributions');
    await fixture.enqueue({ ...changed, deterministic_profile: { schema: 2 } });
    assert.equal(fixture.digests, 3, 'Equivalent manifests also reuse the digest');
}
console.log('Passed: producer hashing reuses unchanged manifests, refreshes changed data and recovers after failure.');

for ( const key of [ '', 'invalid-key' ] ) {
    const fixture = createRuntime({ key, consent: false });
    const state = await fixture.api.setContributionConsent(true);
    assert.equal(state.consent, false);
    assert.equal(fixture.state.consent, false);
    assert.equal(fixture.api.getContributionEpoch(), undefined);
    await fixture.enqueue({ ...decision, contribution_epoch: undefined });
    assert.equal((await fixture.api.lookupSharedObservations([decision.original_url], {})).length, 0);
    assert.equal(fixture.state.outbox.length, 0);
    assert.equal(fixture.digests, 0, 'No key means no document preparation');
    assert.equal(fixture.requests.length, 0);
}
console.log('Passed: stale-pane consent cannot enable collection or lookup without a valid key.');

const replacementKey = 'qk_' + 'b'.repeat(43);
for ( const [ status, body, error ] of [
    [ 401, undefined, 'authentication' ],
    [ 403, undefined, 'authentication' ],
    [ 429, { schema: 1, error: 'quota_exhausted' }, 'quota_exhausted' ],
] ) {
    const fixture = createRuntime({ outbox: restartState.outbox });
    fixture.status = status;
    fixture.body = body;
    await fixture.api.setContributionConsent(true);
    await fixture.settle();
    assert.equal(fixture.state.lastError, error);
    assert.equal(fixture.api.getContributionEpoch(), undefined);
    assert.equal((await fixture.api.getContributionState()).consent, true, 'Paused consent stays checked so the user can opt out');
    assert.equal(fixture.state.consent, true, 'Pause retains opt-in for a replacement key');
    assert.deepEqual(fixture.state.outbox, restartState.outbox);
    assert.equal(fixture.state.retryAt, 0);
    assert.equal(fixture.state.attempts, 0);
    assert.equal(fixture.alarms.length, 0, 'A permanent key failure must not schedule retries');
    assert(fixture.cleared.includes('quereeContributionRetry'));
    await fixture.enqueue({ ...decision, contribution_epoch: 1 });
    assert.equal((await fixture.api.lookupSharedObservations([decision.original_url], {})).length, 0);
    await fixture.fireAlarm();
    await fixture.api.setContributionConsent(true);
    await fixture.settle();
    assert.equal(fixture.requests.length, 1, 'Alarm and repeated opt-in do not bypass the pause');
    assert.equal(fixture.digests, 0);
    assert.deepEqual(fixture.state.outbox, restartState.outbox);
    fixture.status = 202;
    fixture.body = undefined;
    await fixture.api.setContributionKey(replacementKey);
    await fixture.settle();
    assert.notEqual(fixture.api.getContributionEpoch(), undefined);
    assert.equal(fixture.state.lastError, '');
    assert.equal(fixture.state.outbox.length, 0);
    assert.equal(fixture.requests.length, 3, 'Replacing the key resumes both queued payloads');
    assert(fixture.requests.slice(1).every(request =>
        request.options.headers.Authorization === `Bearer ${replacementKey}`));
    await fixture.enqueue({ ...decision, contribution_epoch: fixture.api.getContributionEpoch() });
    await fixture.api.lookupSharedObservations([decision.original_url], {});
    assert.equal(fixture.digests, 1, 'Collection resumes after replacement');
    assert.equal(fixture.requests.length, 5, 'Fresh uploads and lookups resume after replacement');

    const restarted = createRuntime({ ...restartState, lastError: error, attempts: 2 });
    await restarted.start();
    assert.equal(restarted.api.getContributionEpoch(), undefined);
    const paused = await restarted.api.getContributionState();
    assert.equal(paused.lastError, error);
    assert.equal(paused.consent, true, 'A paused restart retains saved consent independently of the collection epoch');
    await restarted.enqueue({ ...decision, contribution_epoch: 0 });
    await restarted.api.lookupSharedObservations([decision.original_url], {});
    await restarted.fireAlarm();
    assert.equal(restarted.requests.length, 0, 'Persisted key failures stay paused at startup');
    assert.equal(restarted.digests, 0);
    assert.equal(restarted.writes, 0, 'Paused startup and pane reads do not rewrite the outbox');
    assert.deepEqual(restarted.state.outbox, restartState.outbox);
    const optedOut = await restarted.api.setContributionConsent(false);
    assert.equal(optedOut.consent, false);
    assert.equal(optedOut.queued, 0);
    assert.equal(optedOut.hasKey, true, 'Opting out retains the invitation key');
    assert.equal(optedOut.lastError, '');
    assert.equal(restarted.state.consent, false);
    assert.deepEqual(restarted.state.outbox, [], 'Opting out while paused removes persisted waiting text');
    assert.equal(restarted.state.attempts, 0);
    assert.equal(restarted.state.retryAt, 0);
    assert.equal(restarted.state.key, restartState.key);
    assert(restarted.cleared.includes('quereeContributionRetry'));
    assert.equal(restarted.api.getContributionEpoch(), undefined);
    await restarted.fireAlarm();
    await restarted.enqueue({ ...decision, contribution_epoch: 0 });
    await restarted.api.lookupSharedObservations([decision.original_url], {});
    assert.equal(restarted.requests.length, 0, 'Opting out must not resume paused contribution work');
}
console.log('Passed: authentication/quota pauses retain visible consent; replacement resumes work and opting out clears waiting text.');

const lookupURLs = Array.from({ length: 21 }, (_, index) => `https://example.net/lookup-${index}`);
{
    const fixture = createRuntime();
    await fixture.start();
    const longURLs = lookupURLs.map(url => url.padEnd(2048, 'x'));
    await fixture.api.lookupSharedObservations(longURLs, { advertising: `sha256:${'a'.repeat(64)}` });
    assert(fixture.requests.length > 1);
    assert.deepEqual(fixture.requests.flatMap(request => request.payload.urls), longURLs,
        'Oversized lookup groups must split without dropping addresses');
    for ( const request of fixture.requests ) {
        assert(request.payload.urls.length <= 20);
        assert(new TextEncoder().encode(request.options.body).length <= 32 * 1024);
    }
}
console.log('Passed: long lookup addresses are split into requests within the body limit.');

{
    const fixture = createRuntime();
    await fixture.start();
    const longURLs = lookupURLs.map(url => url.padEnd(2048, 'x'));
    const miss = longURLs[3];
    const reasons = Array.from({ length: 8 }, () => ({
        kind: 'advertising', rule: 'r'.repeat(256), list: 'l'.repeat(256),
        host: `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`,
    }));
    const served = [];
    fixture.lookupReply = payload => {
        const reply = { schema: 1, exclusions: [] };
        for ( const url of payload.urls ) {
            if ( url === miss ) { continue; }
            const item = url === longURLs.at(-1)
                ? { url, verdict: 'candidate', shopping_signals: false }
                : { url, reasons };
            item.observed_at = new Date(fixture.now - 864e5).toISOString();
            if ( new TextEncoder().encode(JSON.stringify([ ...reply.exclusions, item ])).length > 30 * 1024 ) {
                reply.truncated = true;
                continue;
            }
            reply.exclusions.push(item);
            served.push(url);
        }
        return reply;
    };
    const hits = await fixture.api.lookupSharedObservations(longURLs, {});
    assert.deepEqual(Array.from(hits, hit => longURLs.indexOf(hit.url)).sort((a, b) => a - b),
        longURLs.map((_, index) => index).filter(index => longURLs[index] !== miss),
        'Response-capped hits must not be mistaken for misses');
    assert.equal(new Set(served).size, served.length, 'Follow-ups never request already returned hits');
    assert(fixture.requests.length > 2, 'The fixture must exercise response truncation, not only request splitting');
    assert.equal(hits.find(hit => hit.url === longURLs.at(-1)).shopping_signals, false);
    for ( const request of fixture.requests ) {
        assert(new TextEncoder().encode(request.options.body).length <= 32 * 1024);
    }
}

for ( const exclusions of [ [], [ { url: 'https://unrequested.example/' } ] ] ) {
    const fixture = createRuntime();
    await fixture.start();
    fixture.lookupReply = () => ({ schema: 1, truncated: true, exclusions });
    assert.equal((await fixture.api.lookupSharedObservations([lookupURLs[0]], {})).length, 0);
    assert.equal(fixture.requests.length, 1, 'A no-progress truncated reply must not loop');
}
console.log('Passed: truncated lookups recover omitted hits, preserve real misses and stop on no-progress replies.');

{
    const fixture = createRuntime();
    await fixture.start();
    fixture.lookupReply = () => ({ schema: 1, exclusions: [{
        url: lookupURLs[0], observed_at: new Date(fixture.now).toISOString(),
        reasons: [
            { kind: 'advertising', rule: 'r'.repeat(300), list: 'known-list', host: 'ads.example',
                request_url: 'https://ads.example/private', detail: { unexpected: true } },
            { kind: 'scam', rule: 123, list: {}, host: 'bad_host.example' },
            { kind: 'paid_promotion' }, { kind: 'malware' }, { kind: 'unknown' }, null,
            { kind: 'source_category', category: 'commercial_corporate' },
        ],
    }] });
    const hits = await fixture.api.lookupSharedObservations([lookupURLs[0]], {});
    assert.deepEqual(JSON.parse(JSON.stringify(hits[0].reasons)), [
        { kind: 'advertising', rule: 'r'.repeat(256), list: 'known-list', host: 'ads.example' },
        { kind: 'scam' },
    ]);
    fixture.lookupReply = () => ({ schema: 1, exclusions: [{
        url: lookupURLs[0], observed_at: new Date(fixture.now).toISOString(),
        reasons: [ { kind: 'source_category', category: 'commercial_corporate' } ],
    }] });
    assert.equal((await fixture.api.lookupSharedObservations([lookupURLs[0]], {})).length, 0,
        'Category-only records never reach the controller');
}
console.log('Passed: shared reasons use bounded known fields and ignore retired/unknown kinds.');

for ( const status of [ 401, 403 ] ) {
    const fixture = createRuntime({ outbox: restartState.outbox, retryAt: Date.now() + 60e3 });
    await fixture.start();
    const oldEpoch = fixture.api.getContributionEpoch();
    fixture.lookupStatus = status;
    assert.equal((await fixture.api.lookupSharedObservations(lookupURLs, {})).length, 0);
    assert.equal(fixture.requests.length, 1, 'A lookup key rejection stops subsequent URL groups');
    assert.equal(fixture.requests[0].payload.urls.length, 20);
    assert.equal(fixture.state.lastError, 'authentication');
    assert.equal((await fixture.api.getContributionState()).consent, true);
    assert.equal(fixture.api.getContributionEpoch(), undefined);
    assert.equal(fixture.state.retryAt, 0);
    assert.deepEqual(fixture.state.outbox, restartState.outbox);
    assert(fixture.cleared.includes('quereeContributionRetry'));
    await fixture.enqueue({ ...decision, contribution_epoch: oldEpoch });
    await fixture.api.lookupSharedObservations(lookupURLs, {});
    await fixture.fireAlarm();
    assert.equal(fixture.requests.length, 1, 'Lookup-only rejection also stops future uploads/lookups');
    assert.equal(fixture.digests, 0);
    fixture.lookupStatus = 200;
    await fixture.api.setContributionKey(replacementKey);
    await fixture.settle();
    await fixture.api.lookupSharedObservations(lookupURLs, {});
    assert.equal(fixture.requests.length, 5, 'Replacement resumes both queued uploads and both lookup groups');
    assert(fixture.requests.slice(1).every(request =>
        request.options.headers.Authorization === `Bearer ${replacementKey}`));

    const stale = createRuntime();
    await stale.api.setContributionConsent(true);
    Object.assign(stale, { lookupStatus: status, holdLookups: true });
    const lookup = stale.api.lookupSharedObservations(lookupURLs, {});
    await waitFor(() => stale.pending.length === 1, 'first lookup group is in flight');
    await stale.api.setContributionKey(replacementKey);
    stale.pending.shift()();
    assert.equal((await lookup).length, 0);
    assert.equal(stale.requests.length, 1, 'A stale rejected lookup must not request the next group');
    assert.equal(stale.state.lastError, '', 'An old-key rejection cannot pause the replacement key');
    assert.notEqual(stale.api.getContributionEpoch(), undefined);
    Object.assign(stale, { lookupStatus: 200, holdLookups: false });
    await stale.api.lookupSharedObservations(lookupURLs, {});
    assert.equal(stale.requests.length, 3);
}
console.log('Passed: lookup-only 401/403 pauses all contribution work, stops later groups and ignores stale-key rejections.');

for ( const [ status, body, invalidJSON, retryAfter, delay ] of [
    [ 429, {}, false, null, 60e3 ],
    [ 429, undefined, true, '1', 60e3 ],
    [ 503, undefined, false, '999999', 2 * 60 * 60e3 ],
    [ 400, { schema: 1, error: 'query' }, false, null, 2 * 60 * 60e3 ],
    [ 400, { schema: 1, error: 'unknown_code' }, false, null, 2 * 60 * 60e3 ],
    [ 400, undefined, true, null, 2 * 60 * 60e3 ],
    [ 404, undefined, true, null, 2 * 60 * 60e3 ],
    [ 408, undefined, false, null, 2 * 60 * 60e3 ],
] ) {
    const fixture = createRuntime({ outbox: [ restartState.outbox[0] ] });
    Object.assign(fixture, { status, body, invalidJSON, retryAfter });
    await fixture.api.setContributionConsent(true);
    await fixture.settle();
    assert.equal(fixture.state.lastError, status === 429 || status >= 500 ? 'temporary' : `server_${status}`);
    assert.equal(fixture.state.attempts, 1);
    assert.equal(fixture.state.retryAt, fixture.now + delay);
    assert.deepEqual(fixture.alarms.at(-1), { name: 'quereeContributionRetry', when: fixture.state.retryAt });
    assert.deepEqual(fixture.state.outbox, [ restartState.outbox[0] ]);
    assert.notEqual(fixture.api.getContributionEpoch(), undefined);
    const writes = fixture.writes;
    await fixture.fireAlarm();
    assert.equal(fixture.requests.length, 1, 'An early alarm must not upload before the deadline');
    assert.equal(fixture.writes, writes, 'A waiting pump snapshot is read-only');
    fixture.now = fixture.state.retryAt;
    Object.assign(fixture, { status: 202, body: undefined, invalidJSON: false });
    await fixture.fireAlarm();
    assert.equal(fixture.requests.length, 2, 'Retryable statuses must not permanently stall the pump');
    assert.deepEqual(fixture.requests[0].payload, fixture.requests[1].payload);
    assert.equal(fixture.state.outbox.length, 0);
    assert.equal(fixture.state.lastError, '');
    assert.equal(fixture.state.attempts, 0);
    assert.equal(fixture.state.retryAt, 0);
}
console.log('Passed: rate limits/HTML, Retry-After bounds and unknown HTTP errors retain data and recover at the deadline.');

{
    const blocked = { ...restartState.outbox[0], id: 'waiting-for-marker',
        result: { url: 'https://redirect.example/start' } };
    const unrelated = { ...restartState.outbox[0], id: 'unrelated-document' };
    const fixture = createRuntime({ outbox: [ blocked, unrelated, firstExclusion ] });
    fixture.retryAfter = '3600';
    fixture.replies.push({ status: 503, body: { schema: 2, error: 'inbox_full' } });
    await fixture.start();
    assert.equal(fixture.requests.length, 3, 'A document waiting only for its marker must not block other work');
    assert.deepEqual(fixture.state.outbox.map(entry => entry.id), [ blocked.id ]);
    const deadline = fixture.state.retryAt;
    const restarted = createRuntime(fixture.state);
    await restarted.start();
    assert.equal(restarted.requests.length, 0, 'Restart respects the marker retry deadline');
    await restarted.enqueue({ ...decision, original_url: 'https://new.example/page',
        document: { ...decision.document, url: 'https://new.example/page' },
        contribution_epoch: restarted.api.getContributionEpoch() });
    assert.equal(restarted.requests.length, 1, 'Fresh work bypasses the waiting marker after restart');
    assert.deepEqual(restarted.state.outbox.map(entry => entry.id), [ blocked.id ]);
    assert.equal(restarted.state.outbox[0].addedAt, blocked.addedAt);
    await restarted.api.setContributionKey(replacementKey);
    await restarted.settle();
    assert.equal(restarted.requests.length, 1, 'Replacing a key must not bypass a capacity wait');
    assert.equal(restarted.alarms.at(-1).when, deadline, 'Re-arm the per-entry wait even after the global retry is reset');
    restarted.now = deadline;
    await restarted.fireAlarm();
    assert.equal(restarted.requests[1].payload.submission_id, blocked.id);
    assert.deepEqual(restarted.requests[1].payload, fixture.requests[0].payload);
    assert.equal(restarted.requests[1].options.headers.Authorization, `Bearer ${replacementKey}`);
    assert.equal(restarted.state.outbox.length, 0);
    assert.equal(restarted.state.discarded, 0);

    const persistent = createRuntime({ outbox: [ blocked, unrelated ] });
    Object.assign(persistent, { status: 503, body: { schema: 2, error: 'inbox_full' }, retryAfter: '3600' });
    persistent.replies.push(
        { status: 503, body: { schema: 2, error: 'inbox_full' } },
        { status: 202, body: { schema: 2, status: 'acknowledged' } }
    );
    await persistent.start();
    for ( let hour = 0; hour < 24; hour++ ) {
        persistent.now = persistent.state.retryAt;
        await persistent.fireAlarm();
    }
    assert.equal(persistent.requests.filter(request => request.payload.submission_id === unrelated.id).length, 1);
    assert.equal(persistent.state.outbox.length, 0);
    assert.equal(persistent.state.discarded, 1, 'Only the still-blocked marker expires, not the unrelated page');
}
console.log('Passed: marker-blocked documents preserve identity and timing while unrelated work proceeds across restart.');

{
    const fixture = createRuntime({ outbox: [ firstExclusion, restartState.outbox[0] ] });
    fixture.replies.push({ status: 503, body: { schema: 2, error: 'inbox_full' } });
    await fixture.start();
    assert.equal(fixture.requests.length, 2, 'A full exclusions inbox must not hold up a document');
    assert(fixture.requests[0].payload.exclusions);
    assert(fixture.requests[1].payload.document);
    assert.deepEqual(fixture.state.outbox, [ { ...firstExclusion, retryAt: fixture.state.retryAt } ], 'Keep the blocked exclusion for retry');
    assert.equal(fixture.state.discarded, 0);
    assert.equal(fixture.state.lastError, 'inbox_full');
    assert.equal(fixture.state.attempts, 0, 'A successful document upload resets network retries despite waiting exclusions');
    const deadline = fixture.state.retryAt;
    assert.equal(deadline, fixture.now + 60e3);
    await fixture.fireAlarm();
    assert.equal(fixture.requests.length, 2, 'Successful documents must not reset the exclusion deadline');

    const restarted = createRuntime(fixture.state);
    await restarted.start();
    assert.equal(restarted.requests.length, 0, 'Restart respects the persisted exclusion deadline');
    await restarted.enqueue({ ...decision, contribution_epoch: restarted.api.getContributionEpoch() });
    assert.equal(restarted.requests.length, 1, 'New documents bypass a blocked exclusion after restart');
    assert(restarted.requests[0].payload.document);
    assert.equal(restarted.state.retryAt, deadline);
    assert.deepEqual(restarted.state.outbox, fixture.state.outbox);
    restarted.now = deadline;
    await restarted.fireAlarm();
    assert.equal(restarted.requests.length, 2);
    assert(restarted.requests[1].payload.exclusions);
    assert.equal(restarted.state.outbox.length, 0);
    assert.equal(restarted.state.lastError, '');
    assert.equal(restarted.state.retryAt, 0);
}
{
    const fixture = createRuntime({ outbox: [ firstExclusion, restartState.outbox[0] ] });
    fixture.replies.push(
        { status: 503, body: { schema: 2, error: 'inbox_full' } },
        { status: 503, body: { schema: 2, error: 'database_busy' } }
    );
    await fixture.start();
    assert.equal(fixture.requests.length, 2);
    assert.equal(fixture.state.lastError, 'temporary', 'A wider failure still pauses all uploads');
    assert.equal(fixture.state.outbox.length, 2);
    await fixture.fireAlarm();
    assert.equal(fixture.requests.length, 2);
}
{
    const deadline = Date.now() + 3600e3;
    const fixture = createRuntime({
        outbox: [ { ...firstExclusion, retryAt: deadline }, restartState.outbox[0] ],
        attempts: 3, retryAt: deadline, lastError: 'inbox_full',
    });
    await fixture.start();
    assert.equal(fixture.requests.length, 1, 'The ready document can upload while an exclusion waits');
    assert.equal(fixture.state.attempts, 0);
    assert.equal(fixture.state.retryAt, deadline, 'The exclusion keeps its own capacity deadline');
    fixture.status = 503;
    fixture.body = { schema: 2, error: 'database_busy' };
    await fixture.enqueue({ ...decision, contribution_epoch: fixture.api.getContributionEpoch() });
    assert.equal(fixture.state.attempts, 1);
    assert.equal(fixture.state.retryAt, fixture.now + 60e3, 'The first later network error waits one minute, not two hours');
    assert.equal(fixture.state.outbox.find(entry => entry.id === firstExclusion.id).retryAt, deadline);
}
console.log('Passed: a full exclusions inbox delays only exclusions; documents continue across restarts without losing the retry.');

{
    const outbox = Array.from({ length: 41 }, (_, index) => {
        const url = `https://excluded.example/${index}`;
        return { ...firstExclusion, id: `excluded-${index}`, url,
            result: { url }, decision: { ...firstExclusion.decision, final_url: url },
            producer: index === 20 ? { ...firstExclusion.producer, extension_release: 'other-release' } : firstExclusion.producer,
        };
    });
    const blocked = { status: 503, body: { schema: 2, error: 'inbox_full' } };
    let fixture = createRuntime({ outbox });
    Object.assign(fixture, blocked);
    await fixture.start();
    assert.equal(fixture.requests.length, 3, 'Try each unblocked producer/batch before waiting');
    assert.equal(fixture.requests[0].payload.exclusions.length, 20);
    assert.deepEqual(fixture.state.outbox.map(entry => entry.addedAt), outbox.map(entry => entry.addedAt),
        'Rotating a full batch does not renew any observation');
    const sentURLs = new Set(fixture.requests.flatMap(request => request.payload.exclusions.map(entry => entry.result.url)));
    assert.equal(sentURLs.size, outbox.length,
        'Later withdrawals and other producers reach the server even while earlier exclusions stay blocked');
    fixture = createRuntime(fixture.state);
    Object.assign(fixture, blocked);
    await fixture.start();
    assert.equal(fixture.requests.length, 0, 'Restart retains the full-inbox backoff');
    assert.equal(fixture.state.outbox.length, outbox.length);
    assert.equal(fixture.state.discarded, 0);
    fixture.now = Math.max(...fixture.state.outbox.map(entry => entry.retryAt));
    Object.assign(fixture, { status: 202, body: undefined });
    await fixture.fireAlarm();
    assert.equal(fixture.state.outbox.length, 0, 'All rotated entries drain when capacity returns');
    assert.equal(fixture.state.lastError, '');
}
console.log('Passed: full-inbox retries rotate batches across producers and restarts without dropping or refreshing withdrawals.');

for ( const [ status, body, invalidJSON = false ] of [
    ...[ 'document', 'credentials', 'hostname', 'ip_literal', 'local_host', 'malformed',
        'not_string', 'scheme', 'too_long', 'producer', 'envelope', 'schema', 'invalid_json',
        'extension_release', 'policy_revision', 'ad_profile_digest', 'deterministic_manifest_digest',
    ].map(error => [ 400, { schema: 1, error } ]),
    [ 413, undefined, true ], [ 415, undefined, true ],
] ) {
    for ( const rejected of [ [ restartState.outbox[0] ], [ firstExclusion, secondExclusion ] ] ) {
        const following = { ...restartState.outbox[0], id: 'following',
            url: 'https://following.example/',
            result: { url: 'https://following.example/' },
            document: { ...restartState.outbox[0].document, url: 'https://following.example/' } };
        const fixture = createRuntime({ outbox: [ ...rejected, following ], discarded: 2 });
        fixture.replies.push({ status, body, invalidJSON });
        await fixture.api.setContributionConsent(true);
        await fixture.settle();
        assert.equal(fixture.requests.length, 2, `${status}/${body?.error} must not stall the next upload`);
        assert.equal(fixture.state.outbox.length, 0);
        assert.equal(fixture.state.discarded, 2 + rejected.length, 'Count the rejected payload once');
        assert.equal(fixture.state.attempts, 0);
        assert.equal(fixture.state.retryAt, 0);
        assert.equal(fixture.alarms.length, 0, 'Permanent errors do not schedule retries');
        assert.notEqual(fixture.api.getContributionEpoch(), undefined);
        await fixture.fireAlarm();
        assert.equal(fixture.state.discarded, 2 + rejected.length);
        assert.equal(fixture.requests.length, 2);
    }
}
console.log('Passed: permanent payload/size/type rejections discard only their document or exclusion batch and allow later uploads.');

{
    const retryAt = Date.now() + 5 * 60e3;
    const fixture = createRuntime({ outbox: restartState.outbox, retryAt, attempts: 2, lastError: 'temporary' });
    await fixture.start();
    assert.deepEqual(fixture.alarms, [ { name: 'quereeContributionRetry', when: retryAt } ]);
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.writes, 0, 'Startup and waiting pump snapshots must not write');
    for ( let i = 0; i < 3; i++ ) { await fixture.api.getContributionState(); }
    await fixture.api.lookupSharedObservations([decision.original_url], {});
    assert.equal(fixture.requests.length, 1, 'A transient outage does not disable lookups');
    assert.equal(fixture.writes, 0, 'Pane polls and shared lookup must not write');
    await fixture.fireAlarm('unrelatedAlarm');
    assert.equal(fixture.alarms.length, 1);
    fixture.now = retryAt;
    await fixture.fireAlarm();
    assert.equal(fixture.state.outbox.length, 0, 'Restart retry uploads without a new observation');
    assert.equal(fixture.requests.length, 3);
}
{
    const fixture = createRuntime({ outbox: restartState.outbox, lastError: 'server_413', retryAt: 0 });
    await fixture.start();
    assert.equal(fixture.state.outbox.length, 0, 'A legacy server_* error must not stall startup');
    assert.equal(fixture.requests.length, 2);
}
console.log('Passed: persisted retry deadlines re-arm on startup; read-only state access does not rewrite queued text.');

{
    const expired = { ...restartState.outbox[0], addedAt: Date.now() - 24 * 60 * 60e3 };
    const fresh = restartState.outbox[1];
    const fixture = createRuntime({
        outbox: [ expired, fresh ], discarded: 4,
        retryAt: Date.now() + 60e3, attempts: 2, lastError: 'temporary',
    });
    const before = fixture.state;
    const state = await fixture.api.getContributionState();
    assert.equal(state.queued, 1);
    assert.equal(state.discarded, 5);
    const cleaned = { ...before, outbox: [ fresh ], discarded: 5 };
    assert.deepEqual(fixture.state, cleaned, 'A read persists expired-text removal without changing key, consent or retry state');
    assert.equal(fixture.writes, 1, 'Expired cleanup is persisted even through read-only access');
    for ( let i = 0; i < 3; i++ ) {
        const polled = await fixture.api.getContributionState();
        assert.equal(polled.queued, 1);
        assert.equal(polled.discarded, 5, 'Expired entries are counted only once');
    }
    await fixture.start();
    await fixture.api.lookupSharedObservations([decision.original_url], {});
    assert.equal(fixture.writes, 1, 'Later polls, startup snapshots and lookups do not rewrite cleaned storage');
    assert.deepEqual(fixture.state, cleaned);
}
console.log('Passed: read-only expiry cleanup removes persisted text and counts it once without repeated writes.');

{
    const fixture = createRuntime({ outbox: restartState.outbox, retryAt: Date.now() + 60e3 });
    await fixture.start();
    const saved = fixture.state;
    const readError = new Error('native storage read failed');
    fixture.readError = readError;
    await assert.rejects(fixture.api.getContributionState(), error => error === readError);
    await assert.rejects(fixture.api.lookupSharedObservations([decision.original_url], {}), error => error === readError);
    await assert.rejects(fixture.api.setContributionConsent(false), error => error === readError);
    assert.equal(fixture.writes, 0, 'A failed read must never write an empty replacement');
    assert.deepEqual(fixture.state, saved);
    fixture.readError = undefined;
    assert.equal((await fixture.api.getContributionState()).queued, 2, 'The serial queue recovers after rejection');
    const writeError = new Error('native storage write failed');
    fixture.writeError = writeError;
    await assert.rejects(fixture.api.setContributionConsent(false), error => error === writeError);
    assert.deepEqual(fixture.state, saved, 'Failed writes must not be reported as persisted success');
    fixture.writeError = undefined;
    await fixture.api.setContributionConsent(true);
    await fixture.settle();
    assert.equal((await fixture.api.getContributionState()).consent, true);
    assert.deepEqual(fixture.state.outbox, saved.outbox);
    assert.equal(fixture.requests.length, 0);
}
console.log('Passed: native storage read/write rejections propagate without losing key, consent or queued text.');

for ( const failure of [ 'readError', 'writeError' ] ) {
    const fixture = createRuntime({
        outbox: [ firstExclusion ], discarded: 2,
        retryAt: Date.now() + 60e3, lastError: 'temporary',
    });
    await fixture.start();
    const saved = fixture.state;
    const reason = new Error(`outbox ${failure}`);
    fixture[failure] = reason;
    for ( let attempt = 0; attempt < 2; attempt++ ) {
        await assert.rejects(fixture.enqueue({ ...decision,
            contribution_epoch: fixture.api.getContributionEpoch(),
        }), error => error === reason);
    }
    assert.deepEqual(fixture.state, saved, 'A failed enqueue must not replace persisted state');
    assert.equal(fixture.errors.length, 2, 'Contribution loss stays visible even if the caller ignores rejection');
    if ( failure === 'writeError' ) {
        assert.equal((await fixture.api.getContributionState()).discarded, 4,
            'The pane can show the loss count even while storage remains unwritable');
    }
    fixture[failure] = undefined;
    for ( let poll = 0; poll < 2; poll++ ) {
        assert.equal((await fixture.api.getContributionState()).discarded, 4,
            'Failed observations remain counted without double-counting on polls');
    }
    await fixture.enqueue({ ...decision, contribution_epoch: fixture.api.getContributionEpoch() });
    assert.equal(fixture.state.discarded, 4, 'The next successful write persists the lost-contribution count');
    assert.equal((await fixture.api.getContributionState()).discarded, 4);
    const restarted = createRuntime(fixture.state);
    assert.equal((await restarted.api.getContributionState()).discarded, 4);
}
console.log('Passed: failed outbox writes/reads reject, log and count lost observations once, persisting the count on recovery.');

{
    const fixture = createRuntime();
    fixture.readError = new Error('startup storage unavailable');
    await fixture.start();
    assert.equal(fixture.errors.length, 1, 'Startup storage failure is logged rather than left unhandled');
    assert.equal(fixture.writes, 0);
    assert.equal(fixture.api.getContributionEpoch(), undefined);
    fixture.readError = undefined;
    await fixture.api.setContributionConsent(true);
    await fixture.settle();
    const saved = fixture.state;
    const writes = fixture.writes;
    fixture.readError = new Error('pump storage unavailable');
    await fixture.fireAlarm();
    assert.equal(fixture.errors.length, 2, 'A failed pump snapshot is logged');
    assert.equal(fixture.writes, writes);
    assert.deepEqual(fixture.state, saved);
    fixture.readError = undefined;
    await fixture.enqueue({ ...decision, contribution_epoch: fixture.api.getContributionEpoch() });
    assert.equal(fixture.requests.length, 1, 'A failed snapshot must not leave the pump marked busy');
}
console.log('Passed: background startup/pump storage failures are bounded, logged and recoverable.');

{
    const entries = [ firstExclusion, secondExclusion ];
    const fixture = createRuntime({ outbox: entries, discarded: 4 });
    fixture.body = { schema: 2, results: [
        { index: 1, status: 'invalid' }, { index: 0, status: 'invalid' },
    ] };
    await fixture.api.setContributionConsent(true);
    await fixture.settle();
    assert.equal(fixture.state.outbox.length, 0);
    assert.equal(fixture.state.discarded, 6, 'Count every invalid entry once, retaining earlier discards');
    assert.equal((await fixture.api.getContributionState()).discarded, 6);
    assert.equal(fixture.state.lastError, 'Some pages could not be contributed');
    await fixture.fireAlarm();
    assert.equal(fixture.state.discarded, 6, 'An empty retry must not count the same entries again');
    assert.equal(fixture.requests.length, 1);
}
console.log('Passed: invalid batch acknowledgments increment persisted/pane discard counts exactly once per rejected entry.');

for ( const [ status, error ] of [
    [ 401, 'authentication' ], [ 429, 'quota_exhausted' ],
    [ 503, 'inbox_full' ], [ 503, 'database_busy' ],
] ) {
    const third = { ...secondExclusion, id: 'partial-waiting', url: 'https://waiting.example/new',
        result: { url: 'https://waiting.example/new' },
        decision: { ...secondExclusion.decision, final_url: 'https://waiting.example/new' },
    };
    const fixture = createRuntime({ outbox: [ firstExclusion, secondExclusion, third ] });
    fixture.status = status;
    fixture.body = { schema: 2, error,
        results: [ { index: 0, status: 'acknowledged' }, { index: 1, status: 'invalid' } ],
    };
    await fixture.api.setContributionConsent(true);
    await fixture.settle();
    assert.deepEqual(fixture.state.outbox.map(entry => entry.id), [ third.id ]);
    assert.equal(fixture.state.discarded, 1);
    fixture.status = 202;
    fixture.body = undefined;
    if ( status === 503 ) {
        fixture.now = fixture.state.retryAt;
        await fixture.fireAlarm();
    } else {
        await fixture.api.setContributionKey(replacementKey);
        await fixture.settle();
    }
    assert.equal(fixture.requests.at(-1).payload.exclusions.length, 1);
    assert.equal(fixture.requests.at(-1).payload.exclusions[0].result.url, third.url);
    assert.equal(fixture.state.outbox.length, 0);
    assert.equal(fixture.state.discarded, 1);
}
console.log('Passed: partial failure acknowledgments remove committed/invalid entries before retrying or pausing.');

for ( const [ status, error ] of [ [ 401, 'authentication' ], [ 429, 'quota_exhausted' ] ] ) {
    const fixture = createRuntime({ outbox: [ firstExclusion, secondExclusion ] });
    fixture.status = status;
    fixture.body = { schema: 2, error, results: [ { index: 0, status: 'acknowledged' } ] };
    let release;
    fixture.beforeWrite = async state => {
        if ( release !== undefined || state.outbox.length !== 1 ) { return; }
        await new Promise(resolve => { release = resolve; });
    };
    const consent = fixture.api.setContributionConsent(true);
    await waitFor(() => release !== undefined, 'partial acknowledgment persistence is in flight');
    const oldEpoch = fixture.api.getContributionEpoch();
    fixture.status = 202;
    fixture.body = undefined;
    const replacement = fixture.api.setContributionKey(replacementKey);
    release();
    await Promise.all([ consent, replacement ]);
    await fixture.settle();
    assert.equal(fixture.state.key, replacementKey);
    assert.equal(fixture.state.consent, true);
    assert.notEqual(fixture.api.getContributionEpoch(), undefined);
    assert.notEqual(fixture.api.getContributionEpoch(), oldEpoch);
    assert.equal(fixture.state.lastError, '', `Old ${status} must not pause the replacement key`);
    assert.equal(fixture.state.retryAt, 0);
    assert.equal(fixture.state.discarded, 0);
    assert.equal(fixture.requests.length, 2);
    assert.equal(fixture.requests[1].options.headers.Authorization, `Bearer ${replacementKey}`);
    assert.deepEqual(fixture.requests[1].payload.exclusions.map(entry => entry.result.url),
        [ secondExclusion.result.url ], 'Persisted acknowledgments stay removed across key replacement');
    assert.equal(fixture.state.outbox.length, 0);
}
console.log('Passed: key replacement during partial acknowledgment persistence ignores old authentication/quota failures.');

for ( const loss of [ 'response', 'persistence' ] ) {
    const fixture = createRuntime({ outbox: [ firstExclusion, secondExclusion ] });
    if ( loss === 'response' ) {
        fixture.holdUploads = true;
    } else {
        let failed = false;
        fixture.beforeWrite = state => {
            if ( failed || state.outbox.length !== 0 ) { return; }
            failed = true;
            throw new Error('acknowledgment storage failed once');
        };
    }
    await fixture.api.setContributionConsent(true);
    await fixture.settle();
    if ( loss === 'response' ) {
        fixture.pendingErrors.shift()(new TypeError('committed response was lost'));
        await fixture.settle();
    }
    const ids = [ firstExclusion.id, secondExclusion.id ];
    assert.deepEqual(fixture.requests[0].payload.exclusions.map(entry => entry.submission_id), ids);
    assert.deepEqual(fixture.state.outbox.map(entry => entry.id), ids);
    assert.equal(fixture.state.lastError, 'transport');
    const restarted = createRuntime(fixture.state);
    restarted.now = fixture.state.retryAt;
    await restarted.start();
    assert.deepEqual(restarted.requests[0].payload.exclusions.map(entry => entry.submission_id), ids,
        `Lost ${loss} must retain receipt identities across restart`);
    assert.equal(restarted.state.outbox.length, 0);
}
console.log('Passed: lost upload responses and acknowledgment writes retain stable submission IDs across restart.');

for ( const [ status, body ] of [
    [ 202, undefined ], [ 401, undefined ],
    [ 429, { schema: 1, error: 'quota_exhausted' } ],
    [ 400, { schema: 1, error: 'document' } ],
    [ 400, { schema: 1, error: 'producer' } ],
    [ 413, undefined ], [ 415, undefined ],
] ) {
    const fixture = createRuntime({ outbox: [ restartState.outbox[0] ] });
    Object.assign(fixture, { status, body, holdUploads: true });
    await fixture.api.setContributionConsent(true);
    await fixture.settle();
    assert.equal(fixture.pending.length, 1);
    const oldEpoch = fixture.api.getContributionEpoch();
    await fixture.api.setContributionKey(replacementKey);
    assert.equal(fixture.requests[0].options.signal.aborted, true);
    assert.notEqual(fixture.api.getContributionEpoch(), oldEpoch);
    Object.assign(fixture, { status: 503, body: undefined, holdUploads: false });
    fixture.pending.shift()();
    await fixture.settle();
    assert.equal(fixture.requests.length, 2, 'The old response must not delete or pause the replacement-key queue');
    assert.equal(fixture.requests[1].options.headers.Authorization, `Bearer ${replacementKey}`);
    assert.deepEqual(fixture.state.outbox, [ restartState.outbox[0] ]);
    assert.equal(fixture.state.lastError, 'temporary');
    assert.equal(fixture.state.discarded, 0);
    const digests = fixture.digests;
    await fixture.enqueue({ ...decision, contribution_epoch: oldEpoch });
    assert.equal(fixture.digests, digests, 'Captures from the old key epoch cannot enter the new queue');
}
console.log('Passed: key replacement aborts uploads and ignores stale acknowledgments/auth/quota/rejection responses.');

{
    const fixture = createRuntime({ outbox: restartState.outbox, attempts: 3, retryAt: Date.now() + 60e3, lastError: 'temporary' });
    await fixture.start();
    const epoch = fixture.api.getContributionEpoch();
    const before = fixture.state;
    await assert.rejects(fixture.api.setContributionKey('bad-key'), /Invitation key is invalid/);
    assert.deepEqual(fixture.state, before);
    assert.equal(fixture.api.getContributionEpoch(), epoch);
    await fixture.api.setContributionKey('');
    assert.equal(fixture.api.getContributionEpoch(), undefined);
    assert.equal(fixture.state.key, '');
    assert.equal(fixture.state.consent, false);
    assert.deepEqual(fixture.state.outbox, []);
    assert.equal(fixture.state.attempts, 0);
    assert.equal(fixture.state.retryAt, 0);
    assert.equal(fixture.state.lastError, 'key_required');
    assert(fixture.cleared.includes('quereeContributionRetry'));
    assert.deepEqual(fixture.removed, [ { data_collection: [
        'browsingActivity', 'authenticationInfo', 'technicalAndInteraction', 'websiteContent',
    ] } ]);
    await fixture.enqueue({ ...decision, contribution_epoch: epoch });
    await fixture.api.lookupSharedObservations([decision.original_url], {});
    await fixture.fireAlarm();
    await fixture.api.setContributionConsent(true);
    assert.equal(fixture.state.consent, false, 'A stale pane cannot opt in again after key clear');
    await fixture.api.setContributionKey(replacementKey);
    assert.equal(fixture.api.getContributionEpoch(), undefined, 'Saving a key does not itself restore cleared consent');
    assert.equal(fixture.requests.length, 0);
    await fixture.api.setContributionConsent(true);
    await fixture.enqueue({ ...decision, contribution_epoch: fixture.api.getContributionEpoch() });
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].options.headers.Authorization, `Bearer ${replacementKey}`);
}
console.log('Passed: invalid keys preserve state; clearing a key clears queued text, retries and permissions and requires fresh consent.');

for ( const clearKey of [ false, true ] ) {
    const fixture = createRuntime({ outbox: restartState.outbox });
    Object.assign(fixture, { holdUploads: true, status: 401 });
    await fixture.api.setContributionConsent(true);
    await fixture.settle();
    assert.equal(fixture.pending.length, 1);
    const request = fixture.requests[0];
    const changed = clearKey
        ? fixture.api.setContributionKey('')
        : fixture.api.setContributionConsent(false);
    assert.equal(request.options.signal.aborted, true, 'Key clear/consent off aborts synchronously');
    assert.equal(fixture.api.getContributionEpoch(), undefined);
    await changed;
    const saved = fixture.state;
    fixture.pending.shift()();
    await fixture.settle();
    assert.deepEqual(fixture.state, saved, 'A late response cannot revive or change revoked contribution state');
    assert.equal(fixture.state.outbox.length, 0);
    assert.equal(fixture.state.lastError, clearKey ? 'key_required' : '');
    await fixture.fireAlarm();
    assert.equal(fixture.requests.length, 1);
}
console.log('Passed: key clear and consent off abort active uploads and ignore their late responses.');

{
    const fixture = createRuntime({ outbox: [ restartState.outbox[0] ] });
    fixture.holdUploads = true;
    await fixture.api.setContributionConsent(true);
    await fixture.settle();
    assert.equal(fixture.pendingErrors.length, 1);
    await fixture.api.setContributionKey(replacementKey);
    fixture.holdUploads = false;
    fixture.pendingErrors.shift()(new TypeError('old-key network request failed'));
    await fixture.settle();
    assert.equal(fixture.requests.length, 2, 'An old-key transport failure must not back off the replacement key');
    assert.equal(fixture.state.outbox.length, 0);
    assert.equal(fixture.state.retryAt, 0);
    assert.equal(fixture.state.lastError, '');
}
console.log('Passed: stale transport failures cannot impose backoff on a replacement key.');
