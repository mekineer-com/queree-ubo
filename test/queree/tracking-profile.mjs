import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers';
import { domainToASCII } from 'node:url';
import process from 'node:process';
import { trackingAssetKey, trackingRules, trackingSource } from '../../src/js/queree/tracking-sources.js';
import { AstFilterParser } from '../../src/js/static-filtering-parser.js';
import { CompiledListReader, CompiledListWriter } from '../../src/js/static-filtering-io.js';
import { FilteringContext } from '../../src/js/filtering-context.js';
import engine from '../../src/js/static-net-filtering.js';
import psl from '../../src/lib/publicsuffixlist/publicsuffixlist.js';
const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
// Synthetic source data keeps the offline suite independent of downloaded lists.
const sample = JSON.stringify({ patterns: Object.fromEntries([
    ...trackingSource.patterns.map((key, index) => [ key, {
        filters: [ `||tracker${index}.example/pixel^$3p` ],
    } ]),
    [ 'ordinary_analytics', { filters: [ '||statistics.example^' ] } ],
]) });
const rules = trackingRules(sample);
assert.equal(rules.split('\n').length, trackingSource.patterns.length);
const data = JSON.parse(sample);
data.patterns.facebook_custom_audience.domains = [ 'ordinary.example' ];
assert.equal(trackingRules(JSON.stringify(data)), rules, 'Domain metadata is not a request rule');
delete data.patterns.reddit_ads;
assert.throws(() => trackingRules(JSON.stringify(data)), /missing or invalid: reddit_ads/);
assert.throws(() => trackingRules('{'), SyntaxError);
function compile(raw) {
    const writer = new CompiledListWriter();
    const parser = new AstFilterParser({ trustedSource: false, maxTokenLength: engine.MAX_TOKEN_LENGTH });
    const compiler = engine.createCompiler(parser);
    compiler.start(writer);
    for ( const line of raw.split('\n') ) {
        parser.parse(line);
        if ( parser.isFilter() && parser.hasError() === false ) { compiler.compile(parser, writer); }
    }
    compiler.finish(writer);
    parser.finish();
    return writer.toString();
}
engine.reset();
psl.parse('com\nnet\norg\nexample\n', domainToASCII);
engine.fromCompiled(new CompiledListReader(compile(rules)));
engine.freeze();
engine.optimize();
const cases = [
    [ 'https://tracker0.example/pixel?event=view', 'image', 'https://publisher.example/', 1 ],
    [ 'https://www.facebook.com/plugins/share_button.php', 'sub_frame', 'https://publisher.example/', 0 ],
    [ 'https://www.google-analytics.com/g/collect', 'ping', 'https://publisher.example/', 0 ],
    [ 'https://stats.g.doubleclick.net/g/collect', 'ping', 'https://publisher.example/', 0 ],
    [ 'https://www.googletagmanager.com/gtag/js?id=G-EXAMPLE', 'script', 'https://publisher.example/', 0 ],
    [ 'https://molbio.science/piwik/piwik.php', 'ping', 'https://mekineer.com/', 0 ],
    [ 'https://tracker1.example/pixel', 'script', 'https://publisher.example/', 1 ],
    [ 'https://tracker3.example/pixel', 'script', 'https://publisher.example/', 1 ],
    [ 'https://tracker3.example/pixel', 'script', 'https://tracker3.example/', 0 ],
    [ 'https://tracker3.example/content.js', 'script', 'https://publisher.example/', 0 ],
    [ 'https://tracker4.example/pixel', 'script', 'https://publisher.example/', 1 ],
    [ 'https://tracker5.example/pixel?event=view', 'image', 'https://publisher.example/', 1 ],
    [ 'https://tracker0.example.other.example/pixel', 'image', 'https://publisher.example/', 0 ],
    [ 'https://statistics.example/pixel', 'image', 'https://publisher.example/', 0 ],
];
function match(url, type, originURL) {
    const context = new FilteringContext().fromDetails({ url, type, originURL }).setTabOrigin(originURL).setMethod('GET');
    return engine.matchRequest(context);
}
for ( const [ url, type, originURL, expected ] of cases ) {
    assert.equal(match(url, type, originURL), expected, url);
}

