import {
    adultSourceProfile,
    canonicalPageURL,
    createDecisionCache,
    decisionPolicyFingerprint,
    needsCharacteristicChecks,
    sharedDecisionCompatibility,
} from '../../src/js/queree/decision-cache.js';
import { matchPersonalCategory, personalDisplayRecord } from '../../src/js/queree/personal-categories.js';
import { trackingSource } from '../../src/js/queree/tracking-sources.js';
import adultSources from '../../src/js/queree/vendor/adult-domains.js';
import assert from 'node:assert/strict';
import { communityDomainFromHostname } from '../../src/js/queree/community-domains.js';
import { createHash } from 'node:crypto';
import { decisionPolicyRevision } from '../../src/js/queree/policy.js';
import { loadAdultSources } from '../../tools/queree-adult-sources.mjs';
import { normalizeShareableURL } from '../../src/js/queree/contribution-core.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

async function cachedVerdict(cache, url, policy) {
    return (await cache.getObservation(url, policy))?.verdict;
}

assert.equal(
    canonicalPageURL(
        'HTTPS://Example.COM:443/Article?utm_source=google&id=7#details'
    ),
    'https://example.com/Article?id=7#details'
);
assert.equal(
    canonicalPageURL(
        'https://example.com/path?ID=1&UtM_CaMpAiGn=sale&id=2&srsltid=abc'
    ),
    'https://example.com/path?ID=1&id=2'
);
assert.equal(
    canonicalPageURL(
        'https://example.com/path?ref=friend&source=archive&q=birds&q=bees'
    ),
    'https://example.com/path?ref=friend&source=archive&q=birds&q=bees'
);
assert.equal(
    canonicalPageURL('http://example.com/path'),
    'http://example.com/path'
);
assert.equal(canonicalPageURL('not a URL'), undefined);
assert.equal(canonicalPageURL('file:///tmp/page.html'), undefined);
assert.equal(
    canonicalPageURL('https://example.com/guide#:~:text=chapter'),
    'https://example.com/guide'
);
assert.equal(
    canonicalPageURL('https://example.com/guide#/chapter:~:text=section'),
    'https://example.com/guide#/chapter'
);
for ( const [ tracked, clean ] of [
    [
        'https://e.com/p?a=b,c:d/e&utm_source=x',
        'https://e.com/p?a=b,c:d/e',
    ],
    [ 'https://e.com/p?flag&utm_source=x', 'https://e.com/p?flag' ],
    [ 'https://e.com/p?a=x%20y&utm_source=x', 'https://e.com/p?a=x%20y' ],
    [ "https://e.com/p?a=~!'()&utm_source=x", "https://e.com/p?a=~!'()" ],
] ) {
    assert.equal(canonicalPageURL(tracked), canonicalPageURL(clean));
}
assert.equal(
    canonicalPageURL('https://www.google.com/goto?url=opaque'),
    undefined
);
assert.equal(
    canonicalPageURL('https://www.bing.com/ck/a?u=opaque'),
    undefined
);

class MemoryStorage {
    constructor() {
        this.data = new Map();
        this.setCalls = 0;
    }

    async keys(pattern) {
        return new Set(Array.from(this.data.keys()).filter(key =>
            pattern.test(key)
        ));
    }

    async get(keys) {
        return Object.fromEntries(keys.filter(key => this.data.has(key)).map(
            key => [ key, this.data.get(key) ]
        ));
    }

    async set(bin) {
        this.setCalls += 1;
        for ( const [ key, value ] of Object.entries(bin) ) {
            this.data.set(key, value);
        }
    }

    async remove(keys) {
        for ( const key of [ keys ].flat() ) { this.data.delete(key); }
    }
}

class FlakyStorage extends MemoryStorage {
    constructor() {
        super();
        this.failures = 0;
    }

    async get(keys) {
        if ( this.failures !== 0 ) {
            this.failures -= 1;
            throw new Error('temporary read failure');
        }
        return super.get(keys);
    }
}

const sourceControls = {
    commercial_corporate: false,
    community_contribution: true,
    government_education: true,
    professional_publication: false,
    public_interest_organization: true,
};
const [ adultSource ] = loadAdultSources();
assert.equal(adultSource.name, 'hagezi_nsfw');
assert.equal(adultSource.domains.length, 92021);
assert.equal(Object.hasOwn(adultSources[0], 'domains'), false,
    'Vendor metadata must not ship a second runtime domain array');
const adultProfile = { adult_lists: [ {
    name: adultSource.name, sha256: adultSource.sha256,
} ] };
const adultCompatibility = await sharedDecisionCompatibility(adultProfile);
assert.equal(adultCompatibility.adult_domain,
    'sha256:3fa29ac936ec5fe3b4ed99b5c036ed16be94306b25e335c7b1c056c380a4324a',
    'Adult compatibility is canonical source-only JSON, with no global policy revision');
assert.equal((await sharedDecisionCompatibility({
    ...adultProfile, engine: 'unrelated change', promotion_lists: [ { sha256: 'd'.repeat(64) } ],
})).adult_domain, adultCompatibility.adult_domain);
assert.deepEqual(adultSourceProfile({ adult_lists: [
    { name: 'z-source', sha256: 'b'.repeat(64), retrieved_at: 'ignored' },
    { name: 'a-source', sha256: 'c'.repeat(64) },
    { name: 'a-source', sha256: 'a'.repeat(64) },
] }), { adult_lists: [
    { name: 'a-source', sha256: 'a'.repeat(64) },
    { name: 'a-source', sha256: 'c'.repeat(64) },
    { name: 'z-source', sha256: 'b'.repeat(64) },
] });
const adultFingerprint = await decisionPolicyFingerprint(adultProfile);
adultProfile.adult_lists[0].retrieved_at = 'ignored';
assert.equal((await sharedDecisionCompatibility(adultProfile)).adult_domain,
    adultCompatibility.adult_domain);
adultProfile.adult_lists[0].sha256 = 'c'.repeat(64);
assert.notEqual((await sharedDecisionCompatibility(adultProfile)).adult_domain,
    adultCompatibility.adult_domain);
assert.notEqual(await decisionPolicyFingerprint(adultProfile), adultFingerprint);
assert.equal((await sharedDecisionCompatibility(adultProfile)).commercial_store,
    adultCompatibility.commercial_store, 'Adult updates must not invalidate other shared reasons');
const fingerprint = await decisionPolicyFingerprint(
    { domain_lists: [ { sha256: 'a'.repeat(64) } ] }
);
const promotionProfile = {
    url_pattern_matcher: '@ublacklist/match-pattern@2.0.0',
    promotion_lists: [ { name: 'advertorials', sha256: 'a'.repeat(64) } ],
};
const promotionCompatibility = await sharedDecisionCompatibility(promotionProfile);
const promotionFingerprint = await decisionPolicyFingerprint(promotionProfile);
promotionProfile.promotion_lists[0].sha256 = 'b'.repeat(64);
const changedPromotionCompatibility = await sharedDecisionCompatibility(promotionProfile);
assert.notEqual(changedPromotionCompatibility.advertising,
    promotionCompatibility.advertising);
assert.notEqual(await decisionPolicyFingerprint(promotionProfile), promotionFingerprint);
assert.equal((await sharedDecisionCompatibility(promotionProfile)).commercial_store,
    promotionCompatibility.commercial_store, 'Promotion updates must not change domain-source compatibility');
promotionProfile.url_pattern_matcher = '@ublacklist/match-pattern@next';
assert.notEqual((await sharedDecisionCompatibility(promotionProfile)).advertising,
    changedPromotionCompatibility.advertising);
