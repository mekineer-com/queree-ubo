import * as sfp from '../../src/js/static-filtering-parser.js';

import { CompiledListReader, CompiledListWriter } from '../../src/js/static-filtering-io.js';
import {
    eligibilityExceptions,
    initializeAdProfileAssets,
    popupAdsAsset,
    popupAdsAssetKey,
    preserveAdProfileFallbacks,
    requiredLists,
    requiredMalwareLists,
} from '../../src/js/queree/ad-profile.js';
import { FilteringContext } from '../../src/js/filtering-context.js';
import { LineIterator } from '../../src/js/text-utils.js';
import assert from 'node:assert/strict';
import { domainToASCII } from 'node:url';
import { getTrustedTokens } from '../../src/js/trusted-tokens.js';
import publicSuffixList from '../../src/lib/publicsuffixlist/publicsuffixlist.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers';
import staticNetFilteringEngine from '../../src/js/static-net-filtering.js';
import { trackingAssetKey } from '../../src/js/queree/tracking-sources.js';

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const controller = read('src/js/queree/controller.js');
const storage = read('src/js/storage.js');
for ( const block of [ 'NETWORK_FILTERS:GOOD', 'NETWORK_FILTERS:BAD', 'COSMETIC_FILTERS:SPECIFIC' ] ) {
    assert.throws(() => new CompiledListReader(`#block-start-${block}\n[1]\n`), /incomplete/,
        'The shared native reader rejects truncated blocks instead of looping forever');
}
const assets = {
    'adguard-generic': 'assets/queree/adguard-ads.txt',
    'ublock-filters': 'dist/build/uAssets/prod/filters/filters.min.txt',
    easylist: 'dist/build/uAssets/prod/thirdparties/easylist.txt',
    'spa-0': 'assets/queree/easylist-spanish.txt',
    [popupAdsAssetKey]: 'assets/queree/popupads.txt',
};
assert.deepEqual(requiredLists, Object.keys(assets), 'All approved advertising inputs are required');
assert.deepEqual(requiredMalwareLists, [ 'ublock-badware', 'urlhaus-1' ]);
const maintainedLists = [ ...requiredLists, ...requiredMalwareLists ];
const compilerAPI = { setTimeout() {} };
runInNewContext(between(read('platform/common/vapi-common.js'),
    'vAPI.webextFlavor =', 'vAPI.download ='), {
    vAPI: compilerAPI,
    navigator: { userAgent: 'Firefox/140.0' },
    browser: { runtime: {
        getManifest: () => JSON.parse(read('platform/firefox/manifest.json')),
        getURL: () => 'moz-extension://queree-test/',
    } },
    CSS: { supports: () => true },
});
const background = read('src/js/background.js');
const productionCompiler = {
    userFiltersPath: 'user-filters',
    userSettings: {},
    parsedTrustedListPrefixes: [],
    hiddenSettings: runInNewContext(between(background,
        'const hiddenSettingsDefault =', '\n};') + '\n}; hiddenSettingsDefault'),
    systemSettings: runInNewContext('({' + between(background,
        '    systemSettings: {',
        '    // https://github.com/uBlockOrigin/uBlock-issues/issues/759') + '})').systemSettings,
    canFilterResponseData: true,
};
const diagnostics = [];
let compilingParser;
runInNewContext(
    between(storage, 'µb.isTrustedList =', 'onBroadcast(msg =>') +
    between(storage, 'µb.compileFilters =', 'µb.applyCompiledFilters =') +
    between(controller, 'function profileCompiledLists(', 'async function loadEngine()') +
    ';µb.profileCompiledLists = profileCompiledLists;', {
        µb: productionCompiler,
        vAPI: compilerAPI,
        sfp: { ...sfp, AstFilterParser: class extends sfp.AstFilterParser {
            constructor(options) {
                super(options);
                compilingParser = this;
            }
        } },
        CompiledListWriter, LineIterator, getTrustedTokens,
        staticNetFilteringEngine, eligibilityExceptions,
        // The profile frame loads network records only, never extended filters.
        staticExtFilteringEngine: { compile() {} },
        logger: { writeOne(entry) {
            if ( compilingParser.isNetworkFilter() ) { diagnostics.push(entry.text.trim()); }
        } },
    }
);

publicSuffixList.parse(read(
    'dist/build/uAssets/main/thirdparties/publicsuffix.org/list/effective_tld_names.dat'
), domainToASCII);

function compile(assetKey, raw) {
    diagnostics.length = 0;
    const content = productionCompiler.compileFilters(raw, {
        assetKey, trustedSource: productionCompiler.isTrustedList(assetKey),
    });
    // Pre-existing network diagnostics in the pinned AdGuard asset.
    assert.deepEqual(diagnostics, assetKey === 'adguard-generic' ? [
        'Invalid filter (adguard-generic): .com/aS/feedclick?s=$all,match-case',
        'Invalid filter (adguard-generic): ||nuvid.com/NB*.js$match-case',
    ] : [], `${assetKey}: unexpected compilation diagnostics`);
    return content;
}

// Synthetic known-function requests, not page visits or effectiveness estimates.
// Native results: 0 = unmatched, 1 = blocked, 2 = excepted.
const controls = [
    [ 'Georgia GA4 beacon', 'site.extension.uga.edu',
        'https://stats.g.doubleclick.net/g/collect?v=2', 'beacon', 2 ],
    [ 'GA script', 'publisher.example',
        'https://www.google-analytics.com/analytics.js', 'script', 0 ],
    [ 'GA fetch', 'publisher.example',
        'https://www.google-analytics.com/g/collect?v=2', 'xmlhttprequest', 0 ],
    [ 'GA measurement image', 'www.ondemandkorea.com',
        'https://www.google-analytics.com/collect?v=1', 'image', 2 ],
    [ 'GA object', 'publisher.example',
        'https://www.google-analytics.com/collect?v=1', 'object', 2 ],
    [ 'Twitter script', 'publisher.example',
        'https://static.ads-twitter.com/uwt.js', 'script', 2 ],
    [ 'Twitter XHR', 'publisher.example',
        'https://static.ads-twitter.com/uwt.js', 'xmlhttprequest', 2 ],
    [ 'Amazon ad-system script', 'www.howstuffworks.com',
        'https://c.amazon-adsystem.com/aax2/apstag.js', 'script', 1 ],
    [ 'YouTube ad playback', 'www.youtube.com',
        'https://rr1.googlevideo.com/initplayback?source=youtube&c=TVHTML5&oad=123',
        'xmlhttprequest', 1 ],
    [ 'DFP ad script', 'www.theweathernetwork.com',
        'https://s.twnmm.com/js/a/dfpad/b.js', 'script', 1 ],
    [ 'Adobe Audience Manager', 'www.theweathernetwork.com',
        'https://s.twnmm.com/js/a/adobe_audience_manager.js', 'script', 2 ],
    [ 'Fox News GTM script after badfilter', 'www.foxnews.com',
        'https://www.googletagmanager.com/gtm.js?id=GTM-TEST', 'script', 0 ],
    [ 'GTM object', 'publisher.example',
        'https://www.googletagmanager.com/gtm.js?id=GTM-TEST', 'object', 2 ],
    [ 'Quantserve object', 'publisher.example',
        'https://secure.quantserve.com/quant.js', 'object', 2 ],
    [ 'Ordinary image', 'publisher.example',
        'https://publisher.example/images/logo.png', 'image', 0 ],
    [ 'GA4 fetch', 'publisher.example',
        'https://stats.g.doubleclick.net/g/collect?v=2', 'xmlhttprequest', 2 ],
    [ 'Google ad request is not GA4', 'publisher.example',
        'https://securepubads.g.doubleclick.net/gampad/ads?gdfp_req=1', 'xmlhttprequest', 1 ],
    [ 'Spanish advertising path', 'publisher.example',
        'https://publisher.example/banner-publicidad-test.png', 'image', 1 ],
    [ 'Spanish scoped CDN advertising', 'pandrama.com',
        'https://alicdn.com/t/example.js', 'script', 1 ],
    [ 'Spanish CDN outside source scope', 'publisher.example',
        'https://alicdn.com/t/example.js', 'script', 0 ],
    [ 'Spanish institutional exception', 'sscc.edu.ec',
        'https://sscc.edu.ec/wp-content/banner-publicidad-test.png', 'image', 2 ],
    [ 'Spanish exception stays on its host', 'publisher.example',
        'https://publisher.example/wp-content/banner-publicidad-test.png', 'image', 1 ],
    [ 'Pop-up feed listed tenant', 'publisher.example',
        'https://add-friendso.blogspot.com/resource.js', 'script', 1 ],
    [ 'Native popup rule', 'eurogamer.net',
        'https://bit.ly/fictional', 'popup', 1 ],
    [ 'Pop-up feed listed descendant', 'publisher.example',
        'https://sub.add-friendso.blogspot.com/resource.js', 'script', 1 ],
    [ 'Pop-up feed sibling tenant', 'publisher.example',
        'https://personal-writer.blogspot.com/resource.js', 'script', 0 ],
    [ 'Pop-up feed lookalike', 'publisher.example',
        'https://add-friendso.blogspot.com.evil.test/resource.js', 'script', 0 ],
];

