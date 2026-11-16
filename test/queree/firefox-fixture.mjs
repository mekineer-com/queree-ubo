import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { replaceOnce, verifyFixtureSources } from '../../tools/queree-fixture-sources.mjs';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { canonicalPageURL } from '../../src/js/queree/decision-cache.js';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '../..');
const affiliation = 'We are not affiliated with or endorsed by the uBlock Origin project.';
for ( const page of [ 'about.html', 'queree.html', 'support.html' ] ) {
    const html = await readFile(resolve(root, 'src', page), 'utf8');
    assert.ok(html.includes(affiliation), page);
    assert.match(html, /Team GhostMaker/);
}
for ( const page of (await readdir(resolve(root, 'src'))).filter(name => name.endsWith('.html') && name !== 'background.html') ) {
    const html = await readFile(resolve(root, 'src', page), 'utf8');
    const title = html.match(/<title[^>]*>([^<]*)<\/title>/)?.[1] || '';
    assert.doesNotMatch(title, /uBlock|uBO(?!\+Q)/, page);
}
const support = await readFile(resolve(root, 'src/support.html'), 'utf8');
assert.match(support, /id="bugReport"[^>]+data-url="https:\/\/quer\.ee\/about\/#contact"/);
assert.match(support, /id="filterReport"[^>]+data-url="https:\/\/github\.com\/uBlockOrigin\/uAssets\//);
assert.ok(support.slice(support.indexOf('<div class="e">')).includes(affiliation), 'Quick filter-report mode must not hide the affiliation notice');
assert.doesNotMatch(await readFile(resolve(root, 'src/js/support.js'), 'utf8'), /addDetailsToReportURL\('bugReport'/,
    'Opening our contact page must not append troubleshooting data to its URL');
const background = await readFile(resolve(root, 'src/background.html'), 'utf8');
const backgroundTitle = background.match(/<title>([^<]*)<\/title>/)[1];
assert.ok((await readFile(resolve(root, 'src/js/i18n.js'), 'utf8')).includes(`document.title === '${backgroundTitle}'`),
    'The background title is an internal identity check, not a user-facing brand label');
console.log('Passed: fork identity is explicit, visible in quick reporting and separate from genuine upstream tools');
const source = await readFile(resolve(root, 'test/queree/run-firefox.mjs'), 'utf8');
function section(from, to) {
    assert(source.includes(from) && source.includes(to), 'Browser fixture section must exist');
    return source.slice(source.indexOf(from), source.indexOf(to));
}
assert.equal(replaceOnce('before needle after', 'needle', '$&'), 'before $& after');
assert.throws(() => replaceOnce('missing', 'needle', 'replacement'), /Expected one fixture anchor/);
assert.throws(() => replaceOnce('needle needle', 'needle', 'replacement'), /Expected one fixture anchor/);

const work = await mkdtemp(resolve(tmpdir(), 'queree-fixture-unit-'));
const extension = resolve(work, 'extension');
const put = async (path, value) => {
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(path, value);
};
try {
    const tree = resolve(work, 'source');
    for ( const directory of [ 'src/js', 'src/lib', 'src/css', 'src/web_accessible_resources', 'src/img', 'src/_locales', 'platform/common', 'platform/firefox',
        'assets/queree', 'dist/build/uAssets/main', 'dist/build/uAssets/prod' ] ) {
        await mkdir(resolve(tree, directory), { recursive: true });
    }
    for ( const [ path, contents ] of [
        [ 'src/js/queree/decision.js', 'current decision' ],
        [ 'src/lib/library.js', 'current library' ],
        [ 'src/css/panel.css', 'current styles' ],
        [ 'src/web_accessible_resources/noop.js', 'current redirect' ],
        [ 'src/img/icon.svg', 'current image' ],
        [ 'src/img/icon_128.png', 'removed Firefox icon' ],
        [ 'LICENSE.txt', 'GPL' ], [ 'THIRD_PARTY_NOTICES.txt', 'notices' ],
        [ 'platform/common/managed_storage.json', '{}' ],
        [ 'src/panel.html', 'current panel' ],
        [ 'src/js/vapi.js', 'generic' ],
        [ 'platform/common/vapi.js', 'common' ],
        [ 'platform/firefox/vapi.js', 'firefox' ],
        [ 'src/assets/queree/domain-index.bin', 'current data' ],
        [ 'src/js/queree/vendor/adult-domains.js', 'generator-only' ],
        [ 'dist/version', '2.2.16\n' ],
        [ 'platform/firefox/manifest.json', '{"permissions":["tabs"],"sidebar_action":{}}' ],
        [ 'assets/queree/popupads.txt', 'current fallback' ],
        [ 'assets/queree/website-lists/affiliate-links/soteria.txt', 'current Soteria input' ],
        [ 'assets/queree/website-lists/affiliate-links/SOTERIA_README.md', 'current data terms' ],
        [ 'assets/queree/website-lists/affiliate-links/dropship-redirects.txt', 'current Dropship input' ],
        [ 'dist/build/uAssets/prod/filters/badware.min.txt', 'current badware' ],
        [ 'dist/build/uAssets/main/thirdparties/publicsuffix.org/list/effective_tld_names.dat', 'current suffixes' ],
    ] ) { await put(resolve(tree, path), contents); }
    const messages = { extName: { message: 'Quer.ee' }, extShortDesc: { message: 'Search' }, dashboardName: { message: 'Settings' },
        statsPageName: { message: 'uBO+Q - Logger' }, aboutBackupFilename: { message: 'my-ubo-q-backup.txt' },
        supportS4P1: { message: 'Quer.ee support' }, aboutCDNs: { message: "uBO's upstream lists" } };
    for ( const locale of [ 'en', 'nb' ] ) {
        const original = locale === 'en' ? messages : { ...messages,
            statsPageName: { message: 'uBlock₀ - Logger' }, aboutBackupFilename: { message: 'my-ublock-backup.txt' },
            supportS4P1: { message: 'upstream support' } };
        await put(resolve(tree, `src/_locales/${locale}/messages.json`), JSON.stringify(original));
    }
    for ( const locale of [ 'en', 'nb', 'no' ] ) {
        await put(resolve(extension, `_locales/${locale}/messages.json`), JSON.stringify(messages, null, 2));
    }
    await put(resolve(extension, 'manifest.json'), JSON.stringify({ version: '2.2.16', permissions: [ 'tabs' ] }));
    for ( const [ path, contents ] of [
        [ 'js/queree/decision.js', 'current decision' ], [ 'lib/library.js', 'current library' ],
        [ 'css/panel.css', 'current styles' ], [ 'panel.html', 'current panel' ],
        [ 'web_accessible_resources/noop.js', 'current redirect' ],
        [ 'img/icon.svg', 'current image' ],
        [ 'LICENSE.txt', 'GPL' ], [ 'THIRD_PARTY_NOTICES.txt', 'notices' ],
        [ 'managed_storage.json', '{}' ],
        [ 'js/vapi.js', 'firefox' ], [ 'assets/queree/domain-index.bin', 'current data' ],
        [ 'assets/queree/popupads.txt', 'current fallback' ],
        [ 'assets/queree/website-lists/affiliate-links/soteria.txt', 'current Soteria input' ],
        [ 'assets/queree/website-lists/affiliate-links/SOTERIA_README.md', 'current data terms' ],
        [ 'assets/queree/website-lists/affiliate-links/dropship-redirects.txt', 'current Dropship input' ],
        [ 'assets/ublock/badware.min.txt', 'current badware' ],
        [ 'assets/thirdparties/publicsuffix.org/list/effective_tld_names.dat', 'current suffixes' ],
    ] ) { await put(resolve(extension, path), contents); }
    await verifyFixtureSources(tree, extension);
    for ( const path of [ 'js/queree/decision.js', 'lib/library.js', 'css/panel.css',
        'panel.html', 'js/vapi.js', 'assets/queree/domain-index.bin',
        'assets/queree/popupads.txt', 'assets/ublock/badware.min.txt',
        'assets/queree/website-lists/affiliate-links/soteria.txt',
        'assets/queree/website-lists/affiliate-links/SOTERIA_README.md',
        'assets/queree/website-lists/affiliate-links/dropship-redirects.txt',
        'assets/thirdparties/publicsuffix.org/list/effective_tld_names.dat' ] ) {
        const file = resolve(extension, path);
        const current = await readFile(file);
        await writeFile(file, 'old bytes with the same version');
        await assert.rejects(verifyFixtureSources(tree, extension), /Rebuild the test XPI: stale/);
        await writeFile(file, current);
    }
    for ( const path of [ 'web_accessible_resources/noop.js', 'img/icon.svg', 'LICENSE.txt', 'managed_storage.json', '_locales/no/messages.json' ] ) {
        const file = resolve(extension, path);
        const current = await readFile(file);
        await writeFile(file, path.startsWith('_locales/') ? JSON.stringify({ ...messages, extName: { message: 'old' } }) : 'old');
        await assert.rejects(verifyFixtureSources(tree, extension), /stale/);
        await writeFile(file, current);
    }
    await put(resolve(extension, 'web_accessible_resources/obsolete.js'), 'extra');
    await assert.rejects(verifyFixtureSources(tree, extension), /extra/);
    await rm(resolve(extension, 'web_accessible_resources/obsolete.js'));
    await writeFile(resolve(extension, 'manifest.json'), JSON.stringify({ version: '2.2.15' }));
    await assert.rejects(verifyFixtureSources(tree, extension), /version differs/);
    await writeFile(resolve(extension, 'manifest.json'), JSON.stringify({ version: '2.2.16' }));
    await assert.rejects(verifyFixtureSources(tree, extension), /stale manifest/);
    await writeFile(resolve(extension, 'manifest.json'), JSON.stringify({ version: '2.2.16', permissions: [ 'tabs' ] }));
    await rm(resolve(extension, 'js/queree/decision.js'));
    await assert.rejects(verifyFixtureSources(tree, extension), /ENOENT/);
    console.log('Passed: fixture freshness covers redirects, locales, images, metadata and extra files');

    const rewrites = source.slice(source.indexOf('    const backgroundPath ='),
        source.indexOf("    execFileSync('zip',"));
    for ( const mode of [ {}, { historyNavigationOnly: true }, { malwareOnly: true }, { routesOnly: true } ] ) {
        for ( const path of [ 'background.js', 'scriptlet-filtering.js',
            'queree/search-results.js', 'queree/contribution.js', 'queree/controller.js',
            'queree/contribution-core.js', 'queree/community-domains.js', 'queree/inspection-context.js' ] ) {
            await put(resolve(extension, 'js', path), await readFile(resolve(root, 'src/js', path)));
        }
        await vm.runInNewContext(`(async () => { ${rewrites} })()`, {
            readFile, writeFile, resolve, extension, replaceOnce,
            historyNavigationOnly: false, malwareOnly: false, retentionOnly: false, routesOnly: false,
            ...mode, server: { address: () => ({ port: 1234 }) },
        });
        assert.ok((await readFile(resolve(extension, 'js/background.js'), 'utf8')).includes('autoUpdate: false'));
        const results = await readFile(resolve(extension, 'js/queree/search-results.js'), 'utf8');
        const hookStart = results.indexOf('    function captureDuplicateCountDiagnostics()');
        const hookEnd = results.indexOf("    window.addEventListener('pageshow', onPageShow);", hookStart);
        assert(hookStart !== -1 && hookEnd > hookStart, 'The diagnostic hook must exist only in the fixture rewrite');
        const listeners = new Map(), shutdown = [], attributes = new Map();
        const rows = new Map([ 'ad-result', 'method-result', 'store-result', 'extra-ad-result' ].map(id => {
            const path = id === 'method-result' ? '/method' : id === 'store-result' ? '/store-global' : '/ad';
            const anchor = { href: `http://localhost:1234${path}` };
            return [ id, { id, className: 'MjjYud', parentElement: { id: 'search' },
                outerHTML: `<div id="${id}"></div>`, querySelector: () => ({ anchor }),
                matches: selector => selector === `#${id}` } ];
        }));
        const recorded = new Map([
            [ 'http://localhost:1234/ad', { verdict: 'exclude', reasons: [ { kind: 'advertising' } ], cached: true } ],
            [ 'http://localhost:1234/store-global', { verdict: 'candidate', shopping_signals: true } ],
        ]);
        const before = JSON.stringify(Array.from(recorded));
        const probe = vm.createContext({ URL, location: new URL('http://localhost:1234/search'),
            Event: class { constructor(type) { this.type = type; } },
            document: {
                addEventListener: (name, listener) => listeners.set(name, listener),
                removeEventListener: (name, listener) => { if ( listeners.get(name) === listener ) { listeners.delete(name); } },
                dispatchEvent: event => listeners.get(event.type)?.(),
                getElementById: id => rows.get(id) || null,
                querySelectorAll: () => [ rows.get('ad-result'), rows.get('store-result') ],
                documentElement: {
                    setAttribute: (name, value) => attributes.set(name, value),
                    getAttribute: name => attributes.get(name) ?? null,
                    removeAttribute: name => attributes.delete(name),
                },
            },
            adapter: { headingSelector: 'h3' }, resultAnchor: heading => heading.anchor,
            resultURL: anchor => new URL(anchor.href), recorded,
            selectorReasons: new Map([ [ '#ad-result', 'Advertising' ], [ '#store-result', 'Shopping' ] ]),
            getComputedStyle: () => ({ display: 'none' }), status: { textContent: '3 excluded, 1 unresolved' },
            running: false, activeBatches: new Set(), stylesheetOperationsPending: 0,
            excludedVisible: false, hidingUnavailable: false,
            vAPI: { shutdown: { add: callback => shutdown.push(callback) } },
        });
        vm.runInContext(results.slice(hookStart, hookEnd), probe);
        assert.equal(attributes.size, 0, 'Registering diagnostics must not read or publish inspection state');
        const captureDiagnostics = () => {
            listeners.get('quereeFixtureDuplicateDiagnostics')();
            return JSON.parse(attributes.get('data-queree-fixture-duplicate-diagnostics'));
        };
        const snapshot = captureDiagnostics();
        assert.deepEqual(snapshot.rows.map(row => row.id), Array.from(rows.keys()));
        assert.equal(snapshot.rows[0].savedDecision.verdict, 'exclude');
        assert.equal(snapshot.rows[1].savedDecision, null, 'A lost saved verdict must remain visible as missing');
        assert.equal(snapshot.rows[2].savedDecision.shopping_signals, true);
        assert.deepEqual(snapshot.rows[0].exclusionSelectorMatches, [ { selector: '#ad-result', reason: 'Advertising' } ]);
        assert.deepEqual(snapshot.rows[1].exclusionSelectorMatches, []);
        assert.deepEqual(snapshot.matchedContainers.map(row => row.id), [ 'ad-result', 'store-result' ]);
        rows.delete('extra-ad-result');
        const removed = captureDiagnostics().rows[3];
        assert.equal(removed.present, false);
        assert.equal(removed.savedDecision.verdict, 'exclude', 'Removed duplicates still identify the saved URL decision');
        assert.deepEqual(removed.exclusionSelectorMatches, []);
        assert.equal(JSON.stringify(Array.from(recorded)), before, 'Diagnostics must not mutate saved verdicts');
        probe.waitForValue = async () => { throw Error('Count timeout'); };
        probe.execute = async (endpoint, session, script) => vm.runInContext(`(() => { ${script} })()`, probe);
        vm.runInContext(section('async function waitForDuplicateCount(', 'async function runMalwareMode('), probe);
        await assert.rejects(probe.waitForDuplicateCount('fixture', 'session', 'after duplicate removal', '', () => false),
            /Count timeout[\s\S]*after duplicate removal[\s\S]*"id":"extra-ad-result","present":false[\s\S]*"verdict":"exclude"/);
        assert.equal(attributes.size, 0, 'Reading diagnostics must clear the temporary DOM attribute');
        shutdown.forEach(callback => callback());
        assert.equal(listeners.size, 0, 'A reinjected content script must not inherit a stale diagnostic listener');
        await assert.rejects(probe.waitForDuplicateCount('fixture', 'session', 'after duplicate removal', '', () => false),
            /Count timeout[\s\S]*hook unavailable/);
        const core = await readFile(resolve(extension, 'js/queree/contribution-core.js'), 'utf8');
        const normalization = vm.createContext({ URL, TextEncoder, TextDecoder,
            canonicalPageURL, sharedReasonKinds: new Set() });
        vm.runInContext(core.replace(/^import .*;\n/gm, '').replace(/^export \{.*\};\n/gm, '')
            .replace(/^export /gm, ''), normalization);
        for ( const host of [ 'localhost', 'community.localhost' ] ) {
            const url = `http://${host}:1234/shared-loading`;
            assert.equal(normalization.normalizeShareableURL(url), url,
                'Fixture addresses must actually reach contribution and shared lookup');
        }
        for ( const host of [ 'router.local', 'localhost.localdomain', '127.0.0.1' ] ) {
            assert.equal(normalization.normalizeShareableURL(`http://${host}/private`), undefined);
        }
        if ( mode.malwareOnly ) {
            const controller = await readFile(resolve(extension, 'js/queree/controller.js'), 'utf8');
            const fixture = controller.slice(controller.indexOf('const malwareFixtureOrigin ='));
            const compiled = (start, bad = '') =>
                `#block-start-NETWORK_FILTERS:GOOD\n${Array.from({ length: 120 }, (_, i) => `filter-${start + i}`).join('\n')}\n#block-end-NETWORK_FILTERS:GOOD\n` +
                `#block-start-NETWORK_FILTERS:BAD\n${bad}#block-end-NETWORK_FILTERS:BAD`;
            const lists = [ { assetKey: 'ublock-badware', content: compiled(0, 'filter-0\n') },
                { assetKey: 'urlhaus-1', content: compiled(100) } ];
            for ( const count of [ 219, 120, 0 ] ) {
                let listener;
                const reloads = [];
                const malwareFrame = { document: { documentElement: { dataset: {
                    quereeLoadState: 'ready', quereeLoadResult: JSON.stringify({ filterCount: count }),
                } } } };
                const adFrame = { document: { documentElement: { dataset: { quereeLoadState: 'ready' } } } };
                vm.runInNewContext(fixture, {
                    vAPI: { messaging: { listen: options => { listener = options.listener; } } },
                    loadMalwareEngine: async () => {}, loadEngine: async () => {},
                    requiredMalwareLists: lists.map(list => list.assetKey), requiredLists: [],
                    µb: { selectedFilterLists: [],
                        getCompiledFilterList: async key => lists.find(list => list.assetKey === key),
                        compileFilters: () => '' },
                    policyFrame: id => id ? malwareFrame : adFrame,
                    publicSuffixList: { toSelfie: () => ({}) }, profileCompiledLists: () => [],
                    loadPolicyFrame: async frame => { reloads.push(frame); return { filterCount: 225 }; },
                    policyCommand: () => ({ result: 0 }), matchMalwareRequest: () => ({ result: 1 }),
                });
                const reply = await new Promise(resolve => listener({ what: 'load' }, { privileged: true }, resolve));
                if ( count === 219 ) {
                    assert.equal(reply.error, undefined);
                    assert.equal(reply.productionFilters, 219);
                    assert.equal(reply.expectedProductionFilters, 219);
                    assert.equal(reloads.length, 2);
                    malwareFrame.document.documentElement.dataset.quereeLoadResult = JSON.stringify({ filterCount: 225 });
                    const refreshed = await new Promise(resolve => listener({ what: 'block-cache' }, { privileged: true }, resolve));
                    assert.equal(refreshed.error, undefined, 'Later fixture loads must not be mistaken for the native startup');
                    assert.equal(reloads.length, 4);
                } else {
                    assert.match(reply.error, /Production malware profile differs/);
                    assert.equal(reloads.length, 0, 'Fixture reloads cannot mask omitted production rules');
                }
            }
        }
    }
    console.log('Passed: stale/missing XPI inputs are rejected and every browser-fixture source rewrite applies exactly once');

    const readState = section('async function readInspectionState(', 'async function waitForResults(');
    for ( const leaked of [ false, true ] ) {
        const browser = {
            history: { getVisits: async () => [] },
            storage: { local: { get: async () => ({ quereeTestInspectionCookieStoreIds: [ 'earlier', 'last' ] }) } },
            contextualIdentities: { query: async () => leaked ? [
                { cookieStoreId: 'earlier', name: 'Quer.ee inspection' },
                { cookieStoreId: 'unrecorded', name: 'Quer.ee inspection' },
            ] : [] },
            tabs: { query: async () => [] },
            cookies: { getAll: async ({ storeId }) => {
                if ( leaked && storeId === 'earlier' ) { return [ { name: 'another-cookie' } ]; }
                if ( leaked && storeId === 'unrecorded' ) { return []; }
                throw Error('Removed store');
            } },
        };
        const context = vm.createContext({ browser, navigate: async () => {}, fetch: async () => {},
            webdriverRequest: async (endpoint, path, body) => {
                if ( path.endsWith('/execute/async') ) {
                    return new Promise(done => vm.runInNewContext(`(function () { ${body.script} })(done)`, { browser, done }));
                }
                return path.endsWith('/window/new') ? { handle: 'state' } : 'source';
            } });
        vm.runInContext(readState, context);
        const state = await context.readInspectionState('fixture', 'session', 'moz-extension://fixture', []);
        assert.equal(state.containers, leaked ? 2 : 0, 'Earlier and unrecorded containers must be detected');
        assert.equal(state.checkedContainers, leaked ? 3 : 2);
        assert.equal(state.cookies, leaked ? 1 : 0, 'Cleanup checks every cookie, not only one named cookie');
    }
    console.log('Passed: native malware feeds are validated before fixture reload; cleanup covers every inspection store');

    const statuses = [ '0 of 3 results inspected...', '2 excluded, 0 unresolved (still checking)',
        '2 excluded, 0 unresolved' ];
    const waiting = vm.createContext({ sleep: async () => {}, execute: async () => ({ status: statuses.shift() }) });
    vm.runInContext(section('async function waitForResults(', 'async function waitForValue('), waiting);
    assert.equal((await waiting.waitForResults('fixture', 'session')).status, '2 excluded, 0 unresolved');
    assert.equal(statuses.length, 0, 'Intermediate summaries cannot masquerade as completed inspections');

    const duplicateWait = section('async function waitForDuplicateCount(', 'async function runMalwareMode(');
    for ( const failure of [ false, true, 'diagnostic-error' ] ) {
        const timeout = new Error('Timed out waiting for browser value: "3 excluded, 1 unresolved"');
        let diagnosticReads = 0;
        const context = vm.createContext({
            waitForValue: async (endpoint, session, script, accept) => {
                assert.equal(script, 'return summary;');
                assert.equal(accept('4 excluded, 1 unresolved'), true);
                assert.equal(accept('3 excluded, 1 unresolved'), false);
                if ( failure ) { throw timeout; }
                return '4 excluded, 1 unresolved';
            },
            execute: async () => {
                diagnosticReads += 1;
                if ( failure === 'diagnostic-error' ) { throw Error('Diagnostic read failed'); }
                return { rows: [ { id: 'ad-result', savedDecision: { verdict: 'exclude' },
                    exclusionSelectorMatches: [ { selector: '#ad-result' } ] } ] };
            },
        });
        vm.runInContext(duplicateWait, context);
        const pending = context.waitForDuplicateCount('fixture', 'session', 'after duplicate insertion',
            'return summary;', value => value.startsWith('4 excluded'));
        if ( failure ) {
            await assert.rejects(pending, error => {
                assert.equal(error.cause, timeout, 'Diagnostics must preserve the assertion failure');
                assert.match(error.message, /3 excluded, 1 unresolved/);
                assert.match(error.message, /after duplicate insertion/);
                assert.match(error.message, failure === 'diagnostic-error' ? /Diagnostic read failed/ : /savedDecision.*exclude.*exclusionSelectorMatches/);
                return true;
            });
        } else {
            assert.equal(await pending, '4 excluded, 1 unresolved');
        }
        assert.equal(diagnosticReads, failure ? 1 : 0, 'Passing assertions must not collect diagnostic state');
    }
    console.log('Passed: duplicate-count failures report row/verdict/selector context without changing passing checks');

    const handlers = new Map();
    const context = vm.createContext({
        createServer: handler => ({ handler }), Buffer, page: body => body,
        setTimeout: () => 1, clearTimeout: id => handlers.set('cleared', id),
    });
    vm.runInContext(`let sharedLoadingVisits = 0, sharedQueuedVisits = 0, sharedLoadingCancelled = 0;
        const sharedLoadingStarted = Promise.withResolvers();
        ${section('const server = createServer(', "server.on('upgrade'")}
        globalThis.fixtureServer = server;
        globalThis.counts = () => [sharedLoadingVisits, sharedQueuedVisits, sharedLoadingCancelled];`, context);
    const replies = [];
    const lookup = { url: '/v1/exclusions', on: (name, handler) => handlers.set(name, handler) };
    context.fixtureServer.handler(lookup, { setHeader() {}, end: body => replies.push(body), on() {} });
    handlers.get('data')(Buffer.from(JSON.stringify({ urls: [ 'http://localhost/shared-loading', 'http://localhost/shared-queued' ] })));
    handlers.get('end')();
    await Promise.resolve();
    assert.equal(replies.length, 0, 'Shared hits must wait for a real in-flight request');
    context.fixtureServer.handler({ url: '/shared-loading' }, {
        writableEnded: false, on: (name, handler) => handlers.set(name, handler), setHeader() {}, end() {},
    });
    await Promise.resolve();
    assert.equal(replies.length, 1);
    handlers.get('close')();
    assert.deepEqual(Array.from(context.counts()), [ 1, 0, 1 ]);
    assert.equal(handlers.get('cleared'), 1, 'Cancellation clears the delayed response');
    const sharedCheck = section('async function checkSharedExclusions(', 'async function runRetentionMode(');
    for ( const [ visits, cancelled, queued ] of [ [ 0, 0, 0 ], [ 1, 0, 0 ], [ 1, 1, 0 ], [ 1, 1, 1 ] ] ) {
        const check = vm.createContext({
            exclusionRequests: [], sharedLoadingVisits: visits,
            sharedLoadingCancelled: cancelled, sharedQueuedVisits: queued,
            configureAside: async () => {}, navigate: async () => {},
            waitForResults: async () => ({ status: '2 excluded, 0 unresolved' }),
            readInspectionState: async () => ({ inspectionTabs: 0, containers: 0, owned: 0,
                cookies: 0, checkedContainers: 2 }),
        });
        vm.runInContext(sharedCheck, check);
        const pending = check.checkSharedExclusions('fixture', 'session', 'moz-extension://fixture', 'http://localhost');
        if ( visits === 1 && cancelled === 1 && queued === 0 ) { await pending; }
        else { await assert.rejects(pending, /Shared exclusion cancellation failed/); }
    }
    console.log('Passed: shared cancellation waits for a positive visit and observes its aborted response');
} finally {
    await rm(work, { recursive: true });
}