console.log('Passed: URL-list and matcher updates invalidate the correct decision fingerprints');
const trackingProfile = { tracking_lists: [ {
    ...trackingSource, patterns: trackingSource.patterns.slice(0, -1),
} ] };
const trackingCompatibility = await sharedDecisionCompatibility(trackingProfile);
const trackingFingerprint = await decisionPolicyFingerprint(trackingProfile);
trackingProfile.tracking_lists = [ trackingSource ];
const expandedTrackingCompatibility = await sharedDecisionCompatibility(trackingProfile);
assert.notEqual(await decisionPolicyFingerprint(trackingProfile), trackingFingerprint);
assert.notEqual(expandedTrackingCompatibility.cross_site_tracking, trackingCompatibility.cross_site_tracking);
assert.equal(expandedTrackingCompatibility.advertising, trackingCompatibility.advertising);
console.log('Passed: tracking selection changes refresh local checks and shared tracking compatibility');
const affiliateProfile = { affiliate_link_lists: [ { name: 'soteria_affiliate_endpoints', sha256: 'old' } ] };
const affiliateCompatibility = await sharedDecisionCompatibility(affiliateProfile);
const affiliateFingerprint = await decisionPolicyFingerprint(affiliateProfile);
affiliateProfile.affiliate_link_lists[0].sha256 = 'new';
const revisedAffiliateCompatibility = await sharedDecisionCompatibility(affiliateProfile);
assert.notEqual(await decisionPolicyFingerprint(affiliateProfile), affiliateFingerprint);
assert.notEqual(revisedAffiliateCompatibility.affiliate_tracked_link,
    affiliateCompatibility.affiliate_tracked_link);
assert.equal(revisedAffiliateCompatibility.affiliate_link, affiliateCompatibility.affiliate_link);
assert.equal(revisedAffiliateCompatibility.cross_site_tracking, affiliateCompatibility.cross_site_tracking);
assert.equal(needsCharacteristicChecks({ verdict: 'exclude', reasons: [ { kind: 'affiliate_tracked_link' } ] },
    { excludeAdvertisingSignals: true }), false);
assert.equal(needsCharacteristicChecks({ verdict: 'exclude', reasons: [ { kind: 'affiliate_tracked_link' } ] },
    { excludeAdvertisingSignals: false, excludeCrossSiteTracking: true, excludeShoppingSignals: false }), true);
console.log('Passed: affiliate-link source changes invalidate their checks without changing sponsored-link evidence');
const changedFingerprint = await decisionPolicyFingerprint({
    domain_lists: [ { sha256: 'b'.repeat(64) } ],
});
assert.notEqual(fingerprint, changedFingerprint);

let time = Date.UTC(2026, 9, 31);
const affiliateLinkCache = createDecisionCache(new MemoryStorage(), { now: () => time });
await affiliateLinkCache.put([ {
    url: 'https://personal.example/article', verdict: 'exclude',
    reasons: [ { kind: 'affiliate_tracked_link', list: 'soteria_affiliate_endpoints' } ],
} ], affiliateFingerprint);
assert.deepEqual((await affiliateLinkCache.getObservation('https://personal.example/article', affiliateFingerprint)).reasons,
    [ { kind: 'affiliate_tracked_link' } ]);
assert.equal(await affiliateLinkCache.getObservation('https://personal.example/other', affiliateFingerprint), undefined);
assert.equal(await affiliateLinkCache.getObservation('https://personal.example/article',
    await decisionPolicyFingerprint(affiliateProfile)), undefined);
const rollbackStorage = new MemoryStorage();
const rollbackCache = createDecisionCache(rollbackStorage, { now: ( ) => time });
const pdlFingerprint = await decisionPolicyFingerprint({
    domain_lists: [ { sha256: 'a'.repeat(64) } ],
    corporate_lists: [ { name: 'pdl_companies', sha256: 'b'.repeat(64) } ],
});
for ( const url of [ 'https://en.wikipedia.org/wiki/Example', 'https://urlhaus.abuse.ch/' ] ) {
    await rollbackCache.put([ { url, verdict: 'candidate' } ], fingerprint);
    await rollbackCache.put([ { url, verdict: 'exclude' } ], pdlFingerprint);
    assert.equal(await cachedVerdict(rollbackCache, url, fingerprint), 'candidate');
    assert.equal(await cachedVerdict(rollbackCache, url, pdlFingerprint), 'exclude');
}
await rollbackCache.put([ { url: 'https://example.com/other', verdict: 'exclude' } ], fingerprint);
assert.equal(await cachedVerdict(rollbackCache, 'https://example.com/other', fingerprint), 'exclude');
assert.equal(rollbackStorage.data.size, 5, 'Rollback ignores incompatible verdicts without clearing saved decisions');

const storage = new MemoryStorage();
const cache = createDecisionCache(
    storage,
    { now: ( ) => time, maxEntries: 2 }
);
await cache.put([ {
    url: 'https://example.com/article?utm_source=test',
    verdict: 'candidate',
} ], fingerprint);
const writesAfterPut = storage.setCalls;
assert.equal(
    await cachedVerdict(cache, 'https://example.com/article?fbclid=tracking', fingerprint),
    'candidate'
);
assert.equal(storage.setCalls, writesAfterPut);
assert.equal(
    await cachedVerdict(cache, 'https://example.com/article?edition=print', fingerprint),
    undefined
);
assert.equal(
    await cachedVerdict(cache, 'https://example.com/article', changedFingerprint),
    undefined
);

await cache.put([
    { url: 'https://excluded.example/', verdict: 'exclude' },
    { url: 'https://unresolved.example/', verdict: 'unresolved' },
    { url: 'https://newest.example/', verdict: 'candidate' },
], fingerprint);
assert.equal(storage.data.size, 2);
assert.equal(await cachedVerdict(cache, 'https://unresolved.example/', fingerprint), undefined);

time += 181 * 24 * 60 * 60 * 1000;
assert.equal(await cachedVerdict(cache, 'https://excluded.example/', fingerprint), undefined);
assert.equal(await cache.count(), 0);
await cache.clear();
assert.equal(await cache.count(), 0);
assert.equal(storage.data.size, 0);

const flakyStorage = new FlakyStorage();
const warmCache = createDecisionCache(flakyStorage, { now: ( ) => time });
await warmCache.put([ {
    url: 'https://resilient.example/',
    verdict: 'candidate',
} ], fingerprint);
flakyStorage.failures = 1;
const errors = [];
const coldCache = createDecisionCache(flakyStorage, {
    now: ( ) => time,
    onError: reason => errors.push(reason),
});
assert.equal(
    await cachedVerdict(coldCache, 'https://resilient.example/', fingerprint),
    undefined
);
assert.equal(flakyStorage.data.size, 1);
await coldCache.put([ {
    url: 'https://recovery-write.example/', verdict: 'exclude',
} ], fingerprint);
assert.equal(await cachedVerdict(coldCache, 'https://recovery-write.example/', fingerprint), 'exclude',
    'A failed serialized read must not poison subsequent writes');
assert.equal(
    await cachedVerdict(coldCache, 'https://resilient.example/', fingerprint),
    'candidate'
);
assert.equal(errors.length, 1);

const sharedStorage = new MemoryStorage();
const affiliateCache = createDecisionCache(new MemoryStorage(), { now: () => time });
await affiliateCache.put([ {
    url: 'https://affiliate.example/article', verdict: 'exclude', observed_at: new Date(time).toISOString(),
    checks_complete: true, shopping_signals: false, reasons: [ { kind: 'affiliate_publisher' } ],
} ], fingerprint);
const affiliateObservation = await affiliateCache.getObservation('https://affiliate.example/article', fingerprint);
assert.deepEqual(affiliateObservation.reasons, [ { kind: 'affiliate_publisher' } ]);
assert.equal(needsCharacteristicChecks(affiliateObservation, {
    excludeAdvertisingSignals: false, excludeCrossSiteTracking: false, excludeShoppingSignals: false,
}), false);
assert.equal(needsCharacteristicChecks({ ...affiliateObservation, checks_complete: false }, {
    excludeAdvertisingSignals: false, excludeCrossSiteTracking: true, excludeShoppingSignals: false,
}), true, 'Turning Advertising off still completes enabled Tracking checks');
const sharedCache = createDecisionCache(sharedStorage, { now: () => time });
await sharedCache.put([{
    url:'https://example.net/#/one', verdict:'exclude',
    observed_at:new Date(time - 170 * 864e5).toISOString(),
}], fingerprint);
assert.equal(await cachedVerdict(sharedCache, 'https://example.net/#/one',fingerprint),'exclude');
assert.equal(await cachedVerdict(sharedCache, 'https://example.net/#/two',fingerprint),undefined);
assert.deepEqual(await sharedCache.getObservation('https://example.net/#/one', fingerprint), {
    verdict: 'exclude', observed_at: new Date(time - 170 * 864e5).toISOString(),
}, 'Metadata retains the original server observation age');
time += 11 * 864e5;
assert.equal(await sharedCache.getObservation('https://example.net/#/one', fingerprint), undefined);
assert.equal(await cachedVerdict(sharedCache, 'https://example.net/#/one',fingerprint),undefined);
console.log('Passed: cache separates routes and preserves shared exclusion expiry');

