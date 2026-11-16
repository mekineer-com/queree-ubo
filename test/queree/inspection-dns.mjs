import { domainFromHostname, hostnameFromNetworkURL, hostnameFromURI, originFromURI } from '../../src/js/uri-utils.js';
import { FilteringContext } from '../../src/js/filtering-context.js';
import assert from 'node:assert/strict';
import { communityDomainFromHostname } from '../../src/js/queree/community-domains.js';
import { domainToASCII } from 'node:url';
import { needsCharacteristicChecks } from '../../src/js/queree/decision-cache.js';
import { personalDisplayRecord } from '../../src/js/queree/personal-categories.js';
import publicSuffixList from '../../src/lib/publicsuffixlist/publicsuffixlist.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const section = (source, start, end) => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from !== -1 && to > from, start);
    return source.slice(from, to);
};
const common = read('platform/common/vapi-background.js');
const firefox = read('platform/firefox/vapi-background-ext.js');
const background = read('src/js/background.js');
const traffic = read('src/js/traffic.js');
const controller = read('src/js/queree/controller.js');
publicSuffixList.parse('example\ntest\n', domainToASCII);

const pageURL = 'https://publisher.example/article?keep=1';
const aliasHost = 'ads.vendor.test';
const ip = '192.0.2.6';
const dnsRecord = cname => ({
    addresses: [ ip ],
    ...(cname ? { canonicalName: aliasHost } : {}),
});
const request = (type = 'main_frame', extra = {}) => ({
    tabId: 1, requestId: 'request', method: 'GET', type,
    url: type === 'main_frame' ? pageURL : 'https://metrics.publisher.example/asset?q=1',
    frameId: type === 'sub_frame' ? 2 : 0,
    parentFrameId: type === 'sub_frame' ? 0 : -1,
    ...(type === 'main_frame' ? {} : { documentUrl: pageURL }),
    ...extra,
});

class CountedSet extends Set {
    adds = 0;
    add(value) { this.adds += 1; return super.add(value); }
}