// Optional publisher download verifies native wiring without bundling its data.
if ( process.argv[2] !== undefined ) {
    const upstream = trackingRules(readFileSync(process.argv[2], 'utf8'));
    engine.reset();
    engine.fromCompiled(new CompiledListReader(compile(upstream)));
    engine.freeze();
    engine.optimize();
    const positive = [
        [ 'adobe_advertising_cloud', 'https://cm.everesttech.net/cm/dd', 'image' ],
        [ 'adroll_pixel', 'https://d.adroll.com/pixel/EXAMPLE', 'image' ],
        [ 'adroll_roundtrip', 'https://s.adroll.com/j/roundtrip.js', 'script' ],
        [ 'bing_ads', 'https://bat.bing.com/action/0?ti=12345', 'image' ],
        [ 'criteo', 'https://gum.criteo.com/syncframe', 'sub_frame' ],
        [ 'doubleclick_ad_buyer', 'https://www.googleadservices.com/pagead/conversion.js', 'script' ],
        [ 'doubleclick_floodlight', 'https://12345.fls.doubleclick.net/activityi;src=12345', 'image' ],
        [ 'facebook_custom_audience', 'https://www.facebook.com/tr?id=12345&ev=PageView', 'image' ],
        [ 'google_remarketing', 'https://googleads.g.doubleclick.net/pagead/viewthroughconversion/12345/', 'image' ],
        [ 'linkedin_ads', 'https://ads.linkedin.com/collect?v=2&pid=12345', 'image' ],
        [ 'linkedin_analytics', 'https://snap.licdn.com/li.lms-analytics/insight.min.js', 'script' ],
        [ 'outbrain_amplify', 'https://amplify.outbrain.com/cp/obtp.js', 'script' ],
        [ 'outbrain_pixel', 'https://tr.outbrain.com/pixel?ob_click_id=EXAMPLE', 'image' ],
        [ 'pinterest_conversion_tracker', 'https://s.pinimg.com/ct/core.js', 'script' ],
        [ 'reddit_ads', 'https://www.redditstatic.com/ads/pixel.js', 'script' ],
        [ 'snapchat', 'https://sc-static.net/scevent.min.js', 'script' ],
        [ 'tradedesk', 'https://insight.adsrvr.org/track/up?adv=EXAMPLE', 'image' ],
        [ 'twitter_conversion_tracking', 'https://t.co/i/adsct?txn_id=EXAMPLE', 'image' ],
        [ 'yahoo_dot_tag', 'https://s.yimg.com/wi/ytc.js', 'script' ],
    ];
    assert.deepEqual(positive.map(([ key ]) => key), trackingSource.patterns);
    for ( const [ key, url, type ] of positive ) {
        assert.equal(match(url, type, 'https://publisher.example/'), 1, key);
    }
    for ( const [ url, type, originURL, expected ] of cases.filter(test => test[3] === 0) ) {
        assert.equal(match(url, type, originURL), expected, url);
    }
    for ( const url of [
        'https://assets.pinterest.com/js/pinit.js',
        'https://www.tiktok.com/embed.js',
        'https://dpm.demdex.net/id?d_orgid=EXAMPLE',
        'https://example.sc.omtrdc.net/b/ss/example/1',
        'https://assets.adobedtm.com/example/launch.js',
        'https://widgets.outbrain.com/outbrain.js',
        'https://s.yimg.com/ny/api/res/example.jpg',
    ] ) {
        assert.equal(match(url, 'script', 'https://publisher.example/'), 0, url);
    }
    assert.equal(match('https://www.criteo.com/about/', 'xmlhttprequest', 'https://www.criteo.com/'), 0);
    console.log(`Passed: ${trackingSource.patterns.length} upstream tracking records / ${upstream.split('\n').length} rules, native matches and analytics/widget controls`);
}
let writeTime = 1;
let loads = 0;
const registrations = [];
const commands = [];
let assetObserver;
const frame = { postMessage(message) { commands.push(message); } };
const context = {
    assets: {
        addObserver: observer => { assetObserver = observer; },
        registerAssetSource: async (...args) => { registrations.push(args); },
        get: async key => { assert.equal(key, trackingAssetKey); return { content: sample }; },
        metadata: async () => ({ [trackingAssetKey]: { writeTime }, psl: { writeTime: 1 } }),
    },
    publicSuffixList: { toSelfie: () => 'production-suffix-data' },
    µb: { pslAssetKey: 'psl', compileFilters: compile },
    loadPolicyFrame: async (target, details) => {
        assert.equal(target, frame);
        assert.equal(details.compiledLists.length, trackingSource.patterns.length);
        assert.equal(details.compiledLists.some(list => list.includes('@@')), false, 'No advertising exceptions imported');
        loads += 1;
        return { filterCount: details.compiledLists.length };
    },
    policyCommand: (command, id) => { assert.equal(id, 'quereeTrackingEngine'); return command; },
    policyFrame: () => frame,
    waitForPolicyEngine: async () => frame,
    trackingAssetKey, trackingRules, trackingSource, CompiledListReader,
    location: { origin: 'moz-extension://fixture' },
};
const source = read('src/js/queree/tracking-profile.js').replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, '');
const api = runInNewContext(source + '\n;({loadTrackingEngine,matchTrackingRequest,refreshTrackingEngine,resetTrackingEngine})', context);
assert.throws(() => api.matchTrackingRequest({}), /not ready/);
await Promise.all([ api.loadTrackingEngine(), api.loadTrackingEngine() ]);
assert.equal(loads, 1);
assert.equal(registrations.length, 1);
assert.equal(registrations[0][1].content, 'text');
assert.deepEqual(Array.from(registrations[0][1].contentURL), [ trackingSource.url ],
    'First use downloads from the publisher; no bundled fallback is distributed');