const adultStorage = new MemoryStorage();
const adultCache = createDecisionCache(adultStorage, { now: () => time });
const adultURL = 'https://listed.example/page?id=1#/part';
const adultStamp = new Date(time - 170 * 864e5).toISOString();
const adultReasons = [ {
    kind: 'adult_domain', list: adultSource.name, matched_hostname: 'listed.example',
    request_url: adultURL, title: 'Must not persist',
} ];
await adultCache.put([ {
    url: adultURL, verdict: 'exclude', reasons: adultReasons, observed_at: adultStamp,
} ], adultFingerprint);
assert.deepEqual(await adultCache.getObservation(adultURL, adultFingerprint), {
    verdict: 'exclude', observed_at: adultStamp, reasons: [ { kind: 'adult_domain' } ],
});
assert.equal(JSON.stringify(Array.from(adultStorage.data)).includes(adultURL), false);
assert.equal(JSON.stringify(Array.from(adultStorage.data)).includes('listed.example'), false,
    'Hashed local cache keys must not be paired with plaintext adult hostnames');
assert.deepEqual(Array.from(adultStorage.data.values())[0].slice(3),
    [ [ 'adult_domain' ], null, null ]);
assert.equal(JSON.stringify(Array.from(adultStorage.data)).includes('Must not persist'), false);
assert.equal(await cachedVerdict(adultCache, adultURL, await decisionPolicyFingerprint(adultProfile)), undefined,
    'Removing or changing adult input must invalidate its cached exclusion');
assert.equal(await cachedVerdict(adultCache, 'https://sibling.example/page', adultFingerprint), undefined);
assert.equal(await cachedVerdict(adultCache, `${adultURL}/other`, adultFingerprint), undefined);
time += 11 * 864e5;
assert.equal(await cachedVerdict(adultCache, adultURL, adultFingerprint), undefined,
    'Adult evidence expires from its original observation time');
console.log('Passed: adult cache retains only the reason kind and original expiry');

{
    const storage = new MemoryStorage();
    const cache = createDecisionCache(storage, { now: () => time });
    const stamp = new Date(time).toISOString();
    const cases = [
        [ 'advertising', { kind: 'advertising', rule: 'private rule' }, { kind: 'advertising' } ],
        [ 'affiliate_link', { kind: 'affiliate_link' }, { kind: 'affiliate_link' } ],
        [ 'commercial_store', { kind: 'commercial_store' }, { kind: 'commercial_store' } ],
        [ 'adult_domain', { kind: 'adult_domain' }, { kind: 'adult_domain' } ],
        [ 'scam', { kind: 'scam' }, { kind: 'scam' } ],
        [ 'retired-commercial', { kind: 'commercial_domain' }, undefined ],
        [ 'source', { kind: 'source_category', category: 'commercial_corporate', list: 'private list' }, undefined ],
        [ 'search-ad', { kind: 'search_advertising' }, undefined ],
        [ 'unknown', { kind: 'unknown' }, undefined ],
        [ 'bad-category', { kind: 'source_category', category: 'private category' }, undefined ],
    ];
    for ( const [ name, reason, expected ] of cases ) {
        const url = `https://${name}.example/`;
        await cache.put([ { url, verdict: 'exclude', observed_at: stamp, reasons: [ reason ] } ], fingerprint);
        const observation = await cache.getObservation(url, fingerprint);
        if ( reason.kind === 'source_category' ) {
            assert.equal(observation, undefined, 'A category-only hide is not a saved page observation');
            continue;
        }
        assert.deepEqual(observation.reasons, expected === undefined ? undefined : [ expected ], name);
    }
    for ( const category of [ 'community_contribution', 'public_interest_organization',
        'government_education', 'professional_publication', 'commercial_corporate' ] ) {
        const url = `https://${category}.example/`;
        await cache.put([ { url, verdict: 'exclude', observed_at: stamp,
            reasons: [ { kind: 'source_category', category } ] } ], fingerprint);
        assert.equal(await cache.getObservation(url, fingerprint), undefined);
    }
    const raw = JSON.stringify(Array.from(storage.data));
    for ( const secret of [ 'private rule', 'private list', 'private category', 'example/' ] ) {
        assert.equal(raw.includes(secret), false, `Cache must not retain ${secret}`);
    }
    const url = 'https://advertising.example/';
    await cache.put([ { url, verdict: 'exclude', observed_at: stamp } ], fingerprint);
    assert.deepEqual((await cache.getObservation(url, fingerprint)).reasons, [ { kind: 'advertising' } ],
        'A same-observation write without reasons must not erase known evidence');
    time += 1;
    await cache.put([ { url, verdict: 'exclude', observed_at: new Date(time).toISOString() } ], fingerprint);
    assert.equal((await cache.getObservation(url, fingerprint)).reasons, undefined,
        'A genuinely newer observation must not inherit an older reason');
    const reloaded = createDecisionCache(storage, { now: () => time });
    assert.equal(await reloaded.getObservation('https://source.example/', fingerprint), undefined);
    assert.equal((await reloaded.getObservation('https://unknown.example/', fingerprint)).reasons, undefined);
}
console.log('Passed: bounded reason codes, equal-time writes and privacy');

{
    const storage = new MemoryStorage();
    const cache = createDecisionCache(storage, { now: () => time });
    await cache.put([{ url: 'https://retired.example/', verdict: 'exclude',
        reasons: [{ kind: 'advertising' }] }], fingerprint);
    await cache.put([{ url: 'https://current.example/', verdict: 'candidate' }], fingerprint);
    const retired = [...storage.data.values()].find(value => value[0] === 'x');
    retired[3] = [ 'paid_promotion' ];
    const restored = createDecisionCache(storage, { now: () => time });
    assert.equal(await cachedVerdict(restored, 'https://retired.example/', fingerprint), undefined,
        'Retired paid-promotion evidence is not a reusable exclusion');
    assert.equal(await cachedVerdict(restored, 'https://current.example/', fingerprint), 'candidate',
        'Retiring one kind does not invalidate current cache entries');
    assert.equal(storage.data.size, 1);
    assert.equal(Object.hasOwn(await sharedDecisionCompatibility({}), 'paid_promotion'), false);
}

