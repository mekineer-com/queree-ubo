import commerceFingerprints, { commerceEngineSource, commerceFingerprintsSHA256, commerceFingerprintsSource } from '../../src/js/queree/vendor/commerce-fingerprints.js';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { decisionPolicyFingerprint, sharedDecisionCompatibility } from '../../src/js/queree/decision-cache.js';
import { domainIndexData, listedSourceDomainReasons, loadDomainIndexFromBuffer } from '../../src/js/queree/domain-index.js';
import assert from 'node:assert/strict';
import { contributionObservation } from '../../src/js/queree/contribution-core.js';
import { createHash } from 'node:crypto';
import { detect } from '../../src/js/queree/vendor/opentechalyzer/detect/engine.js';
import { generateCommerceFingerprints } from '../../tools/make-queree-commerce-fingerprints.mjs';
import { join } from 'node:path';
import { listedAffiliateLinkReasons } from '../../src/js/queree/website-lists.js';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { trackingSource } from '../../src/js/queree/tracking-sources.js';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const binary = readFileSync(new URL('src/assets/queree/domain-index.bin', root));
loadDomainIndexFromBuffer(binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength));
const digest = payload => createHash('sha256').update(payload).digest('hex');
assert.equal(commerceFingerprintsSHA256, digest(JSON.stringify(commerceFingerprints)));
const pins = Object.fromEntries(read('tools/queree-release-sources.lock').trim().split('\n').map(line => line.split('=')));
assert.equal(commerceEngineSource, `opentechalyzer:${pins.OPENTECHALYZER_COMMIT}`);
assert.equal(commerceFingerprintsSource, `webappanalyzer:${pins.WEBAPPANALYZER_COMMIT}`);
const signalsFrom = code => JSON.parse(JSON.stringify(vm.runInNewContext(
    code + '; globalThis.__quereeCommerceSignals'
)));
const signalsFor = fingerprints => ({
    js: [ ...new Set(fingerprints.flatMap(item => Object.keys(item.js || {}))) ],
});
assert.deepEqual(signalsFrom(read('src/js/queree/vendor/commerce-signals.js')),
    signalsFor(commerceFingerprints));
assert.ok(commerceFingerprints.every(item => item.dom === undefined && item.requestHost === undefined));

const controller = read('src/js/queree/controller.js');
const profileCode = controller.slice(
    controller.indexOf('const deterministicProfile = '),
    controller.indexOf('const decisionCache = ')
) + '; deterministicProfile';
const profileFor = (sha256, engine = commerceEngineSource, source = commerceFingerprintsSource) => vm.runInNewContext(profileCode, {
    commerceEngineSource: engine,
    commerceFingerprintsSource: source,
    commerceFingerprintsSHA256: sha256,
    domainIndexData: { sha256: 'domain-data', byte_length: 1 },
    shoppingDomainLists: [], scamDomainLists: [], adultDomainLists: [],
    urlPatternMatcher: {}, promotionSources: [], affiliateLinkSources: [], corporateDomainLists: [],
    institutionalDomainLists: [], restrictedSourceNamespaces: [],
    publicInterestDomainLists: [],
    trackingSource,
    requiredMalwareLists: [ 'ublock-badware', 'urlhaus-1' ],
});
assert.equal(profileFor(commerceFingerprintsSHA256).fingerprints.sha256, commerceFingerprintsSHA256);