function assertControls(cases) {
    const context = new FilteringContext();
    for ( const [ name, host, url, type, expected ] of cases ) {
        const originURL = `https://${host}/`;
        context.fromDetails({ originURL, url, type })
            .setMethod('GET')
            .setIPAddress('')
            .setTabOrigin(originURL);
        const actual = staticNetFilteringEngine.matchRequest(context);
        const rule = actual === 0 ? '' : staticNetFilteringEngine.toLogData()?.raw;
        assert.equal(actual, expected, `${name}: ${type} ${url}; rule=${rule}`);
    }
}

staticNetFilteringEngine.reset();
try {
    for ( const assetKey of requiredLists ) {
        assert.ok(Object.hasOwn(assets, assetKey), `No pinned asset for ${assetKey}`);
        staticNetFilteringEngine.fromCompiled(new CompiledListReader(
            compile(assetKey, read(assets[assetKey]))
        ));
    }
    staticNetFilteringEngine.fromCompiled(new CompiledListReader(
        productionCompiler.profileCompiledLists([])[0]
    ));
    staticNetFilteringEngine.freeze();
    staticNetFilteringEngine.optimize();

    assertControls(controls);
    console.log(`Passed: ${controls.length} native ad-profile controls using shared configuration`);
    for ( const [ key, prefix ] of [ [ 'spa-0', 'Spanish' ], [ popupAdsAssetKey, 'Pop-up' ] ] ) {
        staticNetFilteringEngine.reset();
        staticNetFilteringEngine.fromCompiled(new CompiledListReader(compile(key, read(assets[key]))));
        staticNetFilteringEngine.freeze();
        staticNetFilteringEngine.optimize();
        assertControls(controls.filter(([ name ]) => name.startsWith(prefix)));
    }
    console.log('Passed: isolated Spanish and Pop-Up feeds retain native positive, exception and scope controls');
} finally {
    staticNetFilteringEngine.reset();
}

function between(source, start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert.ok(from !== -1 && to > from, `Missing production function: ${start}`);
    return source.slice(from, to);
}

for ( const [ readyToFilter, options, favorLocal ] of [
    [ true, undefined, false ],
    [ true, {}, false ],
    [ true, { favorLocal: true }, true ],
    [ false, undefined, true ],
    [ false, { favorLocal: false }, false ],
] ) {
    const calls = [];
    const compiledCache = new Map();
    const state = {
        readyToFilter,
        compiledFormatChanged: false,
        systemSettings: { compiledMagic: 1 },
        badLists: new Map(),
        extractFilterListMetadata() {},
        isTrustedList: () => false,
        compileFilters: raw => `1\n${raw}`,
    };
    runInNewContext(between(storage, 'µb.getCompiledFilterList =', 'µb.extractFilterListMetadata ='), {
        µb: state,
        io: {
            fromCache: async key => compiledCache.get(key) || '',
            toCache: (key, content) => compiledCache.set(key, content),
            get: async (key, options) => {
                calls.push([ key, options.favorLocal, options.silent ]);
                return { assetKey: key, content: options.favorLocal ? 'PACKAGED' : 'REMOTE' };
            },
        },
    });
    for ( const key of maintainedLists ) {
        const result = await state.getCompiledFilterList(key, options);
        assert.equal(result.content, `1\n${favorLocal ? 'PACKAGED' : 'REMOTE'}`,
            `${key}: cold native retrieval must honor the explicit option or original default`);
        assert.equal(compiledCache.get(`compiled/${key}`), result.content);
        assert.equal((await state.getCompiledFilterList(key, options)).content, result.content,
            'Warm compiled caches remain preferred even for local-first loads');
    }
    assert.deepEqual(calls, maintainedLists.map(key => [ key, favorLocal, true ]),
        'Every cold getter forwards the read options, with no second read for a warm cache');
}
console.log('Passed: native compiled getter honors local-first opt-in, unchanged defaults and warm caches');

const cached = new Map();
const broadcasts = [];
const compiled = [];
let reloads = 0;
let scheduled = 0;
let selfiesDestroyed = 0;
let resourcesInvalidated = 0;
const selected = Object.freeze([ 'ordinary', 'easylist' ]);
const native = {
    userSettings: { quereeEnabled: true },
    quereeFilterLists: new Set(maintainedLists),
    availableFilterLists: { ordinary: {}, easylist: {}, 'spa-0': { off: true },
        'ublock-badware': { off: true }, 'urlhaus-1': { off: true }, unused: {} },
    selectedFilterLists: selected,
    badLists: new Map(),
    hiddenSettings: { userResourcesLocation: 'unset' },
    selfieManager: { destroy() { selfiesDestroyed += 1; } },
    extractFilterListMetadata() {},
    isTrustedList: () => false,
    compileFilters(raw, details) {
        compiled.push({ raw, ...details });
        return `compiled:${raw}`;
    },
    loadFilterLists() { reloads += 1; },
    scheduleAssetUpdater() { scheduled += 1; },
};
runInNewContext(
    between(storage, 'µb.removeCompiledFilterList =', 'µb.removeFilterList =') +
    storage.slice(storage.indexOf('µb.assetObserver =')),
    {
        µb: native,
        trackingAssetKey,
        preserveAdProfileFallbacks,
        io: {
            toCache: (key, content) => cached.set(key, content),
            remove: key => cached.delete(key),
        },
        broadcast: message => broadcasts.push(message),
        redirectEngine: { invalidateResourcesSelfie() { resourcesInvalidated += 1; } },
        vAPI: { webextFlavor: { soup: new Set() } },
    }
);
const eligible = assetKey => native.assetObserver('before-asset-updated', {
    assetKey, type: 'filters',
});
const update = (assetKey, content) => native.assetObserver('after-asset-updated', {
    assetKey, content,
});