function harness(options = {}) {
    const job = {
        finished: false, navigationId: 0, destinationURL: pageURL,
        documentURLs: new Set([ pageURL ]), sourceCategories: [],
        requests: new CountedSet(), requestHosts: new CountedSet(),
    };
    const inspectionTabs = new Map(options.ordinary ? [] : [[ 1, job ]]);
    const state = {
        matches: [], malwareMatches: [], pushes: [], ordinary: [], resolutions: [], finishes: [],
        rootResets: 0, destinationChecks: 0, completions: 0,
    };
    const tabContexts = new Map();
    const tabContext = tabId => {
        if ( tabContexts.has(tabId) === false ) {
            tabContexts.set(tabId, {
                tabId, origin: originFromURI(pageURL), rawURL: pageURL,
                rootHostname: hostnameFromURI(pageURL),
                rootDomain: domainFromHostname(hostnameFromURI(pageURL)),
            });
        }
        return tabContexts.get(tabId);
    };
    const ordinary = (kind, context) => {
        assert.equal(inspectionTabs.has(context.tabId), false, 'Inspection reached ordinary uBO');
        state.ordinary.push([ kind, context.url ]);
    };
    const pageStore = {
        filterRequest(context) {
            ordinary('filter', context);
            context.redirectURL = options.redirectURL;
            return options.result || 0;
        },
        journalAddRequest(context, result) { ordinary(`journal:${result}`, context); },
        setFrameURL(details) { ordinary('frame', details); },
    };
    const ub = {
        normalizeTabURL: (_id, url) => url,
        tabContextManager: {
            mustLookup: tabContext,
            push(tabId, url) {
                state.pushes.push(url);
                tabContexts.set(tabId, {
                    tabId, rawURL: url, origin: originFromURI(url),
                    rootHostname: hostnameFromURI(url),
                    rootDomain: domainFromHostname(hostnameFromURI(url)),
                });
            },
        },
        pageStoreFromTabId: () => pageStore,
    };
    let listener;
    let now = 0;
    const api = { setDefaultIcon() {}, getURL: path => `moz-extension://test${path}` };
    const hooks = runInNewContext([
        section(common, 'vAPI.Net = class {', 'vAPI.scriptletsInjector ='),
        section(firefox, 'const dnsAPI =', 'vAPI.scriptletsInjector ='),
        section(background, 'µBlock.FilteringContext =', 'self.µBlock ='),
        section(controller, 'const firefoxRestrictedHosts =', 'async function prepareProfile('),
        section(controller, 'function contextDetails(', 'export function filterInspectionHeaders('),
        section(controller, 'function resetDestination(', 'function cancelJobs('),
        section(traffic, 'function onBeforeRequest(', 'function onBeforeRootFrameRequest('),
        'const net = new vAPI.Net();',
        'net.setSuspendableListener(onBeforeRequest);',
        '({ net, inspectionRequestFinished });',
    ].join('\n').replace(/^export /gm, ''), {
        FilteringContext, URL, Promise, domainFromHostname, hostnameFromURI,
        needsCharacteristicChecks, personalDisplayRecord, settings: () => ({ personalCategories: [] }),
        hostnameFromNetworkURL, originFromURI, communityDomainFromHostname,
        Date: class extends Date { static now() { return ++now; } },
        vAPI: api, µBlock: ub, µb: ub, inspectionTabs, inspectionPopups: new Set(),
        browser: {
            dns: { resolve(hostname) {
                state.resolutions.push(hostname);
                return options.resolveDNS ? options.resolveDNS() : Promise.resolve(options.record || {});
            } },
            webRequest: {
                ResourceType: { main_frame: 'main_frame', script: 'script', sub_frame: 'sub_frame' },
                onBeforeRequest: { addListener(callback) { listener = callback; } },
            },
        },
        isInspectionTab: id => inspectionTabs.has(id),
        matchTrackingRequest: () => ({ result: 0 }),
        matchMalwareRequest(details) {
            state.malwareMatches.push(details);
            return options.malwareMatch ? options.malwareMatch(details, job) : { result: 0 };
        },
        policyCommand({ details }) {
            state.matches.push(details);
            return options.match ? options.match(details, job) : { result: 0 };
        },
        profileId: 'test-profile', safetyExclusionReasons: () => [],
        sourceDecision: () => undefined,
        deterministicExclusionReasons() { state.destinationChecks += 1; return []; },
        clearRecovery() {}, resetScroll() { state.rootResets += 1; }, clearTimeout() {},
        scheduleCompletion() { state.completions += 1; },
        record: (_job, verdict, reasons) => ({ verdict, reasons }),
        exclusionRecord: (_job, reasons) => ({ verdict: 'exclude', reasons: [ ...(_job.exclusionReasons || []), ...reasons ] }),
        finish(target, result) { target.finished = true; state.finishes.push(result); },
        logger: { enabled: false },
        patchLocalRedirectURL: url => url.startsWith('/') ? api.getURL(url) : url,
        onBeforeRootFrameRequest(context) { ordinary('root', context); return { cancel: false }; },
        onBeforeBehindTheSceneRequest(context) { ordinary('background', context); return { cancel: false }; },
    });
    return {
        ...hooks, job, state, inspectionTabs, context: ub.filteringContext,
        dispatch: details => listener(details),
        cache(details, record) { hooks.net.dnsToCache(hostnameFromNetworkURL(details.url), record, details); },
    };
}

// Real native listener -> Firefox DNS dispatch -> traffic -> controller/context.
for ( const type of [ 'main_frame', 'script', 'sub_frame' ] ) {
    for ( const cname of [ false, true ] ) {
        for ( const cached of [ false, true ] ) {
            const h = harness({ record: dnsRecord(cname) });
            const details = request(type);
            const originalURL = details.url;
            if ( cached ) { h.cache(details, dnsRecord(cname)); }
            assert.equal(await h.dispatch(details), undefined);
            const { job, state } = h;
            assert.equal(state.matches.length, cname || cached === false ? 2 : 1);
            assert.equal(state.resolutions.length, cached ? 0 : 1);
            const canonicalURL = new URL(originalURL);
            canonicalURL.hostname = aliasHost;
            assert.equal(state.matches.at(-1).url, cname ? canonicalURL.href : originalURL);
            assert.equal(state.matches.at(-1).ipaddress, ip);
            assert.equal(state.matches.at(-1).originURL, originFromURI(pageURL));
            assert.equal(state.matches.at(-1).tabOriginURL, originFromURI(pageURL));
            assert.equal(job.destinationURL, pageURL);
            assert.equal(job.navigationId, type === 'main_frame' ? 1 : 0);
            assert.equal(state.rootResets, type === 'main_frame' ? 1 : 0);
            assert.equal(state.destinationChecks, type === 'main_frame' ? 1 : 0);
            assert.deepEqual(state.pushes, type === 'main_frame' ? [ originalURL ] : []);
            assert.equal(job.requests.size, 1);
            assert.equal(job.requests.adds, 1, 'DNS replay must not insert another request');
            assert.equal(job.requestHosts.adds, 1);
            assert.deepEqual([ ...job.requestHosts ], [ hostnameFromURI(originalURL) ]);
            assert.deepEqual(state.ordinary, []);
            assert.equal(details.quereeContext.url, originalURL);
            assert.notEqual(details.quereeContext, h.context);
            const completed = { ...request(type), statusCode: 200 };
            h.inspectionRequestFinished(completed);
            h.inspectionRequestFinished(completed);
            assert.equal(job.requests.size, 0);
            assert.equal(state.completions, 1, 'One native completion settles the request once');
        }
    }
}