// Exercise the generator, not just a separately reimplemented hash formula.
const temporary = mkdtempSync(join(tmpdir(), 'queree-fingerprints-'));
try {
    const upstream = join(temporary, 'upstream');
    const technologies = join(temporary, 'src/technologies');
    mkdirSync(join(upstream, 'dist/fingerprints'), { recursive: true });
    mkdirSync(join(upstream, 'src/fingerprints'), { recursive: true });
    mkdirSync(technologies, { recursive: true });
    writeFileSync(join(upstream, 'package.json'), '{"type":"module"}');
    writeFileSync(join(upstream, 'dist/fingerprints/external.js'),
        'throw new Error("Do not execute leftover compiled code");');
    writeFileSync(join(upstream, 'src/fingerprints/external.ts'),
        'export const convertWappalyzerTech = (name, value) => ({ name, ...value, ' +
        'scriptSrc: [...(value.scripts || []), ...(value.scriptSrc || [])], requestHost: value.xhr });');
    for ( const shard of '_abcdefghijklmnopqrstuvwxyz' ) {
        writeFileSync(join(technologies, `${shard}.json`), '{}');
    }
    const technology = {
        categories: [ 'ecommerce', 'cms' ], html: [ 'first', 'second' ],
        scriptSrc: [ 'store-cdn' ], scripts: [ 'storeSourceMarker' ],
        xhr: [ 'xhr.example' ], dom: { link: { text: 'store' } },
        js: { 'Store.version': '', sharedGlobal: '' }, requires: [ 'Dependency' ],
    };
    const generate = async (name, space, generator = generateCommerceFingerprints) => {
        writeFileSync(join(technologies, 'a.json'), JSON.stringify({
            Store: technology,
            Dependency: { categories: [ 'cms' ], js: { 'Dependency.ready': '', sharedGlobal: '' } },
            Kajabi: { categories: [ 'ecommerce' ] },
            Zapiet: { categories: [ 'ecommerce' ] },
        }, null, space));
        mkdirSync(join(temporary, name));
        const output = join(temporary, name, 'commerce-fingerprints.mjs');
        const { convertWappalyzerTech } = await import(join(upstream, 'src/fingerprints/external.ts'));
        await generator(convertWappalyzerTech, temporary, output);
        const generated = await import(pathToFileURL(output).href);
        const module = readFileSync(output, 'utf8');
        const payload = module.split('export default ')[1].slice(0, -2);
        const sha256 = generated.commerceFingerprintsSHA256;
        assert.equal(sha256, digest(payload));
        const fingerprints = JSON.parse(payload);
        const signals = signalsFrom(readFileSync(join(temporary, name, 'commerce-signals.js'), 'utf8'));
        assert.deepEqual(signals, signalsFor(fingerprints));
        assert.deepEqual(signals, {
            js: [ ...Object.keys(technology.js), 'Dependency.ready' ],
        });
        assert.deepEqual(fingerprints[0].scriptSrc, technology.scriptSrc);
        assert.deepEqual(fingerprints[0].scriptContent, technology.scripts);
        assert.ok(fingerprints.every(item => item.dom === undefined && item.requestHost === undefined));
        assert.deepEqual(fingerprints.map(item => item.name), [ 'Store', 'Kajabi', 'Zapiet', 'Dependency' ]);
        return { module, payload, signals, profile: profileFor(sha256,
            generated.commerceEngineSource, generated.commerceFingerprintsSource) };
    };
    const original = await generate('original');
    const tools = join(temporary, 'tools');
    mkdirSync(tools);
    for ( const name of [ 'make-queree-commerce-fingerprints.mjs', 'queree-generated-files.mjs' ] ) {
        copyFileSync(new URL(`tools/${name}`, root), join(tools, name));
    }
    const changedPins = { ...pins, OPENTECHALYZER_COMMIT: '1'.repeat(40), WEBAPPANALYZER_COMMIT: '2'.repeat(40) };
    writeFileSync(join(tools, 'queree-release-sources.lock'), Object.entries(changedPins)
        .map(([ key, value ]) => `${key}=${value}`).join('\n'));
    const refreshed = await import(pathToFileURL(join(tools, 'make-queree-commerce-fingerprints.mjs')).href);
    const changedSources = await generate('changed-sources', undefined, refreshed.generateCommerceFingerprints);
    assert.equal(changedSources.payload, original.payload, 'Pin refresh alone must not alter fingerprint payload');
    assert.equal(changedSources.profile.engine, `opentechalyzer:${changedPins.OPENTECHALYZER_COMMIT}`);
    assert.equal(changedSources.profile.fingerprints.source, `webappanalyzer:${changedPins.WEBAPPANALYZER_COMMIT}`);
    const unchanged = await generate('unchanged', 2);
    assert.equal(unchanged.module, original.module, 'Input formatting/output path must not affect the digest');
    assert.deepEqual(unchanged.signals, original.signals);
    technology.html[0] = 'changed';
    const changed = await generate('changed');
    technology.html.reverse();
    const reordered = await generate('reordered');
    delete technology.js['Store.version'];
    technology.js['Store.nextVersion'] = '';
    const differentSignals = await generate('different-signals');
    assert.notDeepEqual(differentSignals.signals, reordered.signals);
    const policy = value => decisionPolicyFingerprint(value.profile, {});
    const compatibility = async value => (await sharedDecisionCompatibility(value.profile)).page_observation;
    assert.equal(typeof await compatibility(original), 'string');
    assert.equal(await policy(unchanged), await policy(original));
    assert.equal(await compatibility(unchanged), await compatibility(original));
    for ( const next of [ changed, reordered, differentSignals ] ) {
        assert.notEqual(await policy(next), await policy(original));
        assert.notEqual(await compatibility(next), await compatibility(original));
    }
    assert.notEqual(await policy(reordered), await policy(changed), 'Rule order is detection-significant');
    assert.notEqual(await compatibility(differentSignals), await compatibility(reordered),
        'Changed probe paths must invalidate shared shopping observation compatibility');
    const legacy = { profile: { ...original.profile, fingerprints: original.profile.fingerprints.source } };
    assert.notEqual(await policy(legacy), await policy(original));
    assert.notEqual(await compatibility(legacy), await compatibility(original));
} finally {
    rmSync(temporary, { recursive: true, force: true });
}
console.log('Passed: generated payload SHA256 is stable and invalidates local/shared cache compatibility on payload changes');