// The URL asset is absent from selfie metadata; the regional list is present but off.
for ( const key of [ popupAdsAssetKey, 'spa-0', ...requiredMalwareLists ] ) {
    const compiledKey = `compiled/${key}`;
    cached.set(compiledKey, 'old');
    assert.equal(eligible(key), true, 'Enabled unselected profile feed is in use');
    update(key, 'new');
    assert.equal(cached.get(compiledKey), 'compiled:new', 'Raw updates replace stale compiled data');
    assert.deepEqual(compiled.at(-1), { raw: 'new', assetKey: key, trustedSource: false });

    native.userSettings.quereeEnabled = false;
    assert.equal(eligible(key), undefined, 'Disabled profile alone does not authorize updates');
    const before = compiled.length;
    update(key, 'disabled');
    assert.equal(compiled.length, before + 1, 'Already changed raw data stays fresh while disabled');
    assert.equal(cached.get(compiledKey), 'compiled:disabled');
    native.userSettings.quereeEnabled = true;

    for ( const bad of [ false, true ] ) {
        native.badLists.set(key, bad);
        assert.equal(eligible(key), bad ? undefined : true,
            'Native bad-list severity distinguishes fetch prohibition from compile prohibition');
        update(key, 'bad');
        assert.equal(compiled.length, before + 1, 'Any bad-list entry prohibits compilation');
        assert.equal(cached.get(compiledKey), 'compiled:disabled');
    }
    native.badLists.delete(key);
    update(key, undefined);
    assert.equal(cached.has(compiledKey), false, 'Raw deletion removes native compiled cache');
    assert.equal(broadcasts.at(-1).what, 'assetUpdated');
    assert.equal(broadcasts.at(-1).cached, false);
}
assert.equal(eligible('unused'), undefined, 'Unrelated unselected lists remain unused');
for ( const enabled of [ false, true ] ) {
    native.userSettings.quereeEnabled = enabled;
    for ( const key of selected ) {
        assert.equal(eligible(key), true, 'Ordinary selection works independently of Quer.ee');
        update(key, 'ordinary');
        assert.equal(cached.get(`compiled/${key}`), 'compiled:ordinary');
        native.badLists.set(key, true);
        assert.equal(eligible(key), undefined, 'Bad lists remain forbidden when selected');
        const before = compiled.length;
        update(key, 'bad');
        assert.equal(compiled.length, before);
        native.badLists.delete(key);
        update(key, undefined);
        assert.equal(cached.has(`compiled/${key}`), false);
    }
}
native.hiddenSettings.userResourcesLocation = 'custom';
for ( const key of [ popupAdsAssetKey, 'spa-0', trackingAssetKey ] ) {
    const before = selfiesDestroyed;
    const previousCompiles = compiled.length;
    update(key, 'profile-only');
    if ( key === trackingAssetKey ) {
        assert.equal(compiled.length, previousCompiles, 'JSON updates do not enter the ordinary rule compiler');
    }
    assert.equal(selfiesDestroyed, before, 'Profile-only writes leave the main engine selfie valid');
    native.assetObserver('after-assets-updated', { assetKeys: [ key ] });
    assert.equal(reloads, 0, 'Profile-only batches do not reload the main engine');
    assert.equal(resourcesInvalidated, 0, 'Profile-only batches do not invalidate main engine resources');
    const notification = broadcasts.at(-2);
    assert.equal(notification.what, 'staticFilteringDataChanged');
    assert.deepEqual(Array.from(notification.listKeys), [ key ]);
}
assert.equal(broadcasts.at(-1).what, 'assetsUpdated');
for ( const keys of [ [ 'easylist' ], [ popupAdsAssetKey, 'ordinary' ] ] ) {
    const before = selfiesDestroyed;
    update(keys.at(-1), 'selected');
    assert.equal(selfiesDestroyed, before + 1, 'Selected lists still invalidate the main selfie');
    native.assetObserver('after-assets-updated', { assetKeys: keys });
}
assert.equal(reloads, 2, 'Selected and mixed batches reload the main engine');
assert.equal(resourcesInvalidated, 2);
native.assetObserver('after-assets-updated', { assetKeys: [] });
assert.equal(reloads, 2, 'Empty batches do not reload');
assert.equal(scheduled, 6, 'Every completed batch schedules native updates');
assert.equal(native.selectedFilterLists, selected, 'Native observer never replaces ordinary selections');
assert.deepEqual(selected, [ 'ordinary', 'easylist' ]);
console.log('Passed: native asset observer preserves profile, selection, bad-list and deletion behavior');

for ( const enabled of [ false, true ] ) {
    const values = new Map([ 'easylist', 'ordinary', ...requiredMalwareLists ].flatMap(key => [
        [ key, 'raw' ], [ `compiled/${key}`, 'compiled' ],
    ]));
    const persisted = [];
    const state = {
        ...native,
        userSettings: { quereeEnabled: enabled },
        selectedFilterLists: [ 'easylist', 'ordinary', ...requiredMalwareLists ],
    };
    runInNewContext(
        between(storage, 'µb.saveSelectedFilterLists =', 'µb.applyFilterListSelection =') +
        between(storage, 'µb.removeCompiledFilterList =', 'µb.compileFilters ='), {
            µb: state,
            io: { remove: key => values.delete(key) },
            vAPI: { storage: { set: async bin => persisted.push(bin) } },
        }
    );
    await state.saveSelectedFilterLists([]);
    for ( const assetKey of [ 'easylist', ...requiredMalwareLists ] ) {
        for ( const key of [ assetKey, `compiled/${assetKey}` ] ) {
            assert.equal(values.has(key), enabled, 'Deselection retains caches only for an enabled profile');
        }
    }
    assert.equal(values.has('ordinary'), false);
    assert.equal(values.has('compiled/ordinary'), false);
    assert.deepEqual(Array.from(persisted[0].selectedFilterLists), []);
    await state.saveSelectedFilterLists([ 'ordinary' ], true);
    assert.deepEqual(Array.from(state.selectedFilterLists), [ 'ordinary' ]);
}
console.log('Passed: native deselection retains profile caches only while Quer.ee needs them');

{
    const nativeAssets = read('src/js/assets.js');
    const registry = {
        'assets.json': { content: 'internal' },
        'adguard-generic': { content: 'filters', off: true,
            contentURL: [ 'https://old.example/ads.txt', assets['adguard-generic'] ] },
        'spa-0': { content: 'filters', off: true, contentURL: 'https://old.example/spanish.txt' },
    };
    let saves = 0;
    const refreshRegistry = runInNewContext(
        between(nativeAssets, 'function registerAssetSource(', 'const saveAssetSourceRegistry =') +
        between(nativeAssets, 'function updateAssetSourceRegistry(', 'assets.registerAssetSource =') +
        ';updateAssetSourceRegistry', {
            assetSourceRegistry: registry,
            reIsExternalPath: /^(?:[a-z-]+):\/\//,
            fireNotification: (topic, details) => native.assetObserver(topic, details),
            saveAssetSourceRegistry: () => { saves += 1; },
            assetCacheRemove: () => assert.fail('A registry refresh must not delete these sources'),
        });
    for ( const contentURL of [
        'https://new.example/ads.txt',
        [ 'https://new.example/ads.txt', 'https://mirror.example/ads.txt' ],
        [ 'https://new.example/ads.txt', assets['adguard-generic'] ],
    ] ) {
        refreshRegistry(JSON.stringify({
            'assets.json': { content: 'internal' },
            'adguard-generic': { content: 'filters', off: true, contentURL },
            'spa-0': { content: 'filters', off: true, contentURL: 'https://new.example/spanish.txt' },
        }));
        const expected = [].concat(contentURL);
        if ( expected.includes(assets['adguard-generic']) === false ) {
            expected.push(assets['adguard-generic']);
        }
        assert.deepEqual(Array.from(registry['adguard-generic'].contentURL), expected);
        assert.equal(registry['adguard-generic'].hasLocalURL, true);
        assert.equal(registry['adguard-generic'].hasRemoteURL, true);
        assert.deepEqual(Array.from(registry['spa-0'].contentURL), [
            'https://new.example/spanish.txt', assets['spa-0'],
        ]);
        assert.equal(registry['spa-0'].hasLocalURL, true);
        assert.equal(registry['spa-0'].hasRemoteURL, true);
    }
    assert.equal(saves, 3);
    assert.equal(native.selectedFilterLists, selected);
}
console.log('Passed: native registry updates retain bundled AdGuard/Spanish fallbacks and remote URL order');