{
    const storage = new MemoryStorage();
    const cache = createDecisionCache(storage, { now: () => time });
    const url = 'https://multi-reason.example/store';
    const reasons = [
        ...[ 'advertising', 'affiliate_link', 'commercial_store',
            'adult_domain', 'scam' ].map(kind => ({ kind })),
        ...Object.keys(sourceControls).map(category => ({ kind: 'source_category', category })),
    ];
    await cache.put([ { url, verdict: 'exclude', reasons: [ ...reasons, ...reasons,
        { kind: 'unknown' }, { kind: 'source_category', category: 'unknown' },
    ] } ], fingerprint);
    const restored = createDecisionCache(storage, { now: () => time });
    assert.deepEqual((await restored.getObservation(url, fingerprint)).reasons,
        reasons.filter(reason => reason.kind !== 'source_category'),
        'Every supported reason survives reload, with duplicate codes removed');
    assert.equal([...storage.data.values()][0][3].length, 5);

    const optionalURL = 'https://optional-reasons.example/store';
    const optional = [ { kind: 'advertising' }, { kind: 'commercial_store' } ];
    await cache.put([ { url: optionalURL, verdict: 'exclude', reasons: optional } ], fingerprint);
    const searchResults = readFileSync(new URL('../../src/js/queree/search-results.js', import.meta.url), 'utf8');
    const displaySource = searchResults.slice(searchResults.indexOf('    function reasonApplies('),
        searchResults.indexOf('    function exclusionLabel('));
    const controller = readFileSync(new URL('../../src/js/queree/controller.js', import.meta.url), 'utf8');
    const cachedRecordSource = controller.slice(controller.indexOf('function cachedRecord('),
        controller.indexOf('async function candidateRecord('));
    const cachedRecord = vm.runInNewContext(`${cachedRecordSource}; cachedRecord`);
    const replay = cachedRecord({ url: optionalURL }, await createDecisionCache(storage, {
        now: () => time,
    }).getObservation(optionalURL, fingerprint));
    assert.equal(Object.hasOwn(replay, 'shopping_signals'), false,
        'Shared exclusions may have no measured Shopping flag');
    const settings = {
        excludeAdvertisingSignals: true, excludeShoppingSignals: true,
    };
    const excluded = vm.runInNewContext(`${displaySource}; excludedBySettings`, settings);
    for ( const [ advertising, shopping ] of [ [ true, true ], [ false, true ],
        [ true, false ], [ false, false ], [ false, true ], [ true, false ] ] ) {
        settings.excludeAdvertisingSignals = advertising;
        settings.excludeShoppingSignals = shopping;
        assert.equal(excluded(replay), advertising || shopping,
            `Replay must respect Advertising=${advertising}, Shopping=${shopping}`);
    }

    await cache.put([ { url: optionalURL, verdict: 'exclude', reasons: [ { kind: 'affiliate_link' } ] } ], fingerprint);
    await cache.put([ { url: optionalURL, verdict: 'exclude' } ], fingerprint);
    assert.deepEqual((await cache.getObservation(optionalURL, fingerprint)).reasons,
        [ ...optional, { kind: 'affiliate_link' } ],
        'Partial equal-time writes merge reason codes without erasing existing evidence');
}
console.log('Passed: all reason codes survive reload and optional reasons replay through actual display settings');

const freshnessTime = Date.UTC(2026, 10, 4, 12, 0, 0, 123);
const day = Math.floor(freshnessTime / 864e5);
for ( const verdict of [ 'candidate', 'exclude' ] ) {
    const storage = new MemoryStorage();
    const cache = createDecisionCache(storage, { now: () => freshnessTime });
    const url = `https://future-${verdict}.example/`;
    await cache.put([ { url, verdict, observed_at: new Date(freshnessTime + 30 * 864e5).toISOString() } ], fingerprint);
    assert.deepEqual(await cache.getObservation(url, fingerprint), {
        verdict, observed_at: new Date(freshnessTime).toISOString(),
    }, 'Future observations are clamped to the local write time');
    assert.equal([...storage.data.values()][0][1], day + (verdict === 'candidate' ? 90 : 180));
    const opposite = verdict === 'candidate' ? 'exclude' : 'candidate';
    await cache.put([ { url, verdict: opposite } ], fingerprint);
    assert.equal(await cachedVerdict(cache, url, fingerprint), opposite,
        'A future input must not prevent a subsequent local observation from replacing it');
}

{
    const originalNow = Date.now;
    let nativeTime;
    try {
        Date.now = () => nativeTime;
        for ( const ahead of [ 1, 30 * 864e5 ] ) {
            for ( const verdict of [ 'candidate', 'exclude' ] ) {
                for ( const scenario of [ 'read', 'reload', 'count', 'replace', 'reload-replace', 'queued' ] ) {
                    nativeTime = freshnessTime + ahead;
                    const storage = new MemoryStorage();
                    const errors = [];
                    let cache = createDecisionCache(storage, { onError: reason => errors.push(reason) });
                    const url = 'https://clock-correction.example/page';
                    await cache.put([ { url, verdict } ], fingerprint);
                    assert.equal((await cache.getObservation(url, fingerprint)).observed_at,
                        new Date(nativeTime).toISOString());
                    const opposite = verdict === 'candidate' ? 'exclude' : 'candidate';
                    const queued = scenario === 'queued' ? cache.put([ { url, verdict: opposite } ], fingerprint) : undefined;
                    nativeTime = freshnessTime;
                    if ( scenario.startsWith('reload') ) {
                        cache = createDecisionCache(storage, { onError: reason => errors.push(reason) });
                    }
                    if ( scenario.includes('replace') || scenario === 'queued' ) {
                        await (queued || cache.put([ { url, verdict: opposite } ], fingerprint));
                        assert.deepEqual(await cache.getObservation(url, fingerprint), {
                            verdict: opposite, observed_at: new Date(freshnessTime).toISOString(),
                        }, `${scenario}: corrected native clock must not leave the older decision pinned`);
                    } else {
                        if ( scenario === 'count' ) { assert.equal(await cache.count(), 0); }
                        assert.equal(await cache.getObservation(url, fingerprint), undefined,
                            `${scenario}: native clock correction invalidates future entries even after loading`);
                        assert.equal(storage.data.size, 0, 'Invalid future entries are removed from storage');
                    }
                    assert.equal(errors.length, 0);
                }
            }
        }
    } finally {
        Date.now = originalNow;
    }
}

for ( const verdict of [ 'candidate', 'exclude' ] ) {
    for ( const observed of [ 1e300, -1e300, 8.64e15 + 1, -8.64e15 - 1,
        Infinity, -Infinity, NaN, null, undefined, 'invalid', String(freshnessTime), freshnessTime + 1 ] ) {
        const storage = new MemoryStorage();
        const url = `https://invalid-${verdict}.example/`;
        await createDecisionCache(storage, { now: () => freshnessTime }).put([ { url, verdict } ], fingerprint);
        const [ key, value ] = [...storage.data][0];
        storage.data.set(key, [ ...value.slice(0, 2), observed, ...value.slice(3) ]);
        const errors = [];
        const cache = createDecisionCache(storage, { now: () => freshnessTime, onError: reason => errors.push(reason) });
        assert.equal(await cache.getObservation(url, fingerprint), undefined);
        assert.equal(await cache.getObservation(url, fingerprint), undefined);
        assert.equal(await cache.count(), 0);
        assert.equal(storage.data.has(key), false, `Malformed observation ${observed} must be removed`);
        assert.equal(errors.length, 0, 'Malformed storage must be cleaned without repeated date conversion errors');
    }
}
console.log('Passed: future observations are clamped; native clock corrections and malformed stored times cannot pin entries');

for ( const verdict of [ 'candidate', 'exclude' ] ) {
    const freshnessStorage = new MemoryStorage();
    let observationTime = freshnessTime;
    let freshnessCache = createDecisionCache(freshnessStorage, { now: () => observationTime });
    const url = `https://${verdict}.example/page`;
    const opposite = verdict === 'candidate' ? 'exclude' : 'candidate';
    const localWrite = freshnessCache.put([ { url, verdict } ], fingerprint);
    assert.deepEqual(await freshnessCache.getObservation(url, fingerprint), {
        verdict, observed_at: new Date(freshnessTime).toISOString(),
    }, 'Metadata lookup waits for pending completed-inspection writes');
    await localWrite;
    const [ key, value ] = Array.from(freshnessStorage.data)[0];
    assert.match(key, /^quereeDecision\/1\/[a-f0-9]{64}\/[a-f0-9]{64}$/);
    assert.deepEqual(value, [ verdict === 'candidate' ? 'p' : 'x',
        day + (verdict === 'candidate' ? 90 : 180), freshnessTime,
        ...(verdict === 'candidate' ? [ null, null ] : [ [], null, null ]) ]);
    freshnessCache = createDecisionCache(freshnessStorage, { now: () => observationTime });
    const writes = freshnessStorage.setCalls;
    await freshnessCache.put([ {
        url, verdict: opposite, observed_at: new Date(freshnessTime - 1).toISOString(),
    } ], fingerprint);
    assert.equal(await cachedVerdict(freshnessCache, url, fingerprint), verdict,
        'Reloaded cache rejects same-day observations even one millisecond older');
    assert.equal(freshnessStorage.setCalls, writes, 'Rejected stale observations do not write storage');
    if ( verdict === 'candidate' ) {
        await freshnessCache.put([ {
            url, verdict: 'exclude', observed_at: new Date(freshnessTime - 170 * 864e5).toISOString(),
        } ], fingerprint);
        assert.equal(await cachedVerdict(freshnessCache, url, fingerprint), 'candidate',
            'A late shared exclusion must not overwrite a completed local pass');
    }
    const newerStamp = new Date(freshnessTime + 1).toISOString();
    observationTime += 1;
    const newerWrite = freshnessCache.put([ {
        url, verdict: opposite, observed_at: newerStamp,
    } ], fingerprint);
    const staleWrite = freshnessCache.put([ {
        url, verdict, observed_at: new Date(freshnessTime).toISOString(),
    } ], fingerprint);
    await newerWrite;
    await staleWrite;
    assert.deepEqual(await freshnessCache.getObservation(url, fingerprint), {
        verdict: opposite, observed_at: newerStamp,
    }, 'Serialized writes compare observation time, not differing verdict expiration dates');
    await freshnessCache.put([ { url, verdict, observed_at: newerStamp } ], fingerprint);
    assert.equal(await cachedVerdict(freshnessCache, url, fingerprint), verdict,
        'Equal-time writes retain the existing last-write behavior');
    assert.equal(await freshnessCache.getObservation(`${url}/missing`, fingerprint), undefined);
}