assert.equal(api.matchTrackingRequest({ url: 'https://example.org' }).what, 'matchRequest');
await api.refreshTrackingEngine({ key: 'unrelated-ad-list' });
assert.equal(commands.length, 0);
writeTime += 1;
await api.refreshTrackingEngine({ key: trackingAssetKey });
assert.equal(commands.length, 1);
assert.equal(commands[0].what, 'reset');
assert.throws(() => api.matchTrackingRequest({}), /not ready/);
await api.loadTrackingEngine();
assert.equal(loads, 2);
assetObserver('after-asset-updated', { assetKey: trackingAssetKey });
await api.refreshTrackingEngine({ key: trackingAssetKey });
assert.throws(() => api.matchTrackingRequest({}), /not ready/,
    'A completed write refreshes even when metadata advanced before the old cache was read');
await api.loadTrackingEngine();
assert.equal(loads, 3);
api.resetTrackingEngine();
assert.throws(() => api.matchTrackingRequest({}), /not ready/);
context.waitForPolicyEngine = async () => {
    writeTime += 1;
    assetObserver('after-asset-updated', { assetKey: trackingAssetKey });
    return frame;
};
await api.loadTrackingEngine();
assert.equal(loads, 4, 'Rules are read after frame preparation, not before its concurrent update');
context.waitForPolicyEngine = async () => frame;
api.resetTrackingEngine();
const get = context.assets.get;
let firstDownload = true;
let reads = 0;
context.assets.get = async key => {
    reads += 1;
    const result = await get(key);
    if ( firstDownload ) {
        firstDownload = false;
        writeTime += 1;
        assetObserver('after-asset-updated', { assetKey: trackingAssetKey });
    }
    return result;
};
await api.loadTrackingEngine();
assert.equal(reads, 2, 'First-download cache writes are reread without rejecting the inspection');
assert.equal(loads, 6);

const ordinaryGet = get;
const ordinaryLoad = context.loadPolicyFrame;
api.resetTrackingEngine();
const invalid = JSON.parse(sample);
invalid.patterns.reddit_ads.filters = [ '! Only a comment' ];
context.assets.get = async () => ({ content: JSON.stringify(invalid) });
await assert.rejects(api.loadTrackingEngine(), /no usable rules: reddit_ads/,
    'One empty product cannot hide behind the other valid products');