{
    const ordinaryURL = 'https://imported.example/ordinary.txt';
    const imports = [ popupAdsAssetKey, ordinaryURL ];
    const selected = [ popupAdsAssetKey ];
    const registry = { [popupAdsAssetKey]: structuredClone(popupAdsAsset) };
    const state = {
        userFiltersPath: 'user-filters',
        userSettings: { importedLists: imports },
        selectedFilterLists: selected,
        availableFilterLists: {},
        badLists: new Map(),
        listKeysFromCustomFilterLists: lists => lists,
        saveUserSettings() { assert.fail('Unchanged imports must not be rewritten'); },
        saveSelectedFilterLists() { assert.fail('Imports must retain their selection'); },
        removeFilterList() { assert.fail('These imports must not be removed'); },
    };
    const badListOptions = [];
    const register = runInNewContext(between(read('src/js/assets.js'),
        'function registerAssetSource(', 'function unregisterAssetSource(') + ';registerAssetSource', {
        assetSourceRegistry: registry, reIsExternalPath: /^(?:[a-z-]+):\/\//,
    });
    runInNewContext(between(storage, 'µb.loadBadLists =', '/******************************************************************************/'), {
        µb: state, preserveAdProfileFallbacks,
        i18n$: () => 'User filters',
        vAPI: { storage: { get: async () => ({}) } },
        io: {
            metadata: async () => structuredClone(registry),
            registerAssetSource: register,
            get: async (key, options) => {
                assert.equal(key, 'ublock-badlists');
                badListOptions.push(options);
                return { content: 'https://bad.example/list remove' };
            },
        },
    });
    for ( let i = 0; i < 2; i++ ) {
        const available = await state.getAvailableLists();
        assert.deepEqual(Array.from(registry[popupAdsAssetKey].contentURL), popupAdsAsset.contentURL,
            'A native import must retain the packaged popup fallback, without duplicates');
        assert.equal(registry[popupAdsAssetKey].submitter, 'user');
        assert.equal(registry[popupAdsAssetKey].hasLocalURL, true);
        assert.equal(registry[popupAdsAssetKey].hasRemoteURL, true);
        assert.equal(available[popupAdsAssetKey].off, false);
        assert.deepEqual(Array.from(registry[ordinaryURL].contentURL), [ ordinaryURL ],
            'Ordinary uBO import sources are unchanged');
        assert.equal(state.userSettings.importedLists, imports);
        assert.equal(state.selectedFilterLists, selected);
    }
    assert.deepEqual(badListOptions, [ undefined ],
        'Ordinary uBO bad-list loading retains its native read options and reuse');
}
console.log('Passed: native popup imports retain their bundled fallback without changing ordinary imports');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function subscriptionFixture(enabled = true) {
    const registry = { [popupAdsAssetKey]: structuredClone(popupAdsAsset) };
    const contents = new Map();
    const settingsSaved = [];
    const fetches = [];
    const state = {
        userFiltersPath: 'user-filters',
        userSettings: { importedLists: [], quereeEnabled: enabled },
        selectedFilterLists: [], availableFilterLists: {},
        badLists: new Map([ [ 'initialized', false ] ]),
        quereeFilterLists: new Set(maintainedLists),
        compiledFormatChanged: false,
        readyToFilter: true,
        systemSettings: productionCompiler.systemSettings,
        saveUserSettings() { settingsSaved.push(Array.from(this.userSettings.importedLists)); },
        isTrustedList: () => false,
        compileFilters: productionCompiler.compileFilters.bind(productionCompiler),
    };
    const io = {
        metadata: async () => structuredClone(registry),
        isUpdating: () => false,
        fromCache: async key => contents.get(key) || '',
        toCache: (key, value) => contents.set(key, value),
        remove: key => contents.delete(key),
        extractMetadataFromList: () => ({}),
        fetchFilterList: async url => {
            fetches.push(url);
            return url === assets[popupAdsAssetKey]
                ? { content: '||popup.example^' }
                : { content: '', error: 'offline' };
        },
    };
    const nativeAssets = read('src/js/assets.js');
    runInNewContext(
        between(nativeAssets, 'function registerAssetSource(', 'const saveAssetSourceRegistry =') +
        'Object.assign(assets, { registerAssetSource, unregisterAssetSource });' +
        between(nativeAssets, 'const getContentURLs =', '/******************************************************************************/') +
        between(nativeAssets, 'assets.get =', '/******************************************************************************/') +
        between(storage, 'µb.saveSelectedFilterLists =', 'µb.saveUserFilters =') +
        between(storage, 'µb.loadBadLists =', '/******************************************************************************/') +
        between(storage, 'µb.getCompiledFilterList =', 'µb.compileFilters ='), {
            Object, µb: state, io, assets: io,
            popupAdsAsset, popupAdsAssetKey, preserveAdProfileFallbacks,
            assetSourceRegistry: registry,
            reIsExternalPath: /^(?:[a-z-]+):\/\//,
            getAssetSourceRegistry: async () => registry,
            assetCacheRead: async key => ({ content: contents.get(key) || '' }),
            assetCacheRemove: key => contents.delete(key),
            ubolog() {}, i18n$: () => 'User filters',
            vAPI: { storage: { get: async () => ({}), set: async () => {} } },
        }
    );
    const getLists = runInNewContext(between(read('src/js/messaging.js'),
        'const prepListEntries =', '// My filters') + ';getLists', {
        µb: state, io,
        cosmeticFilteringEngine: { getFilterCount: () => 0 },
        staticNetFilteringEngine: { getFilterCount: () => 0 },
    });
    return { state, io, registry, contents, settingsSaved, fetches, getLists };
}

for ( const removal of [ false, true ] ) {
    const f = subscriptionFixture();
    const ordinaryURL = 'https://imported.example/ordinary.txt';
    if ( removal ) {
        f.state.applyFilterListSelection({ toImport: ordinaryURL });
        f.state.availableFilterLists = await f.state.getAvailableLists();
    }
    const started = deferred();
    const release = deferred();
    const metadata = f.io.metadata;
    let reads = 0;
    f.io.metadata = async () => {
        const snapshot = await metadata();
        if ( reads++ === 0 ) {
            started.resolve();
            await release.promise;
        }
        return snapshot;
    };
    let reply;
    const pending = f.getLists(value => { reply = value; });
    await started.promise;
    f.state.applyFilterListSelection(removal
        ? { toRemove: [ ordinaryURL ] }
        : { toImport: ordinaryURL, merge: true });
    const saves = f.settingsSaved.length;
    release.resolve();
    await pending;
    assert.equal(f.settingsSaved.length, saves, 'A stale dashboard read cannot rewrite the newer subscription choice');
    assert.deepEqual(Array.from(f.state.userSettings.importedLists), removal ? [] : [ ordinaryURL ]);
    assert.deepEqual(Array.from(f.state.selectedFilterLists), removal ? [] : [ ordinaryURL ]);
    assert.equal(reply.available[ordinaryURL] !== undefined, !removal,
        'The actual dashboard caller returns the current import/removal, not its old metadata snapshot');
    assert.equal(f.registry[ordinaryURL] !== undefined, !removal);
}
console.log('Passed: overlapping native dashboard reads preserve new imports and removals');

for ( const enabled of [ false, true ] ) {
    const f = subscriptionFixture(enabled);
    const ordinaryURL = 'https://imported.example/ordinary.txt';
    f.state.availableFilterLists = await f.state.getAvailableLists();
    f.state.applyFilterListSelection({ toImport: `${popupAdsAssetKey}\n${ordinaryURL}`, merge: true });
    f.state.availableFilterLists = await f.state.getAvailableLists();
    assert.equal(f.registry[popupAdsAssetKey].submitter, 'user');
    for ( const key of [ popupAdsAssetKey, ordinaryURL ] ) {
        f.contents.set(key, 'raw');
        f.contents.set(`compiled/${key}`, `${productionCompiler.systemSettings.compiledMagic}\nOLD`);
    }
    f.state.applyFilterListSelection({ toRemove: [ popupAdsAssetKey, ordinaryURL ] });
    await f.getLists(reply => { f.state.availableFilterLists = reply.available; });
    assert.deepEqual(Array.from(f.state.userSettings.importedLists), []);
    assert.deepEqual(Array.from(f.state.selectedFilterLists), []);
    assert.equal(f.registry[ordinaryURL], undefined, 'An ordinary removed subscription is still unregistered');
    assert.equal(f.contents.has(ordinaryURL), false);
    assert.equal(f.contents.has(`compiled/${ordinaryURL}`), false);
    for ( const key of [ popupAdsAssetKey, `compiled/${popupAdsAssetKey}` ] ) {
        assert.equal(f.contents.has(key), enabled, 'Removal retains caches only while Quer.ee needs them');
    }
    assert.equal(f.registry[popupAdsAssetKey]?.submitter, 'queree',
        'Removing the custom subscription restores the required Quer.ee source');
    assert.equal(f.state.availableFilterLists[popupAdsAssetKey].off, true,
        'Keeping the required source does not select it for ordinary browsing');
    assert.deepEqual(Array.from(f.registry[popupAdsAssetKey].contentURL), popupAdsAsset.contentURL);
    await initializeAdProfileAssets(f.state, f.io);
    // Force a cold read after ordinary removal, with every remote fetch failing.
    f.contents.clear();
    const compiled = await f.state.getCompiledFilterList(popupAdsAssetKey, { favorLocal: true });
    assert.ok(compiled.content.includes('#block-start-NETWORK_FILTERS:GOOD'));
    assert.deepEqual(f.fetches, [ assets[popupAdsAssetKey] ], 'The packaged fallback works without a restart or network');
}
console.log('Passed: actual subscription removal restores the required popup source and preserves ordinary removal');