const url = 'https://personal.example/page';
const bundle = {
    url, finalUrl: url, headers: {}, setCookies: [], html: '',
    scriptSrcs: [], scriptContents: [], stylesheetSrcs: [], cssContents: [],
    metas: {}, requestHosts: [], jsGlobals: {}, domSelectors: new Set(),
    dns: { txt: [], mx: [], cname: [], ns: [] }, certSubdomains: [],
    npmDeps: [], probes: {},
};
const namesFor = observations => detect(commerceFingerprints, {
    ...bundle, ...observations,
}, 50).filter(item => item.categories.includes('ecommerce')).map(item => item.name);
for ( const brand of [
    'Shopify', 'WooCommerce', 'BigCommerce', 'Magento', 'PrestaShop',
    'OpenCart', 'Squarespace', 'Wix', 'Ecwid', 'Weebly', 'Drupal Commerce',
    'Kajabi', 'Zapiet',
] ) {
    assert.deepEqual(namesFor({ html: `<article>I wrote about ${brand}, not a shop.</article>` }), [], brand);
}
for ( const [ name, observations ] of [
    [ 'Shopify', { scriptSrcs: [ 'https://cdn.shopify.com/storefront.js' ] } ],
    [ 'Shopify', { scriptContents: [ 'var shopifyTag = true;' ] } ],
    [ 'Shopify', { headers: { 'x-shopify-stage': 'production' } } ],
    [ 'Shopify', { jsGlobals: { Shopify: 'defined', ShopifyAnalytics: 'defined' } } ],
    [ 'BigCommerce', { jsGlobals: { bigcommerce_config: 'defined' } } ],
    [ 'WooCommerce', { metas: { generator: 'WordPress 6.8' }, jsGlobals: { woocommerce_params: 'defined' } } ],
    [ '1C-Bitrix', { headers: { 'x-powered-cms': 'Bitrix Site Manager' } } ],
    [ 'Kajabi', { jsGlobals: { Kajabi: 'defined' } } ],
    [ 'Zapiet', { scriptSrcs: [ 'https://app.zapiet.com/widget.js' ] } ],
] ) {
    assert.ok(namesFor(observations).includes(name), name);
}
assert.deepEqual(namesFor({ scriptSrcs: [ 'https://personal.example/shopifyTag.js' ] }), []);
assert.deepEqual(namesFor({ requestHosts: [ 'store.myshopify.com' ] }), []);
assert.equal(namesFor({ jsGlobals: { Shopify: 'defined' } }).includes('Shopify'), false,
    'The namespace alone is below the maintained confidence threshold');