for ( const verdict of [ 'candidate', 'exclude' ] ) {
    const storage = new MemoryStorage();
    const url = `https://unsupported-${verdict}.example/`;
    const lifetime = verdict === 'candidate' ? 90 : 180;
    const seedCache = createDecisionCache(storage, { now: () => freshnessTime });
    await seedCache.put([ { url, verdict } ], fingerprint);
    const key = Array.from(storage.data.keys())[0];
    storage.data.set(key, [ verdict === 'candidate' ? 'p' : 'x', day + lifetime ]);
    const cache = createDecisionCache(storage, { now: () => freshnessTime });
    assert.equal(await cache.getObservation(url, fingerprint), undefined);
    assert.equal(storage.data.has(key), false, 'Entries without observation timestamps are discarded');
}
console.log('Passed: precise observation ordering and current cache shape');

for ( const single_domain of [ undefined, false, true ] ) {
    for ( const shopping_signals of [ undefined, false, true ] ) {
        const storage = new MemoryStorage();
        const cache = createDecisionCache(storage, { now: () => freshnessTime });
        const url = 'https://museum.example/store';
        const flags = Object.fromEntries(Object.entries({ single_domain, shopping_signals })
            .filter(([, value]) => value !== undefined));
        const decision = { url, verdict: 'exclude', reasons: [ { kind: 'commercial_store' } ], ...flags };
        await cache.put([ decision ], fingerprint);
        assert.deepEqual([...storage.data.values()][0], [ 'x', day + 180, freshnessTime,
            [ 'commercial_store' ], single_domain ?? null, shopping_signals ?? null ]);
        const restored = createDecisionCache(storage, { now: () => freshnessTime });
        assert.deepEqual(await restored.getObservation(url, fingerprint), {
            verdict: 'exclude', observed_at: new Date(freshnessTime).toISOString(),
            reasons: [ { kind: 'commercial_store' } ], ...flags,
        }, 'Exclusion metadata preserves both false and unknown without conflating them');
    }
}
for ( const invalidEntry of [ [ 'x', day + 180, freshnessTime ],
    [ 'x', day + 180, freshnessTime, 'commercial_store' ],
    [ 'x', day + 180, freshnessTime, 'commercial_store', false, false ],
    [ 'x', day + 180, freshnessTime, null, false, false ],
    [ 'x', day + 180, freshnessTime, [ 'unknown' ], false, false ],
    [ 'x', day + 180, freshnessTime, [ 'source_category:unknown' ], false, false ],
    [ 'x', day + 180, freshnessTime, [ 'advertising', 'advertising' ], false, false ],
    [ 'x', day + 180, freshnessTime, new Array(1), false, false ],
    [ 'x', day + 180, freshnessTime, 'commercial_store', false, false, true ],
    [ 'p', day + 90, freshnessTime, false, false, true ] ] ) {
    const storage = new MemoryStorage();
    const url = 'https://old.example/store';
    await createDecisionCache(storage, { now: () => freshnessTime }).put([ { url, verdict: 'exclude' } ], fingerprint);
    const [ key ] = storage.data.keys();
    storage.data.set(key, invalidEntry);
    assert.equal(await createDecisionCache(storage, { now: () => freshnessTime }).getObservation(url, fingerprint), undefined,
        'Obsolete or malformed tuples must be discarded without decoding');
    assert.equal(storage.data.has(key), false);
}
{
    const profile = { shopping_lists: [ { name: 'ut1_shopping', sha256: 'a'.repeat(64) } ] };
    const previousFingerprint = createHash('sha256')
        .update(JSON.stringify([ 1, 'queree-policy-23', profile, sourceControls ])).digest('hex');
    const currentFingerprint = await decisionPolicyFingerprint(profile);
    assert.notEqual(previousFingerprint, currentFingerprint);
    const storage = new MemoryStorage();
    const cache = createDecisionCache(storage, { now: () => freshnessTime });
    await cache.put([ { url: 'https://old.example/article', verdict: 'candidate' } ], previousFingerprint);
    assert.equal(await cache.getObservation('https://old.example/article', currentFingerprint), undefined);
}
console.log('Passed: policy 24 exclusions round-trip optional flags, reject old shapes and ignore policy 23 decisions');

{
    const storage = new MemoryStorage();
    const url = 'https://partial.example/article';
    const stamp = new Date(freshnessTime).toISOString();
    const cache = createDecisionCache(storage, { now: () => freshnessTime });
    await cache.put([ { url, verdict: 'exclude', observed_at: stamp,
        reasons: [ { kind: 'cross_site_tracking' } ], single_domain: false, shopping_signals: false } ], fingerprint);
    assert.equal([...storage.data.values()][0].length, 6, 'Partial rows keep the existing compact shape');
    const restored = createDecisionCache(storage, { now: () => freshnessTime });
    const partial = await restored.getObservation(url, fingerprint);
    assert.equal(partial.observed_at, stamp);
    assert.equal(needsCharacteristicChecks(partial, {}), false, 'A sufficient enabled reason reuses an existing row');
    assert.equal(needsCharacteristicChecks(partial, { excludeCrossSiteTracking: false }), true,
        'Existing rows do not invent passed Advertising checks');
    await restored.put([ { url, ...partial, checks_complete: true } ], fingerprint);
    assert.equal([...storage.data.values()][0].length, 7);
    const complete = await createDecisionCache(storage, { now: () => freshnessTime }).getObservation(url, fingerprint);
    assert.equal(complete.checks_complete, true);
    assert.equal(needsCharacteristicChecks(complete, { excludeCrossSiteTracking: false }), false);
    await restored.put([ { url, ...partial } ], fingerprint);
    assert.equal((await restored.getObservation(url, fingerprint)).checks_complete, true,
        'An equal-time partial observation cannot erase completed checks');
    const [ key ] = storage.data.keys();
    storage.data.set(key, [ ...storage.data.get(key).slice(0, 6), false ]);
    assert.equal(await createDecisionCache(storage, { now: () => freshnessTime }).getObservation(url, fingerprint), undefined,
        'The optional completion slot accepts only true');
}
console.log('Passed: six-field exclusions survive and only fully checked rows gain a trailing completion marker');

for ( const verdict of [ 'candidate', 'exclude' ] ) {
    for ( const kinds of [ [ 'malware' ], [ 'advertising', 'malware' ],
        [ 'malware', 'adult_domain' ], [ 'source_category', 'malware' ] ] ) {
        const storage = new MemoryStorage();
        const cache = createDecisionCache(storage, { now: () => freshnessTime });
        const url = 'https://synthetic.example/malware';
        await cache.put([ { url, verdict, reasons: kinds.map(kind => ({ kind })) } ], fingerprint);
        assert.equal(await cache.getObservation(url, fingerprint), undefined,
            'No malware-bearing decision may become a reusable cached observation');
        assert.equal(await createDecisionCache(storage).count(), 0);
    }
}
console.log('Passed: malware-bearing decisions never enter persistent cache, including mixed reasons');