const registration = deferred();
const registrationStarted = deferred();
const badListRead = deferred();
const badListReadStarted = deferred();
const startupEvents = [];
const startupSources = {
    'adguard-generic': { contentURL: [ 'https://ads.example/primary', 'https://ads.example/mirror' ] },
    'spa-0': { contentURL: 'https://spanish.example/list' },
};
const restoredSources = [];
const startup = {
    structuredClone,
    requiredLists, eligibilityExceptions, initializeAdProfileAssets,
    engineReady: undefined,
    profile: undefined,
    profileFailure: '',
    policyGeneration: 0,
    profileId: 'queree-ads',
    loadDomainIndex: async () => {},
    assets: { registerAssetSource(key, details) {
        if ( key !== popupAdsAssetKey ) {
            restoredSources.push(key);
            startupSources[key] = { ...startupSources[key], ...details };
            return Promise.resolve();
        }
        assert.equal(key, popupAdsAssetKey);
        assert.equal(details, popupAdsAsset);
        assert.equal(details.contentURL[0], key, 'Native bad-list identity is the source URL');
        assert.equal(details.off, true, 'Registration must not auto-select the feed');
        assert.notEqual(details.submitter, undefined, 'Registration survives native catalog replacement');
        assert.notEqual(details.submitter, 'user', 'Registration is not an unreferenced user import');
        startupEvents.push('register');
        registrationStarted.resolve();
        return registration.promise;
    }, metadata: async () => structuredClone(startupSources) },
    µb: {
        readyToFilter: false,
        badLists: new Map(),
        quereeFilterLists: new Set(),
        userSettings: { importedLists: [] },
        selectedFilterLists: selected,
        getAvailableLists() {
            assert.fail('Quer.ee must not reconcile or rewrite user list selections');
        },
        getCompiledFilterList: async (key, options) => {
            assert.equal(options.favorLocal, true, 'Advertising profiles explicitly prefer packaged sources');
            assert.equal(startup.µb.badLists.get('https://bad.example/remove'), true,
                'Selfie startup must initialize native bad lists first');
            assert.equal(startup.µb.badLists.get('https://bad.example/skip'), false);
            assert.deepEqual(Array.from(startup.µb.quereeFilterLists), maintainedLists);
            startupEvents.push(key);
            return { assetKey: key, content: 'NETWORK_FILTERS:GOOD' };
        },
        compileFilters: raw => raw,
    },
    waitForPolicyEngine: async () => 'frame',
    sha256: async parts => {
        assert.equal(parts.at(-1), JSON.stringify('psl'), 'Profile identity includes domain-boundary data');
        return 'profile-version';
    },
    loadPolicyFrame: async (frame, details) => {
        assert.equal(frame, 'frame');
        assert.equal(details.compiledLists.length, requiredLists.length + 1);
        assert.equal(details.compiledLists.at(-1), eligibilityExceptions.join('\n'),
            'Controller sends the shared native exceptions to the inspection engine');
        assert.equal(details.pslSelfie, 'psl');
        return { filterCount: 1 };
    },
    publicSuffixList: { toSelfie: () => 'psl' },
};
runInNewContext(between(storage, 'µb.loadBadLists =', 'µb.getAvailableLists ='), {
    µb: startup.µb,
    io: { get: async (key, options) => {
        assert.equal(key, 'ublock-badlists');
        assert.equal(options.favorLocal, true, 'Quer.ee metadata must use native local-first loading');
        startupEvents.push('bad-lists');
        badListReadStarted.resolve();
        await badListRead.promise;
        return { content: '# native bad lists\nhttps://bad.example/remove remove\n\nhttps://bad.example/skip\n' };
    } },
});
const loadEngine = runInNewContext(
    between(controller, 'function profileCompiledLists(', 'function record(') + ';loadEngine',
    startup
);
const initializing = initializeAdProfileAssets(startup.µb, startup.assets);
await registrationStarted.promise;
assert.deepEqual(startupEvents, [ 'register' ]);
assert.equal(startup.µb.quereeFilterLists.size, 0);
registration.resolve();
await badListReadStarted.promise;
assert.deepEqual(startupEvents, [ 'register', 'bad-lists' ]);
assert.equal(startup.µb.quereeFilterLists.size, 0, 'Membership waits for native initialization');
const concurrentImports = [ 'https://imported.example/list' ];
startup.µb.userSettings.importedLists = concurrentImports;
badListRead.resolve();
await initializing;
assert.equal(startup.µb.userSettings.importedLists, concurrentImports,
    'A concurrent dashboard import survives profile initialization unchanged');
assert.deepEqual(Array.from(startup.µb.quereeFilterLists), maintainedLists,
    'Malware maintenance stays enabled even when its lists are deselected');
assert.deepEqual(restoredSources, [ 'adguard-generic', 'spa-0' ]);
assert.deepEqual(startupSources['adguard-generic'].contentURL, [
    'https://ads.example/primary', 'https://ads.example/mirror', assets['adguard-generic'],
]);
assert.deepEqual(startupSources['spa-0'].contentURL, [
    'https://spanish.example/list', assets['spa-0'],
]);
await initializeAdProfileAssets(startup.µb, startup.assets);
assert.deepEqual(restoredSources, [ 'adguard-generic', 'spa-0' ], 'Warm initialization does not register again');
assert.deepEqual(startupEvents, [ 'register', 'bad-lists' ], 'Startup initialization does not compile filters');
await startup.µb.loadBadLists();
assert.deepEqual(startupEvents, [ 'register', 'bad-lists' ], 'Native bad-list initialization reuses loaded data');
const startSource = read('src/js/start.js');
{
    const errors = [];
    const events = [];
    const state = {
        µb: {
            readyToFilter: false,
            userSettings: { autoUpdate: true },
            hiddenSettings: { autoUpdateDelayAfterLaunch: 60 },
            selectedFilterLists: selected,
            supportStats: {},
            assetObserver() {},
            isReadyResolve() {},
            scheduleAssetUpdater() { events.push('updater'); },
        },
        io: {
            addObserver() {
                assert.equal(state.µb.readyToFilter, true);
                events.push('observer');
            },
            getUpdateAges: async () => [],
        },
        initializeAdProfileAssets: () => assert.fail('Ordinary startup must not initialize Quer.ee profiles'),
        initializeTabs: async () => {},
        webRequest: { start() { events.push('filtering'); } },
        contextMenu: { update() {} },
        browser: { runtime: { onUpdateAvailable: { addListener() {} } } },
        vAPI: { T0: 0 }, selfieIsValid: true, ubolog() {},
        console: { trace: error => errors.push(error) },
    };
    const stage = between(startSource,
        '// Final initialization steps after all needed assets are in memory.',
        '// Process alarm queue');
    await runInNewContext(`(async () => { ${stage} })()`, state);
    assert.equal(state.µb.readyToFilter, true, 'Ordinary uBO startup does not wait for Quer.ee metadata');
    assert.deepEqual(events, [ 'filtering', 'observer', 'updater' ]);
    assert.deepEqual(errors, []);
}
startup.µb.readyToFilter = true;
const loading = loadEngine();
assert.equal(await loading, 'frame');
assert.deepEqual(startupEvents, [ 'register', 'bad-lists', ...requiredLists ]);
assert.equal(startup.µb.selectedFilterLists, selected);
assert.equal(startup.profile.version, 'profile-version');
console.log('Passed: selfie-like startup awaits native registration and bad-list initialization before compiling');

const refreshCode = between(controller, 'async function prepareProfile(', 'async function inspectBatch(') +
    between(controller, 'async function refreshProfile(', 'browser.tabs.onUpdated');