for ( const cname of [ false, true ] ) {
    for ( const cached of [ false, true ] ) {
        for ( const type of [ 'main_frame', 'script' ] ) {
            const h = harness({ record: dnsRecord(cname), match: details => ({
                result: cname ? Number(details.url.includes(aliasHost)) : Number(details.ipaddress === ip),
                raw: 'synthetic-dns-rule',
            }) });
            const details = request(type);
            const originalURL = details.url;
            if ( cached ) { h.cache(details, dnsRecord(cname)); }
            assert.equal((await h.dispatch(details)).cancel, true);
            assert.equal(h.state.finishes.length, 1);
            const canonicalURL = new URL(originalURL);
            canonicalURL.hostname = aliasHost;
            assert.equal(h.state.finishes[0].reasons[0].request_url, cname ? canonicalURL.href : originalURL);
            assert.equal(h.job.navigationId, type === 'main_frame' ? 1 : 0);
            assert.deepEqual(h.state.ordinary, []);
        }
    }
}

// Advertising exceptions cannot waive malware checks on resolved CNAME/IP data.
for ( const cached of [ false, true ] ) {
    const excepted = harness({ record: dnsRecord(true), match: () => ({ result: 2 }) });
    const details = request('script');
    if ( cached ) { excepted.cache(details, dnsRecord(true)); }
    assert.equal(await excepted.dispatch(details), undefined,
        'Safe advertising exceptions allow native DNS replay instead of an early explicit return');
    assert.equal(excepted.state.malwareMatches.at(-1).url, `https://${aliasHost}/asset?q=1`);
    assert.equal(excepted.state.malwareMatches.at(-1).ipaddress, ip);
    assert.equal(excepted.state.resolutions.length, cached ? 0 : 1);
    assert.equal(excepted.job.requests.size, 1);
    assert.equal(excepted.state.finishes.length, 0, 'A safe excepted resource must not exclude its page');
    assert.deepEqual(excepted.state.ordinary, [], 'Safe explicit allows never fall through to ordinary uBO');
}
const rootException = harness({ record: dnsRecord(true), match: () => ({ result: 2 }) });
assert.equal(await rootException.dispatch(request()), undefined);
assert.equal(rootException.state.matches.length, 2);

for ( const cached of [ false, true ] ) {
    const h = harness({ record: dnsRecord(true), match: details => ({
        result: Number(details.url === `https://${aliasHost}/article?keep=1`), raw: 'path-specific-alias-rule',
    }) });
    h.net.cnameUncloakEnabled = false;
    h.net.dnsResolveEnabled = false;
    h.net.cnameIgnoreList = /^./;
    const details = request();
    if ( cached ) { h.cache(details, dnsRecord(true)); }
    assert.equal((await h.dispatch(details)).cancel, true,
        'Quer.ee uses full aliases independently of ordinary DNS and CNAME preferences');
    assert.equal(h.state.finishes[0].reasons[0].request_url, `https://${aliasHost}/article?keep=1`);
    assert.equal(h.state.resolutions.length, cached ? 0 : 1,
        'A cache primed with an ordinary ignored alias needs no duplicate lookup');
}
{
    const h = harness({ ordinary: true });
    h.net.dnsResolveEnabled = false;
    h.net.cnameUncloakEnabled = false;
    await h.dispatch(request('script'));
    assert.equal(h.state.resolutions.length, 0, 'Ordinary requests still honor disabled DNS resolution');
    assert.equal(h.state.ordinary.length, 2);
}