// Known weak upstream rules remain data, not per-product exceptions.
assert.ok(namesFor({ finalUrl: 'https://personal.example/wcs/article' }).includes('HCL Commerce'));
assert.ok(namesFor({ jsGlobals: { amzn: 'defined' } }).includes('Amazon Webstore'));
console.log('Passed: 13 brand mentions rejected; 9 genuine software controls recognized; source text, URLs and XHR hosts stay distinct');

let detections = [];
const state = { url, sponsoredLinks: [], shoppingEvidence: {} };
const selectCommerceDetection = vm.runInNewContext(controller.slice(
    controller.indexOf('function selectCommerceDetection('),
    controller.indexOf('async function completed(')
) + '; selectCommerceDetection');
const commerceDecision = vm.runInNewContext(controller.slice(
    controller.indexOf('async function commerceDecision('),
    controller.indexOf('function selectCommerceDetection(')
) + '; commerceDecision', {
    browser: { tabs: { executeScript: async () => [ state ] } },
    detect: () => detections, commerceFingerprints, commerceConfidence: 50,
    selectCommerceDetection,
    listedAffiliateLinkReasons,
    listedSourceDomainReasons, shoppingDomainLists: domainIndexData.categories.shopping_domain,
});
const genericCart = { name: 'Cart Functionality', categories: [ 'ecommerce' ] };
const software = { name: 'Store', categories: [ 'ecommerce' ] };
assert.equal(selectCommerceDetection([ genericCart, software ]), software);
assert.equal(selectCommerceDetection([ genericCart ]), undefined);
for ( const [ softwareDetections, product_offer, purchase, expected ] of [
    [ [ software ], false, false, true ],
    [ [], true, false, true ],
    [ [], false, false, false ],
    [ [ genericCart ], false, false, false ],
    [ [ software ], true, true, true ],
    [ [], true, true, true ],
] ) {
    detections = softwareDetections;
    state.shoppingEvidence = { product_offer, purchase };
    const observation = await commerceDecision({
        tabId: 1, navigationId: 1, loaded: true, url, requestHosts: new Set(),
    }, 1, url);
    const shopping_evidence = {
        software: softwareDetections.includes(software),
        product_offer, purchase,
    };
    assert.deepEqual(JSON.parse(JSON.stringify(observation)), {
        kind: 'shopping_signals', shopping_signals: expected,
        shopping_evidence,
        reasons: product_offer && purchase
            ? [ { kind: 'commercial_store', rule: 'product-offer-and-purchase' } ] : [],
    });
    const shared = contributionObservation({
        url, verdict: 'candidate', observed_at: new Date(1000).toISOString(),
        shopping_signals: observation.shopping_signals,
        shopping_evidence: observation.shopping_evidence,
        document: {
            schema: 1, url, title: 'Personal page', body: 'Fictional page content.',
            extraction_version: 'test', truncated: false,
            indexing_directives: { complete: true, meta_robots: [], x_robots_tag: [] },
        },
    }, {});
    assert.equal(shared.decision.shopping_signals, expected);
    assert.deepEqual(JSON.parse(JSON.stringify(shared.decision.shopping_evidence)), shopping_evidence);
    assert.deepEqual(shared.decision.reasons, []);
}
console.log('Passed: software or product offers produce shareable shopping observations, not intrinsic exclusion reasons; generic cart alone does not qualify');