function refreshContext() {
    const resets = [];
    const context = {
        setTimeout, clearTimeout, profilePreparationTimeout: 90000,
        engineReady: Promise.resolve('frame'),
        policyGeneration: 0,
        profile: { version: 'old' },
        requiredLists,
        µb: { getCompiledFilterList: async key => ({ assetKey: key, content: 'new' }) },
        profileCompiledLists: lists => lists.map(details => details.content),
        publicSuffixList: { toSelfie: () => 'psl' },
        sha256: async () => 'new',
        resetProfile: (...args) => resets.push(args),
    };
    const refresh = runInNewContext(refreshCode + ';refreshProfile', context);
    return { context, refresh, resets };
}
{
    const { context, refresh, resets } = refreshContext();
    context.engineReady = undefined;
    await refresh({});
    assert.equal(resets.length, 0, 'Unused profile is not loaded by refresh');
    context.engineReady = Promise.resolve('frame');
    context.sha256 = async () => 'old';
    await refresh({});
    assert.equal(resets.length, 0, 'Identical native inputs retain the current profile');
    context.sha256 = async () => 'new';
    await refresh({ listKeys: requiredLists });
    assert.deepEqual(resets, [ [ 'profile_updated', JSON.stringify(requiredLists) ] ]);
}
{
    const { context, refresh, resets } = refreshContext();
    context.sha256 = async parts => parts.join('|');
    context.profile.version = [ ...requiredLists.map(() => 'new'), JSON.stringify('psl') ].join('|');
    await refresh({});
    assert.equal(resets.length, 0);
    context.publicSuffixList.toSelfie = () => 'changed-psl';
    await refresh({ listKeys: [ 'public_suffix_list.dat' ] });
    assert.equal(resets.length, 1, 'Suffix-only updates replace frames even when filters are unchanged');
}
for ( const stage of [ 'ready', 'compile', 'hash', 'identity' ] ) {
    const { context, refresh, resets } = refreshContext();
    const gate = deferred();
    const entered = deferred();
    if ( stage === 'ready' ) {
        context.engineReady = gate.promise;
    } else if ( stage === 'compile' ) {
        context.µb.getCompiledFilterList = async key => {
            entered.resolve();
            await gate.promise;
            return { assetKey: key, content: 'new' };
        };
    } else {
        context.sha256 = () => { entered.resolve(); return gate.promise; };
    }
    const refreshing = refresh({ listKeys: requiredLists });
    if ( stage !== 'ready' ) { await entered.promise; }
    if ( stage !== 'identity' ) { context.policyGeneration += 1; }
    if ( stage === 'identity' ) { context.engineReady = Promise.resolve('new-frame'); }
    context.profile = { version: 'newer-profile' };
    gate.resolve('new');
    await refreshing;
    assert.equal(resets.length, 0, `Stale ${stage} refresh must not reset a newer profile`);
}
for ( const stage of [ 'ready', 'compile', 'hash' ] ) {
    const { context, refresh, resets } = refreshContext();
    const never = new Promise(() => {});
    context.profilePreparationTimeout = 1;
    if ( stage === 'ready' ) { context.engineReady = never; }
    if ( stage === 'compile' ) { context.µb.getCompiledFilterList = () => never; }
    if ( stage === 'hash' ) { context.sha256 = () => never; }
    await refresh({});
    assert.equal(resets.length, 1, `A stuck ${stage} does not block every later batch`);
}
console.log('Passed: profile refresh keeps identical inputs and rejects stale generation/engine races');

const assetSource = read('src/js/assets.js');
const cacheSource = read('src/js/cachestorage.js');
const nativeCacheSet = between(cacheSource,
    '        async set(rawbin) {', '        remove(...args) {');
function cacheWriter(primary, auxiliary = async () => {}) {
    return runInNewContext(`({${nativeCacheSet}}).set`, {
        pendingWrite: new Map(),
        compress: async (bin, key, data) => { bin[key] = data; },
        cacheAPIs: { auxiliary: { set: auxiliary } },
        fastCache: 'auxiliary',
        extensionStorage: { set: primary },
        ubolog() {},
    });
}

function backendCache({
    backend, primary = async () => {}, cache, indexedDB, sessionStorage,
    serialize = async data => data,
}) {
    return runInNewContext(
        between(cacheSource, 'const STORAGE_NAME =', 'export default cacheStorage;') +
        ';fastCache = backend; cacheStorage;', {
            backend, indexedDB, Blob, Response,
            caches: { open: async () => cache },
            webext: { storage: { local: { set: primary } } },
            vAPI: {
                sessionStorage,
                defer: { once: () => ({ then() {} }) },
            },
            µb: { hiddenSettings: {} },
            s14e: { serializeAsync: serialize, isSerialized: () => false },
            ubolog() {},
        }
    );
}

for ( const event of [ 'oncomplete', 'onerror', 'onabort', 'put-throws' ] ) {
    const primaryWrites = [];
    const db = { transaction() {
        const transaction = {
            error: event === 'onerror' ? new Error('IndexedDB quota') : null,
            objectStore: () => ({ put() {
                if ( event === 'put-throws' ) { throw new Error('IndexedDB put failed'); }
            } }),
        };
        if ( event !== 'put-throws' ) { queueMicrotask(() => transaction[event]()); }
        return transaction;
    } };
    const api = backendCache({
        backend: 'indexedDB',
        primary: async bin => primaryWrites.push(bin),
        indexedDB: { open() {
            const request = {};
            queueMicrotask(() => request.onsuccess({ target: { result: db } }));
            return request;
        } },
    });
    assert.equal(await api.set({ 'cache/compiled/feed': 'new' }), event === 'oncomplete',
        `Real IndexedDB backend reports ${event}`);
    assert.equal(primaryWrites.length, 1, 'Primary write still settles after a fast-backend failure');
}
for ( const backend of [ 'cacheAPI', 'browser.storage.session' ] ) {
    for ( const fail of [ false, true ] ) {
        const write = async () => { if ( fail ) { throw new Error('quota exceeded'); } };
        const api = backendCache({
            backend, cache: { put: write }, sessionStorage: { set: write },
        });
        assert.equal(await api.set({ 'cache/selfie/main': 'new' }), !fail,
            `Real ${backend} backend reports storage failure without rejecting best-effort writes`);
        assert.equal(await api.set({ 'cache/compiled/feed': 'new' }),
            backend === 'browser.storage.session' || !fail,
            'Intentionally uncached entries do not count as write failures');
    }
}
console.log('Passed: real fast backends expose failed writes and preserve best-effort/skipped caches');

for ( const [ sameValue, newerFirst ] of [ false, true ].flatMap(same =>
    [ [ same, false ], [ same, true ] ]
) ) {
    const started = [ deferred(), deferred() ];
    const release = [ deferred(), deferred() ];
    let writes = 0;
    let reads = 0;
    let stored = 'old';
    let primaryStored = 'old';
    let primaryWrites = 0;
    const api = backendCache({ backend: 'cacheAPI', primary: async bin => {
        const index = primaryWrites++;
        await release[index].promise;
        primaryStored = bin['cache/compiled/feed'];
    }, cache: {
        async put(url, response) {
            const index = writes++;
            started[index].resolve();
            await release[index].promise;
            if ( sameValue && index === 0 ) { throw new Error('quota exceeded'); }
            stored = await response.text();
        },
        match: async () => { reads += 1; return new Response(stored); },
    } });
    const first = api.set({ 'cache/compiled/feed': 'first' });
    await started[0].promise;
    const newest = sameValue ? 'first' : 'newest';
    const second = api.set({ 'cache/compiled/feed': newest });
    if ( newerFirst ) { release[1].resolve(); }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writes, 1, 'Newer same-key persistence waits for the previous write in either completion order');
    assert.equal(primaryWrites, 1, 'Primary storage follows the same ordering as the fast backend');
    assert.equal((await api.get('cache/compiled/feed'))['cache/compiled/feed'], newest,
        'Pending reads use the newest value even when it is identical');
    assert.equal(reads, 0, 'A pending read does not consult stale persisted data');
    release[0].resolve();
    assert.equal(await first, !sameValue);
    await started[1].promise;
    if ( newerFirst === false ) {
        assert.equal((await api.get('cache/compiled/feed'))['cache/compiled/feed'], newest,
            'Older completion must not remove the newer pending write');
        assert.equal(reads, 0);
    }
    release[1].resolve();
    assert.equal(await second, true, 'A failed predecessor does not reject a best-effort successor');
    assert.equal(stored, newest, 'Inverse completion cannot overwrite the newest fast-cache value');
    assert.equal(primaryStored, newest, 'Inverse completion cannot overwrite the newest primary value');
    assert.equal((await api.get('cache/compiled/feed'))['cache/compiled/feed'], newest);
    assert.equal(reads, 1, 'The owning completion clears its pending value');
}
console.log('Passed: real cache wrapper preserves newest pending/persisted values in both completion orders');