assert.throws(() => api.matchTrackingRequest({}), /not ready/);
context.assets.get = async () => ({ content: '', error: 'network error' });
await assert.rejects(api.loadTrackingEngine(), /network error/);
context.assets.get = ordinaryGet;
context.loadPolicyFrame = async () => ({ filterCount: 0 });
await assert.rejects(api.loadTrackingEngine(), /profile has no usable rules/);
context.loadPolicyFrame = ordinaryLoad;

const metadata = context.assets.metadata;
let metadataReads = 0;
context.assets.metadata = async () => {
    if ( ++metadataReads === 2 ) { api.resetTrackingEngine(); }
    return metadata();
};
await assert.rejects(api.loadTrackingEngine(), /changed while loading/,
    'A reset during the final version read cannot publish a stale ready frame');
assert.throws(() => api.matchTrackingRequest({}), /not ready/);
context.assets.metadata = metadata;

// Native writeTime can advance before the background has parsed the new suffix list.
api.resetTrackingEngine();
let suffixes = 'old-suffixes';
let copiedSuffixes;
context.assets.metadata = async () => ({ [trackingAssetKey]: { writeTime }, psl: { writeTime: 2 } });
context.publicSuffixList.toSelfie = () => suffixes;
context.loadPolicyFrame = async (_frame, details) => {
    copiedSuffixes = details.pslSelfie;
    return { filterCount: 1 };
};
await api.loadTrackingEngine();
assert.equal(copiedSuffixes, 'old-suffixes');
suffixes = 'new-suffixes';
assetObserver('after-asset-updated', { assetKey: 'psl' });
await api.refreshTrackingEngine({ key: 'psl' });
assert.throws(() => api.matchTrackingRequest({}), /not ready/,
    'Suffix publication invalidates a stale copy even when writeTime was already new');
await api.loadTrackingEngine();
assert.equal(copiedSuffixes, 'new-suffixes');
context.assets.metadata = metadata;
context.loadPolicyFrame = ordinaryLoad;
api.resetTrackingEngine();

let gatedReads = 0;
context.assets.get = async () => { gatedReads += 1; return ordinaryGet(trackingAssetKey); };
assetObserver('before-asset-cache-write', { assetKey: trackingAssetKey, content: sample });
const gated = api.loadTrackingEngine();
await new Promise(resolve => setImmediate(resolve));
assert.equal(gatedReads, 0, 'A pending write cannot pair newer metadata with older cached rules');
writeTime += 1;
assetObserver('after-asset-updated', { assetKey: trackingAssetKey });
assetObserver('after-asset-cache-write', { assetKey: trackingAssetKey });
await gated;
assert.ok(gatedReads > 0);

const registry = { [trackingAssetKey]: { writeTime: 10 } };
const cached = new Map([[ `cache/${trackingAssetKey}`, sample ]]);
const assetsSource = read('src/js/assets.js');
const start = assetsSource.indexOf('async function assetCacheWrite(');
const end = assetsSource.indexOf('async function assetCacheRemove(', start);
const writeCache = runInNewContext(assetsSource.slice(start, end) + ';assetCacheWrite', {
    getAssetCacheRegistry: async () => registry,
    cacheStorage: { set: async bin => { for ( const [ key, value ] of Object.entries(bin) ) { cached.set(key, value); } return true; } },
    saveAssetCacheRegistry() {}, fireNotification: assetObserver,
});
await assert.rejects(writeCache(trackingAssetKey, JSON.stringify(invalid), { requirePersistence: true }), /no usable rules/);
assert.equal(cached.get(`cache/${trackingAssetKey}`), sample, 'A bad update preserves the last-good body');
assert.equal(registry[trackingAssetKey].writeTime, 10, 'A bad update preserves the last-good metadata');
await assert.rejects(writeCache(trackingAssetKey, '{', { requirePersistence: true }), SyntaxError);
api.resetTrackingEngine();
await api.loadTrackingEngine();
assert.equal(api.matchTrackingRequest({}).what, 'matchRequest', 'Rejected updates release their write gate');
if ( process.argv[2] !== undefined ) {
    context.assets.get = async () => ({ content: readFileSync(process.argv[2], 'utf8') });
    api.resetTrackingEngine();
    await api.loadTrackingEngine();
}
console.log('Passed: native tracking rules, request controls, selection and isolated profile lifecycle');