for ( const mandatory of [ 'scam', 'adult_domain' ] ) {
    for ( const kinds of [ [ 'commercial_store', mandatory ], [ 'advertising', mandatory ],
        [ mandatory, 'commercial_store' ] ] ) {
        const storage = new MemoryStorage();
        const url = 'https://shortcut.example/redirected-store';
        await createDecisionCache(storage, { now: () => freshnessTime }).put([ {
            url, verdict: 'exclude', reasons: kinds.map(kind => ({ kind })),
        } ], fingerprint);
        const restored = createDecisionCache(storage, { now: () => freshnessTime });
        const observation = await restored.getObservation(url, fingerprint);
        assert.equal(observation.reasons.some(reason => reason.kind === mandatory), true,
            'Compaction must never turn a mandatory exclusion into an optional reason');
    }
}

{
    const storage = new MemoryStorage();
    const cache = createDecisionCache(storage, { now: () => freshnessTime });
    for ( const shopping_signals of [ false, true ] ) {
        const url = `https://shopping.example/${shopping_signals}`;
        await cache.put([{ url, verdict: 'candidate', single_domain: false, shopping_signals }], fingerprint);
        const restored = createDecisionCache(storage, { now: () => freshnessTime });
        const observation = await restored.getObservation(url, fingerprint);
        assert.equal(observation.shopping_signals, shopping_signals);
        assert.equal(observation.single_domain, false);
        assert.equal(observation.verdict, 'candidate');
        assert.equal(await cachedVerdict(restored, `${url}/different-page`, fingerprint), undefined);
    }
    const profile = { engine: 'current', fingerprints: { sha256: 'a'.repeat(64) } };
    const storedManifestDigest = `sha256:${createHash('sha256').update(JSON.stringify(profile)).digest('hex')}`;
    const rekeyed = `sha256:${createHash('sha256').update(JSON.stringify([
        decisionPolicyRevision, 'page_observation', storedManifestDigest,
    ])).digest('hex')}`;
    assert.equal((await sharedDecisionCompatibility(profile)).page_observation, rekeyed,
        'Stored producer fields suffice to rekey existing server observations without reinspection');
    assert.notEqual(
        (await sharedDecisionCompatibility(profile)).page_observation,
        (await sharedDecisionCompatibility({ ...profile, engine: 'changed-policy-input' })).page_observation,
        'Source and policy inputs still isolate incompatible observations'
    );
}

{
    const storage = new MemoryStorage();
    const cache = createDecisionCache(storage, { now: () => freshnessTime });
    const url = 'https://measured.example/article';
    for ( const single_domain of [ undefined, true, false ] ) {
        await cache.put([{ url, verdict: 'candidate', single_domain }], fingerprint);
        const restored = createDecisionCache(storage, { now: () => freshnessTime });
        const observation = await restored.getObservation(url, fingerprint);
        assert.equal(observation.verdict, 'candidate');
        assert.equal(observation.single_domain, single_domain);
        assert.equal(Object.hasOwn(observation, 'single_domain'), single_domain !== undefined);
        assert.equal([...storage.data.values()][0].length, 5);
    }
    for ( const verdict of [ 'unresolved', 'uninspected' ] ) {
        await cache.put([{ url, verdict }], fingerprint);
    }
    assert.equal((await cache.getObservation(url, fingerprint)).single_domain, false,
        'Failed remeasurement does not overwrite a reusable intrinsic pass');
    await cache.put([{ url, verdict: 'exclude', single_domain: true }], fingerprint);
    assert.equal([...storage.data.values()][0].length, 6, 'Partial exclusions retain their compact format');
    assert.equal((await cache.getObservation(url, fingerprint)).single_domain, true);
}

const controller = readFileSync(new URL('../../src/js/queree/controller.js', import.meta.url), 'utf8');
const prepareStart = controller.indexOf('async function classifyItem(');
const prepareEnd = controller.indexOf('export function isInspectionTab(', prepareStart);
assert(prepareStart !== -1 && prepareEnd > prepareStart);
const prepareSource = controller.slice(prepareStart, prepareEnd);
const savedStart = controller.indexOf('async function savedDecision(');
const savedEnd = controller.indexOf('async function classifyItem(', savedStart);
assert(savedStart !== -1 && savedEnd > savedStart);
const savedSource = controller.slice(savedStart, savedEnd);
const restrictedHostsSource = controller.slice(controller.indexOf('const firefoxRestrictedHosts ='),
    controller.indexOf('async function prepareProfile('));
for ( const requireSingleDomain of [ false, true ] ) {
    for ( const single_domain of [ undefined, false, true ] ) {
        const observation = { verdict: 'candidate', single_domain, shopping_signals: false, observed_at: new Date(freshnessTime).toISOString() };
        const context = {
            URL, communityDomainFromHostname, matchPersonalCategory, needsCharacteristicChecks, mobileTabs: { android: false },
            sessionMalwareDecision: () => undefined, normalizeShareableURL,
            loadDomainIndex: async () => {}, sourceDecision: () => undefined,
            currentSettings: { requireSingleDomain, personalCategories: [] },
            cacheFingerprint: fingerprint,
            decisionCache: { getObservation: async () => observation },
        };
        const cachedRecordSource = controller.slice(controller.indexOf('function cachedRecord('),
            controller.indexOf('async function candidateRecord('));
        context.cachedRecord = vm.runInNewContext(`${cachedRecordSource}; cachedRecord`);
        const prepare = vm.runInNewContext(`${restrictedHostsSource}(${savedSource})`, context);
        const result = await prepare({ url: 'https://measured.example/' }, context.currentSettings, context.cacheFingerprint);
        const reuse = requireSingleDomain === false || single_domain !== undefined;
        assert.equal(result?.verdict, reuse ? 'candidate' : undefined);
        assert.equal(result?.single_domain, reuse ? single_domain : undefined);
    }
}
for ( const previousVerdict of [ undefined, 'candidate', 'exclude' ] ) {
    const preparationCache = createDecisionCache(new MemoryStorage(), { now: () => freshnessTime });
    const observed_at = new Date(freshnessTime - 864e5).toISOString();
    if ( previousVerdict !== undefined ) {
        await preparationCache.put([ {
            url: adultURL, verdict: previousVerdict, observed_at,
        } ], adultFingerprint);
    }
    const context = {
        malwareDecision: () => undefined, recheckMalwareResult: result => result,
        getContributionEpoch: () => undefined,
        sharedCompatibility: {},
        safetyExclusionReasons: () => [ { kind: 'adult_domain', list: 'hagezi_nsfw', matched_hostname: 'listed.example' } ],
        record: (item, verdict, reasons) => ({
            url: item.url, verdict, reasons, observed_at: new Date(freshnessTime).toISOString(),
        }),
        decisionCache: preparationCache, cacheFingerprint: adultFingerprint,
        sourceDecision: () => { throw new Error('Adult decision reached ownership/platform handling'); },
    };
    const prepare = vm.runInNewContext(`(${prepareSource})`, context);
    const entry = await prepare({ url: adultURL, sourceReasons: [ { kind: 'source_category' } ] },
        context.sharedCompatibility, context.currentSettings);
    assert.equal(entry.decision.verdict, 'exclude', 'A cached pass must not bypass the current adult input');
    assert.equal(entry.decision.reasons[0].kind, 'adult_domain', 'Adult eligibility precedes supplied source reasons');
    assert.equal(entry.cacheDecision, true, 'Fresh adult decisions cache even with contribution disabled');
    assert.equal(entry.decision.cached, undefined);
    assert.equal(entry.decision.observed_at, new Date(freshnessTime).toISOString());
}

const redirectCache = createDecisionCache(new MemoryStorage(), { now: () => freshnessTime });
const cachedRecord = vm.runInNewContext(controller.slice(
    controller.indexOf('function cachedRecord('), controller.indexOf('async function candidateRecord(')
) + ';cachedRecord');
const cachedObservation = { verdict: 'exclude', reasons: [ { kind: 'affiliate_link' } ] };
assert.deepEqual(cachedRecord({ id: 'one', url: 'https://cached.example/' }, cachedObservation).reasons,
    cachedObservation.reasons, 'Cache hits pass reasons to the presentation layer');
assert.equal(cachedRecord({ id: 'two', url: 'https://cached.example/' }, { verdict: 'exclude' }).reasons.length, 0,
    'Old cached exclusions keep their generic reason');