{
    const started = deferred();
    const release = deferred();
    const persisted = new Map();
    let failedSettled = false;
    const api = backendCache({ backend: 'cacheAPI',
        serialize: async data => {
            if ( data === 'unserializable' ) { throw new Error('serialization failed'); }
            return data;
        },
        cache: { async put(url, response) {
            const value = await response.text();
            if ( value === 'first' ) {
                started.resolve();
                await release.promise;
            }
            persisted.set(decodeURIComponent(url.split('/').at(-1)), value);
        } },
    });
    const key = 'cache/compiled/feed';
    const first = api.set({ [key]: 'first' });
    await started.promise;
    const failed = api.set({ [key]: 'unserializable' }).then(result => {
        failedSettled = true;
        return result;
    });
    const newest = api.set({ [key]: 'newest', 'cache/compiled/overlap': 'newest' });
    assert.equal(await api.set({ 'cache/compiled/independent': 'independent' }), true,
        'Unrelated keys finish while the overlapping write is still blocked');
    assert.equal(failedSettled, false, 'A serialization failure must not break its predecessor chain');
    assert.equal(persisted.has(key), false, 'A third overlapping write waits through a failed predecessor');
    release.resolve();
    assert.equal(await first, true);
    assert.equal(await failed, false, 'Serialization failure remains best-effort');
    assert.equal(await newest, true);
    assert.equal(persisted.get(key), 'newest');
    assert.equal(persisted.get('cache/compiled/overlap'), 'newest');
}
console.log('Passed: overlapping write chains survive serialization failures without blocking unrelated keys');

{
    const started = deferred();
    const failed = deferred();
    const release = deferred();
    const persisted = new Map();
    let settled = false;
    const key = 'cache/compiled/feed';
    const api = backendCache({ backend: 'cacheAPI', cache: {
        async put(url, response) {
            const name = decodeURIComponent(url.split('/').at(-1));
            const value = await response.text();
            if ( name === 'cache/compiled/failing' ) {
                failed.resolve();
                throw new Error('partial multi-key failure');
            }
            if ( value === 'old' ) {
                started.resolve();
                await release.promise;
            }
            persisted.set(name, value);
        },
    } });
    const first = api.set({ [key]: 'old', 'cache/compiled/failing': 'bad' })
        .then(result => { settled = true; return result; });
    await started.promise;
    await failed.promise;
    const second = api.set({ [key]: 'new' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'Partial failure must drain the remaining writes');
    assert.equal(persisted.has(key), false, 'A successor cannot overtake a held write');
    release.resolve();
    assert.equal(await first, false);
    assert.equal(await second, true);
    assert.equal(persisted.get(key), 'new');
}
console.log('Passed: partial multi-key failures drain before releasing same-key successors');
const updaterCode = [
    between(assetSource, 'async function assetCacheRead(', 'async function assetCacheWrite('),
    between(assetSource, 'async function assetCacheWrite(', 'async function assetCacheGetDetails('),
    between(assetSource, 'async function assetCacheSetDetails(', 'async function assetCacheMarkAsDirty('),
    between(assetSource, 'async function getRemote(', '\n/******************************************************************************'),
    between(assetSource, 'async function diffUpdater(', '\nassets.isUpdating ='),
].join('\n');

function updaterFixture({ differential = true, failWrite = false, keys = [ 'spa-0' ] } = {}) {
    const writeStarted = deferred();
    const releaseWrite = deferred();
    const workerStarted = deferred();
    const contents = new Map(keys.flatMap(key => [
        [ `cache/${key}`, 'OLD' ], [ `cache/compiled/${key}`, '1\nOLD' ],
    ]));
    const cacheRegistry = Object.fromEntries(keys.map(key => [ key, {
        writeTime: 1, readTime: 1, resourceTime: 1,
    } ]));
    const registry = Object.fromEntries(keys.map(key => [ key, {
        content: 'filters', hasRemoteURL: true, contentURL: [ `https://filters.example/${key}` ],
    } ]));
    const events = [];
    const completions = [];
    const refreshes = [];
    const resets = [];
    const versions = [];
    const fetches = [];
    const timer = {
        scheduled: false,
        on() { this.scheduled = true; },
        off() { this.scheduled = false; },
        offon() { this.on(); },
        fire() { this.scheduled = false; this.callback(); },
    };
    const ublock = {
        ...native,
        userSettings: { quereeEnabled: true },
        quereeFilterLists: new Set(maintainedLists),
        availableFilterLists: {},
        selectedFilterLists: Object.freeze([]),
        badLists: new Map(),
        readyToFilter: true,
        compiledFormatChanged: false,
        systemSettings: { compiledMagic: 1 },
        hiddenSettings: { differentialUpdate: differential, userResourcesLocation: 'unset' },
        compileFilters: raw => `1\n${raw}`,
        loadBadLists: async () => {},
        loadFilterLists() { assert.fail('Profile-only updates must not reload the main engine'); },
        scheduleAssetUpdater() {},
    };
    const context = {
        Blob,
        setTimeout, clearTimeout, profilePreparationTimeout: 90000,
        Object,
        µb: ublock,
        trackingAssetKey,
        preserveAdProfileFallbacks,
        assets: {
            metadata: async () => structuredClone(registry),
            fetchFilterList: async key => { fetches.push(key); return { content: 'NEW' }; },
            registerAssetSource: async (key, details) => { Object.assign(registry[key], details); },
        },
        io: {
            fromCache: async key => contents.get(`cache/${key}`) || '',
            toCache: (key, content) => contents.set(`cache/${key}`, content),
            remove: key => contents.delete(`cache/${key}`),
        },
        cacheStorage: {
            async set(bin) {
                for ( const [ key, value ] of Object.entries(bin) ) {
                    if ( key.startsWith('cache/') === false ) { continue; }
                    events.push('write-start');
                    writeStarted.resolve();
                    await releaseWrite.promise;
                    if ( failWrite ) { throw new Error('test raw storage failure'); }
                    contents.set(key, value);
                    events.push('write-finish');
                }
            },
            get: async key => ({ [key]: contents.get(key) }),
            remove: async names => { for ( const key of names ) { contents.delete(key); } },
        },
        assetCacheRegistry: cacheRegistry,
        assetCacheRegistryStartTime: 100,
        getAssetCacheRegistry: async () => cacheRegistry,
        getAssetSourceRegistry: async () => registry,
        assetSourceGetDetails: async key => registry[key],
        assetCacheGetDetails: async key => cacheRegistry[key],
        getContentURLs: key => registry[key].contentURL,
        getAssetDiffDetails: assetKey => ({ assetKey, patchPath: 'patch.diff' }),
        computedPatchUpdateTime: () => 1,
        getWriteTime: key => cacheRegistry[key].writeTime,
        getUpdateAfterTime: () => 1000,
        extractMetadataFromList: () => ({ lastModified: 2, diffPath: 'next.diff' }),
        registerAssetSource: (key, details) => Object.assign(registry[key], details),
        saveAssetCacheRegistry() {},
        resourceIsStale: () => false,
        stringIsNotEmpty: value => typeof value === 'string' && value !== '',
        reIsExternalPath: /^https?:\/\//,
        updaterAuto: false,
        updaterStatus: undefined,
        updaterPromise: undefined,
        updaterFetched: new Set(),
        updaterUpdated: [],
        updaterAssetDelay: 100,
        updaterAssetDelayDefault: 100,
        remoteServerFriendly: false,
        requiredLists: keys,
        engineReady: Promise.resolve('frame'),
        policyGeneration: 0,
        profile: { version: [ ...keys.map(() => '1\nOLD'), JSON.stringify('psl') ].join('|') },
        profileCompiledLists: lists => lists.map(details => details.content),
        publicSuffixList: { toSelfie: () => 'psl' },
        sha256: async lists => {
            const version = lists.join('|');
            versions.push(version);
            return version;
        },
        resetProfile: (...args) => resets.push(args),
        Worker: class {
            constructor() { workerStarted.resolve(this); }
            postMessage() {}
            terminate() { events.push('worker-stop'); }
        },
        vAPI: {
            defer: { create(callback) { timer.callback = callback; return timer; } },
            webextFlavor: { soup: new Set() },
        },
        ubolog() {},
        broadcast(message) {
            if ( message.what === 'staticFilteringDataChanged' ) {
                refreshes.push(context.refreshProfile(message));
            }
        },
        fireNotification(topic, details) {
            if ( topic === 'before-asset-cache-write' ) {
                events.push(`before-write:${cacheRegistry[details.assetKey]?.writeTime}`);
            }
            if ( topic === 'after-asset-cache-write' ) { events.push('after-write'); }
            if ( topic === 'after-assets-updated' ) {
                events.push('batch-done');
                completions.push(details);
            }
            return ublock.assetObserver(topic, details);
        },
    };
    // Real wrapper: raw cache entries rely on primary storage, not the auxiliary.
    context.cacheStorage.set = cacheWriter(context.cacheStorage.set);
    const functions = runInNewContext(
        between(storage, 'µb.getCompiledFilterList =', 'µb.extractFilterListMetadata =') +
        between(storage, 'µb.removeCompiledFilterList =', 'µb.removeFilterList =') +
        storage.slice(storage.indexOf('µb.assetObserver =')) + refreshCode + updaterCode +
        ';({ getUpdateCandidates, assetCacheRead, assetCacheWrite })', context
    );
    async function finish() {
        await context.updaterPromise;
        for ( let i = 0; timer.scheduled && i < 10; i++ ) {
            timer.fire();
            await context.updaterPromise;
        }
        assert.equal(timer.scheduled, false, 'Native update cycle is bounded');
        await Promise.all(refreshes);
    }
    return {
        context, functions, contents, cacheRegistry, events, completions, resets, versions, fetches, timer,
        writeStarted, releaseWrite, workerStarted, finish,
    };
}

for ( const mode of [ 'diff', 'broken', 'worker-error', 'diff-reject', 'full', 'full-reject', 'faster' ] ) {
    const differential = mode.startsWith('full') === false;
    const failWrite = mode.endsWith('reject');
    const keys = [ 'broken', 'worker-error' ].includes(mode)
        ? [ 'spa-0', 'adguard-generic' ] : [ 'spa-0' ];
    const fixture = updaterFixture({ differential, failWrite, keys });
    const { context, completions, contents, events } = fixture;
    context.assets.updateStart({ auto: differential, fetchDelay: 10 });
    if ( differential ) {
        const worker = await fixture.workerStarted.promise;
        worker.onmessage({ data: { what: 'ready' } });
        worker.onmessage({ data: { status: 'updated', assetKey: 'spa-0', text: 'NEW' } });
        if ( mode === 'broken' ) { worker.onmessage({ data: { what: 'broken', error: 'test worker stop' } }); }
        if ( mode === 'worker-error' ) { worker.onerror({ message: 'test worker error' }); }
    }
    await fixture.writeStarted.promise;
    await new Promise(resolve => setImmediate(resolve));
    if ( differential === false && fixture.timer.scheduled ) {
        fixture.timer.fire();
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(completions.length, 0, `${mode}: raw write must precede native batch completion`);
    assert.equal(contents.get('cache/compiled/spa-0'), '1\nOLD');
    assert.deepEqual(events.slice(events.indexOf('write-start') - 1, events.indexOf('write-start') + 1),
        [ 'before-write:1', 'write-start' ], 'Actual writes notify before metadata and storage change');
    assert.ok(fixture.cacheRegistry['spa-0'].writeTime > 1,
        'Native metadata publication still precedes persistence for pending cache readers');
    if ( mode === 'faster' ) {
        context.assets.updateStart({ auto: false, fetchDelay: 1 });
        fixture.timer.fire();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(fixture.fetches.length, 0, 'Faster native timer cannot overtake differential writes');
        assert.equal(completions.length, 0);
    }
    fixture.releaseWrite.resolve();
    await fixture.finish();
    assert.equal(completions.length, 1, `${mode}: expected native completion count`);
    assert.ok(events.indexOf('after-write') > events.indexOf('write-start'));
    assert.ok(events.lastIndexOf('after-write') < events.indexOf('batch-done'));
    assert.equal(contents.get('cache/compiled/spa-0'), failWrite ? '1\nOLD' : '1\nNEW');
    assert.equal(fixture.resets.length, failWrite ? 0 : 1,
        `${mode}: batch profile refresh must see new compiled rules, not the old cache`);
    assert.deepEqual(fixture.versions, failWrite ? [] : [ [ ...keys.map(() => '1\nNEW'), JSON.stringify('psl') ].join('|') ],
        `${mode}: actual profile hash inputs must be the new compiled cache`);
    if ( failWrite ) {
        assert.equal(fixture.cacheRegistry['spa-0'].writeTime, 0, 'Rejected storage remains eligible for native retry');
        assert.equal(fixture.cacheRegistry['spa-0'].resourceTime, 1, 'Failed writes retain old resource metadata');
        assert.equal(completions[0].assetKeys.length, 0, 'Rejected writes are not successful updates');
    } else {
        assert.ok(events.indexOf('write-finish') < events.indexOf('batch-done'));
    }
    if ( mode === 'broken' || mode === 'worker-error' || mode === 'diff-reject' ) {
        assert.ok(fixture.fetches.length > 0, 'Differential failure retains the native full-download fallback');
    }
    const after = events.slice();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, after, `${mode}: no cache work remains after batch completion`);
}
console.log('Passed: native differential/full batches drain raw writes, failures, worker failures and manual faster updates');

{
    const fixture = updaterFixture();
    fixture.context.cacheStorage.set = backendCache({
        backend: 'cacheAPI',
        cache: { put: async () => { throw new Error('quota exceeded'); } },
    }).set;
    await assert.rejects(
        fixture.functions.assetCacheWrite('compiled/derived', 'new', { requirePersistence: true }),
        /Asset cache write failed/
    );
    await fixture.functions.assetCacheWrite('compiled/derived', 'new');
    assert.equal(fixture.cacheRegistry['compiled/derived'], undefined,
        'Failed optional fast-cache writes invalidate stale derived data without throwing');
}

{
    const fixture = updaterFixture({ failWrite: true });
    fixture.releaseWrite.resolve();
    assert.equal(await fixture.context.cacheStorage.set({ 'cache/derived': 'data' }), false);
    await fixture.functions.assetCacheWrite('compiled/derived', 'data');
    assert.equal(fixture.completions.length, 0, 'Derived best-effort writes do not become update batches');
    const releasePrimary = deferred();
    const primaryStarted = deferred();
    let finished = false;
    const write = cacheWriter(async () => {
        primaryStarted.resolve();
        await releasePrimary.promise;
    }, async () => { throw new Error('auxiliary storage failure'); });
    const pending = write({ 'cache/feed': 'new' }).then(result => {
        finished = true;
        return result;
    });
    await primaryStarted.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false, 'An auxiliary failure cannot finish before the primary write');
    releasePrimary.resolve();
    assert.equal(await pending, false);
    const fail = async () => { throw new Error('backend storage failure'); };
    assert.equal(await cacheWriter(fail, fail)({ 'cache/feed': 'new' }), false);
}
console.log('Passed: actual cache wrapper reports backend failures without changing derived best-effort writes');