for ( const cname of [ false, true ] ) {
    for ( const cached of [ false, true ] ) {
        for ( const type of [ 'main_frame', 'script', 'sub_frame' ] ) {
            const h = harness({
                record: dnsRecord(cname),
                match: () => ({ result: 2 }),
                malwareMatch: details => ({
                    result: Number(cname ? details.url.includes(aliasHost) : details.ipaddress === ip),
                    raw: 'synthetic-malware-dns-rule',
                }),
            });
            const details = request(type);
            if ( cached ) { h.cache(details, dnsRecord(cname)); }
            assert.equal((await h.dispatch(details)).cancel, true,
                `Malware ${cname ? 'CNAME' : 'IP'} survives advertising exception; ${type}, cached=${cached}`);
            assert.equal(h.state.finishes.length, 1);
            assert.equal(h.state.finishes[0].verdict, 'exclude');
            assert.equal(h.state.finishes[0].reasons[0].kind, 'malware');
            assert.equal(h.state.finishes[0].reasons[0].rule, 'synthetic-malware-dns-rule');
            assert.deepEqual(h.state.ordinary, []);
        }
    }
}

const cleanedURL = 'https://publisher.example/clean';
const cleaned = harness({ match: () => ({ result: 0, redirectURL: cleanedURL }) });
assert.equal((await cleaned.dispatch(request())).redirectUrl, cleanedURL);
assert.deepEqual(cleaned.state.resolutions, []);
const aliasRedirect = harness({ record: dnsRecord(true), match: details => ({
    result: 0, ...(details.url.includes(aliasHost) ? { redirectURL: `https://${aliasHost}/clean` } : {}),
}) });
assert.equal(await aliasRedirect.dispatch(request()), undefined);
assert.equal(aliasRedirect.job.destinationURL, pageURL);
assert.deepEqual(aliasRedirect.state.pushes, [ pageURL ]);

// Resolve an old root only after a new document overwrites the shared context.
for ( const [ malware, ownershipRemoved ] of [ [ false, false ], [ false, true ], [ true, false ], [ true, true ] ] ) {
    let resolveDNS;
    const pendingDNS = new Promise(resolve => { resolveDNS = resolve; });
    const h = harness({ resolveDNS: () => pendingDNS, [malware ? 'malwareMatch' : 'match']: details => ({
        result: Number(details.url.includes(aliasHost)), raw: 'late-alias',
    }) });
    const old = request();
    const pending = h.dispatch(old);
    const replacementURL = 'https://replacement.example/next';
    const replacement = request('main_frame', {
        // Redirect hops may retain the request ID; URL identity must also agree.
        url: replacementURL, proxyInfo: { proxyDNS: true },
    });
    assert.equal(await h.dispatch(replacement), undefined);
    if ( ownershipRemoved ) { h.inspectionTabs.delete(1); }
    resolveDNS(dnsRecord(true));
    const result = await pending;
    assert.equal(result?.cancel, ownershipRemoved ? undefined : true);
    assert.equal(h.job.destinationURL, replacementURL);
    assert.equal(h.job.navigationId, 2);
    assert.equal(h.job.requests.adds, 2);
    assert.deepEqual(h.state.pushes, [ pageURL, replacementURL ]);
    assert.deepEqual(h.state.ordinary, []);
    assert.deepEqual(h.state.finishes, []);
    if ( ownershipRemoved === false ) {
        assert.equal(h.state[malware ? 'malwareMatches' : 'matches'].at(-1).originURL, originFromURI(pageURL));
    }
}

// A reused private tab can inspect the very same URL under a different job.
for ( const malware of [ false, true ] ) {
    for ( const cname of [ false, true ] ) {
        for ( const type of [ 'script', 'sub_frame' ] ) {
            let resolveDNS;
            const pendingDNS = new Promise(resolve => { resolveDNS = resolve; });
            const h = harness({
                resolveDNS: () => pendingDNS,
                [malware ? 'malwareMatch' : 'match']: details => ({
                    result: Number(cname ? details.url.includes(aliasHost) : details.ipaddress === ip),
                    raw: 'previous-job-dns-evidence',
                }),
            });
            const pending = h.dispatch(request(type));
            const replacement = {
                ...h.job, navigationId: 0, rootRequestId: undefined,
                documentId: undefined, committedNavigationId: undefined,
                requests: new CountedSet(), requestHosts: new CountedSet(),
            };
            h.inspectionTabs.set(1, replacement);
            const before = [ h.state.matches.length, h.state.malwareMatches.length ];
            resolveDNS(dnsRecord(cname));
            assert.equal(await pending, undefined, 'An old DNS replay belongs to neither the new job nor ordinary uBO');
            assert.deepEqual([ h.state.matches.length, h.state.malwareMatches.length ], before);
            assert.deepEqual(h.state.finishes, []);
            assert.deepEqual(h.state.ordinary, []);
            assert.equal(replacement.requests.size, 0);
            assert.equal(replacement.requestHosts.size, 0);
            assert.equal(replacement.finished, false);
        }
    }
}