const completionStart = controller.indexOf('    function publishResult(');
const completionEnd = controller.indexOf('\n    }\n}', completionStart);
assert(completionStart !== -1 && completionEnd > completionStart);
const completedResultSource = controller.slice(completionStart, completionEnd + '\n    }'.length);
let malwareMatch = () => ({ result: 0 });
const finalize = vm.runInNewContext(
    controller.slice(controller.indexOf('function malwareReason('), controller.indexOf('export function filterInspectionRequest(')) +
    `\nfunction finalize(result, entry) {
        const prepared = [entry];
        const index = 0;
        return (${completedResultSource})(result, index);
    }\nfinalize`, {
    decisionCache: redirectCache, cacheFingerprint: adultFingerprint,
    sessionMalware: new Map(), normalizeShareableURL, getMalwareGeneration: () => 0,
    staleBatchReason: () => undefined, report: result => result,
    enqueueObservations: async () => {},
    record: (item, verdict, reasons) => ({ ...item, verdict, reasons }),
    matchMalwareRequest: (...args) => malwareMatch(...args),
    });
const finalized = finalize({
    url: adultURL, verdict: 'exclude', reasons: adultReasons,
    observed_at: new Date(freshnessTime).toISOString(),
    document: { body: 'Private captured text' }, document_error: 'private error', contribution_epoch: 1,
    cached: true, server_sourced: true,
}, { item: { url: 'https://clean.example/original' } });
assert.equal(finalized.url, adultURL);
for ( const field of [ 'document', 'document_error', 'contribution_epoch' ] ) {
    assert.equal(Object.hasOwn(finalized, field), false, 'Final replies and cache writes omit private capture fields');
}
assert.equal(await cachedVerdict(redirectCache, adultURL, adultFingerprint), 'exclude');
assert.equal(await cachedVerdict(redirectCache, 'https://clean.example/original', adultFingerprint), undefined,
    'A forwarding address cannot inherit the inspected destination\'s verdict');
assert.deepEqual(await redirectCache.getObservation(adultURL, adultFingerprint), {
    verdict: 'exclude', observed_at: new Date(freshnessTime).toISOString(),
    reasons: [ { kind: 'adult_domain' } ],
});
for ( const failure of [ false, true ] ) {
    malwareMatch = () => {
        if ( failure ) { throw new Error('Synthetic final malware failure'); }
        return { result: 1, raw: 'synthetic-final-malware' };
    };
    const url = `https://fresh.example/${failure}/job`;
    const result = finalize({ url, verdict: 'candidate', reasons: [] }, { item: {} });
    assert.equal(result.verdict, failure ? 'unresolved' : 'exclude');
    assert.equal(result.reasons[0].kind, failure ? 'malware_profile_unavailable' : 'malware');
    assert.equal(await cachedVerdict(redirectCache, url, adultFingerprint), undefined,
        'A candidate overturned by the final malware check never enters the reusable cache');
}
console.log('Passed: adult preparation and destination-only caching retain reason kinds');

const lookupStart = controller.indexOf('shared.then(async byURL =>');
const callbackStart = controller.indexOf('.then(', lookupStart) + '.then('.length;
const callbackEnd = controller.indexOf(').catch(( ) => { })', callbackStart);
assert(lookupStart !== -1 && callbackStart > lookupStart && callbackEnd > callbackStart);
const sharedReplySource = controller.slice(callbackStart, callbackEnd);
const sharedSelectionSource = controller.slice(controller.indexOf('    const sharedObservation ='),
    controller.indexOf('    let adFailure;'));
for ( const scenario of [ 'completed', 'local-excluded', 'pending-write', 'no-cache', 'finished', 'stale', 'disabled', 'write-during-lookup', 'write-after-read', 'clear-after-read', 'measured', 'measurement-needed' ] ) {
    const replyCache = createDecisionCache(new MemoryStorage(), { now: () => freshnessTime });
    const url = 'https://simultaneous.example/page';
    const searchA = { id: 'search-a', url, finished: false };
    const searchB = { id: 'search-b', url, finished: false };
    assert.equal(await cachedVerdict(replyCache, searchA.url, fingerprint), undefined);
    assert.equal(await cachedVerdict(replyCache, searchB.url, fingerprint), undefined);
    const local = { url, verdict: 'candidate', shopping_signals: false, observed_at: new Date(freshnessTime).toISOString() };
    if ( scenario === 'local-excluded' ) {
        local.verdict = 'exclude';
        local.reasons = [ { kind: 'affiliate_link' } ];
    }
    if ( scenario === 'measured' ) { local.single_domain = false; }
    let localWrite = [ 'no-cache', 'write-during-lookup', 'write-after-read' ].includes(scenario)
        ? Promise.resolve()
        : replyCache.put([ local ], fingerprint);
    searchA.finished = scenario !== 'write-during-lookup';
    if ( scenario !== 'pending-write' ) { await localWrite; }
    const finished = [];
    let enabled = true;
    let stale;
    let dispatches = 0;
    let reads = 0;
    const context = {
        batchStartedAt: freshnessTime,
        batchJobs: new Set([ searchB ]),
        sessionMalwareDecision: () => undefined,
        currentSettings: { requireSingleDomain: [ 'measured', 'measurement-needed' ].includes(scenario), personalCategories: [] },
        settings: () => context.currentSettings,
        matchPersonalCategory, needsCharacteristicChecks,
        cacheFingerprint: fingerprint,
        normalizeShareableURL: canonicalPageURL,
        staleBatchReason: () => enabled ? stale : 'filtering_disabled',
        decisionCache: {
            get writeGeneration() { return replyCache.writeGeneration; },
            getObservation: async (...args) => {
                reads += 1;
                const reading = replyCache.getObservation(...args);
                if ( scenario === 'write-during-lookup' && reads === 1 ) {
                    searchA.finished = true;
                    localWrite = replyCache.put([ local ], fingerprint);
                }
                const observation = await reading;
                if ( scenario === 'write-after-read' && reads === 1 ) {
                    localWrite = replyCache.put([ local ], fingerprint);
                }
                if ( scenario === 'clear-after-read' && reads === 1 ) {
                    const generation = replyCache.writeGeneration;
                    localWrite = replyCache.clear();
                    assert.equal(replyCache.writeGeneration, generation + 1,
                        'Clearing advances the generation before its queued mutation runs');
                }
                assert.equal(context.dispatchPaused, false, 'Dispatch must not stay paused during cache lookup');
                if ( scenario === 'finished' ) { searchB.finished = true; }
                if ( scenario === 'stale' ) { stale = 'source_changed'; }
                if ( scenario === 'disabled' ) { enabled = false; }
                return observation;
            },
        },
        record: (job, verdict, reasons) => ({ id: job.id, url: job.url, verdict, reasons }),
        finish: (job, result) => {
            assert.equal(context.dispatchPaused, false);
            assert.equal(job.finished, false, 'A completed local job must not be finished again');
            job.finished = true;
            finished.push(result);
        },
        dispatchPaused: false,
        dispatch: () => { dispatches += 1; },
    };
    const sharedReply = vm.runInNewContext(`${sharedSelectionSource}\n(${sharedReplySource})`, context);
    const hit = { verdict: 'exclude', url, observed_at: new Date(freshnessTime - 1).toISOString(),
        reasons: [ { kind: 'advertising' } ],
    };
    await sharedReply(new Map([[ url, hit ]]));
    await localWrite;
    if ( [ 'finished', 'stale', 'disabled', 'measurement-needed' ].includes(scenario) ) {
        assert.equal(finished.length, 0, `Shared reply must recheck ${scenario} after awaiting metadata`);
        assert.equal(dispatches, 0);
    } else {
        assert.equal(finished.length, 1);
        const result = finished[0];
        const newer = [ 'no-cache', 'clear-after-read' ].includes(scenario) === false;
        assert.equal(result.verdict, newer ? local.verdict : 'exclude',
            'Search B must reuse search A\'s fresher decision');
        assert.equal(result.observed_at, newer ? local.observed_at : hit.observed_at);
        assert.equal(result.cached, true, 'Reused decisions must bypass contribution uploads');
        assert.equal(result.server_sourced, newer === false);
        assert.equal(result.reasons.length, newer ? (local.reasons?.length || 0) : hit.reasons.length);
        if ( scenario === 'local-excluded' ) {
            assert.equal(result.reasons[0].kind, 'affiliate_link',
                'A fresher local exclusion keeps its reason instead of the shared reason');
        }
        assert.equal(result.single_domain, local.single_domain);
        assert.equal(dispatches, 0, 'Shared reuse leaves dispatching to finish/resource cleanup');
    }
    assert.equal(reads, [ 'write-during-lookup', 'write-after-read', 'clear-after-read' ].includes(scenario) ? 2 : 1,
        'Only a queued write, not the metadata read itself, requires another read');
    assert.equal(context.dispatchPaused, false);
}
console.log('Passed: actual shared-reply callback preserves cross-search freshness and rechecks async races');