{
    const fixture = updaterFixture({ failWrite: true });
    fixture.contents.set('cache/derived', 'NEW');
    fixture.contents.set('cache/compiled/derived', '1\nOLD');
    fixture.cacheRegistry.derived = { writeTime: 1, readTime: 1, resourceTime: 1 };
    fixture.cacheRegistry['compiled/derived'] = { writeTime: 1, readTime: 1, resourceTime: 1 };
    fixture.releaseWrite.resolve();
    await fixture.functions.assetCacheWrite('compiled/derived', '1\nNEW');
    fixture.context.io.fromCache = async key => (await fixture.functions.assetCacheRead(key)).content;
    fixture.context.io.get = key => fixture.functions.assetCacheRead(key);
    fixture.context.io.toCache = () => {};
    const result = await fixture.context.µb.getCompiledFilterList('derived');
    assert.equal(result.content, '1\nNEW', 'A failed optional cache must not return obsolete compiled rules');
}
console.log('Passed: failed derived cache writes fall back to compiling the saved source');

{
    const keys = [ 'spa-0', popupAdsAssetKey, ...requiredMalwareLists ];
    const fixture = updaterFixture({ keys });
    fixture.context.µb.quereeFilterLists.clear();
    fixture.context.engineReady = undefined;
    await initializeAdProfileAssets(fixture.context.µb, fixture.context.assets);
    const candidates = await fixture.functions.getUpdateCandidates();
    assert.deepEqual(Array.from(candidates).sort(), keys.slice().sort());
    for ( const key of keys ) {
        assert.equal(fixture.contents.get(`cache/${key}`), 'OLD', 'Enabled warm profile raw cache survives before first query');
        assert.equal(fixture.contents.get(`cache/compiled/${key}`), '1\nOLD');
    }
    assert.equal(fixture.resets.length, 0);
    assert.deepEqual(fixture.context.µb.selectedFilterLists, []);
}
console.log('Passed: native candidate sweep retains enabled warm profile caches before the first query');