// Ordinary requests retain their original routes, outcomes and frame bookkeeping.
for ( const result of [ 0, 1, 2 ] ) {
    const h = harness({ ordinary: true, result });
    const details = request('script', { proxyInfo: { proxyDNS: true } });
    assert.equal((await h.dispatch(details))?.cancel, result === 0 ? undefined : result === 1);
    assert.deepEqual(h.state.ordinary.map(([ kind ]) => kind), [ 'filter', `journal:${result}` ]);
    assert.equal(h.state.matches.length, 0);
    assert.equal(details.quereeContext, undefined);
}
const ordinaryRedirect = harness({ ordinary: true, redirectURL: '/local-resource' });
assert.equal((await ordinaryRedirect.dispatch(request('script'))).redirectUrl, 'moz-extension://test/local-resource');
for ( const [ type, tabId, routes ] of [
    [ 'main_frame', 1, [ 'root' ] ],
    [ 'script', -1, [ 'background' ] ],
    [ 'sub_frame', 1, [ 'filter', 'journal:0', 'frame' ] ],
] ) {
    const h = harness({ ordinary: true });
    const details = request(type, { tabId, proxyInfo: { proxyDNS: true } });
    await h.dispatch(details);
    assert.deepEqual(h.state.ordinary.map(([ kind ]) => kind), routes);
    assert.equal(h.state.matches.length, 0);
    assert.equal(details.quereeContext, undefined);
}
const ordinaryAlias = harness({ ordinary: true });
const frame = request('sub_frame');
ordinaryAlias.cache(frame, dnsRecord(true));
assert.equal(await ordinaryAlias.dispatch(frame), undefined);
assert.deepEqual(ordinaryAlias.state.ordinary.map(([ kind ]) => kind), [
    'filter', 'journal:0', 'frame', 'filter', 'journal:0',
]);
assert.equal(ordinaryAlias.state.ordinary.at(-1)[1], `https://${aliasHost}/`);
assert.equal(frame.quereeContext, undefined, 'Ordinary DNS replay keeps native frame bookkeeping');

{
    const h = harness({ record: dnsRecord(true) });
    h.net.dnsResolveEnabled = false;
    h.net.cnameUncloakEnabled = false;
    await h.dispatch(request());
    assert.equal(h.net.dnsDict.size, 0, 'Inspection DNS never fills the ordinary ring');
    assert.equal(h.net.inspectionDNS.size, 1);
    h.inspectionTabs.clear();
    const ordinary = request('script');
    await h.dispatch(ordinary);
    assert.equal(ordinary.ip, undefined, 'Inspection IP evidence cannot enable ordinary IP rules');
    assert.equal(ordinary.aliasURL, undefined, 'Inspection aliases cannot enable ordinary CNAME rules');
    assert.equal(h.state.resolutions.length, 1, 'Disabled ordinary DNS remains disabled after inspection');
    for ( let i = 0; i < 140; i++ ) {
        h.net.dnsToCache(`host-${i}.example`, dnsRecord(true), { quereeContext: {} });
    }
    assert.equal(h.net.inspectionDNS.size, 128, 'Inspection DNS has its own bounded cache');
    assert.equal(h.net.dnsWritePtr, 0, 'Inspection churn cannot evict ordinary entries');
}
{
    let attempts = 0;
    const h = harness({ resolveDNS: () => ++attempts === 1
        ? Promise.reject(new Error('Resolver blip')) : Promise.resolve(dnsRecord(true)) });
    await h.dispatch(request());
    assert.equal(h.net.inspectionDNS.size, 0, 'Failed inspection DNS is not negatively cached');
    await h.dispatch(request('script', { requestId: 'retry' }));
    assert.equal(attempts, 2);
    assert.equal(h.state.matches.at(-1).url, `https://${aliasHost}/asset?q=1`);
}
{
    let resolveDNS;
    const h = harness({ resolveDNS: () => new Promise(resolve => { resolveDNS = resolve; }),
        match: details => ({ result: Number(details.url.includes(aliasHost)), raw: 'old-route' }) });
    const pending = h.dispatch(request('script'));
    await h.dispatch(request('main_frame', { proxyInfo: { proxyDNS: true } }));
    resolveDNS(dnsRecord(true));
    await pending;
    assert.equal(h.state.finishes.length, 0, 'A same-URL reload rejects the prior document DNS replay without UUIDs');
}

console.log('Passed: native DNS replay isolates caches, retries failures and rejects same-URL stale evidence');