const reportSource = controller.slice(controller.indexOf('const report = result => {'),
    controller.indexOf('    const saved = await Promise.all('));
for ( const scenario of [ 'candidate', 'exclude', 'finished', 'stale', 'disabled' ] ) {
    const storage = new MemoryStorage();
    const replyCache = createDecisionCache(storage, { now: () => freshnessTime });
    const url = 'https://queued-local.example/page';
    const searchB = { id: 'search-b', url, finished: false };
    await cachedVerdict(replyCache, url, fingerprint);
    assert.equal(replyCache.writeGeneration, 0, 'Reads must not advance write generation');
    let releaseStorage, storageSuspended;
    const suspended = new Promise(resolve => { storageSuspended = resolve; });
    const gate = new Promise(resolve => { releaseStorage = resolve; });
    const set = storage.set.bind(storage);
    storage.set = async bin => {
        storage.set = set;
        storageSuspended();
        await gate;
        return set(bin);
    };
    const unrelatedWrite = replyCache.put([ {
        url: 'https://unrelated.example/', verdict: 'candidate',
    } ], fingerprint);
    assert.equal(replyCache.writeGeneration, 1, 'Put advances generation synchronously');
    await suspended;
    const beforeRead = replyCache.serial;
    const finished = [];
    const uploads = [];
    const progress = [];
    let reads = 0;
    let stale;
    let enabled = true;
    let dispatches = 0;
    const context = {
        batchJobs: new Set([ searchB ]), cacheFingerprint: fingerprint,
        batchStartedAt: freshnessTime,
        sessionMalwareDecision: () => undefined, rememberMalware: () => false,
        prepared: [ { item: searchB } ], index: 0,
        recheckMalwareResult: result => result,
        currentSettings: { requireSingleDomain: false, personalCategories: [] },
        settings: () => context.currentSettings,
        matchPersonalCategory, personalDisplayRecord, needsCharacteristicChecks,
        normalizeShareableURL: canonicalPageURL,
        staleBatchReason: () => enabled ? stale : 'filtering_disabled',
        decisionCache: {
            get writeGeneration() { return replyCache.writeGeneration; },
            put: (...args) => replyCache.put(...args),
            getObservation: async (...args) => {
                reads += 1;
                const observation = await replyCache.getObservation(...args);
                assert.equal(context.dispatchPaused, false);
                if ( reads === 2 ) {
                    if ( scenario === 'finished' ) { searchB.finished = true; }
                    if ( scenario === 'stale' ) { stale = 'source_changed'; }
                    if ( scenario === 'disabled' ) { enabled = false; }
                }
                return observation;
            },
        },
        record: (job, verdict, reasons) => ({ id: job.id, url: job.url, verdict, reasons }),
        finish: (job, result) => {
            assert.equal(context.dispatchPaused, false);
            assert.equal(job.finished, false);
            job.finished = true;
            finished.push(result);
        },
        dispatchPaused: false, dispatch: () => { dispatches += 1; },
        completed: 0, allItems: [ searchB ], sourceTabId: 1, batchId: 'queued-race',
        enqueueObservations: async decisions => { uploads.push(...decisions); },
        browser: { tabs: { sendMessage: async (_tabId, message) => { progress.push(message); } } },
    };
    const sharedReply = vm.runInNewContext(`${sharedSelectionSource}\n(${sharedReplySource})`, context);
    const hit = { verdict: 'exclude', url, observed_at: new Date(freshnessTime - 864e5).toISOString(),
        reasons: [ { kind: 'advertising' } ],
    };
    const replying = sharedReply(new Map([[ url, hit ]]));
    for ( let i = 0; i < 100 && replyCache.serial === beforeRead; i++ ) {
        await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.notEqual(replyCache.serial, beforeRead, 'Metadata read is queued behind suspended storage');
    const cacheCompletedLocal = vm.runInNewContext(
        `(${completedResultSource})`, {
            decisionCache: replyCache, cacheFingerprint: fingerprint,
            prepared: [ { item: { url } } ], index: 0,
            staleBatchReason: () => undefined, recheckMalwareResult: result => result,
            report: result => result, enqueueObservations: async () => {},
            sessionMalwareDecision: () => undefined, rememberMalware: () => false,
        }
    );
    const local = { url, verdict: scenario === 'exclude' ? 'exclude' : 'candidate',
        ...(scenario === 'exclude' ? {} : { shopping_signals: false }),
        observed_at: new Date(freshnessTime).toISOString(),
    };
    cacheCompletedLocal(local, 0);
    const localWrite = replyCache.serial;
    assert.equal(replyCache.writeGeneration, 2,
        'Actual completion publication advances generation while storage is still suspended');
    releaseStorage();
    await Promise.all([ unrelatedWrite, localWrite, replying ]);
    assert.deepEqual(await replyCache.getObservation(url, fingerprint), {
        verdict: local.verdict, observed_at: local.observed_at,
        ...(local.verdict === 'candidate' ? { shopping_signals: false } : {}),
    });
    assert.equal(replyCache.writeGeneration, 2, 'Retrying metadata must not queue cache writes');
    assert.equal(await cachedVerdict(replyCache, `${url}/other`, fingerprint), undefined);
    if ( [ 'finished', 'stale', 'disabled' ].includes(scenario) ) {
        assert.equal(finished.length, 0, `Retry must recheck ${scenario} after awaiting metadata`);
        assert.equal(dispatches, 0);
    } else {
        assert.equal(finished.length, 1);
        const result = finished[0];
        assert.equal(result.verdict, local.verdict);
        assert.equal(result.observed_at, local.observed_at);
        assert.equal(result.server_sourced, false);
        assert.equal(result.cached, true);
        assert.equal(result.reasons.length, 0);
        context.source = { generation: 0 };
        context.sourceGeneration = 0;
        context.report = vm.runInNewContext(`${reportSource};report`, context);
        const completeResult = vm.runInNewContext(`(${completedResultSource})`, context);
        await completeResult(result, 0);
        assert.equal(progress.length, 1);
        assert.equal(progress[0].decision.verdict, local.verdict);
        assert.equal(dispatches, 0, 'Shared reuse leaves dispatching to finish/resource cleanup');
    }
    assert.equal(reads, 2, 'Arbitration must retry a read queued before the local completion');
    assert.equal(uploads.length, 0, 'The actual completion callback must not re-upload a reused decision');
    assert.equal(context.dispatchPaused, false);
}
console.log('Passed: queued local completions win shared arbitration; retries preserve cancellation and skip uploads');

{
    const storage = new MemoryStorage();
    const cache = createDecisionCache(storage, { now: () => freshnessTime });
    const url = 'https://evict.example/page';
    const other = 'https://evict.example/other';
    const writing = cache.put([ { url, verdict: 'candidate' }, { url: other, verdict: 'candidate' } ], fingerprint);
    const generation = cache.writeGeneration;
    const removing = cache.remove(url, fingerprint);
    assert.equal(cache.writeGeneration, generation + 1, 'Eviction invalidates an already queued shared read');
    await Promise.all([ writing, removing ]);
    const restored = createDecisionCache(storage, { now: () => freshnessTime });
    assert.equal(await restored.getObservation(url, fingerprint), undefined, 'Eviction survives a fresh cache instance');
    assert.equal((await restored.getObservation(other, fingerprint)).verdict, 'candidate', 'Eviction is page-specific');
}
console.log('Passed: page eviction is serialized, generation-visible and persistent without retaining malware');
