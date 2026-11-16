import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL(
    '../../src/js/scriptlet-filtering.js', import.meta.url
), 'utf8');
// Execute the production registerer without loading the background engine.
const registererSource = source.slice(
    source.indexOf('const contentScriptRegisterer ='),
    source.indexOf('onOrdinaryCookieStoresChanged(')
);

function fixture({ cookieStoreId = [ 'firefox-default' ] } = {}) {
    const requests = [];
    const registerer = runInNewContext(
        `${registererSource}\ncontentScriptRegisterer;`, {
            Promise,
            ordinaryCookieStoreIds: () => cookieStoreId,
            browser: { contentScripts: { register(options) {
                let resolve, reject;
                const promise = new Promise((res, rej) => {
                    resolve = res;
                    reject = rej;
                });
                const handle = {
                    unregisterCalls: 0,
                    unregister() { this.unregisterCalls++; },
                };
                requests.push({ options, resolve, reject, handle });
                return promise;
            } } },
        }
    );
    return { registerer, requests, cookieStoreId };
}

const hostname = 'example.test';

{
    const { registerer, requests } = fixture({ cookieStoreId: null });
    assert.equal(registerer.register(hostname, 'code'), false,
        'Mobile uses the tab-specific injection fallback');
    assert.equal(requests.length, 0,
        'Automatic scripts must not reach shared-private inspection tabs');
    assert.equal(registerer.hostnameToDetails.size, 0);

    const injections = [];
    const method = source.slice(source.indexOf('    injectNow(details) {'),
        source.indexOf('    toLogger(request, details) {'));
    const engine = runInNewContext(`new (class { ${method} })()`, {
        contentScriptRegisterer: registerer,
        hostnameFromURI: url => new URL(url).hostname,
        domainFromHostname: host => host,
        logger: { enabled: false },
        µb: { hiddenSettings: {} },
        vAPI: { tabs: { executeScript: (...args) => injections.push(args) } },
    });
    engine.retrieve = () => ({ code: 'ordinary-tab-script' });
    const traffic = readFileSync(new URL('../../src/js/traffic.js', import.meta.url), 'utf8');
    const respond = runInNewContext(traffic.slice(traffic.indexOf('function onResponseStarted('),
        traffic.indexOf('onResponseStarted.start =')) + ';onResponseStarted', {
        isInspectionTab: id => id === 91,
        isGecko: true,
        µb: { pageStoreFromTabId: () => ({
            getNetFilteringSwitch: () => true,
            getFrameAncestorDetails: () => [],
        }) },
        scriptletFilteringEngine: engine,
    });
    respond({ tabId: 91, frameId: 0, url: 'https://example.test/inspection' });
    assert.equal(injections.length, 0, 'Inspection tabs receive no page-altering scripts');
    respond({ tabId: 92, frameId: 0, url: 'https://example.test/ordinary' });
    assert.equal(injections.length, 1, 'Ordinary mobile tabs retain scriptlet filtering');
    assert.equal(injections[0][0], 92);
    assert.equal(injections[0][1].code, 'ordinary-tab-script');
}

for ( const action of [ 'reset', 'unregister' ] ) {
    const { registerer, requests, cookieStoreId } = fixture();
    assert.equal(registerer.register(hostname, 'old code'), false);
    const pending = registerer.hostnameToDetails.get(hostname).handle;
    const request = requests[0];
    assert.equal(request.options.cookieStoreId, cookieStoreId);
    assert.deepEqual(Array.from(request.options.matches), [ '*://*.example.test/*' ]);
    assert.equal(request.options.js[0].code, 'old code');
    assert.equal(request.options.allFrames, true);
    assert.equal(request.options.matchAboutBlank, true);
    assert.equal(request.options.runAt, 'document_start');
    registerer[action](hostname);
    request.resolve(request.handle);
    await pending;
    assert.equal(request.handle.unregisterCalls, 1, `${action}: late handle removed`);
    assert.equal(registerer.hostnameToDetails.size, 0);
}

for ( const action of [ 'replace', 'refreshCookieStores' ] ) {
    const { registerer, requests } = fixture();
    registerer.register(hostname, 'old code');
    const pending = registerer.hostnameToDetails.get(hostname).handle;
    if ( action === 'replace' ) {
        registerer.register(hostname, 'new code');
    } else {
        registerer.refreshCookieStores();
    }
    const replacement = registerer.hostnameToDetails.get(hostname);
    const replacementPending = replacement.handle;
    requests[1].resolve(requests[1].handle);
    await replacementPending;
    requests[0].resolve(requests[0].handle);
    await pending;
    assert.equal(requests[0].handle.unregisterCalls, 1, `${action}: old handle removed`);
    assert.equal(registerer.hostnameToDetails.get(hostname), replacement);
    assert.equal(replacement.handle, requests[1].handle);
    assert.equal(requests[1].handle.unregisterCalls, 0);
    assert.equal(registerer.register(hostname, replacement.code), true);
    registerer.unregister(hostname);
    assert.equal(requests[1].handle.unregisterCalls, 1);
}

for ( const resolved of [ false, true ] ) {
    const { registerer, requests } = fixture();
    registerer.register(hostname, 'old code');
    const pending = registerer.hostnameToDetails.get(hostname).handle;
    registerer.reset();
    registerer.register(hostname, 'new code');
    const replacement = registerer.hostnameToDetails.get(hostname);
    const replacementPending = replacement.handle;
    if ( resolved ) {
        requests[1].resolve(requests[1].handle);
        await replacementPending;
    }
    requests[0].reject(new Error('stale registration failure'));
    await pending;
    assert.equal(registerer.hostnameToDetails.get(hostname), replacement,
        'stale rejection preserves the replacement, pending or resolved');
    if ( resolved === false ) {
        requests[1].resolve(requests[1].handle);
        await replacementPending;
    }
    assert.equal(replacement.handle, requests[1].handle);
    registerer.reset();
    assert.equal(requests[1].handle.unregisterCalls, 1);
}

{
    const { registerer, requests } = fixture();
    registerer.register(hostname, 'code');
    const pending = registerer.hostnameToDetails.get(hostname).handle;
    requests[0].reject(new Error('current registration failure'));
    await pending;
    assert.equal(registerer.hostnameToDetails.has(hostname), false);
}

console.log('Passed: mobile inspection isolation, ordinary injection fallback and scriptlet registration races');
