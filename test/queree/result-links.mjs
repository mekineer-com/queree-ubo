import { communityDomainFromHostname, communityDomains } from '../../src/js/queree/community-domains.js';
import { contributionObservation, normalizeShareableURL } from '../../src/js/queree/contribution-core.js';
import {
    domainIndexData,
    listedDomainReasons,
    listedSourceDomainReasons,
    loadDomainIndexFromBuffer,
} from '../../src/js/queree/domain-index.js';
import { matchPersonalCategory, personalDisplayRecord, validatePersonalCategories } from '../../src/js/queree/personal-categories.js';
import { createDecisionCache, needsCharacteristicChecks, withoutTextDirective } from '../../src/js/queree/decision-cache.js';
import { affiliateLinkSources, promotionSources, storefrontSources } from '../../src/js/queree/vendor/website-lists.js';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import commerceFingerprints from '../../src/js/queree/vendor/commerce-fingerprints.js';
import { decisionPolicyRevision } from '../../src/js/queree/policy.js';
import { detect } from '../../src/js/queree/vendor/opentechalyzer/detect/engine.js';
import { domainFromHostname } from '../../src/js/uri-utils.js';
import { eligibilityExceptions } from '../../src/js/queree/ad-profile.js';
import {fileURLToPath} from 'node:url';
import { listedAffiliateLinkReasons, listedPromotionalURLReasons } from '../../src/js/queree/website-lists.js';
import publicSuffixList from '../../src/lib/publicsuffixlist/publicsuffixlist.js';
import {readFileSync} from 'node:fs';
import { restrictedSourceNamespaceFromHostname } from '../../src/js/queree/restricted-namespaces.js';
import { reviewed } from '../../tools/queree-ownership-sources.mjs';
import { setImmediate } from 'node:timers';
import vm from 'node:vm';

function sourcePosition(text, anchor, from = 0) {
    const position = text.indexOf(anchor, from);
    assert.ok(position >= 0, `Missing source anchor: ${anchor}`);
    return position;
}

const root = fileURLToPath(new URL('../..', import.meta.url));
const domainIndex = readFileSync(root + '/src/assets/queree/domain-index.bin');
loadDomainIndexFromBuffer(domainIndex.buffer.slice(
    domainIndex.byteOffset,
    domainIndex.byteOffset + domainIndex.byteLength
));
const adultLists = domainIndexData.categories.adult_domain;
for ( const host of [
    'xhamstersexvideo.com.123freedownload.com',
    'sub.xhamstersexvideo.com.123freedownload.com',
    'i.4cdn.org',
] ) {
    assert.equal(
        listedDomainReasons(`https://${host}/`, adultLists, 'adult_domain')[0].kind,
        'adult_domain',
        host
    );
}
for ( const host of [
    'xhamstersexvideo.com.123freedownload.com.evil.test',
    'safe.4cdn.org',
    'scarleteen.com',
    'plannedparenthood.org',
    'reddit.com',
    'wordpress.com',
] ) {
    assert.equal(
        listedDomainReasons(`https://${host}/`, adultLists, 'adult_domain').length,
        0,
        host
    );
}
console.log('Passed: adult domains retain root, descendant, lookalike and tenant boundaries');
assert.equal(storefrontSources[0].domains.length, 29);
assert.equal(promotionSources[0].rules.length, 9);
for ( const domain of storefrontSources[0].domains ) {
    assert.ok(listedDomainReasons(`https://${domain}/`,
        domainIndexData.categories.scam_domain, 'scam')
        .some(reason => reason.list === storefrontSources[0].name), domain);
}
for ( const [ url, expected ] of [
    [ 'https://slashdot.org/content/sponsored-article/', true ],
    [ 'https://slashdot.org/software/', true ],
    [ 'http://www.frandroid.com/author/frandroidcontent/', true ],
    [ 'https://slashdot.org/story/community-discussion', false ],
    [ 'https://slashdot.org/Content/example/', false ],
    [ 'https://slashdot.org.evil.test/content/example/', false ],
    [ 'https://personal.example/?next=https://slashdot.org/content/example/', false ],
    [ 'https://www.frandroid.com/author/frandroidcontent', true ],
    [ 'https://slashdot.org/software', true ],
    [ 'https://slashdot.org/content', true ],
    [ 'https://slashdot.org/content?topic=web#section', true ],
    [ 'https://www.frandroid.com/author/frandroidcontent?page=2', true ],
    [ 'https://slashdot.org/contentious', false ],
    [ 'https://slashdot.org/software-old', false ],
    [ 'https://www.frandroid.com/author/frandroidcontent-other', false ],
    [ 'https://www.frandroid.com/ordinary-article', false ],
    [ 'file://slashdot.org/content/example/', false ],
    [ 'not a URL', false ],
] ) {
    const reasons = listedPromotionalURLReasons(url);
    assert.equal(reasons.length !== 0, expected, url);
    for ( const reason of reasons ) {
        assert.equal(reason.kind, 'advertising');
        assert.equal(reason.list, promotionSources[0].name);
        assert.ok(promotionSources[0].rules.includes(reason.rule));
        assert.equal(reason.request_url, new URL(url).href);
    }
}
for ( const url of [
    'https://en.wikipedia.org/wiki/Example',
    'https://urlhaus.abuse.ch/',
    'https://personal.ai/blog/example',
    'https://webflow.com/blog/july-28-webflow-incident-report',
    'https://digitalocean.com/community/tutorials/example',
] ) {
    assert.equal(listedPromotionalURLReasons(url).length, 0, url);
    assert.equal(listedDomainReasons(url, domainIndexData.categories.scam_domain, 'scam').length, 0, url);
}
console.log('Passed: upstream website lists preserve host/path scope and known allowed controls');
assert.equal(affiliateLinkSources.length, 2);
assert.equal(affiliateLinkSources[0].name, 'soteria_affiliate_endpoints');
assert.equal(affiliateLinkSources[0].domains.length, 136);
assert.equal(affiliateLinkSources[1].name, 'dropship_affiliate_redirects');
assert.equal(affiliateLinkSources[1].domains.length, 23);
for ( const source of affiliateLinkSources ) {
    for ( const domain of source.domains ) {
        for ( const host of [ domain, `sub.${domain}` ] ) {
            const reasons = listedAffiliateLinkReasons([ `https://${host}/one` ]);
            assert.equal(reasons[0].kind, 'affiliate_tracked_link');
            assert.equal(reasons[0].list, source.name);
            assert.equal(reasons[0].matched_hostname, host);
            assert.equal(Object.hasOwn(reasons[0], 'request_url'), false);
        }
        assert.deepEqual(listedAffiliateLinkReasons([ `https://${domain}.evil.test/` ]), []);
        assert.deepEqual(listedPromotionalURLReasons(`https://${domain}/`), [],
            'Link-list membership must not become publisher-wide exclusion');
    }
}
assert.deepEqual(listedAffiliateLinkReasons([
    'https://affiliate.godaddy.com/one', 'https://go.banggood.com/two',
    'https://go.banggood.com/three',
]).map(reason => reason.list), [ 'soteria_affiliate_endpoints', 'dropship_affiliate_redirects' ],
    'The same link check preserves both sources and deduplicates repeated matches per source');
for ( const target of [
    'https://open.spotify.com/track/fictional', 'https://newsletter.example/subscribe',
    'https://amzn.to/ordinary', 'https://aka.ms/help', 'https://go.microsoft.com/help',
    'https://go.bsky.app/profile', 'https://personal.example/?next=https://affiliate.godaddy.com/',
    'https://banggood.com/product', 'https://aliexpress.com/item/one',
    'https://temu.com/product', 'https://wish.com/product',
    'file://affiliate.godaddy.com/article', 'not a URL',
] ) {
    assert.deepEqual(listedAffiliateLinkReasons([ target ]), [], target);
}
assert.equal(listedAffiliateLinkReasons([
    'http://affiliate.godaddy.com/one', 'https://affiliate.flipkart.com/two',
]).length, 1, 'Several matches retain one reason per source, not an outgoing-link inventory');
console.log('Passed: all 136 Soteria and 23 Dropship entries share one page-link check, not publisher classification');
const source=readFileSync(root + '/src/js/queree/search-results.js','utf8');
const controller=readFileSync(root + '/src/js/queree/controller.js','utf8');
function controllerSection(start, end) {
    const from = sourcePosition(controller, start);
    return controller.slice(from, sourcePosition(controller, end, from));
}
const commerceProbe=readFileSync(root + '/src/js/queree/commerce-probe.js','utf8');
const background=readFileSync(root + '/src/js/background.js','utf8');
const firefoxManifest=readFileSync(root + '/platform/firefox/manifest.json','utf8');
const popupPage=readFileSync(root + '/src/popup-fenix.html','utf8');
const privacy=readFileSync(root + '/QUEREE_PRIVACY.md','utf8');
const dashboardPage=readFileSync(root + '/src/dashboard.html','utf8');
const quereePage=readFileSync(root + '/src/queree.html','utf8');
const settingsPage=readFileSync(root + '/src/settings.html','utf8');
const messaging=readFileSync(root + '/src/js/messaging.js','utf8');
const traffic=readFileSync(root + '/src/js/traffic.js','utf8');
const quereeMessaging=readFileSync(root + '/src/js/queree/messaging.js','utf8');
const quereeScript=readFileSync(root + '/src/js/queree.js','utf8');
const settingsScript=readFileSync(root + '/src/js/settings.js','utf8');
const contributionScript=readFileSync(root + '/src/js/queree/contribution.js','utf8');
const scriptletFiltering=readFileSync(root + '/src/js/scriptlet-filtering.js','utf8');
const inspectionContext=readFileSync(root + '/src/js/queree/inspection-context.js','utf8');
const inspectionHistory=readFileSync(root + '/src/js/queree/inspection-history.js','utf8');
const startup=readFileSync(root + '/src/js/start.js','utf8');
assert.equal(decisionPolicyRevision, 'queree-policy-32');
assert.deepEqual(communityDomains, [
    'askubuntu.com', 'facebook.com', 'instagram.com', 'linkedin.com', 'mathoverflow.net',
    'quora.com', 'reddit.com', 'serverfault.com', 'stackapps.com',
    'stackexchange.com', 'stackoverflow.com', 'superuser.com', 'threads.com', 'threads.net', 'tiktok.com',
    'twitter.com', 'x.com', 'youtube.com',
]);
assert.equal(communityDomainFromHostname('WWW.YOUTUBE.COM.'), 'youtube.com');
assert.equal(communityDomainFromHostname('youtube.com.evil.test'), undefined);
assert.equal(communityDomainFromHostname('WWW.QUORA.COM.'), 'quora.com');
assert.equal(communityDomainFromHostname('quora.com.evil.test'), undefined);
for ( const domain of communityDomains ) {
    assert.equal(communityDomainFromHostname(`meta.${domain}`), domain);
    assert.equal(communityDomainFromHostname(`${domain}.evil.test`), undefined);
}
for ( const domain of [ 'stackoverflow.co', 'stackoverflowteams.com', 'stackoverflow.blog' ] ) {
    assert.equal(communityDomainFromHostname(domain), undefined, 'Q&A classification does not include separate company sites');
}
for ( const [ name, value ] of Object.entries({
    quereeIncludeCommercialCorporate: false,
    quereeIncludeGovernmentEducation: true,
    quereeIncludeProfessionalPublications: true,
    quereeIncludePublicInterestOrganizations: true,
}) ) {
    assert.match(background, new RegExp(`${name}: ${value}`));
    assert.match(quereePage, new RegExp(`data-setting-name="${name}"`));
}
assert.match(background, /quereePersonalCategories: defaultPersonalCategories/);
assert.doesNotMatch(background, /quereeIncludeCommunityContributions/);
const privilegedOperations = [
    [ 'clearDecisionCache', {}, [] ],
    [ 'getDecisionCacheState', {}, [] ],
    [ 'getContributionState', {}, [] ],
    [ 'setContributionConsent', { consent: true }, [ true ] ],
    [ 'setContributionKey', { key: 'qk_fixture' }, [ 'qk_fixture' ] ],
];
const messageCalls = [];
const messageReplies = [];
const messageResponse = { status: 'ok' };
const messageRegistrations = [];
const unhandledMessage = Symbol('unhandled');
const quereeMessagingContext = {
    settingsRevision: 0, inspectionTabGeneration: 0,
    maxSimultaneousInspections: 8,
    ...Object.fromEntries(privilegedOperations.map(([ what ]) => [
        what, async (...args) => {
            messageCalls.push({ what, args });
            return messageResponse;
        },
    ])),
    inspectResults: async (...args) => {
        messageCalls.push({ what: 'inspectResults', args });
        return messageResponse;
    },
    openInspectionTab: async (...args) => {
        messageCalls.push({ what: 'openInspectionTab', args });
        return true;
    },
    getMobileInspectionState: async () => ({ mobile: false, ready: false }),
    prepareMobileInspections: async () => ({ mobile: true, ready: true }),
    µb: { userSettings: { quereeEnabled: true, quereePersonalCategories: [] }, hiddenSettings: {}, isReadyPromise: Promise.resolve() },
    vAPI: { messaging: {
        UNHANDLED: unhandledMessage,
        listen: registration => messageRegistrations.push(registration),
    } },
};
quereeMessagingContext.settingsSnapshot = vm.runInNewContext(
    controller.match(/^function settings\(\) \{[\s\S]*?^\}/m)[0] + '\n' +
    controller.match(/^export function settingsSnapshot\(\) \{[\s\S]*?^\}/m)[0].replace('export ', '') +
    '\nsettingsSnapshot', quereeMessagingContext
);
const registerQuereeMessaging = vm.runInNewContext(
    quereeMessaging.replace(/^import[\s\S]*?;\n/gm, '')
        .replace(/^export /gm, '') + ';registerQuereeMessaging',
    quereeMessagingContext
);
assert.equal(messageRegistrations.length, 0, 'Importing must not register the channel');
registerQuereeMessaging();
assert.equal(messageRegistrations.length, 1);
assert.equal(messageRegistrations[0].name, 'queree');
const quereeMessageListener = messageRegistrations[0].listener;
const messageCallback = reply => { messageReplies.push(reply); };
await quereeMessageListener({ what: 'openInspectionTab', tabId: 10, sourceTabId: 999 },
    { tabId: 1 }, messageCallback);
assert.deepEqual(messageCalls.splice(0), [ { what: 'openInspectionTab', args: [ 1, 10 ] } ]);
assert.deepEqual(messageReplies.splice(0), [ true ]);
// The isolated channel test above does not exercise the native bootstrap call site.
assert.equal(messaging.match(/registerQuereeMessaging\(\);/g).length, 1);
assert.ok(sourcePosition(messaging, 'registerQuereeMessaging();') > sourcePosition(messaging, 'vAPI.messaging.setup('));
assert.match(messaging, /if \( isInspectionTab\(tabId\) \) \{ return \{\}; \}/);
for ( const [ what, request, expectedArgs ] of privilegedOperations ) {
    for ( const privileged of [ false, undefined, 'true' ] ) {
        assert.equal(quereeMessageListener({ what, ...request }, { privileged }, messageCallback), unhandledMessage);
        assert.equal(messageCalls.length, 0, `${what}: unprivileged requests cannot reach the operation`);
        assert.equal(messageReplies.length, 0);
    }
    await quereeMessageListener({ what, ...request }, { privileged: true }, messageCallback);
    assert.deepEqual(messageCalls.splice(0), [ { what, args: expectedArgs } ]);
    assert.deepEqual(messageReplies.splice(0), [ messageResponse ]);
}
for ( const what of [ 'getContributionState', 'setContributionConsent', 'setContributionKey' ] ) {
    const operation = quereeMessagingContext[what];
    quereeMessagingContext[what] = async () => { throw new Error('Storage unavailable'); };
    await quereeMessageListener({ what }, { privileged: true }, messageCallback);
    assert.deepEqual(messageReplies.splice(0), [ undefined ],
        `${what}: failed storage must answer the dashboard instead of leaving its request hung`);
    quereeMessagingContext[what] = operation;
}
assert.equal(quereeMessageListener({ what: 'unknown' }, { privileged: true }, messageCallback), unhandledMessage);
assert.equal(messageCalls.length, 0);
assert.equal(messageReplies.length, 0);
for ( const enabled of [ true, false, 'true' ] ) {
    quereeMessagingContext.µb.userSettings.quereeEnabled = enabled;
    quereeMessagingContext.µb.userSettings.quereeExcludeCrossSiteTracking = enabled;
    await quereeMessageListener({ what: 'getSettings' }, {}, messageCallback);
    assert.equal(messageReplies.length, 1);
    const reply = messageReplies.shift();
    assert.equal(reply.enabled, enabled === true);
    assert.equal(reply.excludeCrossSiteTracking, enabled === true);
}
{
    let finishStartup;
    quereeMessagingContext.µb.isReadyPromise = new Promise(resolve => { finishStartup = resolve; });
    const pending = quereeMessageListener({ what: 'getSettings' }, {}, messageCallback);
    await Promise.resolve();
    assert.equal(messageReplies.length, 0, 'Do not answer with startup defaults');
    quereeMessagingContext.µb.userSettings = {
        quereeEnabled: false, quereeRequireSingleDomain: true, quereePersonalCategories: [],
    };
    finishStartup();
    await pending;
    assert.deepEqual(messageReplies.splice(0).map(value => JSON.parse(JSON.stringify(value))), [ {
        enabled: false, requireSingleDomain: true, excludeAdvertisingSignals: false, excludeCrossSiteTracking: false,
        excludeShoppingSignals: false, keepUnresolvedTabs: false, personalCategories: [],
        simultaneousInspections: 6,
        cleanHistory: false, revision: 0, inspectionTabGeneration: 0,
        sourceControls: { commercial_corporate: false, government_education: false,
            professional_publication: false, public_interest_organization: false },
        mobileInspection: { mobile: false, ready: false },
    } ]);
    quereeMessagingContext.µb.isReadyPromise = Promise.resolve();
}
// Retired worker flags must not reach the controller, even from extension pages.
for ( const privileged of [ true, false, undefined, 'true' ] ) {
    for ( const captureDocuments of [ true, false, undefined, 'true' ] ) {
        const items = [ { id: 'message-item', url: 'https://personal.example/' } ];
        const sender = { privileged, tabId: 17, frameURL: 'https://www.google.com/search?q=birds' };
        await quereeMessageListener({
            what: 'inspectResults', items, batchId: 'message-batch', captureDocuments,
            tabId: 99, sourceTabId: 99, windowId: 99, sourceWindowId: 99,
            tabURL: 'https://spoof.example/', sourceURL: 'https://spoof.example/',
        }, sender, messageCallback);
        assert.equal(messageCalls.length, 1);
        const { what, args } = messageCalls.pop();
        assert.equal(what, 'inspectResults');
        assert.equal(args.length, 4, 'Inspection carries a scan URL snapshot, not worker capture options');
        assert.equal(args[0], sender.tabId);
        assert.equal(args[1], items);
        assert.equal(args[2], 'message-batch');
        assert.equal(args[3], 'https://spoof.example/');
        assert.deepEqual(messageReplies.splice(0), [ messageResponse ]);
    }
}
console.log('Passed: deferred Quer.ee registration preserves native order, privileged callbacks and sender identity');
{
    const inspect = quereeMessagingContext.inspectResults;
    quereeMessagingContext.inspectResults = async () => { throw new Error('Synthetic inspection rejection'); };
    const replies = [];
    await quereeMessageListener({ what: 'inspectResults', items: [], batchId: 'failed' },
        { tabId: 17, url: 'https://www.google.com/search?q=birds' }, reply => replies.push(reply));
    assert.deepEqual(replies, [ undefined ], 'Rejected inspections still answer exactly once');
    quereeMessagingContext.inspectResults = inspect;
}
{
    const previous = quereeMessagingContext.µb.userSettings.quereePersonalCategories;
    const writes = [];
    quereeMessagingContext.validatePersonalCategories = validatePersonalCategories;
    quereeMessagingContext.browser = { storage: { local: { set: values => {
        const gate = Promise.withResolvers();
        writes.push({ values, ...gate });
        return gate.promise;
    } } } };
    const categories = name => [ { name, enabled: true, entries: [ 'https://personal.example/' ] } ];
    const replies = [];
    const save = name => quereeMessageListener({ what: 'setPersonalCategories', categories: categories(name) },
        { privileged: true }, reply => replies.push(reply));
    const failed = save('Failed');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(replies.length, 0, 'Do not report success before native storage finishes');
    writes[0].reject(new Error('Synthetic native write failure'));
    await failed;
    assert.equal(replies.pop().error, 'Synthetic native write failure');
    assert.equal(quereeMessagingContext.µb.userSettings.quereePersonalCategories, previous);

    const older = save('Older');
    await new Promise(resolve => setImmediate(resolve));
    const newer = save('Newer');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writes.length, 2, 'Category saves share the ordered settings-write queue');
    writes[1].reject(new Error('Older save failed late'));
    await older;
    assert.equal(replies.pop().error, 'Older save failed late');
    await new Promise(resolve => setImmediate(resolve));
    writes[2].resolve();
    await newer;
    const saved = replies.pop().categories;
    assert.equal(saved[0].name, 'Newer');
    assert.equal(writes[2].values.quereePersonalCategories, saved);
    assert.equal(quereeMessagingContext.µb.userSettings.quereePersonalCategories, saved,
        'A stale failed write must not roll back a newer successful save');
    quereeMessagingContext.µb.userSettings.quereePersonalCategories = previous;
}
console.log('Passed: inspection rejection answers the caller and native category-save failures preserve newer saves');
{
    let listener;
    const cleanup = [];
    vm.runInNewContext(controller.slice(
        controller.indexOf('browser.storage.onChanged.addListener('),
        controller.indexOf('\nonBroadcast(message =>')
    ), {
        browser: { storage: { onChanged: { addListener(fn) { listener = fn; } } } },
        setInspectionHistoryEnabled: value => cleanup.push(value),
    });
    for ( const change of [ { newValue: true }, { newValue: false }, { oldValue: false } ] ) {
        listener({ quereeCleanHistory: change }, 'local');
    }
    assert.deepEqual(cleanup, [ true, false, true ], 'Removing the stored override restores the true default');
}
console.log('Passed: native storage-key removal re-enables inspection-history cleanup');
const manifest=JSON.parse(firefoxManifest);
for ( const [ href, supported ] of [
    [ 'https://www.google.com/search?q=test', true ],
    [ 'https://www.google.com.pe/search?q=test', true ],
    [ 'https://www.google.com/sorry/index', true ],
    [ 'https://www.bing.com/search?q=test', true ],
    [ 'https://www.bing.com/turing/captcha', true ],
    [ 'https://mail.google.com/mail/u/0/', false ],
    [ 'https://docs.google.com/document/d/test', false ],
    [ 'https://www.google.com/maps', false ],
    [ 'https://www.google.com/url?q=test', false ],
    [ 'https://www.google.co.uk/search?q=test', false ],
    [ 'https://www.bing.com/news', false ],
    [ 'http://www.google.com/search?q=test', false ],
] ) {
    const context = { vAPI: {}, location: new URL(href), reached: false };
    const prefix = source.slice(0, source.indexOf('    let processed ='));
    await vm.runInNewContext(`${prefix} reached = true; })());`, context);
    assert.equal(context.reached, supported, href);
}
{
    let shutdown;
    let reply;
    let stopped = 0;
    let synced = 0;
    const removed = [];
    const context = {
        shuttingDown: false, settingsGeneration: 0, simultaneousInspections: 6, settingEnabled: false, requireSingleDomain: false, excludeAdvertisingSignals: true, excludeCrossSiteTracking: true, excludeShoppingSignals: true,
        onPageShow() {}, onMessage() {}, stop: () => { stopped += 1; },
        syncSearchMode: () => { synced += 1; },
        vAPI: {
            shutdown: { add: callback => { shutdown = callback; } },
            messaging: { send: () => new Promise(resolve => { reply = resolve; }) },
        },
        window: { addEventListener() {}, removeEventListener: name => removed.push(name) },
        document: { addEventListener() {}, removeEventListener: name => removed.push(name) },
        retryMobileInspection() {}, maybeLoadMore() {},
        browser: { runtime: { onMessage: {
            addListener() {}, removeListener: () => removed.push('message'),
        } } },
    };
    const boot = source.slice(source.indexOf("    window.addEventListener('pageshow', onPageShow);"),
        source.lastIndexOf('})());'));
    const refresh = source.slice(source.indexOf('    async function refreshSettings('),
        source.indexOf('    async function onPageShow('));
    const pending = vm.runInNewContext(`(async () => { ${refresh} ${boot} })()`, context);
    shutdown();
    assert.equal(stopped, 1);
    assert.deepEqual(removed, [ 'pageshow', 'click', 'visibilitychange', 'visibilitychange', 'message' ]);
    reply({ enabled: true, requireSingleDomain: true });
    await pending;
    assert.equal(synced, 0, 'A settings reply after shutdown cannot restart scanning');
    assert.equal(context.settingEnabled, false);
}
console.log('Passed: native reinjection respects supported URLs and shutdown rejects late startup replies');
{
    const replies = [];
    const settings = [];
    const context = {
        shuttingDown: false, settingsGeneration: 0, simultaneousInspections: 6,
        vAPI: { messaging: { send: () => new Promise(resolve => replies.push(resolve)) } },
        onMessage: message => { context.settingsGeneration += 1; settings.push(message); },
    };
    const refresh = vm.runInNewContext(source.slice(
        source.indexOf('    async function refreshSettings('),
        source.indexOf('    async function onPageShow(')
    ) + ';refreshSettings', context);
    const startup = refresh();
    replies.shift()(undefined);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(replies.length, 1, 'A lost startup reply gets one retry');
    replies.shift()({ enabled: true });
    await startup;
    assert.equal(settings[0].enabled, true);
    const stale = refresh();
    context.onMessage({ enabled: false });
    replies.shift()({ enabled: true });
    await stale;
    assert.equal(settings.length, 2, 'A reply cannot overwrite a newer settings notification');
    const unavailable = refresh();
    replies.shift()(undefined);
    await new Promise(resolve => setImmediate(resolve));
    replies.shift()(undefined);
    await unavailable;
    assert.equal(replies.length, 0, 'Unavailable settings do not cause unbounded retries');
}
console.log('Passed: startup settings retry once and cannot overwrite a newer notification');
{
    const firefoxFixture = readFileSync(root + '/test/queree/run-firefox.mjs', 'utf8');
    const fixtureHelpers = readFileSync(root + '/tools/queree-fixture-sources.mjs', 'utf8');
    const helperStart = sourcePosition(fixtureHelpers, 'function replaceOnce(');
    const helperEnd = sourcePosition(fixtureHelpers, '\n}', helperStart) + '\n}'.length;
    const replaceOnce = vm.runInNewContext(
        fixtureHelpers.slice(helperStart, helperEnd) + ';replaceOnce'
    );
    const rewrite = firefoxFixture.slice(sourcePosition(firefoxFixture, '    const fixtureScope = replaceOnce(results,'),
        sourcePosition(firefoxFixture, '    await writeFile(resultsPath, fixtureResults);'));
    const fixtureSource = vm.runInNewContext(rewrite + ';fixtureResults', { results: source, replaceOnce });
    for ( const [ href, supported ] of [
        [ 'http://localhost:4461/search-shared?q=x', true ],
        [ 'http://localhost:4461/search-single-domain', true ],
        [ 'http://127.0.0.1:4461/search?q=x', true ],
        [ 'http://localhost:4461/clean', false ],
        [ 'https://www.google.com/search?q=x', true ],
        [ 'https://mail.google.com/mail/u/0/', false ],
    ] ) {
        const context = { vAPI: {}, location: new URL(href), reached: false };
        const prefix = fixtureSource.slice(0, fixtureSource.indexOf('    let processed ='));
        await vm.runInNewContext(`${prefix} reached = true; })());`, context);
        assert.equal(context.reached, supported, href);
    }
}
console.log('Passed: the actual Firefox fixture rewrite admits only its local search pages');
assert.deepEqual(
    manifest.browser_specific_settings.gecko.data_collection_permissions,
    {
        required: [ 'none' ],
        optional: [
            'browsingActivity',
            'authenticationInfo',
            'technicalAndInteraction',
            'websiteContent',
        ],
    }
);
assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, '140.0');
assert.equal(manifest.browser_specific_settings.gecko.update_url, undefined,
    'The public build must receive Mozilla updates, not a self-hosted feed');
assert.deepEqual(manifest.browser_specific_settings.gecko_android, { strict_min_version: '142.0' },
    'Android must support the declared Firefox data-consent permissions');
assert(manifest.permissions.includes('contextualIdentities'));
assert(manifest.permissions.includes('cookies'));
assert.match(quereeScript, /permissions\.request\(\{\s*data_collection:/);
assert.match(quereeScript, /checkbox\.disabled = state\.hasKey === false/);
assert.match(quereePage, /id="quereeContribute" type="checkbox" disabled/);
assert.match(dashboardPage, /data-pane="queree\.html"[^>]*>Quer\.ee</);
assert.match(popupPage, /href="https:\/\/quer\.ee\/"/);
assert.match(popupPage, /src="img\/queree-mark\.svg"/);
assert.match(
    readFileSync(root + '/src/js/popup-fenix.js','utf8'),
    /dom\.attr\(ev\.currentTarget, 'href'\)/
);
assert.doesNotMatch(settingsPage, /data-setting-name="queree/);
assert.doesNotMatch(settingsScript, /queree[A-Z]/);
assert.match(contributionScript, /permissions\.onRemoved\.addListener/);
assert.match(contributionScript, /hasContributionDataPermissions/);
console.log('Passed: optional contribution requires Firefox data consent');
const imageModeCode = source.slice(
    source.indexOf('    function isGoogleImages('),
    source.indexOf('    function searchEngineAdapter(')
);
for ( const [ href, expected ] of [
    [ 'https://www.google.com/search?q=pond&udm=2', true ],
    [ 'https://www.google.com/search?q=pond&udm=imgs', true ],
    [ 'https://www.google.com/search?q=pond&tbm=isch', true ],
    [ 'https://www.google.com/search?q=pond&udm=14', false ],
    [ 'https://www.google.com/search?q=pond&udm=7', false ],
    [ 'https://www.google.com/search?q=pond&udm=18', false ],
    [ 'https://www.google.com/search?q=pond&tbm=nws', false ],
    [ 'https://www.bing.com/search?q=pond&udm=2', false ],
] ) {
    const location = new URL(href);
    assert.equal(vm.runInNewContext(imageModeCode + ';isGoogleImages()', {
        location, URL,
    }), expected, href);
}
const syncSearchModeCode = source.slice(
    source.indexOf('    function syncSearchMode('),
    source.indexOf('    function onMessage(')
);
let imageMode = false;
let searchPage = true;
const modeChanges = [];
const { syncSearchMode, onPageShow: restoredPage } = vm.runInNewContext(
    syncSearchModeCode + ';({syncSearchMode,onPageShow})', {
    settingEnabled: true, enabled: true, restoreGeneration: 0, batchSequence: 0, settingsGeneration: 0, simultaneousInspections: 6, shuttingDown: false,
    isGoogleImages: () => imageMode, isSearchPage: () => searchPage,
    start: () => modeChanges.push('start'),
    stop: () => modeChanges.push('stop'),
    vAPI: { messaging: {
        destroyPort: () => modeChanges.push('reconnect'),
        send: async () => { modeChanges.push('settings'); return { enabled: true }; },
    } },
    onMessage: () => modeChanges.push('received'),
    retryMobileInspection() {},
    scheduleScan: () => modeChanges.push('scan'),
    });
syncSearchMode();
imageMode = true;
syncSearchMode();
imageMode = false;
syncSearchMode();
assert.deepEqual(modeChanges, [ 'start', 'stop', 'start' ]);
await restoredPage({ persisted: false });
assert.equal(modeChanges.length, 3, 'Ordinary page loads do not reset messaging');
await restoredPage({ persisted: true });
assert.deepEqual(modeChanges.slice(3), [ 'reconnect', 'settings', 'received', 'scan' ]);
searchPage = false;
syncSearchMode();
assert.equal(modeChanges.at(-1), 'stop', 'Same-document navigation outside search stops the observer');
searchPage = true;
syncSearchMode();
assert.equal(modeChanges.at(-1), 'start');
assert.match(
    readFileSync(root + '/src/js/queree/controller.js', 'utf8'),
    /onHistoryStateUpdated\.addListener/
);
assert.match(source, /message\?\.what === 'quereeSearchURLChanged'/);
console.log('Passed: Google Images is skipped and search modes can resume');
const collectCode=source.slice(
    source.indexOf('    function searchEngineAdapter('),
    source.indexOf('    function apply(')
);
const statusSelector = '.queree-unresolved, .queree-characteristic';
function resultElement(tagName, text = '', selectors = []) {
    let textNode = { textContent: text };
    return {
        tagName: tagName.toUpperCase(), children: [], dataset: {},
        get textContent() { return text + this.children.map(child => child.textContent).join(''); },
        set textContent(value) { text = value; textNode = { textContent: value }; this.children = []; },
        get firstChild() { return text ? textNode : this.children[0] || null; },
        get lastElementChild() { return this.children.at(-1) || null; },
        setAttribute(name, value) { this[name] = value; },
        removeAttribute(name) { delete this[name]; },
        matches(selector) {
            return selector.split(',').some(part => {
                const value = part.trim();
                return selectors.includes(value) || value === tagName ||
                    (value.startsWith('#') && value.slice(1) === this.id) ||
                    (value === 'a[href]' && tagName === 'a' && this.href !== undefined) ||
                    (value.startsWith('.') && value.slice(1) === this.className);
            });
        },
        append(child) {
            child.remove?.();
            child.parentElement = this;
            this.children.push(child);
        },
        remove() {
            const parent = this.parentElement;
            if ( !parent ) { return; }
            parent.children.splice(parent.children.indexOf(this), 1);
            this.parentElement = null;
        },
        closest(selector) {
            return this.matches(selector) ? this : this.parentElement?.closest(selector) || null;
        },
        querySelectorAll(selector) {
            return this.children.flatMap(child => [
                ...(child.matches(selector) ? [ child ] : []),
                ...child.querySelectorAll(selector),
            ]);
        },
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
        cloneNode(deep) {
            const clone = resultElement(tagName, text, selectors);
            clone.className = this.className;
            clone.href = this.href;
            if ( deep ) {
                for ( const child of this.children ) { clone.append(child.cloneNode(true)); }
            }
            return clone;
        },
    };
}
const rawURLs=[
 'https://www.google.com/goto?url=CAESopaque',
 'https://www.google.com/url?url=https%3A%2F%2Fexample.net%2Fpage',
 'https://www.google.com/search?q=other',
 'https://sites.google.com/view/personal-page',
 'https://example.org/direct',
];
const headings=rawURLs.map(href=>{
    const container={querySelector:()=>({textContent:'Search description'}),querySelectorAll:()=>[{}]};
    const anchor={href,closest:()=>container,setAttribute(name,value){assert.equal(name,'href');this.href=value;}};
    return Object.assign(resultElement('h3', 'Search title'), { closest:()=>anchor });
});
headings.push({closest:()=>({href:'https://not-a-result.example/',closest:()=>null})});
const context={
    document:{querySelectorAll:()=>headings,querySelector:()=>null},
    location:new URL('https://www.google.com/search?q=test'),processed:new WeakMap(),URL,Date,
};
vm.createContext(context);
const results=vm.runInContext('(function(){'+collectCode+';return collect()})()',context);
assert.deepEqual(Array.from(results,x=>x.url),[
 rawURLs[0], 'https://example.net/page',rawURLs[3],rawURLs[4],
]);
assert.equal(results[1].anchor.href,'https://example.net/page');
assert.equal(results[1].result_title,'Search title');
assert.equal(results[1].result_description,'Search description');
console.log('Passed: only links inside Google result containers are collected');
for ( const [ href, expected ] of [
    [ 'https://www.google.com/search?q=other', false ],
    [ 'mailto:person@example.com', false ],
    [ 'https://personal.example/article', true ],
] ) {
    const hasAnchor = vm.runInNewContext('(function() {' + collectCode + source.slice(
        source.indexOf('    function hasResultAnchor('),
        source.indexOf('    function scheduleEmptyResult(')
    ) + ';return hasResultAnchor();})()', {
        document: { querySelectorAll: () => [ Object.assign(resultElement('h3'), {
            closest: () => ({ href, closest: () => ({}) }),
        }) ], querySelector: () => null },
        location: new URL('https://www.google.com/search?q=test'), URL,
    });
    assert.equal(hasAnchor, expected, href);
}
console.log('Passed: unusable heading links cannot suppress the empty-search status');
const bingURLs=[
    'https://example.org/birding',
    'https://www.nps.gov/articles/birding-for-beginners.htm',
    'https://store.example/birds?utm_source=bing&utm_medium=cpc',
];
const bingRedirect='https://www.bing.com/ck/a?u=a1'+Buffer.from(bingURLs[0]).toString('base64url');
const malformedBingRedirect='https://www.bing.com/ck/a?p=missing-target';
const bingHeadings=[bingRedirect,bingURLs[1],bingURLs[2],malformedBingRedirect].map(href=>{
    const container={querySelector:()=>({textContent:'Bing description'}),querySelectorAll:()=>[{}]};
    const anchor={href,closest:()=>container,setAttribute(name,value){assert.equal(name,'href');this.href=value;}};
    const heading = resultElement('h2', 'Bing title');
    const querySelector = heading.querySelector;
    heading.querySelector = selector => selector === 'a[href]' ? anchor : querySelector.call(heading, selector);
    return heading;
});
bingHeadings.push({querySelector:()=>null});
const bingResults=vm.runInNewContext('(function(){'+collectCode+';return collect()})()',{
    document:{querySelectorAll:()=>bingHeadings,querySelector:()=>null},
    location:new URL('https://www.bing.com/search?q=test'),processed:new WeakMap(),URL,Date,
    atob,TextDecoder,Uint8Array,
});
assert.deepEqual(Array.from(bingResults,x=>x.url),[
    ...bingURLs,
    malformedBingRedirect,
]);
assert.equal(bingResults[0].anchor.href,bingURLs[0]);
assert.equal(bingResults[0].result_description,'Bing description');
assert.deepEqual(
    JSON.parse(JSON.stringify(bingResults[2].sourceReasons)),
    [ { kind:'search_advertising',engine:'bing',medium:'cpc' } ]
);
console.log('Passed: Bing adapter collects only direct organic result links');
assert.doesNotMatch(source, /Google blocked this automated search|No Google results/);
assert.match(source, /`No \$\{adapter\.name\} results`/);
const emptyStatusCode=source.slice(
    source.indexOf('    function emptySourceStatus('),
    source.indexOf('    function scheduleEmptyResult(')
);
const sourceStatus=(title,text,pathname='/search',noResults=/no results found for/i)=>vm.runInNewContext(
    emptyStatusCode+';emptySourceStatus()',
    {
        document:{
            title,
            body:{textContent:text},
            querySelector:()=>null,
            querySelectorAll:()=>[],
        },
        adapter:{noResults:value=>noResults.test(value)},
        location:{pathname},
    }
);
assert.equal(sourceStatus('Google','No results found for this query'),'no_results');
assert.equal(sourceStatus('Google','Our systems detected unusual traffic','/sorry/index'),'challenge');
assert.equal(sourceStatus('Google','Unexpected page'),'unrecognized_markup');
assert.equal(sourceStatus(
    'Bing', 'There are no results for this query', '/search',
    /there are no results for/i
),'no_results');
assert.equal(sourceStatus('Bing','Checking your browser','/turing/captcha'),'challenge');
console.log('Passed: empty Google and Bing pages classify to a terminal state');
function escapedSelectorValues(hostname, href, rawHref = href) {
    const escaped = [];
    vm.runInNewContext(
        `(function(){${collectCode};hrefAttributeSelectors(anchor)})()`,
        {
            anchor: { href, getAttribute: ( ) => rawHref },
            atob,
            CSS: { escape: value => {
                escaped.push(value);
                return `escaped-${escaped.length}`;
            } },
            document: { querySelector: ( ) => null },
            location: new URL(`https://${hostname}/search?q=test`),
            TextDecoder,
            Uint8Array,
            URL,
        }
    );
    return Array.from(new Set(escaped));
}
assert.deepEqual(
    escapedSelectorValues(
        'www.google.com', 'https://different.example/find?q=lamp'
    ),
    [ 'https://different.example/find?q=lamp' ]
);
assert.deepEqual(
    escapedSelectorValues(
        'www.bing.com',
        'https://www.bing.com/ck/a?p=volatile&u=a1TARGET&x=1'
    ).sort(),
    [ '?u=a1TARGET&', '?u=a1TARGET', '&u=a1TARGET&', '&u=a1TARGET' ].sort()
);
assert.deepEqual(
    escapedSelectorValues(
        'www.google.com', 'https://www.google.com/url?q=&source=web'
    ),
    []
);
console.log('Passed: redirect selectors are scoped, terminated and non-empty');
assert.doesNotMatch(source, /quereeLastResults|setInterval/);
assert.match(source, /function scheduleScan\(\)/);
assert.doesNotMatch(source, /container\.hidden|const excluded = new Set/);
assert.match(source, /function changeStylesheets\(add, remove = \[\]\)/);
assert.match(source, /vAPI\.userStylesheet\.apply\(resolve\)/);
assert.doesNotMatch(source, /queree-filter-active|queree-show-excluded/);
assert.match(source, /content: "Excluded by Quer\.ee" !important/);
assert.match(source, /align-items: center; display: flex/);
assert.match(source, /button \{ flex: none; margin-left: auto; \}/);
assert.match(source, /max-width: 680px/);
assert.match(source, /position: sticky/);
assert.match(source, /:is\(\$\{adapter.panelRoot\}\):has\(> #queree-results-control\) \{ isolation: isolate; \}/,
    'Keep the panel layer inside the result area, below native header menus');
assert.match(source.match(/#queree-results-control \{[^}]*\}/)[0], /z-index: 1;/,
    'Keep result labels below the shared desktop/mobile panel');
assert.match(source, /panel\.offsetHeight \* 1\.8/);
assert.match(source, /const summaryHoldDuration = 2000/);
console.log('Passed: search pages use ephemeral CSS without persisting results');
assert.match(firefoxManifest, /https:\/\/www\.google\.com\/sorry\/\*/);
assert.match(firefoxManifest, /https:\/\/www\.bing\.com\/search\*/);
assert.match(source, /const unknownSourceDeadline = 120000;/);
console.log('Passed: delayed Google challenges replace provisional unknown markup');
const startCode=controller.slice(
    sourcePosition(controller, 'async function start('),
    sourcePosition(controller, 'function dispatch(')
);
assert.ok(
    sourcePosition(startCode, 'job.timeout = setTimeout') <
        sourcePosition(startCode, 'job.tabPromise = browser.tabs.create'),
    'Inspection timeout must cover tab creation'
);
assert.match(firefoxManifest, /"tabHide"/);
assert.ok(
    sourcePosition(startCode, 'inspectionTabs.set(tab.id, job)') <
        sourcePosition(startCode, 'await browser.tabs.hide(tab.id)') &&
    sourcePosition(startCode, 'await browser.tabs.hide(tab.id)') <
        sourcePosition(startCode, 'await browser.tabs.update(tab.id, { url: job.url })'),
    'Inspection tabs must be registered and hidden before navigation'
);
assert.match(startCode, /hiddenTabIds\?\.includes\(tab\.id\) !== true/);
assert.match(startCode, /kind: 'inspection_hide_failed'/);
assert.match(startCode, /cookieStoreId/);
assert.match(startCode, /windowId: job\.sourceWindowId/);
assert.doesNotMatch(scriptletFiltering, /quereeIsInspectionTab|inspectionWindowName/);
assert.match(inspectionContext, /tabs\.query\(\{ cookieStoreId \}\)/);
assert.match(inspectionContext, /contextualIdentities\.remove\(cookieStoreId\)/);
assert.match(inspectionContext, /const ownedCookieStoreIds = new Set\(\)/);
assert.match(inspectionContext, /supported === false/);
assert.match(controller, /removeInspectionCookieStore\(cookieStoreId\)/);
assert.match(firefoxManifest, /"permissions": \[[\s\S]*"history"/);
assert.doesNotMatch(firefoxManifest, /"optional_permissions"/);
assert.match(inspectionHistory, /history\.getVisits\(\{ url \}\)/);
assert.match(inspectionHistory, /visits\.length !== 1/);
assert.match(inspectionHistory, /history\.deleteUrl\(\{ url: entry\.url \}\)/);
assert.match(privacy, /Desktop inspections do not use your ordinary cookies or logins/);
assert.match(privacy, /simultaneous visit to the same address could also be removed/);
assert.match(controller, /kind: 'download_response'/);
console.log('Passed: Firefox inspections have disposable state and guarded history');
assert.match(controller, /const maxSimultaneousInspections = 8;/);
assert.match(background, /quereeSimultaneousInspections: 6/);
assert.match(quereePage, /max="8"[^>]+quereeSimultaneousInspections/);
assert.match(quereePage, /disposable containers on desktop, reusable private tabs on Android/);
assert.match(quereePage, /removes desktop inspection-only visits from history when it can distinguish them from your own browsing/);
assert.match(quereePage, /Nothing is contributed to Quer\.ee unless/);
assert.match(quereePage, /https:\/\/quer\.ee\/privacy\//);
assert.match(quereePage, /https:\/\/quer\.ee\/about\/#contact/);
assert.match(privacy, /your IP address/);
assert.match(firefoxManifest, /"homepage_url": "https:\/\/quer\.ee\/"/);
assert.match(startup, /dashboard\.html#queree\.html/);
assert.match(commerceProbe, /slice\(0, htmlLimit - html\.length\)/);
assert.match(commerceProbe, /scriptContentLength >= 256 \* 1024/);
assert.match(commerceProbe, /\? globalThis\.wrappedJSObject/);
assert.match(commerceProbe, /root\.defaultView\.wrappedJSObject/);
assert.doesNotMatch(controller, /scriptletsInjector|queree-.*marker/);
console.log('Passed: inspection concurrency and commerce payloads are bounded');
for ( const requireSingleDomain of [ false, true ] ) {
    for ( const [ verdict, single_domain ] of [
        [ 'candidate', true ], [ 'candidate', false ], [ 'candidate', undefined ],
        [ 'unresolved', undefined ], [ 'exclude', undefined ],
    ] ) {
        const heading = resultElement('h3');
        const labels = heading.children;
        const context = {
            requireSingleDomain, excludeAdvertisingSignals: true, excludeCrossSiteTracking: true, excludeShoppingSignals: true,
            selectorsForExcludedResult: () => [ '#result' ],
            document: { createElement: resultElement },
        };
        const apply = vm.runInNewContext(source.slice(source.indexOf('    function reasonApplies('),
            source.indexOf('    async function refreshCharacteristic(')) + '; apply', context);
        const decision = { verdict, shopping_signals: false,
            ...(single_domain === undefined ? {} : { single_domain }) };
        const unchanged = JSON.stringify(decision);
        const selectors = [];
        apply({ anchor: {}, heading }, decision, selectors);
        const mismatch = requireSingleDomain && verdict !== 'exclude' && single_domain !== true;
        assert.equal(selectors.length, verdict === 'exclude' || mismatch ? 1 : 0);
        assert.equal(JSON.stringify(decision), unchanged, 'A preference never changes the intrinsic decision');
        if ( mismatch ) {
            assert.equal(labels[0].textContent, single_domain === false
                ? 'Not single-domain' : 'Single-domain unconfirmed');
        }
        if ( verdict === 'candidate' && !mismatch ) { assert.equal(labels.length, 0); }
    }
}
for ( const engine of [ 'Google', 'Bing' ] ) {
    const google = engine === 'Google';
    const title = `${engine} result title`;
    const containerSelector = google ? '.MjjYud' : '#b_results > li.b_algo';
    const container = resultElement(google ? 'div' : 'li', '', [ containerSelector ]);
    const heading = resultElement(google ? 'h3' : 'h2');
    const anchor = resultElement('a');
    anchor.href = 'https://personal.example/article';
    const titleSpan = resultElement('span', `  ${title}  `);
    if ( google ) {
        container.append(anchor);
        anchor.append(heading);
        heading.append(titleSpan);
    } else {
        container.append(heading);
        heading.append(anchor);
        anchor.append(titleSpan);
    }
    const context = {
        requireSingleDomain: false, excludeAdvertisingSignals: true, excludeCrossSiteTracking: true, excludeShoppingSignals: true,
        selectorsForExcludedResult: () => [],
        document: {
            createElement: resultElement,
            querySelectorAll: selector => {
                assert.equal(selector, google ? 'h3, [role="heading"]' : '#b_results > li.b_algo h2');
                return [ heading ];
            },
        },
        location: new URL(`https://www.${google ? 'google' : 'bing'}.com/search?q=test`),
        processed: new WeakMap(), URL, Date,
    };
    vm.createContext(context);
    const { collect, resultTitle } = vm.runInContext(
        '(function(){' + collectCode + ';return { collect, resultTitle };})()', context
    );
    const apply = vm.runInContext(source.slice(source.indexOf('    function reasonApplies('),
        source.indexOf('    async function refreshCharacteristic(')) + '; apply', context);
    const [ item ] = collect();
    assert.equal(item.anchor, anchor);
    assert.equal(item.result_title, title);
    const originalText = heading.textContent;
    const originalChildren = [ ...heading.children ];
    const unresolved = { verdict: 'unresolved', reasons: [ { kind: 'http_error', detail: '403' } ] };
    apply(item, unresolved, []);
    const label = heading.querySelector(statusSelector);
    assert.equal(label.tagName, 'SPAN');
    assert.equal(label.parentElement, heading, 'Status shares the title heading and its transform');
    assert.equal(heading.children.at(-1), label, 'Status follows the title content inside the heading');
    assert.equal(label.textContent, 'Site returned HTTP 403');
    assert.equal(label.dataset.reason, 'http_error');
    assert.equal(label.title, '403');
    apply(item, { verdict: 'unresolved', reasons: [ { kind: 'firefox_restricted' } ] }, []);
    assert.equal(label.textContent, 'Firefox does not allow inspection');
    assert.equal(label.dataset.reason, 'firefox_restricted');
    assert.equal(label.title, '');
    for ( const [ reason, text, detail = '' ] of [
        [ { kind: 'challenge_page' }, 'Site verification did not finish' ],
        [ { kind: 'http_error', detail: '403', challenge_provider: 'cloudflare' },
            'Cloudflare verification did not finish', '403' ],
        [ { kind: 'http_error', detail: '429', retry_after: '60' },
            'Site rate limit reached', '429; Retry-After: 60' ],
        [ { kind: 'http_error', detail: '503' }, 'Site returned HTTP 503', '503' ],
        [ { kind: 'incomplete_load' }, 'Page inspection timed out' ],
        [ { kind: 'navigation_failed', detail: 'NS_ERROR_NET_TIMEOUT' },
            'Page could not load', 'NS_ERROR_NET_TIMEOUT' ],
    ] ) {
        apply(item, { verdict: 'unresolved', reasons: [ reason ] }, []);
        assert.equal(label.textContent, text, engine);
        assert.equal(label.title, detail, engine);
        assert.equal(heading.querySelectorAll(statusSelector).length, 1);
        assert.equal(resultTitle(heading), title, 'Failure labels stay out of the captured result title');
        context.requireSingleDomain = true;
        apply(item, { verdict: 'unresolved', reasons: [ reason ] }, []);
        assert.equal(label.textContent, text, 'The failure takes precedence over an unconfirmed characteristic');
        context.requireSingleDomain = false;
    }
    const focusMessages = [];
    context.keepUnresolvedTabs = true;
    context.inspectionTabGeneration = 0;
    context.vAPI = { messaging: { send: async (channel, request) => {
        focusMessages.push([ channel, { ...request } ]);
        return true;
    } } };
    apply(item, { ...unresolved, inspection_tab_id: 10, inspection_tab_generation: 0 }, []);
    assert.equal(label.role, 'button');
    assert.equal(label.tabIndex, 0);
    assert.equal(label.parentElement, heading, 'Debug status must share the title transform too');
    assert.match(label['aria-label'], /^Open inspection tab:/);
    let canceled = 0;
    const tap = (overrides = {}) => ({ type: 'click', isTrusted: true, currentTarget: label,
        preventDefault() { canceled += 1; }, stopPropagation() { canceled += 1; }, ...overrides });
    await label.onclick(tap({ isTrusted: false }));
    await label.onkeydown(tap({ type: 'keydown', key: 'Tab' }));
    assert.equal(focusMessages.length, 0);
    assert.equal(canceled, 0);
    await label.onclick(tap());
    await label.onkeydown(tap({ type: 'keydown', key: 'Enter' }));
    await label.onkeydown(tap({ type: 'keydown', key: ' ' }));
    assert.equal(focusMessages.length, 3, 'Desktop clicks, phone taps and keyboard activation share the same operation');
    assert.deepEqual(focusMessages[0], [ 'queree', { what: 'openInspectionTab', tabId: 10 } ]);
    assert.equal(canceled, 6, 'Opening evidence does not also follow the enclosing Google/Bing link');
    context.inspectionTabGeneration = 1;
    context.renderInspectionTabLink(label);
    assert.equal(label.role, undefined, 'A later debug lifetime cannot revive an old inspection tab');
    await label.onclick(tap());
    assert.equal(focusMessages.length, 3, 'Late old-generation replies cannot open released evidence');
    apply(item, { ...unresolved, inspection_tab_id: 10, inspection_tab_generation: 0 }, []);
    assert.equal(label.role, undefined, 'Re-rendering a stored or delayed decision cannot revive its tab');
    context.inspectionTabGeneration = 0;
    context.keepUnresolvedTabs = false;
    context.renderInspectionTabLink(label);
    assert.equal(label.role, undefined);
    assert.equal(label.tabIndex, -1);
    await label.onclick(tap());
    assert.equal(focusMessages.length, 3);
    context.keepUnresolvedTabs = true;
    context.inspectionTabGeneration = 0;
    context.vAPI.messaging.send = async () => false;
    await label.onclick(tap());
    assert.equal(label.dataset.inspectionTabId, undefined, 'A closed evidence tab loses its dead link');
    assert.equal(label.role, undefined);
    for ( const [ reason, text ] of [
        [ 'inspection_reply_unavailable', 'Quer.ee could not inspect this result' ],
        [ 'incomplete_load', 'Page inspection timed out' ],
    ] ) {
        for ( const [ metadata, opens ] of [
            [ { inspection_tab_id: 10, inspection_tab_generation: 0 }, true ],
            [ { inspection_tab_id: 10, inspection_tab_generation: -1 }, false ],
            [ { inspection_tab_generation: 0 }, false ],
            [ {}, false ],
        ] ) {
            focusMessages.length = 0;
            context.vAPI.messaging.send = async (channel, request) => {
                focusMessages.push([ channel, { ...request } ]);
                return true;
            };
            apply(item, { verdict: 'unresolved', reasons: [ { kind: reason } ], ...metadata }, []);
            assert.equal(label.textContent, text);
            let prevented = false, stopped = false;
            const event = { type: 'click', isTrusted: true, currentTarget: label,
                preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } };
            await label.onclick(event);
            const navigatesResult = !prevented && label.closest('a[href]') !== null;
            assert.equal(navigatesResult, false, `${engine}: ${reason} must not follow the result link`);
            assert.equal(prevented && stopped, true, `${engine}: ${reason} owns the status click`);
            assert.equal(focusMessages.length, opens ? 1 : 0, `${engine}: ${reason} ${JSON.stringify(metadata)}`);
            if ( opens ) {
                assert.deepEqual(focusMessages[0], [ 'queree', { what: 'openInspectionTab', tabId: 10 } ]);
            } else {
                assert.equal(label.role, undefined, 'Unavailable evidence is not presented as a button');
            }
        }
        apply(item, { verdict: 'unresolved', reasons: [ { kind: reason } ],
            inspection_tab_id: 10, inspection_tab_generation: 0 }, []);
        focusMessages.length = 0;
        context.vAPI.messaging.send = async () => { focusMessages.push('closed'); return false; };
        for ( let attempt = 0; attempt < 2; attempt++ ) {
            let prevented = false;
            await label.onclick({ type: 'click', isTrusted: true, currentTarget: label,
                preventDefault() { prevented = true; }, stopPropagation() {} });
            assert.equal(prevented, true, 'A closed retained tab never falls back to result navigation');
        }
        assert.deepEqual(focusMessages, [ 'closed' ], 'A closed tab is not reopened or recreated');
        assert.equal(label.role, undefined);
    }
    assert.equal(anchor.onclick, undefined, 'The ordinary result link is not intercepted');
    assert.equal(label.ontouchstart, undefined, 'Long-press handling is left to the browser');
    assert.equal(label.oncontextmenu, undefined, 'The native long-press menu is not intercepted');
    apply(item, unresolved, []);
    assert.equal(label.tabIndex, -1, 'Unresolved results without a retained tab are ordinary text');
    const assertCleanTitle = () => {
        assert.equal(heading.textContent, originalText + label.textContent);
        assert.equal(resultTitle(heading), title);
        context.processed = new WeakMap();
        const [ recollected ] = collect();
        assert.equal(recollected.result_title, title, 'Recollection never includes status metadata');
        assert.equal(heading.querySelector(statusSelector), label, 'Title extraction leaves the live label intact');
        assert.equal(heading.querySelectorAll(statusSelector).length, 1);
        assert.deepEqual(heading.children.slice(0, -1), originalChildren);
    };
    assertCleanTitle();
    apply(item, unresolved, []);
    assert.equal(heading.querySelector(statusSelector), label, 'Repeated decisions reuse the same label');
    assertCleanTitle();
    apply(item, { verdict: 'unresolved', reasons: [ { kind: 'timeout', detail: 'Timed out' } ] }, []);
    assert.equal(heading.querySelector(statusSelector), label);
    assert.equal(label.dataset.reason, 'timeout');
    assert.equal(label.title, 'Timed out');
    context.requireSingleDomain = true;
    apply(item, { verdict: 'candidate', single_domain: false }, []);
    assert.equal(heading.querySelector(statusSelector), label, 'Changed status reuses the existing child');
    assert.equal(label.className, 'queree-characteristic');
    assert.equal(label.textContent, 'Not single-domain');
    assert.equal(label.title, '');
    assertCleanTitle();
    apply(item, { verdict: 'candidate', single_domain: false }, []);
    assertCleanTitle();
    context.requireSingleDomain = false;
    apply(item, { verdict: 'candidate' }, []);
    assert.equal(heading.querySelector(statusSelector), null, 'A later pass removes the label');
    assert.equal(heading.textContent, originalText);
    assert.deepEqual(heading.children, originalChildren);
    context.processed = new WeakMap();
    assert.equal(collect()[0].result_title, title);
    for ( const [ kind, setting, expected ] of [
        [ 'advertising', 'excludeAdvertisingSignals', 'Advertising' ],
        [ 'cross_site_tracking', 'excludeCrossSiteTracking', 'Cross-site tracking' ],
        [ 'commercial_store', 'excludeShoppingSignals', 'Shopping' ],
    ] ) {
        context[setting] = false;
        apply(item, { verdict: 'exclude', checks_complete: true, shopping_signals: false,
            reasons: [ { kind } ] }, []);
        const finding = heading.querySelector(statusSelector);
        assert.equal(finding.className, 'queree-characteristic');
        assert.equal(finding.textContent, expected);
        assert.equal(resultTitle(heading), title, 'Inspection status never enters the contributed title');
        apply(item, { verdict: 'candidate' }, []);
        assert.equal(heading.querySelector(statusSelector), null, 'A completed inspection removes the warning');
        context[setting] = true;
    }
    context.requireSingleDomain = true;
    context.selectorsForExcludedResult = () => [ '#personal-result' ];
    for ( const [ kind, expected ] of [
        [ 'advertising', 'Advertising' ], [ 'commercial_store', 'Shopping' ],
        [ 'cross_site_tracking', 'Cross-site tracking' ],
        [ 'adult_domain', 'Adult content' ], [ 'scam', 'Fake store / scam' ],
        [ 'malware', 'Malware' ],
    ] ) {
        // Disabled signal controls must not erase evidence on a personally shown page.
        context.excludeAdvertisingSignals = false;
        context.excludeCrossSiteTracking = false;
        context.excludeShoppingSignals = false;
        const decision = { verdict: 'exclude', reasons: [ { kind } ], single_domain: false,
            shopping_signals: true, personal_category: { name: 'My pages', enabled: true } };
        const before = JSON.stringify(decision);
        const selectors = [];
        apply(item, decision, selectors);
        assert.equal(selectors.length, 0, 'Checked personal matches override exclusions and characteristics');
        const observed = heading.querySelector(statusSelector);
        assert.equal(observed.className, 'queree-characteristic');
        assert.equal(observed.textContent, expected);
        assert.equal(resultTitle(heading), title, 'Observed labels stay out of contributed titles');
        assert.equal(JSON.stringify(decision), before, 'Showing an exclusion never promotes its verdict');
        apply(item, { ...decision, personal_category: { name: 'My pages', enabled: false } }, selectors);
        assert.equal(selectors.length, 1, 'Unchecked personal matches hide regardless of other controls');
        assert.equal(selectors[0][1], 'Hidden by setting: My pages');
        assert.equal(heading.querySelector(statusSelector), null, 'Hidden matches do not claim an unfinished inspection');
    }
    context.excludeShoppingSignals = true;
    const selectors = [];
    for ( const verdict of [ 'candidate', 'uninspected' ] ) {
        apply(item, { verdict, single_domain: false, shopping_signals: true,
            personal_category: { name: 'My pages', enabled: true } }, selectors);
        assert.equal(selectors.length, 0);
        assert.equal(heading.querySelector(statusSelector), null);
    }
}
assert.match(source, /\.queree-unresolved, \.queree-characteristic\s*\{\s*display: block;/);
console.log('Passed: Google and Bing statuses are heading children, update without duplicates and never pollute recollected titles');
const presentationLimits = vm.runInNewContext(source.slice(
    source.indexOf('    const maxExcludedSelectors ='),
    source.indexOf('    const summaryHoldDuration =')
) + ';({ maxExcludedSelectors, maxExclusionCSSLength })');
const exclusionLabel = vm.runInNewContext(source.slice(
    source.indexOf('    function reasonApplies('), source.indexOf('    function apply(')
) + ';exclusionLabel', { excludeAdvertisingSignals: true, excludeCrossSiteTracking: true, excludeShoppingSignals: true });
for ( const [ kind, expected ] of [
    [ 'advertising', 'Advertising' ], [ 'search_advertising', 'Ad result' ],
    [ 'affiliate_link', 'Affiliate links' ],
    [ 'affiliate_publisher', 'Listed affiliate publisher' ],
    [ 'affiliate_tracked_link', 'Affiliate or tracked link' ],
    [ 'cross_site_tracking', 'Cross-site tracking' ],
    [ 'malware', 'Malware' ],
    [ 'commercial_store', 'Shopping' ], [ 'adult_domain', 'Adult content' ],
] ) {
    const item = { sourceReasons: [ { kind: 'search_advertising' } ] };
    assert.equal(exclusionLabel({ reasons: [ { kind } ] }, false, item), expected);
}
for ( const [ category, expected ] of [
    [ 'community_contribution', 'Social platforms' ],
    [ 'public_interest_organization', 'Public-interest organizations' ],
    [ 'government_education', 'Government and education' ],
    [ 'professional_publication', 'Professional publications' ],
    [ 'commercial_corporate', 'Corporations' ],
] ) {
    assert.equal(exclusionLabel({ reasons: [ { kind: 'source_category', category } ] }, false, {}),
        `Hidden by setting: ${expected}`);
}
assert.equal(exclusionLabel({ reasons: [ { kind: 'search_advertising' } ] }, false, {}),
    'Excluded by Quer.ee', 'A result-specific ad reason cannot label another result');
assert.equal(exclusionLabel({ reasons: [ { kind: 'unknown' }, { kind: 'adult_domain' } ] }, false, {}),
    'Adult content', 'Use the first supported reason');
for ( const decision of [ {}, { reasons: [] }, { reasons: [ { kind: 'source_category', category: 'constructor' } ] },
    { reasons: [ { kind: '"; color: red' } ] } ] ) {
    assert.equal(exclusionLabel(decision, false, {}), 'Excluded by Quer.ee');
}
assert.equal(exclusionLabel({ single_domain: false }, true, {}), 'Not single-domain');
assert.equal(exclusionLabel(undefined, true, {}), 'Single-domain unconfirmed');
console.log('Passed: exclusion explanations use fixed labels and distinguish settings, ads and provisional results');
{
    let text = '';
    let writes = 0;
    const context = {
        status: { get textContent() { return text; }, set textContent(value) { text = value; writes++; } },
        toggle: { disabled: false },
        activeBatches: new Set(), progressTimer: undefined,
        emptyStored: false, stylesheetOperationsPending: 0, hidingUnavailable: false,
        excludedVisible: false,
        document: { querySelectorAll: () => [] },
        matchedExcludedContainers: () => [ {} ],
        getComputedStyle: () => ({ display: 'none' }),
    };
    const update = vm.runInNewContext(source.slice(source.indexOf('    function updateStatus('),
        source.indexOf('    function stopProgress(')) + ';updateStatus', context);
    update();
    update();
    assert.equal(writes, 1, 'Identical status must not generate another child-list mutation');
    assert.equal(text, '1 excluded, 0 unresolved');
    context.excludedVisible = true;
    update();
    assert.equal(text, '1 excluded, 0 unresolved');
    context.emptyStored = true;
    text = 'No Google results';
    update();
    assert.equal(text, 'No Google results', 'An idle scan preserves the terminal search status');
}
{
    const panel = { isConnected: false };
    let attached;
    const ensure = vm.runInNewContext(source.slice(source.indexOf('    function ensurePanel('),
        source.indexOf('    function updateStatus(')) + ';ensurePanel', {
        panel, adapter: { panelRoot: '#search' },
        document: { querySelector: () => ({ prepend: node => { attached = node; } }) },
    });
    ensure();
    assert.equal(attached, panel, 'Replacing the search root reattaches the existing controls');
}
console.log('Passed: status updates settle, preserve empty results and reattach detached controls');
function resultPresentationFixture({
    requireSingleDomain = false,
    maxSelectors = presentationLimits.maxExcludedSelectors,
    names = [ 'measured', 'unknown', 'excluded' ],
    oldRules = false,
} = {}) {
    const items = names.map(id => {
        const heading = resultElement('h3');
        const url = `https://personal.example/${id}`;
        return { id, url, sourceHref: url, anchor: { id, href: url }, heading };
    });
    const styles = new Set(oldRules ? [ 'old hide' ] : []);
    const applied = [];
    const replies = [];
    const scheduledScans = [];
    let onMessage;
    const context = {
        enabled: true, settingEnabled: true, requireSingleDomain, excludeAdvertisingSignals: true, excludeCrossSiteTracking: true, excludeShoppingSignals: true, shuttingDown: false,
        keepUnresolvedTabs: false, personalCategories: undefined, sourceControls: undefined,
        settingsRevision: -1, renderInspectionDebugMode() {},
        mobileInspection: { mobile: false, ready: false }, mobileQ: undefined, mobileHelp: undefined,
        renderMobileInspection() {},
        generation: 1, restoreGeneration: 0, batchSequence: 0, settingsGeneration: 0, simultaneousInspections: 6, running: false, rescan: false,
        emptyTimer: undefined, emptyStartedAt: undefined, emptyStored: false,
        scanTimer: undefined, summaryTimer: undefined, activeBatches: new Set(),
        observer: undefined, panel: undefined, status: undefined, style: undefined, toggle: undefined,
        paginationTarget: 10, paginationAuto: true, paginationComplete: false, paginationLoading: false,
        paginationNext: undefined, paginationCancel: undefined, paginationButton: undefined,
        paginationSource: undefined,
        maybeLoadMore() {}, renderPagination() {},
        searchEngineAdapter: () => ({}),
        location: { href: 'initial' }, sourceSearchIdentity: 'initial', searchIdentity: href => href,
        recorded: new Map(), activeItems: new Map(),
        selectorReasons: new Map(oldRules ? [ [ '#old', 'Excluded by Quer.ee' ] ] : []),
        exclusionStylesheets: new Map(oldRules ? [ [ 'old hide', 'old mark' ] ] : []),
        appliedStylesheets: new Set(styles),
        processed: new WeakMap(),
        document: {
            documentElement: { removeAttribute() {} },
            querySelectorAll: () => items.flatMap(item => item.heading.querySelectorAll(statusSelector)),
            createElement: resultElement,
        },
        selectorsForExcludedResult: anchor => [ `#${anchor.id}` ],
        collect: () => items.filter(item => {
            if ( context.processed.get(item.anchor) === item.anchor.href ) { return false; }
            context.processed.set(item.anchor, item.anchor.href);
            return true;
        }),
        stylesheetOperation: Promise.resolve(), stylesheetOperationsPending: 0,
        excludedVisible: false, hidingUnavailable: false, maxExcludedSelectors: maxSelectors,
        maxExclusionCSSLength: presentationLimits.maxExclusionCSSLength,
        vAPI: {
            userStylesheet: {
                add: css => styles.add(css), remove: css => styles.delete(css),
                apply: done => { applied.push([...styles]); done(); },
            },
            messaging: { destroyPort() {}, send: (_channel, request) => new Promise(resolve => {
                if ( request.what === 'getSettings' ) {
                    resolve(context.backgroundSettings);
                    return;
                }
                assert.equal(request.what, 'inspectResults');
                replies.push({ request, resolve });
            }) },
        },
        browser: { runtime: { onMessage: { addListener: listener => { onMessage = listener; } } } },
        MutationObserver: class { observe() {} disconnect() {} },
        window: { addEventListener() {} },
        isGoogleImages: () => false, isSearchPage: () => true, hasResultAnchor: () => items.length !== 0,
        ensurePanel() {}, updateStatus() {}, holdStatusSummary() {}, startProgress() {}, stopProgress() {}, updateProgress() {},
        clearTimeout() {}, setTimeout: callback => { scheduledScans.push(callback); },
    };
    const lifecycle = vm.runInNewContext(
        source.slice(source.indexOf('    function setMobileInspection('), source.indexOf('    function updateStatus(')) +
        source.slice(source.indexOf('    function exclusionCSS('), source.indexOf('    function matchedExcludedContainers(')) +
        source.slice(source.indexOf('    function reasonApplies('),
            source.indexOf('    function emptySourceStatus(')) +
        source.slice(source.indexOf('    async function scan('),
            source.indexOf("    window.addEventListener('pageshow', onPageShow);")) +
        'browser.runtime.onMessage.addListener(onMessage);' +
        ';({ scan, stop, onPageShow, refreshCharacteristic, addExclusionSelectors, exclusionMarkerCSS })', context);
    return { context, items, styles, applied, replies, scheduledScans, ...lifecycle, onMessage };
}
for ( const engine of [ 'Google', 'Bing' ] ) {
    const f = resultPresentationFixture({ names: [ 'first', 'waiting' ] });
    const page = resultElement('div');
    page.prepend = page.append;
    Object.assign(f.context, { URL, CSS: { escape: value => JSON.stringify(value) } });
    const adapterFor = vm.runInNewContext(source.slice(source.indexOf('    function searchEngineAdapter('),
        source.indexOf('    let adapter =')) + ';searchEngineAdapter', f.context);
    f.context.adapter = adapterFor(engine === 'Google' ? 'www.google.com' : 'www.bing.com', '/search');
    f.context.selectorsForExcludedResult = vm.runInNewContext(
        source.slice(source.indexOf('    function hrefAttributeSelectors('),
            source.indexOf('    // Next-link selectors')) + ';selectorsForExcludedResult', f.context);
    for ( const item of f.items ) {
        const anchor = resultElement('a');
        anchor.href = item.url;
        anchor.getAttribute = name => name === 'href' ? anchor.href : null;
        item.anchor = anchor;
        if ( engine === 'Google' ) { anchor.append(item.heading); }
        else { item.heading.append(anchor); }
    }
    Object.assign(f.context.document, {
        documentElement: page, querySelector: () => page, getElementById: () => null,
        createElement(tag) {
            const node = resultElement(tag);
            if ( tag === 'aside' ) {
                node.append({ ...resultElement('strong', 'Quer.ee'), addEventListener() {} });
                node.append(resultElement('span'));
                node.append({ ...resultElement('button'), disabled: false,
                    addEventListener(_type, listener) { this.click = listener; } });
                node.style = {};
            }
            return node;
        },
    });
    f.context.matchedExcludedContainers = () => [];
    f.context.ensurePanel = vm.runInNewContext(source.slice(source.indexOf('    function ensurePanel('),
        source.indexOf('    function renderMobileInspection(')) + ';ensurePanel', f.context);
    let batchSettled = false;
    const pending = f.scan();
    pending.then(() => { batchSettled = true; });
    await new Promise(resolve => setImmediate(resolve));
    const { request, resolve } = f.replies[0];
    const decision = { id: 'first', verdict: 'exclude', reasons: [ { kind: 'advertising' } ] };
    f.onMessage({ what: 'quereeInspectionProgress', batchId: request.batchId, completed: 1, total: 2, decision });
    await f.context.stylesheetOperation;
    const [ selector ] = f.context.selectorsForExcludedResult(f.items[0].anchor);
    const [ otherSelector ] = f.context.selectorsForExcludedResult(f.items[1].anchor);
    assert.ok(selector.includes(engine === 'Google' ? '.MjjYud' : '#b_results > li.b_algo'));
    const hidden = [...f.styles].join('');
    assert.ok(hidden.includes(selector), `${engine}: actual result selector is in the applied CSS`);
    assert.equal(hidden.includes(otherSelector), false, 'The unfinished result is not hidden');
    assert.match(hidden, /display:\s*none\s*!important/);
    assert.equal(f.context.recorded.has(f.items[1].url), false, 'The second decision is not finished');
    assert.equal(batchSettled, false, 'Hiding precedes the final batch reply');
    await f.context.toggle.click({ isTrusted: true });
    const visible = [...f.styles].join('');
    assert.equal(visible.includes(selector), true, 'Show excluded retains the explanation marker');
    assert.doesNotMatch(visible, /display:\s*none\s*!important/, 'Show excluded removes the hide rule');
    assert.equal(f.items[0].anchor.href, f.items[0].url, 'The ordinary result link remains intact');
    assert.equal(f.items[0].anchor.onclick, undefined);
    assert.equal(batchSettled, false, 'Show excluded works while the batch remains pending');
    resolve([ decision, { id: 'waiting', verdict: 'candidate' } ]);
    await pending;
}
console.log('Passed: Google and Bing apply exclusion CSS before batch completion and restore links on request');
{
    const f = resultPresentationFixture({ names: [ 'pending' ] });
    const renders = [];
    f.context.renderPagination = () => { renders.push(f.context.running); };
    const pending = f.scan();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(renders[0], true, 'Starting inspection rerenders pagination so Stop is available');
    f.context.document.hidden = true;
    f.onMessage({ what: 'quereeInspectionProgress', batchId: f.replies[0].request.batchId,
        completed: 1, total: 1, decision: { id: 'pending', verdict: 'candidate' } });
    assert.equal(f.context.recorded.get(f.items[0].url).verdict, 'candidate',
        'A source becoming hidden does not discard ongoing website inspection progress');
    f.replies[0].resolve([ { id: 'pending', verdict: 'candidate' } ]);
    await pending;
}
{
    const f = resultPresentationFixture({ names: [ 'saved', 'waiting' ] });
    const page = resultElement('div');
    page.prepend = page.append;
    for ( let i = 0; i < 2; i++ ) {
        const stale = resultElement('aside');
        stale.id = 'queree-results-control';
        stale.append(resultElement('span', '1 excluded, 0 unresolved', [ '[role="status"]' ]));
        page.append(stale);
    }
    const oldStyle = resultElement('style');
    oldStyle.id = 'queree-results-style';
    page.append(oldStyle);
    Object.assign(f.context.document, {
        documentElement: page,
        querySelector: () => page,
        querySelectorAll: selector => page.querySelectorAll(selector),
        getElementById: id => page.querySelector(`#${id}`),
        createElement(tag) {
            const node = resultElement(tag);
            if ( tag === 'aside' ) {
                node.append({ ...resultElement('strong', 'Quer.ee'), addEventListener() {} });
                node.append(resultElement('span'));
                node.append({
                    ...resultElement('button'), disabled: false,
                    addEventListener(_type, listener) { this.click = listener; },
                });
                node.style = {};
                node.offsetHeight = 20;
            }
            return node;
        },
    });
    f.context.adapter = { panelRoot: '#search' };
    f.context.ensurePanel = vm.runInNewContext(source.slice(source.indexOf('    function ensurePanel('),
        source.indexOf('    function renderMobileInspection(')) + ';ensurePanel', f.context);
    const clock = recoveryClock();
    Object.assign(f.context, clock, {
        progressTimer: undefined, progressCompleted: 0, progressTotal: 0, progressDots: 0,
        summaryHoldDuration: 2000,
    });
    f.context.matchedExcludedContainers = () => f.context.selectorReasons.has('#saved')
        ? [ { scrollIntoView() {} } ] : [];
    f.context.getComputedStyle = () => ({ display: 'none' });
    Object.assign(f.context, vm.runInNewContext(source.slice(source.indexOf('    function updateStatus('),
        source.indexOf('    function resultTitle(')) +
        ';({ updateStatus, startProgress, stopProgress, updateProgress, holdStatusSummary })', f.context));
    const restored = f.scan();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(page.querySelectorAll('#queree-results-control').length, 1);
    assert.equal(page.querySelectorAll('#queree-results-style').length, 1);
    assert.equal(f.context.status.textContent, 'Restoring results');
    assert.equal(f.context.toggle.disabled, false);
    const { request, resolve } = f.replies.shift();
    assert.equal(request.items[0].id, 'saved');
    const decision = { id: 'saved', verdict: 'exclude', cached: true, reasons: [ { kind: 'advertising' } ] };
    f.onMessage({ what: 'quereeInspectionProgress', batchId: request.batchId, completed: 1, total: 2, decision });
    await clock.advance(399);
    assert.equal(f.context.status.textContent, 'Restoring results');
    await clock.advance(1);
    assert.equal(f.context.status.textContent, '1 of 2 results inspected.');
    await clock.advance(800);
    assert.equal(f.context.status.textContent, '1 of 2 results inspected...');
    await f.context.toggle.click({ isTrusted: true });
    assert.equal(f.context.status.textContent, '1 excluded, 0 unresolved (still checking)',
        'A manual visibility toggle briefly shows the current summary');
    assert.equal(f.context.toggle.disabled, false);
    await clock.advance(2000);
    assert.match(f.context.status.textContent, /^1 of 2 results inspected/);
    f.onMessage({ what: 'quereeInspectionProgress', batchId: request.batchId,
        completed: 2, total: 2,
        decision: { id: 'waiting', verdict: 'candidate', shopping_signals: false } });
    await new Promise(resolve => setImmediate(resolve));
    assert.match(f.context.status.textContent, /^1 of 2 results inspected/,
        'Automatic updates leave the progress text to its existing timer');
    await clock.advance(1999);
    assert.match(f.context.status.textContent, /^2 of 2 results inspected/,
        'Automatic result updates keep the progress indicator until the batch finishes');
    await clock.advance(1);
    assert.match(f.context.status.textContent, /^2 of 2 results inspected/);
    resolve([ decision, { id: 'waiting', verdict: 'candidate' } ]);
    await restored;
    assert.equal(f.context.toggle.disabled, false);
    assert.equal(f.context.status.textContent, '1 excluded, 0 unresolved');
    assert.equal(f.context.recorded.get(f.items[0].url).cached, true);

    f.items.push({ id: 'new', url: 'https://personal.example/new', sourceHref: 'https://personal.example/new',
        anchor: { id: 'new', href: 'https://personal.example/new' }, heading: resultElement('h3') });
    const next = f.scan();
    await new Promise(resolve => setImmediate(resolve));
    const cached = f.replies.shift();
    assert.equal(cached.request.items[0].id, 'new');
    const cachedDecision = { id: 'new', verdict: 'candidate', cached: true };
    f.onMessage({ what: 'quereeInspectionProgress', batchId: cached.request.batchId,
        completed: 1, total: 1, decision: cachedDecision });
    assert.equal(f.context.status.textContent, '1 excluded, 0 unresolved');
    cached.resolve([ cachedDecision ]);
    await next;
    await clock.advance(400);
    assert.equal(f.context.status.textContent, '1 excluded, 0 unresolved');
    assert.equal(f.context.progressTimer, undefined);

    f.items.push({ id: 'slow', url: 'https://personal.example/slow', sourceHref: 'https://personal.example/slow',
        anchor: { id: 'slow', href: 'https://personal.example/slow' }, heading: resultElement('h3') });
    const slow = f.scan();
    await new Promise(resolve => setImmediate(resolve));
    const pending = f.replies.shift();
    await clock.advance(1599);
    assert.equal(f.context.status.textContent, '1 excluded, 0 unresolved',
        'A following batch does not immediately overwrite the completed summary');
    await clock.advance(1);
    assert.match(f.context.status.textContent, /^3 of 4 results inspected/,
        'A later page adds to the whole-search count instead of restarting at zero');
    f.onMessage({ what: 'quereeInspectionProgress', batchId: pending.request.batchId,
        completed: 1, total: 1, decision: { id: 'slow', verdict: 'candidate' } });
    await clock.advance(400);
    assert.match(f.context.status.textContent, /^4 of 4 results inspected/,
        'A later batch completion cannot overwrite the cumulative total with its own size');
    pending.resolve([ { id: 'slow', verdict: 'candidate' } ]);
    await slow;

    const duplicate = { url: f.items[0].url };
    const extra = { url: 'https://personal.example/extra' };
    f.context.startProgress([ duplicate, extra, extra ]);
    assert.equal(f.context.progressCompleted, 4);
    assert.equal(f.context.progressTotal, 5, 'Rechecks and duplicate links do not inflate the overall total');
    f.context.stopProgress();
}
console.log('Passed: one restored panel, dots for pending work and no progress flash for quick cache hits');
for ( const background of [ 'unchecked', 'checking', 'paused' ] ) {
    const panel=resultElement('aside');
    const strong=resultElement('strong');
    strong.after=node=>panel.append(node);
    panel.append(strong);
    const copied=[];
    const context={
        panel, mobileInspection:{mobile:true,ready:false,tabsReady:true,background},
        mobileQ:undefined,mobileHelp:undefined,backgroundSettingsCopied:false,enabled:false,
        recorded:new Map(),processed:new WeakMap(),scheduleScan() {},
        backgroundSettingsURL:'chrome://geckoview/content/config.xhtml?filter=dom.suspend_inactive.enabled',
        navigator:{clipboard:{writeText:async value=>{copied.push(value);}}},
        document:{createElement(tag){
            return Object.assign(resultElement(tag),{
                setAttribute(name,value){this[name]=value;},
                addEventListener(_name,listener){this.click=async event=>{
                    listener(event);
                    await new Promise(resolve=>setImmediate(resolve));
                };},
            });
        }},
        vAPI:{messaging:{send:async()=>context.mobileInspection}},
    };
    const ui=vm.runInNewContext(source.slice(source.indexOf('    function showBackgroundSetup('),
        source.indexOf('    function updateStatus('))+
        source.slice(source.indexOf('    function retryMobileInspection('),source.indexOf('    function syncSearchMode('))+
        ';({renderMobileInspection,setMobileInspection,retryMobileInspection})',context);
    ui.renderMobileInspection();
    assert.equal(context.mobileQ.dataset.needed,'true');
    if ( background === 'paused' ) {
        assert.match(context.mobileHelp.textContent,/set dom.suspend_inactive.enabled to false/);
    }
    await context.mobileQ.click({ isTrusted: true });
    assert.deepEqual(copied,[context.backgroundSettingsURL],'The same Q copies the filtered settings address');
    if ( background === 'paused' ) {
        assert.match(context.mobileHelp.textContent,/Settings address copied/);
        assert.match(context.mobileHelp.textContent,/set dom.suspend_inactive.enabled to false/);
    } else {
        assert.match(context.mobileHelp.textContent,/Could not check background execution/,
            'An incomplete probe must not diagnose a preference failure');
    }
    assert.doesNotMatch(context.mobileHelp.textContent,/Checking background execution on the next/);
    if ( background !== 'paused' ) {
        assert.doesNotMatch(context.mobileHelp.textContent,/Background pages are not running/,
            'An untested background page is not a diagnosed failure');
    }
    ui.setMobileInspection({mobile:true,tabsReady:true,background:'running',ready:true});
    assert.equal(context.mobileQ.dataset.needed,'false');
    assert.equal(context.mobileHelp.hidden,true,'A successful timer dismisses setup without a confirmation tap');
    ui.setMobileInspection({mobile:true,tabsReady:true,background:'paused',ready:false});
    context.navigator.clipboard.writeText=async()=>{throw Error('Clipboard unavailable');};
    await context.mobileQ.click({ isTrusted: true });
    assert.ok(context.mobileHelp.textContent.includes(context.backgroundSettingsURL));
    assert.doesNotMatch(context.mobileHelp.textContent,/Settings address copied/);
    context.enabled=true;
    context.document.hidden=false;
    ui.setMobileInspection({mobile:true,tabsReady:true,background:'paused',ready:false});
    let automatic=0;
    context.navigator.clipboard.writeText=async()=>assert.fail('Returning from settings must not overwrite the clipboard');
    context.vAPI.messaging.send=async()=>{
        automatic++;
        return {mobile:true,tabsReady:true,background:'running',ready:true};
    };
    context.mobileQ.disabled=true;
    await ui.retryMobileInspection();
    assert.equal(automatic,0,'The setup action ignores its own foreground return while busy');
    context.mobileQ.disabled=false;
    await ui.retryMobileInspection();
    assert.equal(automatic,0,'A plain tab return while paused must not start another test');
    ui.setMobileInspection({mobile:true,tabsReady:false,background:'unchecked',ready:false});
    ui.setMobileInspection({mobile:true,tabsReady:true,background:'unchecked',ready:false});
    await ui.retryMobileInspection();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(automatic,1,'An untested initial setup runs once');
    assert.equal(context.mobileQ.dataset.needed,'false');
    await ui.retryMobileInspection();
    assert.equal(automatic,1,'Ordinary loads and tab switches retain the pass');
    context.navigator.clipboard.writeText=async value=>{copied.push(value);};
    await context.mobileQ.click({ isTrusted: true });
    assert.equal(automatic,2,'A green Q can be tapped for a genuine manual retest');
}
console.log('Passed: amber Q copies setup instructions, tolerates denied clipboard and turns green automatically');
for ( const hidden of [ false, true ] ) {
    const f = resultPresentationFixture({ names: [ 'cached' ] });
    f.context.document.hidden = hidden;
    f.context.mobileInspection = { mobile: true, tabsReady: false, ready: false };
    let checks = 0;
    f.context.retryMobileInspection = () => { checks += 1; };
    f.context.recorded.set(f.items[0].url, { verdict: 'candidate', cached: true });
    f.onMessage({ what: 'quereeMobileInspectionState', mobile: true, revision: 1,
        ready: false, tabsReady: true, background: 'unchecked' });
    assert.equal(checks, hidden ? 0 : 1, 'A visible cached search starts the late-ready background check');
    f.onMessage({ what: 'quereeMobileInspectionState', mobile: true, revision: 2,
        ready: false, tabsReady: true, background: 'unchecked' });
    assert.equal(checks, hidden ? 0 : 1, 'Ordinary pool updates do not repeat the diagnostic');
}
for ( const ready of [ false, true ] ) {
    const f = resultPresentationFixture({ names: [ 'phone' ] });
    f.context.mobileInspection = { mobile: true, ready: false, tabsReady: false };
    const pending = f.scan();
    await new Promise(resolve => setImmediate(resolve));
    f.onMessage({ what: 'quereeMobileInspectionState', mobile: true, ready, tabsReady: true });
    f.replies.shift().resolve([ {
        id: 'phone', verdict: 'unresolved', reasons: [ { kind: 'private_tab_needed' } ],
    } ]);
    await pending;
    assert.equal(f.context.recorded.has(f.items[0].url), false,
        'A late setup-needed reply must not overwrite a usable pool, even before its timer check');
    assert.equal(f.context.processed.has(f.items[0].anchor), false);
    assert.ok(f.scheduledScans.length > 0, 'Resume automatically after Q setup, without page refresh');
}
{
    const fixture = resultPresentationFixture({ names: [ 'current' ], maxSelectors: 1 });
    const { context, items, applied } = fixture;
    context.recorded.set(items[0].url, { verdict: 'exclude', reasons: [ { kind: 'malware' } ] });
    await fixture.addExclusionSelectors([ [ '#gone', 'Advertising' ] ]);
    await fixture.addExclusionSelectors([ [ '#current', 'Malware' ] ]);
    assert.equal(context.exclusionStylesheets.size, 2, 'The per-sheet bound splits rather than drops exclusions');
    await fixture.refreshCharacteristic(false);
    assert.deepEqual([...context.selectorReasons.keys()], [ '#current' ],
        'Presentation refresh rebuilds from current results instead of discarding a new exclusion');
    assert.equal(context.hidingUnavailable, false);
    const previousApplies = applied.length;
    await fixture.refreshCharacteristic(false);
    assert.equal(applied.length, previousApplies,
        'An unchanged replacement must not remove and add the same native stylesheet');
}
for ( const reply of [ undefined, [], new Error('Disconnected') ] ) {
    const fixture = resultPresentationFixture({ names: [ 'finished', 'missing' ] });
    const scanning = fixture.scan();
    await new Promise(resolve => setImmediate(resolve));
    const { request, resolve } = fixture.replies[0];
    fixture.onMessage({ what: 'quereeInspectionProgress', batchId: request.batchId,
        completed: 1, total: 2, decision: { id: 'finished', verdict: 'candidate' } });
    resolve(reply instanceof Error ? Promise.reject(reply) : reply);
    if ( reply === undefined ) {
        await new Promise(resolve => setImmediate(resolve));
        fixture.replies[1].resolve(undefined);
    }
    await scanning;
    assert.equal(fixture.context.recorded.get(fixture.items[0].url).verdict, 'candidate');
    assert.equal(fixture.context.recorded.get(fixture.items[1].url).verdict, 'unresolved');
    assert.equal(fixture.items[1].heading.querySelector(statusSelector).className, 'queree-unresolved');
    assert.equal(fixture.context.running, false);
    assert.equal(fixture.context.activeItems.size, 0);
}
for ( const finalVerdict of [ 'unresolved', 'uninspected' ] ) {
    const fixture = resultPresentationFixture({ names: [ 'changed' ] });
    const scanning = fixture.scan();
    await new Promise(resolve => setImmediate(resolve));
    const { request, resolve } = fixture.replies[0];
    fixture.onMessage({ what: 'quereeInspectionProgress', batchId: request.batchId,
        completed: 1, total: 1, decision: { id: 'changed', verdict: 'exclude', reasons: [ { kind: 'advertising' } ] } });
    await fixture.context.stylesheetOperation;
    assert.equal(fixture.context.selectorReasons.has('#changed'), true);
    if ( finalVerdict === 'uninspected' ) {
        fixture.onMessage({ what: 'quereeInspectionProgress', batchId: request.batchId,
            completed: 1, total: 1, decision: { id: 'changed', verdict: finalVerdict } });
        assert.equal(fixture.context.recorded.get(fixture.items[0].url).verdict, finalVerdict);
    }
    resolve([ { id: 'changed', verdict: finalVerdict } ]);
    await scanning;
    assert.equal(fixture.styles.size, 0, 'A nonexcluded result removes a provisional exclusion');
    assert.equal(fixture.context.selectorReasons.size, 0);
    if ( finalVerdict === 'uninspected' ) {
        assert.equal(fixture.items[0].heading.querySelector(statusSelector), null,
            'Skipped Social sites are not mislabeled as unresolved');
    }
}
console.log('Passed: stale selectors are pruned and incomplete replies remain visible as unresolved');
for ( const [ shopping, hidden ] of [ [ false, false ], [ true, true ] ] ) {
    const fixture = resultPresentationFixture({ names: [ 'file' ], requireSingleDomain: true });
    const scanning = fixture.scan();
    await new Promise(resolve => setImmediate(resolve));
    const { request, resolve } = fixture.replies[0];
    const decision = { id: 'file', verdict: 'uninspected', domain_only: true, shopping_signals: shopping };
    fixture.onMessage({ what: 'quereeInspectionProgress', batchId: request.batchId,
        completed: 1, total: 1, decision });
    resolve([ decision ]);
    await scanning;
    assert.equal(fixture.context.selectorReasons.has('#file'), hidden);
    assert.equal(fixture.items[0].heading.querySelector(statusSelector), null,
        'A file has neither an unsupported-viewer label nor a single-domain warning');
}
{
    const batchIds = [];
    for ( const now of [ 1000, 2000 ] ) {
        const f = resultPresentationFixture({ names: [ 'reload' ] });
        f.context.Date = { now: () => now };
        const scanning = f.scan();
        await new Promise(resolve => setImmediate(resolve));
        batchIds.push(f.replies[0].request.batchId);
        f.replies[0].resolve([ { id: 'reload', verdict: 'candidate' } ]);
        await scanning;
    }
    assert.notEqual(batchIds[0], batchIds[1], 'A new content-script instance must not reuse a retained background batch ID');
    const f = resultPresentationFixture();
    let refills = 0;
    f.context.maybeLoadMore = () => { refills += 1; };
    f.context.simultaneousInspections = 1;
    f.onMessage({ what: 'quereeSettingsChanged', enabled: true, simultaneousInspections: 4,
        excludeAdvertisingSignals: true, excludeCrossSiteTracking: true, excludeShoppingSignals: true });
    assert.equal(f.context.simultaneousInspections, 4);
    assert.equal(refills, 1, 'Changing the limit reevaluates the queue without waiting for a slow page');
}
{
    const fixture = resultPresentationFixture({ names: [ 'repeated' ] });
    const previous = fixture.scan();
    await new Promise(resolve => setImmediate(resolve));
    const originalGeneration = fixture.context.generation;
    fixture.context.location.href = 'changed';
    fixture.onMessage({ what: 'quereeSearchURLChanged' });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(fixture.context.generation > originalGeneration);
    assert.equal(fixture.replies.length, 2, 'A new query inspects repeated URLs in a new batch');
    fixture.replies[0].resolve([ { id: 'repeated', verdict: 'unresolved', reasons: [ { kind: 'source_changed' } ] } ]);
    await previous;
    assert.equal(fixture.context.recorded.size, 0, 'Cancelled work from the old query stays retired');
    fixture.replies[1].resolve([ { id: 'repeated', verdict: 'candidate' } ]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fixture.context.recorded.get(fixture.items[0].url).verdict, 'candidate');
}
console.log('Passed: in-page search changes retire old replies and reinspect repeated results');
{
    const f = resultPresentationFixture({ names: [ 'personal' ] });
    const categories = [ { name: 'My pages', enabled: false, entries: [ f.items[0].url ] } ];
    f.onMessage({ what: 'quereeSettingsChanged', enabled: true, personalCategories: categories });
    const previous = f.scan();
    await new Promise(resolve => setImmediate(resolve));
    const generation = f.context.generation;
    f.onMessage({ what: 'quereeSettingsChanged', enabled: true,
        personalCategories: [ { ...categories[0], enabled: true } ] });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(f.context.generation > generation);
    assert.equal(f.replies.length, 2, 'Personal category edits request fresh display decisions');
    f.replies[0].resolve([ { id: 'personal', verdict: 'exclude',
        personal_category: { name: 'My pages', enabled: false } } ]);
    await previous;
    assert.equal(f.context.recorded.size, 0, 'A reply from before a category edit cannot restore old hiding');
    f.replies[1].resolve([ { id: 'personal', verdict: 'uninspected',
        personal_category: { name: 'My pages', enabled: true } } ]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.context.recorded.get(f.items[0].url).personal_category.enabled, true);
    assert.equal(f.styles.size, 0);
}
console.log('Passed: personal category changes retire stale replies and refresh visibility');
{
    const f = resultPresentationFixture({ names: [ 'source-category' ] });
    const settings = { what: 'quereeSettingsChanged', enabled: true, personalCategories: [],
        sourceControls: { commercial_corporate: false } };
    f.onMessage(settings);
    const previous = f.scan();
    await new Promise(resolve => setImmediate(resolve));
    const generation = f.context.generation;
    f.onMessage({ ...settings, sourceControls: { commercial_corporate: true } });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(f.context.generation > generation, 'Source controls must restart classification even with unchanged display flags');
    assert.equal(f.replies.length, 2);
    f.replies[0].resolve([ { id: 'source-category', verdict: 'exclude',
        reasons: [ { kind: 'source_category', category: 'commercial_corporate' } ] } ]);
    await previous;
    assert.equal(f.context.recorded.size, 0, 'An old category hide must not survive the settings change');
    f.replies[1].resolve([ { id: 'source-category', verdict: 'candidate' } ]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.context.recorded.get(f.items[0].url).verdict, 'candidate');
    assert.equal(f.styles.size, 0);
}
console.log('Passed: source-category notifications retire stale replies and request updated classification');
{
    const f = resultPresentationFixture();
    f.onMessage({ what: 'quereeSettingsChanged', revision: 2, enabled: false });
    f.onMessage({ what: 'quereeSettingsChanged', revision: 1, enabled: true });
    assert.equal(f.context.settingEnabled, false, 'A delayed older settings reply cannot re-enable filtering');
    f.onMessage({ what: 'quereeMobileInspectionState', revision: 3,
        mobile: true, ready: false, tabsReady: false });
    f.onMessage({ what: 'quereeMobileInspectionState', revision: 2,
        mobile: true, ready: true, tabsReady: true });
    assert.equal(f.context.mobileInspection.ready, false, 'An older pool reply cannot turn Q green');
}
for ( const previouslyEnabled of [ false, true ] ) {
    const fixture = resultPresentationFixture({ names: [ 'restored' ] });
    fixture.context.enabled = previouslyEnabled;
    fixture.context.settingEnabled = previouslyEnabled;
    fixture.context.backgroundSettings = { enabled: !previouslyEnabled };
    await fixture.onPageShow({ persisted: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fixture.context.enabled, !previouslyEnabled,
        'Back refreshes settings even when the content script was disabled');
    assert.equal(fixture.replies.length, previouslyEnabled ? 0 : 1);
    fixture.replies[0]?.resolve([ { id: 'restored', verdict: 'candidate' } ]);
    await new Promise(resolve => setImmediate(resolve));
}
console.log('Passed: Back applies settings changed while the page was cached, including re-enabling');
{
    const f = resultPresentationFixture({ names: Array.from({ length: 37 }, (_, i) => `finished-${i}`) });
    const settings = { enabled: true, personalCategories: [], sourceControls: {},
        requireSingleDomain: false, excludeAdvertisingSignals: true,
        excludeCrossSiteTracking: true, excludeShoppingSignals: true };
    f.onMessage({ ...settings, what: 'quereeSettingsChanged' });
    const pending = f.scan();
    await new Promise(resolve => setImmediate(resolve));
    const decisions = f.items.map((item, i) => ({ id: item.id,
        verdict: i < 20 ? 'exclude' : i < 35 ? 'candidate' : 'unresolved',
        checks_complete: i < 35, shopping_signals: false,
        reasons: i < 20 ? [ { kind: 'advertising' } ] : [],
    }));
    f.replies[0].resolve(decisions);
    await pending;
    f.context.paginationComplete = true;
    f.context.backgroundSettings = { ...settings,
        mobileInspection: { revision: 1, mobile: true, tabsReady: true, ready: true } };
    await f.onPageShow({ persisted: true });
    await f.scan();
    assert.equal(f.replies.length, 1, 'Back must not request new inspections for finished or unresolved results');
    assert.equal(f.context.recorded.size, 37);
    assert.equal(f.context.paginationComplete, true, 'Restoring unchanged settings must not reopen the cycle');
    for ( const [ i, item ] of f.items.entries() ) {
        assert.equal(f.context.recorded.get(item.url), decisions[i], 'Back reuses the same observation');
    }
}
console.log('Passed: Back retains twenty excluded, fifteen shown and two unresolved without new inspection requests');
{
    const f = resultPresentationFixture({ names: [ 'tracked-back' ] });
    const { context } = f;
    const item = f.items[0];
    const decision = { verdict: 'exclude', checks_complete: true, shopping_signals: false,
        reasons: [ { kind: 'cross_site_tracking' } ] };
    context.recorded.set(item.url, decision);
    await f.refreshCharacteristic(false);
    assert.equal(context.selectorReasons.get('#tracked-back'), 'Cross-site tracking');
    for ( const excludeCrossSiteTracking of [ false, true ] ) {
        context.backgroundSettings = { enabled: true, excludeCrossSiteTracking };
        await f.onPageShow({ persisted: true });
        await context.stylesheetOperation;
        await f.scan();
        assert.equal(context.selectorReasons.has('#tracked-back'), excludeCrossSiteTracking);
        assert.equal(context.stylesheetOperationsPending, 0);
        assert.equal(context.recorded.get(item.url), decision, 'History restoration retains the intrinsic exclusion');
        assert.equal(item.heading.querySelector(statusSelector)?.textContent,
            excludeCrossSiteTracking ? undefined : 'Cross-site tracking');
        assert.equal(f.replies.length, 0, 'Back/Forward toggles reuse the finished observation');
    }
}
console.log('Passed: Back/Forward restores tracking settings without reinspection or promoting exclusions');
for ( const [ before, after ] of [ [ false, true ], [ true, false ], [ false, undefined ], [ true, true ] ] ) {
    const f = resultPresentationFixture({ names: [ 'personal-back' ] });
    const category = { name: 'My pages', enabled: before, entries: [ f.items[0].url ] };
    const initialSettings = { enabled: true, requireSingleDomain: false,
        excludeAdvertisingSignals: true, excludeCrossSiteTracking: true, excludeShoppingSignals: true,
        personalCategories: [ category ] };
    f.onMessage({ what: 'quereeSettingsChanged', ...initialSettings });
    const pending = f.scan();
    await new Promise(resolve => setImmediate(resolve));
    f.replies.shift().resolve([ { id: f.items[0].id, verdict: before ? 'candidate' : 'exclude',
        personal_category: { name: category.name, enabled: before } } ]);
    await pending;
    assert.equal(f.context.selectorReasons.has('#personal-back'), !before);
    const generation = f.context.generation;
    f.context.backgroundSettings = { ...initialSettings,
        personalCategories: after === undefined ? []
            : [ { ...category, enabled: after, entries: category.entries.slice() } ] };
    await f.onPageShow({ persisted: true });
    await new Promise(resolve => setImmediate(resolve));
    if ( before === after ) {
        await f.scan();
        assert.equal(f.context.generation, generation, 'Equal category snapshots retain the current batch');
        assert.equal(f.replies.length, 0, 'Back with unchanged categories must not request new decisions');
        assert.equal(f.context.recorded.get(f.items[0].url).personal_category.enabled, before);
        continue;
    }
    assert.ok(f.context.generation > generation, 'Back detects changed or deleted personal categories without a broadcast');
    assert.equal(f.replies.length, 1, 'Back requests current display decisions after a missed category change');
    assert.equal(f.context.recorded.size, 0, 'Stale personal overrides are retired before the new reply');
    f.replies.shift().resolve([ { id: f.items[0].id,
        verdict: after === false ? 'exclude' : 'candidate',
        ...(after === undefined ? {} : { personal_category: { name: category.name, enabled: after } }),
    } ]);
    await new Promise(resolve => setImmediate(resolve));
    await f.context.stylesheetOperation;
    assert.equal(f.context.selectorReasons.has('#personal-back'), after === false);
    assert.equal(f.styles.size > 0, after === false, 'Native hiding CSS follows the refreshed personal choice');
    assert.equal(f.context.recorded.get(f.items[0].url).personal_category?.enabled, after);
}
console.log('Passed: Back refreshes changed and deleted personal categories but preserves equal snapshots');
{
    const fixture = resultPresentationFixture({ names: [ 'software', 'offer', 'ordinary', 'ad' ] });
    const { context, items } = fixture;
    for ( const item of items ) {
        context.recorded.set(item.url, item.id === 'ad'
            ? { verdict: 'exclude', reasons: [ { kind: 'advertising' } ] }
            : { verdict: 'candidate', shopping_signals: item.id !== 'ordinary' });
    }
    await fixture.refreshCharacteristic(false);
    assert.deepEqual([...context.selectorReasons.keys()], [ '#software', '#offer', '#ad' ]);
    assert.equal(context.selectorReasons.get('#offer'), 'Hidden by setting: Shopping signals');
    fixture.onMessage({
        what: 'quereeSettingsChanged', enabled: true,
        requireSingleDomain: false, excludeShoppingSignals: false,
    });
    await context.stylesheetOperation;
    assert.deepEqual([...context.selectorReasons.keys()], [ '#ad' ]);
    assert.equal(context.recorded.get(items[0].url).shopping_signals, true,
        'The setting changes presentation, not the reusable observation');
    assert.equal(fixture.replies.length, 0, 'Turning shopping filtering off reopens no pages');
    fixture.onMessage({
        what: 'quereeSettingsChanged', enabled: true,
        requireSingleDomain: false, excludeAdvertisingSignals: true, excludeCrossSiteTracking: true, excludeShoppingSignals: true,
    });
    await context.stylesheetOperation;
    assert.deepEqual([...context.selectorReasons.keys()], [ '#software', '#offer', '#ad' ]);
    assert.equal(fixture.replies.length, 0, 'Turning it back on reuses the same observations');
}
console.log('Passed: Shopping signals toggles reuse software/offer observations without waiving advertising');
{
    const reasons = {
        ad: [ 'advertising' ], affiliate: [ 'affiliate_link' ],
        promotion: [ 'advertising' ], search: [ 'search_advertising' ],
        tracking: [ 'cross_site_tracking' ],
        trackedAd: [ 'cross_site_tracking', 'advertising' ],
        trackedShop: [ 'cross_site_tracking', 'commercial_store' ],
        shop: [ 'commercial_store' ], scam: [ 'scam' ], adult: [ 'adult_domain' ],
        malware: [ 'malware' ], bank: [ 'source_category' ],
        mixed: [ 'advertising', 'cross_site_tracking', 'commercial_store', 'scam' ],
        optional: [ 'advertising', 'commercial_store' ], unknown: [ 'unknown' ], empty: [],
    };
    const fixture = resultPresentationFixture({ names: Object.keys(reasons) });
    const { context } = fixture;
    for ( const item of fixture.items ) {
        item.sourceReasons = reasons[item.id].map(kind => ({ kind }));
        context.recorded.set(item.url, { verdict: 'exclude', single_domain: true,
            shopping_signals: false, checks_complete: true,
            reasons: reasons[item.id].map(kind => ({ kind, category: 'commercial_corporate' })) });
    }
    const snapshot = JSON.stringify([...context.recorded]);
    await fixture.refreshCharacteristic(false);
    assert.equal(context.selectorReasons.size, Object.keys(reasons).length);
    for ( const tracking of [ false, true ] ) {
        for ( const advertising of [ false, true ] ) {
            for ( const shopping of [ false, true ] ) {
                fixture.onMessage({
                    what: 'quereeSettingsChanged', enabled: true, requireSingleDomain: false,
                    excludeAdvertisingSignals: advertising, excludeCrossSiteTracking: tracking,
                    excludeShoppingSignals: shopping,
                });
                await context.stylesheetOperation;
                const expected = Object.keys(reasons).filter(name =>
                    [ 'scam', 'adult', 'malware', 'bank', 'mixed', 'unknown', 'empty' ].includes(name) ||
                    (advertising && [ 'ad', 'affiliate', 'promotion', 'search', 'optional', 'trackedAd' ].includes(name)) ||
                    (tracking && [ 'tracking', 'trackedAd', 'trackedShop' ].includes(name)) ||
                    (shopping && [ 'shop', 'optional', 'trackedShop' ].includes(name)));
                assert.deepEqual([...context.selectorReasons.keys()], expected.map(name => `#${name}`));
                assert.equal(context.selectorReasons.get('#mixed'), advertising ? 'Advertising'
                    : tracking ? 'Cross-site tracking' : shopping ? 'Shopping' : 'Fake store / scam');
                assert.equal(JSON.stringify([...context.recorded]), snapshot,
                    'Showing an excluded result must never turn it into an indexable candidate');
            }
        }
    }
    assert.equal(fixture.replies.length, 0, 'All filter changes reuse observations without inspecting pages');
}
console.log('Passed: advertising, tracking and shopping controls are independent and mixed reasons cannot waive safety');
for ( const completion of [ 'advertising', 'clear', 'failed' ] ) {
    const f = resultPresentationFixture({ names: [ 'partial-tracking' ] });
    const item = f.items[0];
    f.context.recorded.set(item.url, { verdict: 'exclude', reasons: [ { kind: 'cross_site_tracking' } ] });
    await f.refreshCharacteristic(false);
    f.onMessage({ what: 'quereeSettingsChanged', enabled: true,
        excludeAdvertisingSignals: true, excludeCrossSiteTracking: false, excludeShoppingSignals: true });
    await f.context.stylesheetOperation;
    assert.equal(f.context.recorded.get(item.url).cached, true, 'Disabling Tracking schedules missing checks');
    assert.match(item.heading.querySelector(statusSelector).textContent, /remaining checks pending/);
    const pending = f.scan();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.replies.length, 1);
    f.replies[0].resolve([ { id: item.id, verdict: 'exclude',
        reasons: [ { kind: 'cross_site_tracking' }, ...(completion === 'advertising' ? [ { kind: 'advertising' } ] : []) ],
        checks_complete: completion === 'clear', shopping_signals: completion === 'failed' ? undefined : false,
        ...(completion === 'failed' ? { inspection_error: { kind: 'incomplete_load' } } : {}),
    } ]);
    await pending;
    assert.equal(f.context.selectorReasons.has('#partial-tracking'), completion === 'advertising',
        'Advertising stays enforced after Tracking is disabled');
    const label = item.heading.querySelector(statusSelector);
    if ( completion === 'failed' ) {
        assert.match(label.textContent, /Cross-site tracking; remaining checks incomplete/);
        assert.equal(label.className, 'queree-unresolved');
    } else if ( completion === 'clear' ) {
        assert.equal(label.textContent, 'Cross-site tracking', 'The known index exclusion stays labeled');
    }
    await f.scan();
    assert.equal(f.replies.length, 1, 'Settled or failed fresh work is not retried in a loop');
}
console.log('Passed: characteristic toggles remeasure partial exclusions, enforce remaining Advertising and distinguish failed checks');
for ( const cached of [ false, true ] ) {
    const f = resultPresentationFixture({ names: [ 'late-tracking' ] });
    const item = f.items[0];
    const first = f.scan();
    await new Promise(resolve => setImmediate(resolve));
    f.onMessage({ what: 'quereeSettingsChanged', enabled: true,
        excludeAdvertisingSignals: true, excludeCrossSiteTracking: false, excludeShoppingSignals: true });
    f.replies[0].resolve([ { id: item.id, verdict: 'exclude', cached,
        reasons: [ { kind: 'cross_site_tracking' } ] } ]);
    await first;
    assert.equal(f.context.recorded.get(item.url).cached, true,
        'A late reply using the old display choices must not waive newly required checks');
    const recheck = f.scan();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.replies.length, 2);
    f.replies[1].resolve([ { id: item.id, verdict: 'exclude', reasons: [ { kind: 'advertising' } ] } ]);
    await recheck;
    assert.equal(f.context.selectorReasons.get('#late-tracking'), 'Advertising');
}
console.log('Passed: settings changes during fresh or cached work recheck late partial replies');
{
    const fixture = resultPresentationFixture();
    const { context, styles, addExclusionSelectors } = fixture;
    context.excludedVisible = true;
    await addExclusionSelectors([ [ '#shared', 'Advertising' ], [ '#first', 'Advertising' ] ]);
    await addExclusionSelectors([ [ '#shared', 'Storefront' ], [ '#second', 'Storefront' ] ]);
    assert.equal(context.selectorReasons.get('#shared'), 'Excluded by Quer.ee');
    const marker = [...styles].join('');
    assert.match(marker, /content: "Excluded by Quer\.ee"/);
    assert.match(marker, /:is\(#first\):not\(:is\(#shared,\n#second\)\)::before/);
    assert.match(marker, /:is\(#second\):not\(:is\(#shared,\n#first\)\)::before/);
    assert.equal(styles.size, 1, 'Incremental updates replace the previous marker stylesheet');
    const before = [...styles];
    await addExclusionSelectors([ [ '#' + 'x'.repeat(presentationLimits.maxExclusionCSSLength), 'Advertising' ] ], true);
    assert.equal(context.hidingUnavailable, true);
    assert.deepEqual([...styles], before, 'Oversized marker rules leave the previous stylesheet intact');
    assert.equal(context.selectorReasons.size, 3);
    await addExclusionSelectors([ [ '#replacement', 'Adult content' ] ], true);
    assert.deepEqual([...context.selectorReasons], [ [ '#replacement', 'Adult content' ] ]);
    assert.match([...styles].join(''), /Adult content/);
}
console.log('Passed: incremental and replacement marker CSS is bounded and conflicting selectors stay generic');
{
    const f = resultPresentationFixture({ names: [ 'escaped-name', 'ordinary-label' ] });
    const name = 'Notes "quoted"\\files\nnext line';
    f.context.excludedVisible = true;
    f.context.recorded.set(f.items[0].url, { verdict: 'exclude',
        personal_category: { name, enabled: false } });
    f.context.recorded.set(f.items[1].url, { verdict: 'exclude', reasons: [ { kind: 'advertising' } ] });
    await f.refreshCharacteristic(false);
    const label = `Hidden by setting: ${name}`;
    assert.equal(f.context.selectorReasons.get('#escaped-name'), label);
    const [ [ hidden, marker ] ] = f.context.exclusionStylesheets;
    assert.ok(hidden.includes('#escaped-name'), 'Names cannot break the hiding selector');
    assert.ok(f.styles.has(marker), 'Show excluded uses the escaped explanation stylesheet');
    assert.ok(marker.includes('content: "Hidden by setting: Notes \\22 quoted\\22 \\5c files\\a next line" !important;'),
        'Quotes, backslashes and newlines must remain text inside the CSS string');
    assert.equal(marker.includes(label), false, 'Raw category text must not be interpolated into CSS');
    assert.match(marker, /content: "Advertising" !important;/, 'Other result labels remain intact');
}
console.log('Passed: personal category marker labels escape quotes, backslashes and newlines without breaking hiding');
{
    const fixture = resultPresentationFixture();
    const { context, styles, addExclusionSelectors, exclusionMarkerCSS } = fixture;
    const labels = [ 'Advertising', 'Affiliate links', 'Storefront', 'Paid promotion',
        'Shopping', 'Adult content' ];
    const entries = Array.from({ length: 18 }, (_, index) => [
        `#result-${index}-${'x'.repeat(800)}`, labels[index % labels.length],
    ]);
    const reasons = new Map(entries);
    assert.ok(exclusionMarkerCSS(reasons).length > presentationLimits.maxExclusionCSSLength);
    await addExclusionSelectors(entries);
    assert.ok(context.exclusionStylesheets.size > 1, 'Oversized explanations split rather than disappear');
    for ( const [ hidden, marker ] of context.exclusionStylesheets ) {
        assert.ok(hidden.length <= presentationLimits.maxExclusionCSSLength);
        assert.ok(marker.length <= presentationLimits.maxExclusionCSSLength);
        assert.ok(styles.has(hidden), 'Every result remains hidden');
    }
    for ( const [ selector, label ] of entries ) {
        assert.ok(Array.from(context.exclusionStylesheets.values()).some(css =>
            css.includes(selector) && css.includes(`content: "${label}"`)), 'Keep every specific reason');
    }
    assert.equal(context.selectorReasons.size, entries.length);
    assert.equal(context.hidingUnavailable, false);

    const previous = [...styles];
    const markerOverflow = `#${'x'.repeat(33000)}`;
    assert.ok(markerOverflow.length < presentationLimits.maxExclusionCSSLength);
    assert.ok(exclusionMarkerCSS(new Map([ [ markerOverflow, 'Advertising' ] ])).length >
        presentationLimits.maxExclusionCSSLength);
    assert.equal(await addExclusionSelectors([ [ markerOverflow, 'Advertising' ] ], true), false);
    assert.equal(context.hidingUnavailable, true);
    assert.deepEqual([...styles], previous, 'A genuinely oversized single rule retains the previous rules');
    assert.equal(context.selectorReasons.size, entries.length);

    await addExclusionSelectors([ [ '#short', 'Advertising' ] ], true);
    assert.match([...context.exclusionStylesheets.values()][0], /content: "Advertising"/,
        'Explanations return when the replacement fits');
}
console.log('Passed: oversized explanations split into bounded batches without losing reasons or hiding');
for ( const [ requireSingleDomain, maxSelectors ] of [ [ false, 256 ], [ true, 256 ], [ true, 1 ] ] ) {
    const fixture = resultPresentationFixture({ requireSingleDomain, maxSelectors, oldRules: true,
        names: [ `measured${requireSingleDomain && maxSelectors === 1
            ? 'x'.repeat(presentationLimits.maxExclusionCSSLength / 2) : ''}`, 'unknown', 'excluded' ],
    });
    const { context, items, applied } = fixture;
    for ( const [ index, decision ] of [
        { verdict: 'candidate', single_domain: false }, { verdict: 'candidate' }, { verdict: 'exclude' },
    ].entries() ) { context.recorded.set(items[index].url, { shopping_signals: false, ...decision }); }
    context.running = true;
    await fixture.refreshCharacteristic();
    assert.deepEqual([...context.recorded.keys()], items.map(item => item.url));
    if ( requireSingleDomain && maxSelectors === 1 ) {
        assert.equal(context.hidingUnavailable, true);
        assert.equal(context.selectorReasons.has('#old'), true);
        assert.equal(context.exclusionStylesheets.get('old hide'), 'old mark');
        assert.equal(applied.length, 0, 'A rejected oversized replacement retains tracked rules');
        continue;
    }
    assert.equal(context.selectorReasons.has('#excluded'), true);
    assert.equal(context.selectorReasons.has('#measured'), requireSingleDomain);
    assert.equal(context.selectorReasons.has('#unknown'), requireSingleDomain,
        'A missing measurement stays hidden while waiting for a busy batch');
    assert.equal(context.processed.has(items[1].anchor), requireSingleDomain === false);
    assert.equal(context.processed.has(items[0].anchor), true,
        'Measured observations need no new inspection during presentation rebuilding');
    assert.equal(fixture.scheduledScans.length, 1, 'Unfinished inspections do not defer presentation rebuilding');
    assert.equal(applied.length, 1, 'Replace old and new presentation rules in one application');
    assert.match(applied[0].join(''), /#excluded/);
}
console.log('Passed: single-domain presentation preserves intrinsic decisions and restores retained observations');
for ( const refresh of [ false, true ] ) {
    const f = resultPresentationFixture({ names: [ 'personal', 'ordinary' ], requireSingleDomain: true });
    const personal = { verdict: 'candidate', cached: true, shopping_signals: false,
        personal_category: { name: 'My pages', enabled: true } };
    f.context.recorded.set(f.items[0].url, personal);
    f.context.recorded.set(f.items[1].url, { verdict: 'candidate', cached: true, shopping_signals: false });
    if ( refresh ) { await f.refreshCharacteristic(); }
    const scanning = f.scan();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.replies.length, 1);
    assert.deepEqual(Array.from(f.replies[0].request.items, item => item.id), [ 'ordinary' ],
        'Only ordinary candidates lacking single-domain are remeasured');
    assert.equal(f.context.recorded.get(f.items[0].url), personal);
    assert.equal(f.context.processed.has(f.items[0].anchor), true);
    assert.equal(f.context.selectorReasons.has('#personal'), false);
    assert.equal(f.items[0].heading.querySelector(statusSelector), null);
    f.replies[0].resolve([ { id: 'ordinary', verdict: 'candidate', single_domain: true } ]);
    await scanning;
}
console.log('Passed: scan and characteristic refresh never remeasure personally shown candidates for missing single-domain');
for ( const initiallyRequired of [ false, true ] ) {
    for ( const replyMode of [ 'progress', 'final' ] ) {
        const fixture = resultPresentationFixture({
            requireSingleDomain: initiallyRequired, names: [ 'match', 'nonmatch', 'unknown' ],
        });
        const { context, items, styles, replies, onMessage } = fixture;
        const flush = async () => {
            await new Promise(resolve => setTimeout(resolve, 0));
            await context.stylesheetOperation;
        };
        const settings = requireSingleDomain => onMessage({
            what: 'quereeSettingsChanged', enabled: true, requireSingleDomain,
        });
        const assertHidden = expected => {
            for ( const item of items ) {
                assert.equal(context.selectorReasons.has(`#${item.id}`), expected.includes(item.id),
                    `${initiallyRequired}/${replyMode}: ${item.id} tracked hiding selector`);
                assert.equal([...styles].some(css => css.includes(`#${item.id}`)), expected.includes(item.id),
                    `${initiallyRequired}/${replyMode}: ${item.id} native hiding CSS`);
            }
        };
        const scanning = fixture.scan();
        await flush();
        assert.equal(replies.length, 1);
        assert.equal(context.running, true, 'Inspection is deliberately still pending');
        assertHidden(initiallyRequired ? items.map(item => item.id) : []);
        if ( initiallyRequired === false ) {
            settings(true);
            await flush();
        }
        assertHidden(items.map(item => item.id));
        assert.equal(context.recorded.size, 0, 'Provisional hiding is not an intrinsic/cache decision');
        assert.deepEqual(Array.from(replies[0].request.items, item => item.id), items.map(item => item.id));
        assert.ok(replies[0].request.items.every(item => item.verdict === undefined && item.cached === undefined));

        settings(false);
        await flush();
        assertHidden([]);
        assert.equal(context.recorded.size, 0, 'Turning off pending presentation creates no exclusions');
        await fixture.scan();
        assert.equal(replies.length, 1, 'Turning off during a batch starts no new inspection');
        settings(true);
        await flush();
        assertHidden(items.map(item => item.id));

        const decisions = [
            { id: 'match', verdict: 'candidate', single_domain: true, shopping_signals: false },
            { id: 'nonmatch', verdict: 'candidate', single_domain: false, shopping_signals: false },
            { id: 'unknown', verdict: 'candidate', shopping_signals: false },
        ];
        const unchanged = JSON.stringify(decisions);
        if ( replyMode === 'progress' ) {
            for ( const [ index, decision ] of decisions.entries() ) {
                onMessage({ what: 'quereeInspectionProgress', batchId: Array.from(context.activeBatches).at(-1),
                    completed: index + 1, total: decisions.length, decision });
                await flush();
                assertHidden([ 'nonmatch', 'unknown' ]);
            }
            assert.equal(context.running, true, 'Confirmed matches reveal before the batch finishes');
        }
        replies[0].resolve(decisions);
        await scanning;
        await flush();
        assertHidden([ 'nonmatch', 'unknown' ]);
        assert.equal(items[0].heading.querySelector(statusSelector), null, 'Confirmation removes the provisional label');
        assert.equal(items[1].heading.querySelector(statusSelector).textContent, 'Not single-domain');
        assert.equal(items[2].heading.querySelector(statusSelector).textContent, 'Single-domain unconfirmed');

        settings(false);
        await flush();
        await fixture.scan();
        assertHidden([]);
        assert.equal(styles.size, 0);
        assert.equal(context.exclusionStylesheets.size, 0);
        assert.ok(items.every(item => item.heading.querySelector(statusSelector) === null));
        assert.equal(replies.length, 1, 'Turning off restores results without reinspection');
        assert.equal(context.recorded.size, decisions.length);
        for ( const [ index, item ] of items.entries() ) {
            assert.deepEqual({ ...context.recorded.get(item.url), cached: undefined },
                { ...decisions[index], cached: undefined }, 'Retain the intrinsic observation while marking missing checks');
        }
        assert.equal(JSON.stringify(decisions), unchanged, 'Presentation never mutates cached/intrinsic observations');
    }
}
console.log('Passed: delayed inspections hide pending results, reveal only confirmed matches and restore without reinspection');
{
    const fixture = resultPresentationFixture({ requireSingleDomain: true, names: [ 'pending' ] });
    const { context, styles, replies, onMessage } = fixture;
    context.excludedVisible = true;
    const scanning = fixture.scan();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match([...styles].join(''), /Single-domain unconfirmed/);
    const decision = { id: 'pending', verdict: 'exclude', reasons: [ { kind: 'advertising' } ] };
    onMessage({ what: 'quereeInspectionProgress', batchId: Array.from(context.activeBatches).at(-1),
        completed: 1, total: 1, decision });
    await context.stylesheetOperation;
    assert.match([...styles].join(''), /content: "Advertising"/);
    assert.doesNotMatch([...styles].join(''), /Single-domain unconfirmed/);
    replies[0].resolve([ decision ]);
    await scanning;
    onMessage({ what: 'quereeSettingsChanged', enabled: false, requireSingleDomain: true });
    await context.stylesheetOperation;
    assert.equal(styles.size, 0);
    assert.equal(context.selectorReasons.size, 0);
}
console.log('Passed: a provisional marker becomes the completed exclusion reason and is cleaned up');
{
    const fixture = resultPresentationFixture({ requireSingleDomain: true, names: [ 'first' ] });
    const { context, items, styles, replies } = fixture;
    const flush = async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
        await context.stylesheetOperation;
    };
    const firstScan = fixture.scan();
    await flush();
    const later = {
        id: 'later', url: 'https://personal.example/later', sourceHref: 'https://personal.example/later',
        anchor: { id: 'later', href: 'https://personal.example/later' },
        heading: resultElement('h3'),
    };
    items.push(later);
    const laterScan = fixture.scan();
    await flush();
    assert.equal(context.selectorReasons.has('#later'), true,
        'A result inserted during another inspection is hidden immediately');
    assert.equal(later.heading.querySelector(statusSelector).textContent, 'Single-domain unconfirmed');
    assert.equal(context.processed.has(later.anchor), true, 'The later result enters the existing queue immediately');
    assert.equal(context.recorded.size, 0);
    assert.equal(replies.length, 2, 'The new batch joins without waiting for or replacing the earlier one');
    let labelWrites = 0;
    const label = later.heading.querySelector(statusSelector);
    let text = label.textContent;
    Object.defineProperty(label, 'textContent', {
        get: () => text, set: value => { text = value; labelWrites += 1; },
    });
    await fixture.scan();
    assert.equal(labelWrites, 0, 'Unchanged pending labels must not cause repeated DOM-mutation rescans');
    replies[0].resolve([{ id: 'first', verdict: 'candidate', single_domain: true }]);
    await firstScan;
    await flush();
    assert.equal(context.running, true, 'Finishing the older batch does not stop the new one');
    assert.equal(replies.length, 2);
    assert.deepEqual(Array.from(replies[1].request.items, item => item.id), [ 'later' ]);
    fixture.onMessage({ what: 'quereeSettingsChanged', enabled: true, requireSingleDomain: false });
    await flush();
    assert.equal(styles.size, 0, 'Turning off restores the deferred result while its inspection continues');
    fixture.onMessage({ what: 'quereeSettingsChanged', enabled: true, requireSingleDomain: true });
    await flush();
    assert.equal(context.selectorReasons.has('#later'), true);
    replies[1].resolve([{ id: 'later', verdict: 'candidate', single_domain: true }]);
    await laterScan;
    await flush();
    assert.equal(styles.size, 0, 'Confirmation restores the dynamically inserted result');
    assert.equal(later.heading.querySelector(statusSelector), null);
    assert.equal(replies.length, 2);
}
console.log('Passed: results inserted during a batch hide immediately without replacing inspection or mutating unchanged labels');
for ( const refreshAlreadyRunning of [ false, true ] ) {
    assert.equal(presentationLimits.maxExcludedSelectors, 256, 'Exercise the real production selector limit');
    const fixture = resultPresentationFixture({
        oldRules: true,
        // Batching handles 257 ordinary selectors; one oversized selector must still reject atomically.
        names: Array.from({ length: presentationLimits.maxExcludedSelectors + 1 }, (_, i) =>
            `nonmatch-${i}${i === presentationLimits.maxExcludedSelectors
                ? 'x'.repeat(presentationLimits.maxExclusionCSSLength / 2) : ''}`),
    });
    const { context, items, styles, applied, onMessage } = fixture;
    for ( const item of items ) {
        context.recorded.set(item.url, { verdict: 'candidate', single_domain: false });
    }
    let refreshing;
    if ( refreshAlreadyRunning ) {
        context.requireSingleDomain = true;
        refreshing = fixture.refreshCharacteristic();
        assert.equal(context.hidingUnavailable, true);
        assert.deepEqual([...context.selectorReasons.keys()], [ '#old' ], 'Rejected replacement keeps tracked selectors synchronously');
        assert.deepEqual([...context.exclusionStylesheets], [ [ 'old hide', 'old mark' ] ],
            'Stop must still be able to find old CSS before refresh resumes');
        assert.equal(applied.length, 0, 'An oversized replacement never queues CSS changes');
    }
    onMessage({ what: 'quereeSettingsChanged', enabled: false, requireSingleDomain: true });
    assert.equal(context.enabled, false);
    assert.equal(context.selectorReasons.size, 0);
    assert.equal(context.exclusionStylesheets.size, 0);
    await refreshing;
    await new Promise(resolve => setTimeout(resolve, 0));
    await context.stylesheetOperation;
    assert.equal(styles.size, 0, 'Disabling removes old hiding CSS even at the replacement limit');
    assert.equal(context.selectorReasons.size, 0, 'Refresh must not resurrect stopped selectors');
    assert.equal(context.exclusionStylesheets.size, 0, 'Refresh must not resurrect stopped stylesheet maps');
    assert.equal(context.recorded.size, 0);
    assert.equal(context.activeItems.size, 0);
    assert.equal(context.stylesheetOperationsPending, 0);
    assert.equal(fixture.replies.length, 0, 'A combined disable message never starts an inspection');
    assert.ok(items.every(item => item.heading.querySelector(statusSelector) === null));
    assert.deepEqual(applied, [ [] ], 'Only the stop cleanup reaches the native stylesheet API');
}
console.log('Passed: combined disable and in-flight rejected refresh cannot resurrect CSS or tracked maps at 257 results');
{
    const fixture = resultPresentationFixture({ oldRules: true });
    let release;
    fixture.context.stylesheetOperation = new Promise(resolve => { release = resolve; });
    const pending = fixture.addExclusionSelectors([ [ '#replacement', 'Advertising' ] ], true);
    fixture.context.shuttingDown = true;
    fixture.stop();
    assert.equal(fixture.styles.size, 0, 'Shutdown removes applied CSS even if its replacement was still queued');
    fixture.context.vAPI = undefined;
    release();
    await pending;
    assert.equal(fixture.styles.size, 0, 'Queued work cannot touch a destroyed native API or restore hiding');
}
console.log('Passed: shutdown clears retired applied styles and prevents queued replacement CSS');
for ( const single_domain of [ false, true ] ) {
    let onMessage;
    const refreshes = [];
    const item = { id: 'measured', url: 'https://personal.example/' };
    const context = {
        running: true, requireSingleDomain: true, activeBatches: new Set(['measurement']), shuttingDown: false,
        excludeAdvertisingSignals: true, excludeCrossSiteTracking: true, excludeShoppingSignals: true,
        mobileInspection: { mobile: false, ready: false },
        activeItems: new Map([[item.id, item]]),
        recorded: new Map([[item.url, { verdict: 'candidate', cached: true }]]),
        refreshCharacteristic: remeasure => { refreshes.push(remeasure); },
        updateProgress() {}, maybeLoadMore() {}, apply() {}, addExclusionSelectors: async () => {},
        browser: { runtime: { onMessage: { addListener: listener => { onMessage = listener; } } } },
    };
    vm.runInNewContext(source.slice(source.indexOf('    function reasonApplies('),
        source.indexOf('    function hiddenBySettings(')) + source.slice(source.indexOf('    function rememberDecision('),
        source.indexOf('    async function refreshCharacteristic(')) +
        source.slice(source.indexOf('    function onMessage('),
            source.indexOf("    window.addEventListener('pageshow', onPageShow);")) +
        'browser.runtime.onMessage.addListener(onMessage);', context);
    onMessage({ what: 'quereeInspectionProgress', batchId: 'measurement', completed: 1, total: 1,
        decision: { id: item.id, verdict: 'candidate', single_domain },
    });
    assert.deepEqual(refreshes, [ false ], 'New measurement replaces the old unconfirmed hiding/label');
    assert.equal(context.recorded.get(item.url).single_domain, single_domain);
}
const inspectionBatch = controllerSection('export async function inspectResults(', 'export function isInspectionTab(');
assert.match(inspectionBatch, /source\.generation !== sourceGeneration/);
assert.match(inspectionBatch, /policyGeneration !== expectedPolicyGeneration/);
assert.match(
    source,
    /\$\{progressCompleted\} of \$\{progressTotal\} results inspected/
);
assert.match(source, /progressDots = \(progressDots \+ 1\) % 4/);
assert.match(controller, /what: 'quereeInspectionProgress'/);
assert.match(controller, /decision: \{\s*id: result\.id/);
console.log('Passed: each settled decision reports bounded batch progress');
for ( const restoring of [ false, true ] ) {
    const items = [
        { id: 'done', url: 'https://personal.example/done', anchor: {} },
        { id: 'pending', url: 'https://personal.example/pending', anchor: {} },
    ];
    const processed = new WeakMap();
    const recorded = new Map();
    const requests = [];
    let settle;
    const scanCode = source.slice(
        source.indexOf('    function needsCharacteristicMeasurement('),
        source.indexOf('    async function refreshCharacteristic(')
    ) + source.slice(
        source.indexOf('    async function scan('),
        source.indexOf('    function stop(')
    );
    const scanContext = {
        settingsGeneration: 0,
        location: { href: 'https://www.google.com/search?q=fixture' },
        enabled: true, requireSingleDomain: false, excludeAdvertisingSignals: true, excludeCrossSiteTracking: true, excludeShoppingSignals: true, generation: 1, restoreGeneration: 0, batchSequence: 0, running: false, rescan: false, shuttingDown: false,
        emptyTimer: undefined, emptyStartedAt: undefined, emptyStored: false,
        activeBatches: new Set(), scanTimer: undefined, panel: undefined,
        mobileInspection: {mobile:false},
        activeItems: new Map(), recorded, processed,
        rememberDecision: (item, decision) => { recorded.set(item.url, decision); return false; },
        isGoogleImages: () => false,
        collect: () => items.filter(item => {
            if ( processed.has(item.anchor) ) { return false; }
            processed.set(item.anchor, item.anchor.href);
            return true;
        }),
        ensurePanel() {}, startProgress() {}, stopProgress() {}, updateStatus() {}, holdStatusSummary() {},
        maybeLoadMore() {}, renderPagination() {},
        addExclusionSelectors: async () => {},
        apply() {}, clearTimeout() {}, setTimeout() {},
        vAPI: { messaging: { send: (_channel, message) => {
            requests.push(message);
            return new Promise(resolve => { settle = resolve; });
        } } },
    };
    const scan = vm.runInNewContext(`${scanCode}; scan`, scanContext);
    const interrupted = scan();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(requests[0].sourceURL, scanContext.location.href);
    recorded.set(items[0].url, { id: 'done', verdict: 'candidate' });
    if ( restoring ) { scanContext.restoreGeneration += 1; }
    settle(undefined); // uBO resolves pending calls this way when a port is lost.
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(requests.length, 2, 'A lost connection retries once without needing page restoration');
    assert.equal(requests[1], requests[0], 'Reconnect to the original batch rather than create another');
    if ( restoring ) {
        settle(items.map(item => ({ id: item.id, verdict: 'candidate' })));
        await interrupted;
        assert.equal(recorded.size, 2);
        continue;
    }
    settle(undefined);
    await interrupted;
    assert.equal(requests.length, 2, 'A persistent failure must not become a retry loop');
    assert.equal(processed.has(items[0].anchor), true);
    assert.equal(processed.has(items[1].anchor), true);
    assert.equal(recorded.get(items[0].url).verdict, 'candidate');
    assert.equal(recorded.get(items[1].url).verdict, 'unresolved',
        'A lost reply must not leave an unfinished result looking accepted');
    assert.equal(scanContext.running, false);
    assert.equal(recorded.size, 2);
}
console.log('Passed: a lost reply preserves completed progress and marks unfinished results unresolved');
for ( const phase of [ 'preparation', 'reply', 'presentation' ] ) {
    const items = [ { id: 'first', url: 'https://personal.example/first', anchor: {} } ];
    const replies = [];
    let releaseStylesheet;
    let stylesheetCalls = 0;
    let progressRunning = false;
    let onMessage;
    let progressUpdates = 0;
    const scanContext = {
        settingsGeneration: 0,
        enabled: true, requireSingleDomain: false, excludeAdvertisingSignals: true, excludeCrossSiteTracking: true, excludeShoppingSignals: true, generation: 1, restoreGeneration: 0, batchSequence: 0, running: false, rescan: false, shuttingDown: false,
        emptyTimer: undefined, emptyStartedAt: undefined, emptyStored: false,
        activeBatches: new Set(), scanTimer: undefined, summaryTimer: undefined,
        location: { href: 'https://www.google.com/search?q=fixture' },
        panel: undefined, status: undefined, style: undefined, toggle: undefined,
        observer: undefined, excludedVisible: false, hidingUnavailable: false,
        paginationTarget: 10, paginationAuto: true, paginationComplete: false, paginationLoading: false,
        paginationNext: undefined, paginationCancel: undefined, paginationButton: undefined,
        paginationSource: undefined,
        maybeLoadMore() {}, renderPagination() {},
        mobileInspection: {mobile:false},
        activeItems: new Map(), recorded: new Map(), processed: new WeakMap(),
        rememberDecision: (item, decision) => { scanContext.recorded.set(item.url, decision); return false; },
        selectorReasons: new Map(), exclusionStylesheets: new Map(), appliedStylesheets: new Set(),
        isGoogleImages: () => false,
        collect: () => items.filter(item => {
            if ( scanContext.processed.has(item.anchor) ) { return false; }
            scanContext.processed.set(item.anchor, item.anchor.href);
            return true;
        }),
        ensurePanel() {}, updateStatus() {}, holdStatusSummary() {}, apply() {}, changeStylesheets() {},
        startProgress: () => { progressRunning = true; },
        stopProgress: () => { progressRunning = false; },
        updateProgress: () => { progressUpdates += 1; },
        addExclusionSelectors: async () => {
            stylesheetCalls += 1;
            if (
                (phase === 'preparation' && stylesheetCalls === 1) ||
                (phase === 'presentation' && stylesheetCalls === 2)
            ) {
                await new Promise(resolve => { releaseStylesheet = resolve; });
            }
        },
        clearTimeout() {}, setTimeout() {}, Date,
        document: { documentElement: {}, querySelectorAll: () => [] },
        MutationObserver: class { observe() {} disconnect() {} },
        browser: { runtime: { onMessage: { addListener: listener => { onMessage = listener; } } } },
        vAPI: { messaging: { send: (_channel, request) => new Promise(resolve => {
            replies.push({ request, resolve });
        }) } },
    };
    const lifecycle = vm.runInNewContext(
        source.slice(source.indexOf('    function needsCharacteristicMeasurement('),
            source.indexOf('    async function refreshCharacteristic(')) +
        source.slice(source.indexOf('    async function scan('),
            source.indexOf('    function syncSearchMode(')) +
        source.slice(source.indexOf('    function onMessage('),
            source.indexOf("    window.addEventListener('pageshow', onPageShow);")) +
        'browser.runtime.onMessage.addListener(onMessage);' +
        ';({ scan, stop, start })', scanContext
    );
    const previousScan = lifecycle.scan();
    await new Promise(resolve => setTimeout(resolve, 0));
    if ( phase === 'presentation' ) {
        replies[0].resolve([ { id: 'first', verdict: 'candidate' } ]);
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    lifecycle.stop();
    lifecycle.start();
    await new Promise(resolve => setTimeout(resolve, 0));
    const current = replies.at(-1);
    const currentBatchId = Array.from(scanContext.activeBatches).at(-1);
    if ( phase === 'reply' ) {
        replies[0].resolve([ { id: 'first', verdict: 'unresolved' } ]);
    } else {
        releaseStylesheet();
    }
    await previousScan;
    assert.equal(scanContext.running, true, `${phase}: replacement still owns the scan`);
    assert.equal(Array.from(scanContext.activeBatches).at(-1), currentBatchId, `${phase}: replacement keeps its batch ID`);
    assert.equal(scanContext.activeItems.size, 1, `${phase}: replacement keeps its active items`);
    assert.equal(progressRunning, true, `${phase}: replacement progress still runs`);
    onMessage({
        what: 'quereeInspectionProgress', batchId: currentBatchId, completed: 1, total: 1,
        decision: { id: 'first', verdict: 'candidate' },
    });
    assert.equal(progressUpdates, 1, `${phase}: replacement accepts progress messages`);
    assert.equal(scanContext.recorded.get(items[0].url).verdict, 'candidate');
    items.push({ id: 'second', url: 'https://personal.example/second', anchor: {} });
    const sent = replies.length;
    const appended = lifecycle.scan();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(replies.length, sent + 1, `${phase}: new results join without replacing live work`);
    assert.equal(scanContext.activeBatches.size, 2);
    const appendedBatch = replies.at(-1);
    current.resolve([ { id: 'first', verdict: 'candidate' } ]);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(scanContext.running, true, `${phase}: the appended batch still owns progress`);
    assert.equal(scanContext.activeItems.size, 1);
    appendedBatch.resolve([ { id: 'second', verdict: 'candidate' } ]);
    await appended;
    assert.equal(scanContext.running, false);
    assert.equal(scanContext.activeItems.size, 0);
    assert.equal(progressRunning, false);
}
console.log('Passed: stale scan completions preserve the replacement across every stylesheet/message await');
{
    const sourceStates = new Map();
    const sourceJobs = new Map();
    const cancelled = [];
    let started = 0;
    let settle;
    const lifecycle = vm.runInNewContext(
        controller.slice(controller.indexOf('function searchPageURL('),
            controller.indexOf('async function inspectBatch('))
            .replace('export async function', 'async function') +
        controller.slice(controller.indexOf('function cancelSource('),
            controller.indexOf('function resetProfile(')) +
        ';({ inspectResults, updateSourceLocation, cancelSource })', {
            sourceAdmissions: new Map(), sourceStates, sourceJobs, maxAwaySearches: 2, policyGeneration: 0,
            profileRefresh: undefined, pendingProfileUpdate: undefined,
            getMalwareGeneration: () => 0,
            inspectionTabs: new Map(), µb: { isReadyPromise: Promise.resolve() },
            mobileTabs: { android: false, initialize: async () => {} },
            setInspectionHistoryEnabled() {},
            personalDisplayRecord,
            settings: () => ({ personalCategories: [], enabled: true }), recoverInspectionTabs() {},
            browser: { tabs: {
                get: async id => ({ id, url: searchURL }),
                sendMessage: async () => {},
            } },
            inspectBatch: () => {
                started += 1;
                return new Promise(resolve => { settle = resolve; });
            },
            cancelJobs: (jobs, kind) => cancelled.push([ ...jobs, kind ]),
            clearTimeout() {}, URL, Date,
        }
    );
    const searchURL = 'https://www.google.com/search?q=birds';
    const first = lifecycle.inspectResults(1, [], 'batch-1');
    await new Promise(resolve => setTimeout(resolve, 0));
    const original = sourceStates.get(1);
    sourceJobs.set(1, new Set([ 'job-1' ]));
    lifecycle.updateSourceLocation(1, 'https://personal.example/');
    assert.notEqual(original.awayAt, undefined);
    const reattached = lifecycle.inspectResults(1, [], 'batch-1');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(started, 1, 'Back must not create a new batch or reset its deadline');
    lifecycle.updateSourceLocation(1, searchURL + '&sei=navigation-token');
    assert.equal(original.awayAt, undefined);
    assert.equal(original.generation, 0, 'Back must not cancel existing jobs');
    settle([ { verdict: 'unresolved', reasons: [ { kind: 'incomplete_load' } ] } ]);
    const results = await first;
    assert.equal(await reattached, results);
    assert.equal(await lifecycle.inspectResults(1, [], 'batch-1'), results,
        'Results completed while away, including timeouts, must survive Back');
    sourceJobs.delete(1);
    for ( const id of [ 2, 3, 4 ] ) {
        sourceStates.set(id, { generation: 0, pageURL: searchURL, pending: true });
        sourceJobs.set(id, new Set([ `job-${id}` ]));
    }
    for ( const id of [ 1, 2, 3 ] ) {
        lifecycle.updateSourceLocation(id, 'https://personal.example/');
    }
    assert.equal(cancelled.length, 0, 'Completed searches do not consume away slots');
    lifecycle.updateSourceLocation(4, 'https://personal.example/');
    assert.equal(sourceStates.has(2), false, 'A third pending away search evicts the oldest');
    assert.equal(sourceStates.has(1), true, 'Completed results remain available for Back');
    assert.deepEqual(cancelled[0], [ 'job-2', 'away_search_limit' ]);
    lifecycle.updateSourceLocation(3, 'https://www.google.com/search?q=other');
    assert.equal(sourceStates.has(3), false, 'A different search replaces prior work');
    lifecycle.cancelSource(4);
    assert.equal(sourceStates.has(4), false, 'Closing a source tab releases its batch');
}
console.log('Passed: bounded away searches retain results and original deadlines');
assert.ok(eligibilityExceptions.includes('@@||static.ads-twitter.com/uwt.js'));
console.log('Passed: conversion-only X tag is a native uBO eligibility exception');
const advertisingReasonCode=controller.slice(
    controller.indexOf('function advertisingReason('),
    controller.indexOf('export function filterInspectionRequest(')
);
const advertisingReason=vm.runInNewContext(
    advertisingReasonCode+';advertisingReason',
    { profileId: 'queree-ads' }
);
assert.deepEqual(
    JSON.parse(JSON.stringify(advertisingReason(
        { url: 'https://securepubads.g.doubleclick.net/gampad/ads', type: 'xmlhttprequest' },
        { raw: '||g.doubleclick.net^' }
    ))),
    {
        kind: 'advertising',
        list: 'queree-ads',
        rule: '||g.doubleclick.net^',
        request_url: 'https://securepubads.g.doubleclick.net/gampad/ads',
        request_type: 'xmlhttprequest',
    }
);
console.log('Passed: advertising evidence retains the matched request URL and type');
const keyCode=controller.slice(controller.indexOf('function searchPageURL('),controller.indexOf('export async function inspectResults('));
const normalize=vm.runInNewContext(keyCode+';searchPageURL',{URL});
const a='https://www.google.com/search?q=faucet';
assert.equal(normalize(a),normalize(a+'&sei=late-navigation-token'));
assert.notEqual(normalize(a),normalize(a+'&start=10'));
assert.notEqual(normalize(a),normalize('https://www.google.com/search?q=pond'));
const bing='https://www.bing.com/search?q=birdwatching';
assert.equal(normalize(bing),normalize(bing+'&form=QBLH&rdr=1&rdrig=opaque'));
assert.notEqual(normalize(bing),normalize(bing+'&first=11'));
console.log('Passed: result URLs and volatile Google/Bing navigation tokens normalize correctly');

const url = 'https://example.net/article';
let captureTabURL = url;
let captureCalls = 0;
let duringTabLookup = () => {};
const capturedDocument = {
    url,
    title: 'Personal article',
    body: 'Article text.',
    extraction_version: 'rendered-text-v2',
    truncated: false,
    indexing_directives: { complete: true, meta_robots: [], x_robots_tag: [] },
};
const candidateRecordCode = controller.slice(
    controller.indexOf('async function candidateRecord('),
    controller.indexOf('function detachFromSource(')
);
const challengePatterns = vm.runInNewContext(controller.slice(
    controller.indexOf('const challengeTitle'),
    controller.indexOf('const shoppingDomainLists')
) + ';({ challengeTitle, challengeURL })');
const captureCandidate = vm.runInNewContext('(' + candidateRecordCode + ')', {
    ...challengePatterns,
    malwareDecision: () => undefined, recheckMalwareResult: result => result,
    browser: { tabs: {
        executeScript: async () => {
            captureCalls += 1;
            return [ structuredClone(capturedDocument) ];
        },
        get: async () => {
            duringTabLookup();
            return { url: captureTabURL };
        },
    } },
    record: (_job, verdict, reasons = []) => ({ verdict, reasons }),
    domainFromHostname,
    inspectionPollInterval: 3000,
    scheduleCompletion() {},
    recoverBeforeFailure: () => assert.fail('Clean capture fixture unexpectedly entered recovery'),
    URL,
    withoutTextDirective,
});
const captureJob = {
    captureDocument: false,
    destinationURL: url,
    finished: false,
    loaded: true,
    navigationId: 1,
    requestHosts: new Set([ new URL(url).hostname ]),
    requests: new Set(),
    rootHeaders: {},
    tabId: 1,
    xRobotsTags: [ 'noindex' ],
};
let captureResult = await captureCandidate(captureJob, 1, url);
assert.equal(captureCalls, 0);
assert.equal(captureResult.document, undefined);
captureJob.captureDocument = true;
captureResult = await captureCandidate(captureJob, 1, url);
assert.equal(captureCalls, 1);
assert.equal(captureResult.document.title, 'Personal article');
assert.deepEqual(
    Array.from(captureResult.document.indexing_directives.x_robots_tag),
    [ 'noindex' ]
);
assert.equal(captureResult.document.indexing_directives.complete, true);
const beforeCorporateCapture = captureCalls;
for ( const sourceCategories of [ [ 'commercial_corporate' ], [ 'government_education' ], [] ] ) {
    const result = await captureCandidate({ ...captureJob, sourceCategories }, 1, url);
    assert.equal(result.verdict, 'candidate', 'Index admission must not hide external company results');
    assert.equal(result.document !== undefined, !sourceCategories.includes('commercial_corporate'));
}
assert.equal(captureCalls, beforeCorporateCapture + 2, 'Company pages must not run document capture');
captureJob.xRobotsTags = Array(9).fill('index');
captureResult = await captureCandidate(captureJob, 1, url);
assert.equal(captureResult.document.indexing_directives.complete, false);
captureTabURL = 'https://other.example/article';
captureJob.captureDocument = false;
assert.deepEqual(
    JSON.parse(JSON.stringify(await captureCandidate(captureJob, 1, url))),
    {
        verdict: 'unresolved',
        reasons: [ { kind: 'stale_observation' } ],
    }
);
console.log('Passed: worker capture is opt-in and bound to the inspected document');

captureTabURL = url;
publicSuffixList.parse('net\norg\ncom\nio\ngithub.io\n', value => value);
for ( const [ finalURL, hosts, expected ] of [
    [ url, [ 'example.net', 'images.example.net' ], true ],
    [ url, [ 'example.net', 'fonts.example.org' ], false ],
    [ url, [], undefined ],
    [ 'https://alice.github.io/page', [ 'alice.github.io' ], true ],
    [ 'https://alice.github.io/page', [ 'alice.github.io', 'bob.github.io' ], false ],
    ...communityDomains.flatMap(host => [
        [ `https://${host}/article`, [ host, `images.${host}` ], true ],
        [ `https://${host}/article`, [ host, 'cdn.example.org' ], false ],
        [ `https://${host}/article`, [], undefined ],
    ]),
] ) {
    captureTabURL = finalURL;
    const result = await captureCandidate({
        ...captureJob, captureDocument: false,
        destinationURL: finalURL, requestHosts: new Set(hosts),
    }, 1, finalURL);
    assert.equal(result.verdict, 'candidate');
    assert.equal(result.single_domain, expected, `${finalURL}: ${hosts}`);
    assert.equal(Object.hasOwn(result, 'single_domain'), expected !== undefined);
}
for ( const targetURL of [ url, 'https://ordinary.example/article' ] ) {
    captureTabURL = targetURL;
    const loadingJob = {
        ...captureJob, destinationURL: targetURL,
        requests: new Set(), contentReadyAt: Date.now() - 20000,
    };
    duringTabLookup = () => { loadingJob.requests.add('late-script'); };
    assert.equal((await captureCandidate(loadingJob, 1, targetURL)).verdict, 'candidate',
        'Background activity during final checks does not restart observation');
}
captureTabURL = url;
duringTabLookup = () => {};
for ( const invalidate of [
    job => { job.navigationId += 1; job.loaded = false; },
    job => { job.finished = true; },
] ) {
    const job = { ...captureJob, finished: false, loaded: true, navigationId: 1 };
    duringTabLookup = () => invalidate(job);
    assert.equal(await captureCandidate(job, 1, url), undefined,
        'A same-address reload or completion during tab lookup invalidates old evidence');
}
duringTabLookup = () => {};

const staleCommerceDecision = vm.runInNewContext('(' + controller.slice(
    controller.indexOf('async function commerceDecision('),
    controller.indexOf('function selectCommerceDetection(')
) + ')', {
    browser: { tabs: { executeScript: async (_tabId, details) =>
        details.file.endsWith('commerce-probe.js')
            ? [ { url: 'https://other.example/article' } ]
            : []
    } },
});
assert.deepEqual(
    JSON.parse(JSON.stringify(await staleCommerceDecision({
        finished: false,
        loaded: true,
        navigationId: 1,
        tabId: 1,
    }, 1, url))),
    { kind: 'stale_observation' }
);
console.log('Passed: stale commerce probes cannot become clean candidates');

const recoveryHelpersCode = controller.slice(
    controller.indexOf('function clearRecovery('),
    controller.indexOf('function finish(')
);
const completionCode = controller.slice(
    controller.indexOf('async function completed('),
    controller.indexOf('async function start(')
);
const committedCode = controller.slice(
    controller.indexOf('browser.webNavigation.onCommitted.addListener('),
    controller.indexOf('browser.webNavigation.onHistoryStateUpdated.addListener(')
);
const destinationHelpersCode = controller.slice(
    controller.indexOf('function resetDestination('),
    controller.indexOf('function cancelAdvertisingRequest(')
);
const firefoxRestrictedHosts = vm.runInNewContext(controller.slice(
    controller.indexOf('const firefoxRestrictedHosts ='),
    controller.indexOf('async function prepareProfile(')
) + ';firefoxRestrictedHosts');

function recoveryClock() {
    let now = 100000;
    let nextId = 0;
    const timers = new Map();
    return {
        timers,
        Date: { now: () => now },
        setTimeout(callback, delay) {
            const id = ++nextId;
            timers.set(id, { callback, at: now + delay });
            return id;
        },
        clearTimeout: id => timers.delete(id),
        async advance(delay) {
            const end = now + delay;
            for (;;) {
                const next = Array.from(timers).filter(([, timer]) => timer.at <= end)
                    .sort((a, b) => a[1].at - b[1].at)[0];
                if ( next === undefined ) { break; }
                const [ id, timer ] = next;
                timers.delete(id);
                now = timer.at;
                await timer.callback();
            }
            now = end;
            await new Promise(resolve => setImmediate(resolve));
        },
    };
}

for ( const failure of [ 'mobile_navigation', 'desktop_navigation', 'desktop_context' ] ) {
    const clock = recoveryClock();
    const results = [];
    const job = { url, finished: false };
    const failNavigation = async () => { throw new Error('Navigation failed'); };
    const start = vm.runInNewContext(startCode + ';start', {
        ...clock, activeJobs: 0, inspectionTimeout: 70000,
        mobileTabs: { android: failure === 'mobile_navigation', acquire: () => 10 },
        inspectionTabs: new Map(),
        createInspectionCookieStore: async () => {
            if ( failure === 'desktop_context' ) { throw new Error('Context failed'); }
            return 'isolated';
        },
        browser: { runtime: { getURL: path => `moz-extension://fixture/${path}` }, tabs: {
            create: async () => ({ id: 10 }), hide: async () => [ 10 ], update: failNavigation,
        } },
        markInspectionTab: async () => {}, beginInspectionHistory: async () => {},
        record: (_job, verdict, reasons) => ({ verdict, reasons }),
        finish: (target, result) => {
            target.finished = true;
            clock.clearTimeout(target.timeout);
            results.push(result);
        },
    });
    await start(job);
    assert.equal(results.length, 1);
    assert.equal(results[0].verdict, 'unresolved');
    assert.equal(results[0].reasons[0].kind, failure === 'desktop_context'
        ? 'inspection_context_failed' : 'navigation_failed', failure);
    assert.equal(clock.timers.size, 0);
}
console.log('Passed: Android and desktop navigation failures are not mislabeled as context failures');

for ( const stalled of [ false, true ] ) {
    const clock = recoveryClock();
    const results = new Map();
    const jobs = [1, 2, 2].map((sourceTabId, id) => ({
        id, sourceTabId, url, started: false, finished: false,
        resolve: result => results.set(id, result),
    }));
    const context = {
        ...clock, pendingJobs: jobs.slice(), activeJobs: 0, dispatchPaused: false, queueTimer: undefined,
        settings: () => ({ personalCategories: [], simultaneousInspections: 1 }),
        mobileTabs: { android: true, size: 1, available: 1, acquire: () => 10 },
        inspectionTabs: new Map(), browser: {
            runtime: { getURL: path => `moz-extension://fixture/${path}` },
            tabs: { update: async () => {} },
        },
        µb: { hiddenSettings: {} },
        clearRecovery() {}, detachFromSource() {}, rememberMalware() {},
        record: (_job, verdict, reasons) => ({ verdict, reasons }),
        finalizeJobResources: job => {
            if ( job.started === false ) { return Promise.resolve(true); }
            return new Promise(resolve => clock.setTimeout(() => {
                if ( stalled === false ) {
                    context.activeJobs -= 1;
                    dispatch();
                }
                resolve(!stalled);
            }, 5000));
        },
    };
    const dispatch = vm.runInNewContext(
        controller.slice(controller.indexOf('const inspectionTimeout'), controller.indexOf('const resourceCleanupTimeout')) +
        controller.slice(controller.indexOf('function finish('), controller.indexOf('function scheduleCompletion(')) +
        controller.slice(controller.indexOf('async function start('), controller.indexOf('function enqueue(')) +
        controller.slice(controller.indexOf('function cancelJobs('), controller.indexOf('function cancelSource(')) +
        ';dispatch', context);
    dispatch();
    await clock.advance(80000);
    if ( stalled ) {
        assert.equal(results.get(1).reasons[0].kind, 'inspection_queue_stalled');
        assert.equal(results.get(2).reasons[0].kind, 'inspection_queue_stalled');
        assert.equal(context.activeJobs, 1, 'A stalled queue never frees an occupied slot');
        assert.equal(jobs[1].started, false);
    } else {
        assert.equal(jobs[1].started, true, 'The second search starts after the first slot is released');
        assert.equal(jobs[1].finished, false, 'Queue time does not shorten an inspection');
        assert.equal(jobs[2].started, false, 'Only one inspection occupies the slot');
        await clock.advance(64999);
        assert.equal(jobs[1].finished, false, 'The second search gets its full 70 seconds');
        await clock.advance(100001);
        assert.equal(results.size, 3);
        assert.ok([...results.values()].every(result => result.reasons[0].kind === 'incomplete_load'));
    }
    assert.equal(clock.timers.size, 0);
}
console.log('Passed: overlapping searches get full per-page deadlines; stalled queues still finish');

for ( const reason of [ { kind: 'http_error', detail: '429', retry_after: '120' },
    { kind: 'challenge_page', challenge_provider: 'cloudflare' }, { kind: 'navigation_failed' } ] ) {
    const job = { recovery: { reason } };
    let expire, result;
    vm.runInNewContext(controller.match(/job\.timeout = setTimeout\(\( \) => \{[\s\S]*?\}, inspectionTimeout\);/)[0], {
        job, inspectionTimeout: 70000, setTimeout: callback => { expire = callback; },
        record: (_job, verdict, reasons) => ({ verdict, reasons }), finish: (_job, recorded) => { result = recorded; },
    });
    expire();
    assert.equal(result.reasons[0], reason, 'The overall deadline preserves a late failure and its diagnostics');
}

function recoveryFixture(targetURL = url, realScroll = false) {
    const clock = recoveryClock();
    const results = [];
    const handlers = {};
    const state = {
        tab: { url: targetURL, status: 'complete', title: 'Personal article' },
        lookup: () => state.tab,
        readiness: () => [ { url: targetURL, complete: true, content: true } ],
        capture: () => [ structuredClone({ ...capturedDocument, url: targetURL }) ],
        commerce: async () => undefined,
        reload: async () => {},
        safety: () => [],
        record: (_job, verdict, reasons = []) => ({ verdict, reasons: [ ...(_job.exclusionReasons || []), ...reasons ] }),
        scripts: [], scrolls: 0, reloads: [], cleanups: 0, detachments: 0, advertising: false,
        tracking: false, settings: {},
        sectionIDs: new Set(),
        sectionCheck: code => [ vm.runInNewContext(code, {
            location: new URL(state.tab.url),
            document: { getElementById: id => state.sectionIDs.has(id) ? { id } : null },
        }) ],
        scroll: () => [ { moved: false } ],
    };
    const target = {
        url: targetURL, tabId: 1, started: true, finished: false, loaded: true,
        navigationId: 1, committedNavigationId: 1, destinationURL: targetURL,
        documentURLs: new Set([ targetURL.split('#', 1)[0] ]),
        sourceCategories: communityDomainFromHostname(new URL(targetURL).hostname)
            ? [ 'community_contribution' ] : [],
        statusCode: 200, requests: new Set(), requestHosts: new Set(),
        contentReadyAt: clock.Date.now() - 20000,
        scrollDone: true, resolve: result => results.push(result),
    };
    const hooks = vm.runInNewContext(
        controller.slice(controller.indexOf('function exclusionRecord('), controller.indexOf('function cachedRecord(')) +
        controller.slice(controller.indexOf('function rememberExclusion('), controller.indexOf('function malwareDecision(')) +
        controller.slice(controller.indexOf('const inspectionPollInterval'), controller.indexOf('const queueStallTimeout')) +
        controller.slice(controller.indexOf('const challengeTitle'), controller.indexOf('const shoppingDomainLists')) +
        controller.slice(controller.indexOf('function clearRecovery('), controller.indexOf('async function advanceScroll(')) +
        controller.slice(controller.indexOf('async function updateInspectionRoute('),
            controller.indexOf('browser.tabs.onUpdated.addListener(')) +
        candidateRecordCode +
        completionCode +
        controller.slice(controller.indexOf('export function filterInspectionRequest('),
            controller.indexOf('function cancelSource(')).replace(/^export /gm, '') +
        controller.slice(controller.indexOf('browser.tabs.onUpdated.addListener('),
            controller.indexOf('browser.webNavigation.onCommitted.addListener(')) + committedCode +
        controller.slice(controller.indexOf('browser.webNavigation.onHistoryStateUpdated.addListener('),
            controller.indexOf('browser.tabs.onRemoved.addListener(')) +
        (realScroll ? controller.slice(controller.indexOf('async function advanceScroll('),
            controller.indexOf('async function commerceDecision(')) : '') +
        ';({ clearRecovery, resumeAfterChallenge, recoverBeforeFailure, candidateRecord, finish, completed, scheduleCompletion, advanceScroll, cancelJobs, filterInspectionRequest, filterInspectionHeaders, inspectionRequestFinished })', {
            ...clock, URL, withoutTextDirective, domainFromHostname, communityDomainFromHostname,
            needsCharacteristicChecks, personalDisplayRecord,
            firefoxRestrictedHosts,
            matchPersonalCategory, settings: () => ({ personalCategories: [], ...state.settings }),
            µb: { hiddenSettings: {} },
            matchMalwareRequest: () => ({ result: 0 }),
            matchMalwareHeaders: () => ({ result: 0 }),
            matchTrackingRequest: () => ({ result: state.tracking ? 1 : 0 }),
            malwareDecision: () => undefined, recheckMalwareResult: result => result,
            rememberMalware() {},
            isLANAddress: () => false,
            browser: {
                tabs: {
                    get: async () => state.lookup(),
                    update: () => assert.fail('Optional checks must not navigate around canceled requests'),
                    reload: async (id, options) => {
                        state.reloads.push({ id, ...options });
                        await state.reload();
                    },
                    executeScript: async (_tabId, details) => {
                        if ( details.code !== undefined ) { return state.sectionCheck(details.code); }
                        state.scripts.push(details.file);
                        if ( details.file.endsWith('inspection-dom.js') ) { return []; }
                        if ( details.file.endsWith('scroll.js') ) { return state.scroll(); }
                        return details.file.endsWith('document-capture.js')
                            ? state.capture() : state.readiness();
                    },
                    onUpdated: { addListener: callback => { handlers.updated = callback; } },
                    sendMessage: async () => {},
                },
                webNavigation: {
                    onCommitted: { addListener: callback => { handlers.committed = callback; } },
                    onHistoryStateUpdated: { addListener: callback => { handlers.history = callback; } },
                },
            },
            inspectionTabs: new Map([[ 1, target ]]), inspectionPopups: new Set(),
            sourceAdmissions: new Map(), sourceStates: new Map(),
            safetyExclusionReasons: (...args) => state.safety(...args),
            record: (...args) => state.record(...args),
            detachFromSource: () => { state.detachments += 1; },
            finalizeJobResources: async () => { state.cleanups += 1; return true; },
            dispatchPaused: false, dispatch: () => {},
            sourceDecision: rawURL => communityDomainFromHostname(new URL(rawURL).hostname)
                ? { categories: [ 'community_contribution' ] } : undefined,
            deterministicExclusionReasons: listedPromotionalURLReasons,
            listedSourceDomainReasons: () => [], shoppingDomainLists: [],
            contextDetails: () => ({}),
            policyCommand: () => ({ result: state.advertising ? 1 : 0 }),
            advertisingReason: fctxt => ({ kind: 'advertising', request_type: fctxt.type }),
            trackingReason: fctxt => ({ kind: 'cross_site_tracking', request_type: fctxt.type }),
            observeHistoryCommit: () => {}, updateSourceLocation: () => {},
            commerceDecision: (...args) => state.commerce(...args),
            advanceScroll: async job => {
                state.scrolls += 1;
                job.scrollDone = true;
                hooks.scheduleCompletion(job);
            },
        }
    );
    const request = (type = 'script') => ({
        tabId: 1, type, url: targetURL, isRootDocument: () => type === 'main_frame',
    });
    const fail = (details = {}) => {
        const event = { tabId: 1, requestId: 'failed-request', type: 'main_frame', statusCode: 403, ...details };
        target.requests.add(event.requestId);
        hooks.inspectionRequestFinished(event);
    };
    return { clock, results, handlers, state, job: target, hooks, request, fail };
}

{
    const h = recoveryFixture();
    h.job.statusCode = undefined;
    h.state.tab.title = 'Just a moment';
    await h.hooks.completed(h.job, 1);
    assert.equal(h.job.recovery.reason.kind, 'challenge_page');
    assert.equal(h.state.reloads.length, 0, 'Recognized verification is not hard-reloaded');
    h.state.tab.title = 'Personal article';
    await h.hooks.completed(h.job, 1);
    assert.equal(h.state.reloads.length, 1, 'A cleared challenge without metadata can use the one native recovery reload');
    assert.equal(h.results.length, 0, 'A pass still needs actual response metadata');
}

for ( const failure of [ false, true ] ) {
    const h = recoveryFixture('https://personal.example/article');
    Object.assign(h.job, { url: h.state.tab.url, id: 'remaining', captureDocument: true });
    h.job.requestHosts.add('personal.example');
    h.state.record = vm.runInNewContext(controller.slice(controller.indexOf('function record('),
        controller.indexOf('function exclusionRecord(')) + ';record', {
        deterministicProfile: {}, now: () => '2026-11-13T00:00:00.000Z',
    });
    h.state.settings = { excludeCrossSiteTracking: false };
    h.state.tracking = true;
    assert.equal(h.hooks.filterInspectionRequest(h.request(), { requestId: 'pixel' }).cancel, true);
    assert.equal(h.results.length, 0);
    h.state.tracking = false;
    h.state.commerce = async () => ({ kind: 'shopping_signals', shopping_signals: false,
        shopping_evidence: { software: false, product_offer: false, purchase: false }, reasons: [] });
    if ( failure ) { h.state.readiness = () => { throw new Error('Synthetic unreadable page'); }; }
    await h.hooks.completed(h.job, 1);
    const [ result ] = h.results;
    assert.equal(result.verdict, 'exclude', 'Finishing display checks cannot grant index eligibility');
    assert.deepEqual(Array.from(result.reasons, reason => reason.kind), [ 'cross_site_tracking' ]);
    assert.equal(result.checks_complete, !failure);
    assert.equal(result.inspection_error?.kind, failure ? 'readiness_unavailable' : undefined);
    assert.equal(result.shopping_signals, failure ? undefined : false);
    assert.equal(result.single_domain, failure ? undefined : true);
    assert.equal(h.state.scripts.some(path => path.endsWith('document-capture.js')), false,
        'Already excluded pages need no accepted-page capture');
}
console.log('Passed: disabled findings survive complete or failed remaining checks without candidate capture or false passes');

for ( const [ redirected, kind ] of [
    [ false, 'tracking' ], [ true, 'tracking' ], [ false, 'advertising' ], [ true, 'advertising' ],
] ) {
    const original = 'https://personal.example/article';
    const blockedURL = redirected ? 'https://blocked.example/destination' : original;
    const h = recoveryFixture(original);
    Object.assign(h.job, { url: original, id: 'blocked-root' });
    h.state.record = vm.runInNewContext(controller.slice(controller.indexOf('function record('),
        controller.indexOf('function exclusionRecord(')) + ';record', {
        deterministicProfile: {}, now: () => '2026-11-13T00:00:00.000Z',
    });
    h.state.settings = kind === 'tracking'
        ? { excludeCrossSiteTracking: false } : { excludeAdvertisingSignals: false };
    h.state.tracking = kind === 'tracking';
    h.state.advertising = kind === 'advertising';
    const reply = h.hooks.filterInspectionRequest({ ...h.request('main_frame'), url: blockedURL },
        { requestId: 'blocked-root' });
    assert.equal(reply.cancel, true, 'Disabling the display filter never uncancels a root request');
    assert.equal(reply.redirectUrl, undefined, 'Do not follow an address canceled by the engine');
    assert.equal(h.job.loaded, false);
    assert.equal(h.results.length, 1, 'A canceled root finishes immediately instead of waiting for a failure timer');
    h.hooks.inspectionRequestFinished({ tabId: 1, requestId: 'blocked-root', type: 'main_frame', error: 'NS_BINDING_ABORTED' });
    await h.clock.advance(10000);
    const [ result ] = h.results;
    assert.equal(result.verdict, 'exclude');
    assert.equal(result.checks_complete, false);
    assert.equal(result.inspection_error, undefined);
    assert.equal(result.url, blockedURL);
    assert.equal(result.final_url, blockedURL);
    assert.equal(result.original_url, original);
    assert.equal(h.state.scripts.length, 0, 'A canceled root cannot acquire checks from the previous document');
}
console.log('Passed: canceled roots and redirect targets remain canceled, excluded and incomplete without another navigation');

for ( const path of [ 'request', 'commit' ] ) {
    const h = recoveryFixture();
    const destination = 'https://support.mozilla.org/questions/fictional';
    h.state.tab.url = destination;
    if ( path === 'request' ) {
        h.hooks.filterInspectionRequest({ ...h.request('main_frame'), url: destination },
            { requestId: 'protected-redirect' });
    } else {
        h.handlers.committed({ tabId: 1, frameId: 0, url: destination });
    }
    await h.clock.advance(0);
    assert.equal(h.results[0].reasons[0].kind, 'firefox_restricted');
    assert.equal(h.results[0].final_url, destination);
    assert.equal(h.state.scripts.length, 0, 'Protected redirects stop before probes and the 90-second timeout');
}

for ( const order of [ 'tabs-first', 'history-first' ] ) {
    for ( const original of [ url, 'https://reddit.com/article' ] ) {
        const { clock, hooks, handlers, job, results, state } = recoveryFixture(original);
        const finalURL = new URL('/normalized?route=kept#chapter', original).href;
        job.rootHeaders = { 'content-type': 'text/html' };
        job.xRobotsTags = [ 'noindex' ];
        job.setCookies = [ 'fixture=1' ];
        job.requestHosts.add(new URL(original).hostname);
        job.captureDocument = true;
        state.readiness = () => [ {
            url: state.tab.url, complete: true, content: true,
        } ];
        state.capture = () => [ structuredClone({ ...capturedDocument, url: state.tab.url }) ];
        const evidence = [ job.rootHeaders, job.xRobotsTags, job.setCookies, job.requestHosts ];
        const previousNavigation = job.navigationId;
        state.tab.url = finalURL;
        const history = () => handlers.history({ tabId: 1, frameId: 0, url: finalURL });
        const tabs = () => handlers.updated(1, { url: finalURL });
        if ( order === 'tabs-first' ) { tabs(); history(); } else { history(); tabs(); }
        if ( communityDomainFromHostname(new URL(original).hostname) ) {
            await clock.advance(0);
            assert.equal(results[0].verdict, 'uninspected', 'A restored Social destination stops without DOM checks');
            continue;
        }
        assert.equal(job.navigationId, previousNavigation + 1);
        assert.equal(job.committedNavigationId, job.navigationId);
        assert.equal(job.destinationURL, finalURL.split('#', 1)[0]);
        assert.equal(job.observedURL, finalURL);
        assert.equal(job.statusCode, 200);
        assert.deepEqual([ job.rootHeaders, job.xRobotsTags, job.setCookies, job.requestHosts ], evidence);
        assert.equal(job.contentReadyAt, undefined);
        // Firefox's loading principal can still name the document's initial URL.
        const resource = {
            tabId: 1, type: 'script', url: new URL('/own.js', original).href,
            isRootDocument: () => false,
        };
        const details = { requestId: 'same-document', frameId: 0, documentUrl: original };
        assert.equal(hooks.filterInspectionRequest(resource, details), undefined);
        assert.equal(job.requests.has(details.requestId), true);
        hooks.inspectionRequestFinished({ tabId: 1, type: 'script', ...details });
        await clock.advance(25999);
        assert.equal(results.length, 0, 'History changes restart settling and the observation window');
        await clock.advance(1);
        assert.equal(results[0].verdict, 'candidate');
        assert.equal(results[0].final_url, finalURL);
        assert.deepEqual(Array.from(results[0].document.indexing_directives.x_robots_tag), [ 'noindex' ]);
    }
}
for ( const phase of [ 'completed', 'candidateRecord' ] ) {
    const { hooks, handlers, job, state, results } = recoveryFixture();
    let release;
    state.lookup = () => new Promise(resolve => { release = resolve; });
    const pending = hooks[phase](job, job.navigationId, state.tab.url);
    assert.equal(typeof release, 'function');
    handlers.history({ tabId: 1, frameId: 0, url: new URL('/new-route', url).href });
    release(state.tab);
    assert.equal(await pending, undefined, `${phase}: history changes invalidate awaited snapshots`);
    assert.equal(results.length, 0);
}
{
    const { clock, handlers, job, results } = recoveryFixture('https://slashdot.org/article');
    handlers.history({ tabId: 1, frameId: 0, url: 'https://slashdot.org/content/sponsored-article/' });
    assert.equal(job.finished, true);
    await clock.advance(0);
    assert.equal(results[0].verdict, 'exclude', 'New history routes still get deterministic URL checks');
    assert.equal(results[0].reasons[0].kind, 'advertising');
}
{
    const { clock, handlers, job, results, fail } = recoveryFixture();
    fail();
    const recovery = job.recovery;
    await clock.advance(4000);
    handlers.history({ tabId: 1, frameId: 0, url: new URL('/new-route', url).href });
    assert.equal(job.recovery, recovery, 'A history change cannot erase a failed request in the same document');
    await clock.advance(16000);
    assert.equal(results[0].reasons[0].kind, 'http_error');
}
console.log('Passed: same-document history changes retain evidence, invalidate snapshots and settle at the final route');

for ( const [ fragment, id, section ] of [
    [ '#pricing', 'pricing', true ],
    [ '#price%20details', 'price details', true ],
    [ '#caf%C3%A9', 'caf\u00e9', true ],
    [ '#Pricing', 'pricing', false ],
    [ '#/inbox', 'pricing', false ],
    [ '#%E0%A4%A', 'pricing', false ],
    [ '#', '', false ],
] ) {
    const h = recoveryFixture();
    const readyAt = h.clock.Date.now() - 5000;
    const requestReason = { kind: 'advertising', request_type: 'script' };
    Object.assign(h.job, { contentReadyAt: readyAt, scrollSteps: 12, earlyCommerce: true,
        shoppingSignals: true, shoppingEvidence: { product_offer: true },
        exclusionReasons: [ requestReason, { kind: 'affiliate_tracked_link' } ] });
    h.state.sectionIDs.add(id);
    h.state.tab.url = url + fragment;
    let checks = 0;
    const check = h.state.sectionCheck;
    h.state.sectionCheck = code => { checks++; return check(code); };
    await Promise.all([
        h.handlers.updated(1, { url: h.state.tab.url }),
        h.handlers.history({ tabId: 1, frameId: 0, url: h.state.tab.url }),
    ]);
    assert.equal(checks, fragment === '#' ? 0 : 1, 'Duplicate URL events share the native check');
    assert.equal(h.job.observedURL, h.state.tab.url);
    assert.equal(h.job.contentReadyAt, section ? readyAt : undefined, fragment);
    assert.equal(h.job.scrollSteps, section ? 12 : 0, fragment);
    assert.equal(h.job.scrollDone, section, fragment);
    assert.equal(h.job.earlyCommerce, section, fragment);
    assert.equal(h.job.shoppingSignals, section ? true : undefined, fragment);
    assert.equal(h.job.exclusionReasons.length, section ? 2 : 1, fragment);
    assert.equal(h.job.exclusionReasons[0], requestReason);
}
{
    const h = recoveryFixture();
    h.job.contentReadyAt = h.clock.Date.now();
    h.job.captureDocument = true;
    h.job.xRobotsTags = [];
    h.state.readiness = () => [ { url: h.state.tab.url, complete: true, content: true } ];
    h.state.capture = () => [ structuredClone({ ...capturedDocument, url: h.state.tab.url }) ];
    h.hooks.scheduleCompletion(h.job, 20000);
    for ( const id of [ 'pricing', 'performance', 'apps', 'explore' ] ) {
        await h.clock.advance(4000);
        h.state.sectionIDs.add(id);
        h.state.tab.url = `${url}#${id}`;
        await h.handlers.history({ tabId: 1, frameId: 0, url: h.state.tab.url });
    }
    await h.clock.advance(3999);
    assert.equal(h.results.length, 0, 'Section changes never shorten observation');
    await h.clock.advance(1);
    assert.equal(h.results[0].verdict, 'candidate', 'Repeated sections do not restart the 20 seconds');
    assert.equal(h.results[0].final_url, `${url}#explore`);
    assert.equal(h.results[0].document.url, `${url}#explore`, 'Capture belongs to the final section URL');
}
{
    const h = recoveryFixture(url, true);
    Object.assign(h.job, { scrollDone: false, scrollSteps: 7, contentReadyAt: undefined });
    let release;
    h.state.scroll = () => new Promise(resolve => { release = resolve; });
    const pending = h.hooks.advanceScroll(h.job, 1);
    h.state.sectionIDs.add('pricing');
    h.state.tab.url = `${url}#pricing`;
    await h.handlers.updated(1, { url: h.state.tab.url });
    release([ { moved: true } ]);
    await pending;
    assert.equal(h.job.scrollSteps, 8, 'The successful move still counts in the same section sample');
    assert.equal(h.job.scrollPending, false);
    h.state.scroll = () => [ { moved: false } ];
    h.state.readiness = () => [ { url: h.state.tab.url, complete: true, content: true } ];
    await h.clock.advance(2999);
    assert.equal(h.job.scrollDone, false, 'The normal confirming scroll poll still applies');
    await h.clock.advance(1);
    assert.equal(h.job.scrollDone, true);
    await h.clock.advance(19999);
    assert.equal(h.results.length, 0);
    await h.clock.advance(1);
    assert.equal(h.results[0].final_url, `${url}#pricing`);
}
for ( const order of [ 'check-first', 'scroll-first' ] ) {
    const h = recoveryFixture(url, true);
    Object.assign(h.job, { scrollDone: false, scrollSteps: 0, contentReadyAt: undefined });
    const check = h.state.sectionCheck;
    for ( let step = 1; step <= 20; step++ ) {
        let releaseScroll;
        let releaseCheck;
        h.state.scroll = () => new Promise(resolve => { releaseScroll = resolve; });
        const pending = h.hooks.advanceScroll(h.job, h.job.navigationId);
        h.state.sectionIDs.add(`section-${step}`);
        h.state.tab.url = `${url}#section-${step}`;
        h.state.sectionCheck = code => new Promise(resolve => { releaseCheck = () => resolve(check(code)); });
        const route = h.handlers.updated(1, { url: h.state.tab.url });
        if ( order === 'check-first' ) { releaseCheck(); await route; }
        releaseScroll([ { moved: true } ]);
        await pending;
        if ( order === 'scroll-first' ) { releaseCheck(); await route; }
        assert.equal(h.job.scrollSteps, step, `${order}: every successful move consumes one step`);
    }
    assert.equal(h.job.scrollDone, true, `${order}: section changes cannot defeat the 20-step cap`);
    h.state.scroll = () => assert.fail('A completed sample must not scroll again');
    await h.hooks.advanceScroll(h.job, h.job.navigationId);
    h.state.readiness = () => [ { url: h.state.tab.url, complete: true, content: true } ];
    await h.clock.advance(750);
    const remaining = 20000 - (h.clock.Date.now() - h.job.contentReadyAt);
    await h.clock.advance(remaining - 1);
    assert.equal(h.results.length, 0);
    await h.clock.advance(1);
    assert.equal(h.results[0].final_url, `${url}#section-20`);
}
{
    const h = recoveryFixture(url, true);
    Object.assign(h.job, { scrollDone: false, scrollSteps: 19, contentReadyAt: undefined });
    h.state.scroll = () => [ { moved: true } ];
    await h.hooks.completed(h.job, h.job.navigationId);
    await h.clock.advance(0);
    assert.equal(h.job.contentReadyAt, h.clock.Date.now(),
        'The twentieth step starts observation without another scroll-interval wait');
    await h.clock.advance(19999);
    assert.equal(h.results.length, 0);
    await h.clock.advance(1);
    assert.equal(h.results[0].verdict, 'candidate');
}
for ( const interruption of [ 'hash-route', 'path', 'document', 'recovery' ] ) {
    const h = recoveryFixture(url, true);
    Object.assign(h.job, { scrollDone: false, scrollSteps: 7, contentReadyAt: undefined });
    let release;
    h.state.scroll = () => new Promise(resolve => { release = resolve; });
    const pending = h.hooks.advanceScroll(h.job, 1);
    if ( interruption === 'document' ) {
        h.handlers.committed({ tabId: 1, frameId: 0, url });
    } else if ( interruption === 'recovery' ) {
        h.fail();
    } else {
        h.state.tab.url = interruption === 'path' ? new URL('/next', url).href : `${url}#/inbox`;
        await h.handlers.history({ tabId: 1, frameId: 0, url: h.state.tab.url });
    }
    release([ { moved: true } ]);
    await pending;
    assert.equal(h.job.scrollSteps, interruption === 'recovery' ? 7 : 0,
        `${interruption}: old scroll replies cannot consume the replacement sample`);
}
for ( const phase of [ 'readiness', 'commerce', 'capture' ] ) {
    const h = recoveryFixture();
    h.job.captureDocument = true;
    h.job.xRobotsTags = [];
    const readyAt = h.job.contentReadyAt;
    const property = phase === 'readiness' ? 'readiness' : phase;
    const fresh = () => phase === 'commerce' ? undefined : phase === 'capture'
        ? [ structuredClone({ ...capturedDocument, url: h.state.tab.url }) ]
        : [ { url: h.state.tab.url, complete: true, content: true } ];
    let release;
    h.state[property] = () => new Promise(resolve => { release = resolve; });
    const pending = h.hooks.completed(h.job, 1);
    while ( release === undefined ) { await Promise.resolve(); }
    h.state.sectionIDs.add('apps');
    h.state.tab.url = `${url}#apps`;
    await h.handlers.updated(1, { url: h.state.tab.url });
    release(phase === 'commerce' ? { kind: 'shopping_signals', shopping_signals: true,
        reasons: [ { kind: 'commercial_store' } ] } : phase === 'capture'
        ? [ structuredClone({ ...capturedDocument, url }) ] : [ { url, complete: true, content: true } ]);
    await pending;
    assert.equal(h.results.length, 0, `${phase}: old-URL results cannot finish inspection`);
    assert.equal(h.job.contentReadyAt, readyAt, `${phase}: retry does not restart observation`);
    h.state[property] = fresh;
    h.state.readiness = () => [ { url: h.state.tab.url, complete: true, content: true } ];
    h.state.capture = () => [ structuredClone({ ...capturedDocument, url: h.state.tab.url }) ];
    await h.clock.advance(0);
    assert.equal(h.results[0].verdict, 'candidate', phase);
    assert.equal(h.results[0].final_url, `${url}#apps`, phase);
}
for ( const next of [ `${url}#/inbox`, `${url}#intro`, `${url}?view=inbox`, new URL('/inbox', url).href ] ) {
    const h = recoveryFixture();
    h.job.shoppingSignals = true;
    h.job.shoppingEvidence = { product_offer: true, purchase: true };
    h.job.exclusionReasons = [ { kind: 'commercial_store' } ];
    h.state.sectionIDs.add('intro');
    let release;
    const check = h.state.sectionCheck;
    h.state.sectionCheck = () => new Promise(resolve => { release = resolve; });
    h.state.tab.url = `${url}#/pending-inbox`;
    const pending = h.handlers.updated(1, { url: h.state.tab.url });
    h.state.sectionCheck = check;
    h.state.tab.url = next;
    await h.handlers.history({ tabId: 1, frameId: 0, url: next });
    release([ true ]);
    await pending;
    assert.equal(h.job.observedURL, next, 'A delayed ID result cannot restore an earlier URL');
    assert.equal(h.job.contentReadyAt, undefined);
    assert.equal(h.job.scrollDone, false);
    assert.equal(h.job.shoppingSignals, undefined, 'An unconfirmed route cannot lend its evidence to a section');
    assert.equal(h.job.shoppingEvidence, undefined);
    assert.equal(h.job.exclusionReasons.length, 0);
    assert.equal(h.job.committedNavigationId, h.job.navigationId);
}
{
    const h = recoveryFixture();
    h.state.sectionCheck = () => { throw new Error('Document unavailable'); };
    h.state.tab.url = `${url}#pricing`;
    await h.handlers.updated(1, { url: h.state.tab.url });
    assert.equal(h.job.scrollDone, false, 'A failed native check cannot waive real-route inspection');
    assert.equal(h.job.contentReadyAt, undefined);
}
console.log('Passed: native section IDs preserve scrolling/observation, refresh final URLs and invalidate old asynchronous snapshots');

for ( const restoredURL of [ url, 'https://reddit.com/restored' ] ) {
    const { clock, handlers, hooks, job, results, state } = recoveryFixture();
    job.rootHeaders = { server: 'old-document' };
    job.xRobotsTags = [ 'noindex' ];
    job.shoppingSignals = true;
    job.shoppingEvidence = { software: true, product_offer: true, purchase: true };
    job.requestHosts.add('old.example');
    job.requests.add('old-request');
    state.tab.url = restoredURL;
    handlers.committed({ tabId: 1, frameId: 0, url: restoredURL });
    if ( communityDomainFromHostname(new URL(restoredURL).hostname) ) {
        await clock.advance(0);
        assert.equal(results[0].verdict, 'uninspected');
        assert.equal(state.scrolls, 0);
        continue;
    }
    assert.equal(job.destinationURL, restoredURL);
    assert.equal(job.committedNavigationId, job.navigationId);
    assert.equal(job.statusCode, undefined, 'A request-less commit must not fabricate a response');
    assert.deepEqual(Object.keys(job.rootHeaders), []);
    assert.equal(job.xRobotsTags.length, 0);
    assert.equal(job.shoppingSignals, undefined);
    assert.equal(job.shoppingEvidence, undefined, 'A new document cannot inherit a previous store observation');
    assert.equal(job.requestHosts.size, 0);
    assert.equal(job.requests.size, 0);
    handlers.updated(1, { url: restoredURL, status: 'complete' }, state.tab);
    await hooks.completed(job, job.navigationId);
    await clock.advance(30000);
    assert.equal(results.length, 0, 'Restoration acceptance without observed root evidence stays deferred');
    assert.equal(state.scrolls, 0);
}
console.log('Passed: request-less commits update identity but cannot borrow prior response evidence or pass');

for ( const recovered of [ false, true ] ) {
    const { clock, hooks, handlers, job, state, results, request } = recoveryFixture();
    job.statusCode = undefined;
    job.scrollDone = false;
    job.timeout = clock.setTimeout(() => hooks.finish(job,
        { verdict: 'unresolved', reasons: [ { kind: 'incomplete_load' } ] }), 70000);
    const deadline = clock.timers.get(job.timeout).at;
    hooks.scheduleCompletion(job);
    await clock.advance(2999);
    assert.equal(state.reloads.length, 0, 'Normal polling leaves time for response metadata to arrive');
    await clock.advance(1);
    assert.deepEqual(state.reloads, [ { id: 1, bypassCache: true } ]);
    assert.equal(job.statusCode, undefined, 'Reloading does not invent response metadata');
    assert.equal(state.scripts.length, 0, 'Inspection waits for the actual response');
    assert.equal(clock.timers.get(job.timeout).at, deadline, 'The overall deadline is unchanged');

    const root = { ...request('main_frame'), getIPAddress: () => '' };
    const details = { requestId: 'hard-reload', frameId: 0 };
    hooks.filterInspectionRequest(root, details);
    if ( recovered ) {
        hooks.filterInspectionHeaders(root, [ { name: 'X-Robots-Tag', value: 'noindex' } ],
            [], 200, undefined, details);
    }
    handlers.committed({ tabId: 1, frameId: 0, url: state.tab.url });
    hooks.inspectionRequestFinished({ ...details, tabId: 1, type: 'main_frame', statusCode: 200 });
    await clock.advance(recovered ? 26000 : 67000);
    assert.equal(state.reloads.length, 1, 'Another response-less commit never starts a reload loop');
    assert.equal(results.length, 1);
    assert.equal(results[0].verdict, recovered ? 'candidate' : 'unresolved');
    if ( recovered ) {
        assert.equal(job.statusCode, 200);
        assert.deepEqual(Array.from(job.xRobotsTags), [ 'noindex' ], 'Fresh headers keep indexing restrictions');
        assert.equal(state.scrolls, 1, 'Recovered pages receive the normal inspection');
    } else { assert.equal(clock.Date.now(), deadline, 'An unsuccessful retry ends at the original deadline'); }
}

{
    const { hooks, job, state, fail } = recoveryFixture();
    job.statusCode = undefined;
    fail({ error: 'NS_ERROR_NET_TIMEOUT' });
    await hooks.completed(job, job.navigationId);
    assert.equal(state.reloads.length, 0, 'Known navigation failures keep their existing recovery policy');
}

for ( const stale of [ false, true ] ) {
    const { clock, hooks, handlers, job, state, results, request } = recoveryFixture();
    job.statusCode = undefined;
    const gate = Promise.withResolvers();
    const entered = Promise.withResolvers();
    state.reload = () => { entered.resolve(); return gate.promise; };
    const pending = hooks.completed(job, job.navigationId);
    await entered.promise;
    if ( stale ) {
        hooks.filterInspectionRequest(request('main_frame'), { requestId: 'new-document' });
        job.statusCode = 200;
        handlers.committed({ tabId: 1, frameId: 0, url: state.tab.url });
    }
    gate.reject(new Error('Reload failed'));
    await pending;
    if ( stale ) { assert.equal(job.recovery, undefined, 'A stale reload failure cannot reject a replacement document'); }
    else {
        assert.equal(job.recovery.reason.kind, 'navigation_failed');
        await clock.advance(20000);
        assert.equal(results[0].verdict, 'unresolved');
    }
}
console.log('Passed: missing response metadata gets one native hard reload within the original deadline; headers, normal checks and failure ownership stay intact');

{
    const { hooks, job, state } = recoveryFixture('https://personal.example/a');
    const fctxt = {
        tabId: 1, type: 'script', url: 'https://advertiser.example/ad.js',
        isRootDocument: () => false,
        duplicate() { return { ...this }; },
    };
    const response = { cancel: true };
    const forwarded = [];
    const native = {
        tabId: 1, type: 'script', requestId: 'native-seam', frameId: 8,
        documentUrl: 'https://embed.example/frame',
        frameAncestors: [ { frameId: 0, url: job.destinationURL } ],
    };
    const trafficHooks = vm.runInNewContext(
        traffic.slice(traffic.indexOf('function onBeforeRequest('), traffic.indexOf('function onBeforeRootFrameRequest(')) +
        traffic.slice(traffic.indexOf('function onHeadersReceived('), traffic.indexOf('const reMediaContentTypes')) +
        ';({ onBeforeRequest, onHeadersReceived })', {
            µb: { filteringContext: { fromWebrequestDetails: () => fctxt } },
            requestHeadersManager: { lookup: () => [] },
            isInspectionTab: tabId => tabId === 1,
            filterInspectionRequest: (...args) => {
                forwarded.push(args[1]);
                return hooks.filterInspectionRequest(...args);
            },
            filterInspectionHeaders: (...args) => {
                forwarded.push(args.at(-1));
                return hooks.filterInspectionHeaders(...args);
            },
        }
    );
    assert.equal(trafficHooks.onBeforeRequest(native), undefined);
    assert.equal(job.requests.has(native.requestId), true);
    state.advertising = true;
    const headers = { ...native, statusCode: 200, responseHeaders: [] };
    assert.deepEqual(JSON.parse(JSON.stringify(trafficHooks.onHeadersReceived(headers))), response);
    assert.equal(job.finished, true, 'Genuine nested header ads still exclude the current page');
    assert.equal(forwarded[0], native, 'The request seam preserves the original native identity object');
    assert.equal(forwarded[1], headers, 'The header seam preserves the original native identity object');
}
for ( const [ from, to ] of [
    [ 'https://personal.example/a', 'https://personal.example/b' ],
    [ 'https://reddit.com/a', 'https://personal.example/b' ],
    [ 'https://personal.example/a', 'https://reddit.com/b' ],
] ) {
    for ( const nested of [ false, true ] ) {
        const { clock, hooks, job, state, results } = recoveryFixture(from);
        const ad = {
            tabId: 1, type: 'script', url: 'https://advertiser.example/ad.js',
            isRootDocument: () => false,
        };
        const native = (requestId, topURL) => ({
            tabId: 1, requestId, type: 'script', url: ad.url,
            frameId: nested ? 8 : 0,
            documentUrl: nested ? 'https://embed.example/frame' : topURL,
            frameAncestors: nested ? [
                { frameId: 4, url: 'https://embed.example/parent' },
                { frameId: 0, url: topURL },
            ] : [],
        });
        const old = native('old-ad', from);
        hooks.filterInspectionRequest(ad, old);
        const root = {
            tabId: 1, type: 'main_frame', url: to,
            isRootDocument: () => true, getIPAddress: () => '203.0.113.10',
        };
        const rootDetails = { tabId: 1, type: 'main_frame', requestId: 'new-root', frameId: 0 };
        hooks.filterInspectionRequest(root, rootDetails);
        if ( communityDomainFromHostname(new URL(to).hostname) ) {
            await clock.advance(0);
            assert.equal(results[0].verdict, 'uninspected');
            continue;
        }
        state.advertising = true;
        assert.equal(hooks.filterInspectionHeaders(ad, [], [], 200, undefined, old).cancel, true);
        assert.equal(hooks.filterInspectionRequest(ad, native('late-old-ad', from)).cancel, true);
        hooks.inspectionRequestFinished({ ...old, error: 'NS_ERROR_FAILURE' });
        hooks.inspectionRequestFinished({ ...rootDetails, requestId: 'old-root', error: 'NS_ERROR_NET_TIMEOUT' });
        assert.equal(job.finished, false, `${from} -> ${to}: old ads cannot exclude the new destination`);
        assert.equal(job.recovery, undefined, 'Old native request errors cannot start new recovery');
        assert.equal(job.requests.size, 1);
        assert.equal(job.requests.has('new-root'), true);
        assert.equal(job.requestHosts.has('advertiser.example'), false, 'Old hosts are not new-page evidence');
        const current = native('current-ad', to);
        assert.equal(hooks.filterInspectionRequest(ad, current).cancel, true);
        assert.equal(job.finished, true, 'Genuine current subframe ads still exclude ordinary destinations');
        await clock.advance(0);
        assert.equal(results[0].reasons[0].kind, 'advertising');
    }
}
for ( const sameURL of [ false, true ] ) {
    const { hooks, job, results } = recoveryFixture();
    const root = {
        tabId: 1, type: 'main_frame', url,
        isRootDocument: () => true, getIPAddress: () => '203.0.113.10',
    };
    hooks.filterInspectionRequest(root, { requestId: 'previous-root' });
    hooks.filterInspectionRequest({ ...root, url: sameURL ? url : new URL('/replacement', url).href },
        { requestId: 'current-root' });
    hooks.filterInspectionHeaders(root, [ { name: 'x-robots-tag', value: 'noindex' } ], [], 503,
        undefined, { requestId: 'previous-root' });
    assert.equal(hooks.filterInspectionHeaders(root, [ { name: 'Content-Type', value: 'application/pdf' } ], [], 200,
        undefined, { requestId: 'previous-root' }).cancel, true, 'A stale file cannot reach a viewer');
    assert.equal(job.finished, false, 'A stale file response cannot classify the current root');
    hooks.inspectionRequestFinished({ tabId: 1, type: 'main_frame', requestId: 'previous-root', error: 'NS_ERROR_FAILURE' });
    assert.equal(job.statusCode, undefined, 'Late prior-root headers do not replace the new response');
    assert.equal(job.xRobotsTags.length, 0);
    assert.equal(job.recovery, undefined);
    hooks.inspectionRequestFinished({ tabId: 1, type: 'main_frame', requestId: 'current-root', error: 'NS_ERROR_NET_TIMEOUT' });
    assert.equal(job.recovery.reason.kind, 'navigation_failed', 'The current root still gets normal error recovery');
    assert.equal(results.length, 0);
}
{
    const { hooks, handlers, job, state } = recoveryFixture();
    job.documentId = 'old-document';
    const root = { tabId: 1, type: 'main_frame', url, isRootDocument: () => true };
    hooks.filterInspectionRequest(root, { requestId: 'same-url-root' });
    state.advertising = true;
    const ad = { ...root, type: 'script', isRootDocument: () => false };
    const old = { requestId: 'old-ad', frameId: 0, documentId: 'old-document', documentUrl: url };
    assert.equal(hooks.filterInspectionRequest(ad, old).cancel, true);
    assert.equal(job.finished, false, 'An available UUID distinguishes an old same-URL top document during navigation');
    handlers.committed({ tabId: 1, frameId: 0, url, documentId: 'new-document' });
    assert.equal(hooks.filterInspectionRequest(ad, old).cancel, true);
    assert.equal(job.finished, false, 'The prior UUID also remains stale after commit');
    hooks.filterInspectionRequest(ad, { ...old, requestId: 'new-ad', documentId: 'new-document' });
    assert.equal(job.finished, true, 'The committed document UUID still allows genuine ad evidence');
}
for ( const type of [ 'script', 'sub_frame' ] ) {
    for ( const committed of [ false, true ] ) {
        const { hooks, handlers, job, state } = recoveryFixture();
        job.documentId = 'old-document';
        const root = { tabId: 1, type: 'main_frame', url, isRootDocument: () => true };
        hooks.filterInspectionRequest(root, { requestId: 'same-url-root' });
        if ( committed ) {
            handlers.committed({ tabId: 1, frameId: 0, url, documentId: 'new-document' });
        }
        state.advertising = true;
        const ad = {
            tabId: 1, type, url: 'https://advertiser.example/ad',
            isRootDocument: () => false,
        };
        const details = {
            requestId: 'old-child', frameId: 8, parentFrameId: 0,
            parentDocumentId: 'old-document',
            documentUrl: type === 'sub_frame' ? url : 'https://embed.example/frame',
            frameAncestors: [ { frameId: 0, url } ],
        };
        assert.equal(hooks.filterInspectionRequest(ad, details).cancel, true);
        assert.equal(hooks.filterInspectionHeaders(ad, [], [], 200, undefined, details).cancel, true);
        assert.equal(job.finished, false, 'An old parent UUID isolates child traffic during same-URL replacement');
        hooks.filterInspectionRequest(ad, {
            ...details, requestId: 'new-child', parentDocumentId: 'new-document',
        });
        assert.equal(job.finished, true, 'Current child evidence still excludes its own destination');
    }
}
assert.doesNotMatch(controller, /browser\.webNavigation\.onErrorOccurred\.addListener/);
console.log('Passed: native paths, top ancestors, available document UUIDs and request IDs isolate old evidence without bypassing ad cancellation');

for ( const replacement of [ 'identity', 'generation', 'none' ] ) {
    const clock = recoveryClock();
    const searchA = 'https://www.google.com/search?q=first';
    const source = { generation: 0, pageURL: 'https://www.google.com/search?q=second', pending: true };
    const sourceStates = new Map([[ 1, source ]]);
    const cancelled = [];
    let updated;
    let resolveLookup;
    vm.runInNewContext(
        controller.slice(controller.indexOf('function searchPageURL('), controller.indexOf('export async function inspectResults(')) +
        controller.slice(controller.indexOf('function cancelSource('), controller.indexOf('function releaseIdleProfile(')) +
        controller.slice(controller.indexOf('browser.tabs.onUpdated.addListener('),
            controller.indexOf('browser.webNavigation.onCommitted.addListener(')), {
            ...clock, URL, sourceAdmissions: new Map(), sourceStates, sourceJobs: new Map([[ 1, new Set([ 'current-job' ]) ]]),
            inspectionTabs: new Map(), maxAwaySearches: 2,
            cancelJobs: (_jobs, reason) => cancelled.push(reason),
            browser: { tabs: {
                get: () => new Promise(resolve => { resolveLookup = resolve; }),
                onUpdated: { addListener: callback => { updated = callback; } },
                sendMessage: async () => {},
            } },
        }
    );
    updated(1, { url: searchA });
    const pending = clock.advance(1000);
    assert.equal(typeof resolveLookup, 'function');
    if ( replacement === 'identity' ) { sourceStates.set(1, { ...source }); }
    if ( replacement === 'generation' ) { source.generation += 1; }
    resolveLookup({ url: searchA });
    await pending;
    assert.deepEqual(cancelled, replacement === 'none' ? [ 'source_changed' ] : [], replacement);
    assert.equal(sourceStates.has(1), replacement !== 'none');
}
console.log('Passed: awaited source lookups recheck both identity and generation; current lookups still cancel changed searches');

for ( const kept of [ false, true ] ) {
    const { hooks, job, results, state } = recoveryFixture();
    job.finished = true;
    job.kept = kept;
    state.advertising = true;
    const request = {
        tabId: 1, type: 'script', url: 'https://example.test/late.js',
        isRootDocument: () => false,
    };
    assert.equal(hooks.filterInspectionRequest(request, { requestId: 'late' }).cancel, kept ? undefined : true);
    assert.equal(hooks.filterInspectionHeaders(request, [], [], 200, undefined, { requestId: 'late' }).cancel,
        kept ? undefined : true);
    assert.equal(job.requests.size, 0);
    assert.equal(job.requestHosts.size, 0);
    assert.equal(results.length, 0, 'A retained finished tab cannot produce another verdict');
}
console.log('Passed: finished tabs allow retained-tab browsing and cancel other late traffic without restarting policy work');

for ( const [ type, download, status = 200, attachment = false, verdict ] of [
    [ 'application/octet-stream', true, 200, false, 'uninspected' ],
    [ 'application/octet-stream', false, 302 ],
    [ 'application/octet-stream', true, 404 ],
    [ 'application/pdf', false, 404 ],
    [ 'application/pdf', false, 204 ],
    [ 'application/pdf', false, 205 ],
    [ 'APPLICATION/ZIP; filename=archive.zip', true, 200, false, 'uninspected' ],
    [ 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', true, 200, false, 'uninspected' ],
    [ 'application/x-msdownload', true, 200, false, 'uninspected' ],
    [ 'text/html; charset=utf-8', false ],
    [ 'application/xhtml+xml; charset=utf-8', false ],
    [ 'text/html', true, 200, true ],
    [ 'text/html', false, 302, true ],
    [ 'application/octet-stream', false, 307, true ],
    [ 'text/html', true, 404, true ],
    [ 'text/plain', true, 200, false, 'uninspected' ],
    [ 'image/svg+xml', true, 200, false, 'uninspected' ],
    [ 'video/webm', true, 200, false, 'uninspected' ],
    [ 'application/ogg', true, 200, false, 'uninspected' ],
    [ 'application/pdf', true, 200, false, 'uninspected' ],
    [ 'application/pdf', true, 200, true, 'uninspected' ],
    [ 'application/ld+json', true, 200, false, 'uninspected' ],
    [ 'application/atom+xml', true, 200, false, 'uninspected' ],
    [ 'not-a-media-type', true ],
    [ '', false ],
] ) {
    const { hooks, job, results, clock, state } = recoveryFixture();
    const root = {
        tabId: 1, type: 'main_frame', url, isRootDocument: () => true,
        getIPAddress: () => '203.0.113.10',
    };
    const details = { requestId: 'file-root' };
    hooks.filterInspectionRequest(root, details);
    const headers = [ { name: 'Content-Type', value: type } ];
    if ( attachment ) { headers.push({ name: 'Content-Disposition', value: 'attachment' }); }
    const reply = hooks.filterInspectionHeaders(root, headers, [], status, undefined, details);
    assert.equal(reply.cancel === true, download, type);
    assert.equal(job.finished, download, type);
    if ( download ) {
        await clock.advance(0);
        assert.equal(results[0].verdict, verdict || 'unresolved');
        if ( verdict ) {
            assert.equal(results[0].domain_only, true);
            assert.deepEqual(state.scripts, []);
        } else {
            assert.equal(results[0].reasons[0].kind, 'download_response');
        }
    }
}
console.log('Passed: successful non-HTML responses finish without probes; errors and HTML attachments retain download handling');

{
    const { hooks, job, results, clock } = recoveryFixture();
    const root = { tabId: 1, type: 'main_frame', url, isRootDocument: () => true,
        getIPAddress: () => '203.0.113.10' };
    const details = { tabId: 1, type: 'main_frame', requestId: 'missing-pdf' };
    hooks.filterInspectionRequest(root, details);
    hooks.filterInspectionHeaders(root, [ { name: 'Content-Type', value: 'application/pdf' } ], [], 404, undefined, details);
    hooks.inspectionRequestFinished({ ...details, statusCode: 404 });
    assert.equal(job.finished, false, 'A file HTTP error gets normal failure recovery');
    await clock.advance(20000);
    assert.equal(results[0].verdict, 'unresolved');
    assert.equal(results[0].reasons[0].kind, 'http_error');
}

for ( const values of [
    [ 'first=1; Path=/', 'woocommerce_items_in_cart=1; Path=/' ],
    [ 'first=1; Path=/\nwoocommerce_items_in_cart=1; Path=/' ],
    [ 'first=1; Path=/\r\nwoocommerce_items_in_cart=1; Path=/' ],
] ) {
    const { hooks, job } = recoveryFixture();
    const root = {
        tabId: 1, type: 'main_frame', url, isRootDocument: () => true,
        getIPAddress: () => '203.0.113.10',
    };
    const details = { requestId: 'cookie-root' };
    hooks.filterInspectionRequest(root, details);
    hooks.filterInspectionHeaders(root, values.map(value => ({
        name: 'Set-Cookie', value,
    })), [], 200, undefined, details);
    assert.deepEqual(Array.from(job.setCookies), [
        'first=1; Path=/', 'woocommerce_items_in_cart=1; Path=/',
    ]);
    assert.equal(job.rootHeaders['set-cookie'], job.setCookies.join('\n'),
        'Maintained header rules and cookie rules must see the same response evidence');
}
console.log('Passed: separate and newline-merged response cookies reach both maintained matcher inputs');

for ( const targetURL of [ url, 'https://ordinary.example/article' ] ) {
    const { clock, hooks, job, results, state } = recoveryFixture(targetURL);
    job.contentReadyAt = undefined;
    job.scrollDone = false;
    const ready = state.readiness;
    for ( const unavailable of [ { content: false } ] ) {
        state.readiness = () => [ { ...ready()[0], ...unavailable } ];
        await hooks.completed(job, 1);
        assert.equal(job.contentReadyAt, undefined, targetURL);
        assert.equal(state.scrolls, 0, 'Unready content cannot start scrolling');
    }
    state.readiness = ready;
    job.requests.add('pending-script');
    await hooks.completed(job, 1);
    assert.equal(job.requests.size, 1, 'The background request remains in flight');
    assert.equal(state.scrolls, 1, 'Every page goes through the shared scroll flow');
    await clock.advance(3000);
    assert.equal(job.contentReadyAt, clock.Date.now(), targetURL);
    await clock.advance(19999);
    assert.equal(results.length, 0, 'Every page needs the full observation period');
    await clock.advance(1);
    assert.equal(results[0].verdict, 'candidate', targetURL);
    assert.equal(results[0].shopping_signals, false,
        `${targetURL}: completed candidates carry the boolean required for cache reuse`);
    assert.ok(state.scripts.every(file => /\/(?:readiness|inspection-dom)\.js$/.test(file)),
        'Generic inspection needs no target-specific parser');

    for ( const [ kind, expected ] of [
        [ 'affiliate_link', 'exclude' ], [ 'shopping_signals', 'candidate' ],
        [ 'commerce_probe_unavailable', 'unresolved' ],
    ] ) {
        const checked = recoveryFixture(targetURL);
        let commerceCalls = 0;
        checked.state.commerce = async () => {
            commerceCalls += 1;
            return { kind: kind === 'affiliate_link' ? 'shopping_signals' : kind,
                reasons: kind === 'affiliate_link' ? [ { kind: 'affiliate_link' } ] : [],
                shopping_signals: true,
                shopping_evidence: { software: true, product_offer: false, purchase: false } };
        };
        await checked.hooks.completed(checked.job, 1);
        await checked.clock.advance(0);
        assert.equal(commerceCalls, 1, targetURL);
        assert.equal(checked.results[0].verdict, expected,
            `${targetURL}: ${kind}`);
        if ( kind !== 'shopping_signals' ) {
            assert.equal(checked.results[0].reasons[0].kind, kind);
        }
        if ( kind === 'shopping_signals' ) {
            assert.equal(checked.results[0].shopping_signals, true);
        }
    }
}
console.log('Passed: inspected pages share readiness, settling, scrolling, observation and content checks');

{
    const { clock, hooks, job, results, request } = recoveryFixture();
    job.contentReadyAt = undefined;
    hooks.scheduleCompletion(job);
    for ( let i = 0; i < 58; i++ ) {
        hooks.filterInspectionRequest(request('xmlhttprequest'), { requestId: `poll-${i}` });
        await clock.advance(400);
    }
    assert.equal(results[0].verdict, 'candidate', 'Continuous background requests do not postpone completion');
    assert.ok(job.requests.size > 0, 'The page can finish inspection while background requests remain open');
}
console.log('Passed: continuous background activity cannot restart the inspection clock');

{
    const { clock, hooks, handlers, job, results, state, request } = recoveryFixture();
    hooks.filterInspectionRequest(request('main_frame'), { requestId: 'parsed-page' });
    job.statusCode = 200;
    hooks.inspectionRequestFinished({
        tabId: 1, requestId: 'parsed-page', type: 'main_frame', statusCode: 200,
    });
    hooks.filterInspectionRequest(request('script'), { requestId: 'optional-script' });
    state.tab.status = 'loading';
    handlers.committed({ tabId: 1, frameId: 0, url });
    await clock.advance(26000);
    assert.equal(results[0].verdict, 'candidate',
        'A parsed, readable page finishes inspection while optional resources keep the spinner running');
    assert.equal(state.tab.status, 'loading');
}

for ( const interruption of [ 'none', 'navigation', 'recovery' ] ) {
    const clock = recoveryClock();
    const target = { finished: false, loaded: true, navigationId: 1, routeId: 1, scrollSteps: 19 };
    const probes = [];
    const scheduled = [];
    const advance = vm.runInNewContext(controller.slice(controller.indexOf('async function advanceScroll('),
        controller.indexOf('async function commerceDecision(')) + ';advanceScroll', {
        ...clock, inspectionPollInterval: 3000, scrollLimit: 20, scrollInterval: 750,
        browser: { tabs: { executeScript: () => new Promise(resolve => probes.push(resolve)) } },
        scheduleCompletion: () => scheduled.push(true),
        finish: () => assert.fail('A delayed successful probe must not fail inspection'),
    });
    const pending = advance(target, 1);
    if ( interruption === 'navigation' ) { target.navigationId += 1; target.routeId += 1; }
    if ( interruption === 'recovery' ) { target.recovery = { deadline: clock.Date.now() + 10000 }; }
    const overlap = advance(target, target.navigationId);
    assert.equal(probes.length, 1, 'Concurrent completion polls share one in-flight scroll');
    assert.ok(scheduled.length > 0, 'A blocked poll schedules another check, including after navigation or recovery');
    probes.shift()([ { moved: true } ]);
    await Promise.all([ pending, overlap ]);
    assert.equal(target.scrollPending, false);
    assert.equal(target.scrollSteps, interruption === 'none' ? 20 : 19,
        'Only the current document and recovery may consume a scroll step');
    if ( interruption !== 'none' ) {
        const current = advance(target, target.navigationId);
        assert.equal(probes.length, 1, 'The new document or recovered page can resume scrolling');
        probes.shift()([ { moved: true } ]);
        await current;
    }
    assert.equal(target.scrollSteps, 20);
    assert.equal(target.scrollDone, true);
    await advance(target, target.navigationId);
    assert.equal(probes.length, 0, 'A late overlapping poll cannot exceed the 20-step limit');
}
console.log('Passed: overlapping scroll probes stay within the sample limit and resume after navigation or recovery');

{
    const clock = recoveryClock();
    const target = { finished: false, loaded: true, navigationId: 1, scrollSteps: 0 };
    const advance = vm.runInNewContext(controller.slice(controller.indexOf('async function advanceScroll('),
        controller.indexOf('async function commerceDecision(')) + ';advanceScroll', {
        ...clock, inspectionPollInterval: 3000,
        browser: { tabs: { executeScript: async () => [ { moved: false } ] } },
        scheduleCompletion: (_job, delay = 3000) => scheduled.push(delay),
        finish: () => assert.fail('A successful scroll probe with no movement is not a failure'),
    });
    const scheduled = [];
    await advance(target, 1);
    assert.equal(scheduled.pop(), 3000, 'A stationary scroll still needs a confirming poll');
    await clock.advance(3000);
    await advance(target, 1);
    assert.equal(target.scrollDone, true, 'A non-moving scroll ends the bounded sample');
    assert.equal(scheduled.pop(), 0, 'Observation starts immediately after confirmation');
}

for ( const category of [ 'public_interest_organization', 'government_education',
    'professional_publication', 'commercial_corporate' ] ) {
    for ( const shopping_evidence of [
        { software: true, product_offer: false, purchase: false },
        { software: false, product_offer: true, purchase: false },
        { software: false, product_offer: false, purchase: true },
        { software: false, product_offer: true, purchase: true },
        { software: true, product_offer: true, purchase: true },
    ] ) {
        const targetURL = 'https://museum.example/article';
        const { clock, hooks, job, state, results } = recoveryFixture(targetURL);
        job.url = targetURL;
        job.sourceCategories = [ category ];
        job.captureDocument = true;
        job.xRobotsTags = [];
        state.capture = () => [ structuredClone({ ...capturedDocument, schema: 1, url: targetURL }) ];
        state.record = vm.runInNewContext(controller.slice(
            controller.indexOf('function record('), controller.indexOf('function cachedRecord(')
        ) + ';record', {
            profile: undefined, deterministicProfile: {}, sharedCompatibility: {},
            now: () => new Date(1000).toISOString(),
        });
        state.commerce = async () => ({
            kind: 'shopping_signals', shopping_signals: shopping_evidence.software || shopping_evidence.product_offer,
            shopping_evidence,
            reasons: shopping_evidence.product_offer && shopping_evidence.purchase
                ? [ { kind: 'commercial_store', rule: 'product-offer-and-purchase' } ] : [],
        });
        await hooks.completed(job, 1);
        await clock.advance(0);
        const store = shopping_evidence.product_offer && shopping_evidence.purchase;
        const decision = results[0];
        assert.equal(decision.verdict, store ? 'exclude' : 'candidate', `${category}: ${JSON.stringify(shopping_evidence)}`);
        assert.deepEqual(decision.shopping_evidence, shopping_evidence);
        const shared = contributionObservation(decision, {});
        if ( category === 'commercial_corporate' && !store ) {
            assert.equal(shared, undefined, 'Company informational pages never contribute text');
            assert.equal(decision.document, undefined);
            continue;
        }
        assert.ok(shared, 'Both candidate articles and excluded stores remain contributable');
        assert.deepEqual(shared.decision.shopping_evidence, shopping_evidence);
        assert.equal(shared.decision.shopping_signals, shopping_evidence.software || shopping_evidence.product_offer);
        if ( store ) {
            assert.equal(decision.reasons[0].kind, 'commercial_store');
            assert.equal(shared.document, undefined, 'Purchase pages never contribute indexable text');
        }
    }
}
for ( const kind of [ 'scam', 'adult_domain' ] ) {
    const { clock, hooks, job, state, results } = recoveryFixture('https://personal.example/article');
    state.safety = () => [ { kind } ];
    state.commerce = async () => { throw new Error('Excluded pages need no commerce processing'); };
    await hooks.completed(job, 1);
    await clock.advance(0);
    assert.equal(results[0].verdict, 'exclude');
    assert.equal(results[0].reasons[0].kind, kind);
    assert.equal(state.scripts.length, 0, 'Mandatory safety stops before page probes');
}
console.log('Passed: informational categories cannot exempt product-plus-purchase; evidence survives contribution and ordinary index exclusions precede page probes');

let tabURL = url;
let verdict;
let blockProbe = false;
let resolveProbe;
const browser = { tabs: {
    get: async () => ({ url: tabURL, status: 'complete' }),
    reload: async () => {},
    executeScript: async () => {
        if ( blockProbe ) {
            blockProbe = false;
            return new Promise(resolve => { resolveProbe = resolve; });
        }
        return [{ url: tabURL, complete: true, content: true }];
    },
} };
const checkCompletion = vm.runInNewContext('(' + completionCode + ')', {
    browser,
    safetyExclusionReasons: () => [],
    candidateRecord: async () => 'candidate',
    withoutTextDirective,
    commerceDecision: async () => undefined,
    Date,
    inspectionPollInterval: 3000,
    observationPeriod: 20000,
    challengeTitle: /never-matches/,
    challengeURL: /never-matches/,
    scheduleCompletion: () => {},
    record: (_job, outcome) => outcome,
    finish: (_job, outcome) => { verdict = outcome; },
});
const job = {
    finished: false, loaded: true, tabId: 1, navigationId: 2,
    committedNavigationId: 1, destinationURL: url, statusCode: 200,
    requests: new Set(), scrollDone: true,
    requestHosts: new Set(),
    sourceCategories: [],
};
await checkCompletion(job, 2, true);
assert.equal(verdict, undefined, 'An aborted same-URL reload must not borrow the old document');
job.committedNavigationId = 2;
job.statusCode = undefined;
await checkCompletion(job, 2, true);
assert.equal(verdict, undefined, 'A failed request without a response must not pass');
job.statusCode = 200;
await checkCompletion(job, 2, false);
assert.equal(verdict, undefined, 'A quiet page must remain observed until the deadline');
assert.ok(job.contentReadyAt > 0, 'Observation begins only after usable content appears');
job.contentReadyAt -= 20000;
await checkCompletion(job, 2, true);
assert.equal(verdict, 'candidate');
verdict = undefined;
tabURL = url + '#section';
await checkCompletion(job, 2, true);
assert.equal(verdict, 'candidate', 'A fragment does not change the committed document');
verdict = undefined;
tabURL = url;
job.requests.add('background-request');
await checkCompletion(job, 2, true);
assert.equal(verdict, 'candidate', 'A pending background request does not prevent completion');
verdict = undefined;
job.requests.clear();
let committed;
browser.webNavigation = {
    onCommitted: { addListener: callback => { committed = callback; } },
    onHistoryStateUpdated: { addListener: () => {} },
};
vm.runInNewContext(recoveryHelpersCode + destinationHelpersCode + controller.slice(
    controller.indexOf('browser.webNavigation.onCommitted.addListener('),
    controller.indexOf('browser.tabs.onRemoved.addListener(')
), {
    browser,
    URL,
    firefoxRestrictedHosts,
    safetyExclusionReasons: () => [],
    sourceDecision: () => undefined, deterministicExclusionReasons: () => [],
    inspectionTabs: new Map([[1, job]]),
    updateSourceLocation: () => {},
    observeHistoryCommit: () => {},
    withoutTextDirective,
    resetScroll: target => { target.scrollDone = false; },
    scheduleCompletion() {},
    Date,
    clearTimeout,
});
blockProbe = true;
const pending = checkCompletion(job, 2, true);
while ( resolveProbe === undefined ) { await Promise.resolve(); }
committed({ tabId: 1, frameId: 0, url: tabURL });
resolveProbe([{ url: tabURL, complete: true, content: true }]);
await pending;
assert.equal(job.navigationId, 3, 'Every committed document must advance the generation');
assert.equal(verdict, undefined, 'A probe from before a cached restoration must not pass');
console.log('Passed: current-document identity, successful response, and full observation window');

for ( const probe of [ 'scroll', 'readiness' ] ) {
    for ( const interruption of [ 'navigation', 'loading', 'finished', 'none' ] ) {
        let reject;
        let outcome;
        const target = {
            tabId: 1, finished: false, loaded: true, navigationId: 1,
            committedNavigationId: 1, statusCode: 200, destinationURL: url,
        };
        const check = vm.runInNewContext('(' + controller.slice(
            controller.indexOf(probe === 'scroll' ? 'async function advanceScroll(' : 'async function completed('),
            controller.indexOf(probe === 'scroll' ? 'async function commerceDecision(' : 'async function start(')
        ) + ')', {
            browser: { tabs: {
                get: async () => ({ url, status: 'complete' }),
                executeScript: () => new Promise((_resolve, no) => { reject = no; }),
            } },
            safetyExclusionReasons: () => [], withoutTextDirective,
            challengeTitle: /never-matches/, challengeURL: /never-matches/,
            record: (_job, verdict, reasons) => ({ verdict, reasons }),
            finish: (job, result) => { job.finished = true; outcome = result; },
        });
        const pending = check(target, 1);
        await new Promise(resolve => setTimeout(resolve, 0));
        if ( interruption === 'navigation' ) { target.navigationId += 1; }
        if ( interruption === 'loading' ) { target.loaded = false; }
        if ( interruption === 'finished' ) { target.finished = true; }
        reject(new Error('Document unloaded'));
        await pending;
        if ( probe === 'scroll' ) { assert.equal(target.scrollPending, false, 'Rejected probes release the in-flight scroll'); }
        if ( interruption === 'none' ) {
            assert.equal(outcome.verdict, 'unresolved');
            assert.equal(outcome.reasons[0].kind, `${probe}_unavailable`);
        } else {
            assert.equal(outcome, undefined, `${probe}: ${interruption} invalidates the rejected probe`);
        }
    }
}
console.log('Passed: stale script rejections cannot finish a replacement document; current failures remain unresolved');

for ( const type of [ 'script', 'stylesheet', 'sub_frame', 'xmlhttprequest' ] ) {
    const { clock, job, results, fail } = recoveryFixture();
    job.contentReadyAt = undefined;
    fail({ type, statusCode: 401 });
    fail({ type, error: 'NS_ERROR_CONNECTION_REFUSED' });
    assert.equal(job.requests.size, 0);
    assert.equal(job.recovery, undefined, 'Background failures do not fail the page');
    await clock.advance(22999);
    assert.equal(results.length, 0, 'Normal settling and observation still apply');
    await clock.advance(1);
    assert.equal(results[0].verdict, 'candidate');
}
console.log('Passed: background failures settle without waiving the normal inspection');

const headersManagerStart = traffic.indexOf('const requestHeadersManager =');
const headersManagerCode = traffic.slice(headersManagerStart,
    traffic.indexOf('\n/******************************************************************************/', headersManagerStart));
for ( const event of [ 'onBeforeRedirect', 'onCompleted', 'onErrorOccurred' ] ) {
    const { clock, hooks, job, results } = recoveryFixture();
    const listeners = {};
    const manager = vm.runInNewContext(headersManagerCode + ';requestHeadersManager', {
        isGecko: true,
        browser: { webRequest: Object.fromEntries([
            'onSendHeaders', 'onBeforeRedirect', 'onCompleted', 'onErrorOccurred',
        ].map(name => [ name, { addListener: callback => { listeners[name] = callback; } } ])) },
        inspectionRequestFinished: details => {
            assert.equal(manager.requests.has(details.requestId), false);
            hooks.inspectionRequestFinished(details);
        },
    });
    manager.start();
    listeners.onSendHeaders({ requestId: event, requestHeaders: [] });
    manager.requests.set('unrelated', []);
    job.requests.add(event);
    listeners[event]({
        tabId: 1, requestId: event, type: 'xmlhttprequest',
        ...(event === 'onErrorOccurred' ? { error: 'NS_ERROR_FAILURE' }
            : event === 'onBeforeRedirect' ? { statusCode: 302, redirectUrl: url }
                : { statusCode: 404 }),
    });
    assert.equal(job.requests.size, 0, event);
    assert.equal(manager.requests.has('unrelated'), true);
    await clock.advance(3000);
    assert.equal(results[0].verdict, 'candidate', event);
}
console.log('Passed: native request completion events release request tracking');

for ( const failure of [ 'http', 'navigation', 'completion' ] ) {
    const { clock, hooks, job, results, state, fail } = recoveryFixture();
    if ( failure === 'http' ) { fail({ type: 'main_frame' }); }
    if ( failure === 'navigation' ) { fail({ type: 'main_frame', error: 'NS_ERROR_NET_TIMEOUT' }); }
    if ( failure === 'completion' ) {
        job.statusCode = 403;
        await hooks.completed(job, 1);
    }
    const reason = {
        http: [ 'http_error', '403' ],
        navigation: [ 'navigation_failed', 'NS_ERROR_NET_TIMEOUT' ],
        completion: [ 'http_error', '403' ],
    }[failure];
    assert.equal(job.finished, false, `${failure}: failure is deferred`);
    assert.equal(results.length, 0);
    await hooks.completed(job, 1);
    hooks.finish(job, { verdict: 'candidate' });
    assert.equal(job.finished, false, `${failure}: pending recovery cannot pass`);
    assert.equal(state.scripts.length, 0, 'A known failure must not start normal page probes');
    await clock.advance(19999);
    assert.equal(results.length, 0, `${failure}: the full twenty seconds remain available`);
    await clock.advance(1);
    assert.equal(results.length, 1);
    assert.equal(results[0].verdict, 'unresolved');
    assert.deepEqual(Array.from([ results[0].reasons[0].kind, results[0].reasons[0].detail ]), reason);
    assert.equal(job.recovery, undefined);
    assert.equal(state.cleanups, 1);
}
console.log('Passed: HTTP and navigation failures wait twenty seconds without passing');

for ( const [ headers, status, evidence ] of [
    [ { 'cf-mitigated': 'challenge' }, 403, { challenge_provider: 'cloudflare' } ],
    [ { server: 'cloudflare' }, 403, {} ],
    [ { 'retry-after': '60' }, 429, { retry_after: '60' } ],
    [ { 'retry-after': 'Sun, 15 Nov 2026 14:00:00 GMT' }, 429,
        { retry_after: 'Sun, 15 Nov 2026 14:00:00 GMT' } ],
] ) {
    const { clock, job, results, fail } = recoveryFixture();
    job.rootHeaders = headers;
    fail({ statusCode: status });
    await clock.advance(20000);
    assert.deepEqual(JSON.parse(JSON.stringify(results[0].reasons[0])), {
        kind: 'http_error', detail: String(status), ...evidence,
    }, 'Response evidence clarifies the failure without changing its kind or deadline');
}

{
    const { clock, hooks, job, results, fail } = recoveryFixture();
    fail({ type: 'main_frame' });
    const first = job.recovery;
    const expiry = clock.timers.get(first.timer).at;
    await clock.advance(4000);
    fail({ error: 'NS_ERROR_FAILURE' });
    fail({ type: 'main_frame', error: 'NS_ERROR_NET_TIMEOUT' });
    hooks.recoverBeforeFailure(job, { kind: 'challenge_page' });
    assert.equal(job.recovery, first, 'Repeated failures retain the original recovery');
    assert.equal(clock.timers.size, 1, 'Repeated failures do not add timers');
    assert.equal(clock.timers.get(first.timer).at, expiry);
    await clock.advance(15999);
    assert.equal(job.finished, false);
    await clock.advance(1);
    assert.equal(results[0].reasons[0].kind, 'http_error');
    assert.equal(results[0].reasons[0].detail, '403', 'Retain the first actual failure evidence');
    hooks.recoverBeforeFailure(job, { kind: 'navigation_failed' });
    assert.equal(clock.timers.size, 0, 'Finished jobs cannot start recovery again');
}
console.log('Passed: repeated failures keep the first recovery expiry and failure evidence');

for ( const phase of [ 'readiness', 'commerce', 'candidate' ] ) {
    const { clock, hooks, job, state, results, fail } = recoveryFixture();
    let release;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const probeResult = phase === 'readiness' ? state.readiness()
        : phase === 'candidate' ? state.tab : undefined;
    const block = () => {
        entered();
        return new Promise(resolve => { release = resolve; });
    };
    if ( phase === 'candidate' ) {
        let lookups = 0;
        state.lookup = () => ++lookups === 1 ? state.tab : block();
    } else { state[phase] = block; }
    const pending = hooks.completed(job, 1);
    await started;
    fail();
    release(probeResult);
    await pending;
    assert.equal(job.finished, false, `${phase}: late async completion cannot pass during recovery`);
    assert.equal(results.length, 0);
    assert.equal(state.cleanups, 0, 'A suppressed candidate must not clean up the recovering tab');
    await clock.advance(20000);
    assert.equal(results.length, 1);
    assert.equal(results[0].verdict, 'unresolved');
    assert.equal(results[0].reasons[0].kind, 'http_error');
}
console.log('Passed: late readiness, commerce and candidate completions cannot bypass recovery');

for ( const phase of [ 'commerce', 'capture' ] ) {
    for ( const signal of [ 'title', 'url' ] ) {
        const { clock, hooks, job, results, state } = recoveryFixture();
        job.captureDocument = phase === 'capture';
        const gate = Promise.withResolvers();
        const entered = Promise.withResolvers();
        const value = state[phase]();
        state[phase] = () => { entered.resolve(); return gate.promise; };
        const pending = hooks.completed(job, 1);
        await entered.promise;
        assert.equal(job.recovery, undefined, 'There has been no earlier recovery event');
        if ( signal === 'title' ) { state.tab.title = 'Verify you are human'; }
        else { state.tab.url = `${url}?challenge=1`; }
        gate.resolve(await value);
        await pending;
        assert.equal(job.finished, false, `${phase}/${signal}: the final tab lookup must not pass a new challenge`);
        assert.equal(job.recovery.reason.kind, 'challenge_page');
        assert.equal(results.length, 0);
        assert.equal(state.cleanups, 0);
        await clock.advance(20000);
        assert.equal(results[0].verdict, 'unresolved');
        assert.equal(results[0].reasons[0].kind, 'challenge_page');
    }
}
console.log('Passed: final candidate lookup detects title/URL challenges first appearing during commerce or capture');

for ( const navigation of [ 'request', 'commit' ] ) {
    const { clock, hooks, handlers, job, results, request, fail } = recoveryFixture();
    fail();
    const oldTimer = job.recovery.timer;
    const staleCallback = clock.timers.get(oldTimer).callback;
    await clock.advance(4000);
    if ( navigation === 'request' ) {
        hooks.filterInspectionRequest(request('main_frame'), { requestId: 'replacement' });
    } else {
        handlers.committed({ tabId: 1, frameId: 0, url });
    }
    assert.equal(job.recovery, undefined, `${navigation}: a new document clears recovery`);
    assert.equal(clock.timers.has(oldTimer), false, `${navigation}: old timer is cancelled`);
    staleCallback();
    assert.equal(job.finished, false, 'A queued old callback cannot finish a document without recovery');
    fail({ error: 'NS_ERROR_NET_TIMEOUT' });
    const replacement = job.recovery;
    staleCallback();
    assert.equal(job.finished, false, 'A queued old callback cannot finish replacement recovery');
    assert.equal(job.recovery, replacement);
    await clock.advance(6000);
    assert.equal(results.length, 0, 'The old deadline does not apply to the replacement');
    await clock.advance(14000);
    assert.equal(results.length, 1);
    assert.equal(results[0].reasons[0].detail, 'NS_ERROR_NET_TIMEOUT');
}
console.log('Passed: root requests and commits cancel recovery; stale callbacks cannot finish replacements');

{
    const { clock, handlers, job, results, fail } = recoveryFixture();
    fail();
    const recovery = job.recovery;
    handlers.updated(1, { status: 'loading' });
    assert.equal(job.recovery, recovery, 'Tab loading is not evidence of a replacement document');
    assert.equal(clock.timers.has(recovery.timer), true);
    await clock.advance(20000);
    assert.equal(results.length, 1);
    assert.equal(results[0].reasons[0].detail, '403', 'The original document failure keeps its deadline');
}

for ( const outcome of [ 'candidate', 'exclude' ] ) {
    const { clock, hooks, handlers, job, results, state, request, fail } = recoveryFixture();
    fail({ type: 'main_frame' });
    hooks.filterInspectionRequest(request('main_frame'), { requestId: 'replacement' });
    job.statusCode = 200;
    handlers.committed({ tabId: 1, frameId: 0, url });
    hooks.inspectionRequestFinished({ tabId: 1, requestId: 'replacement', type: 'main_frame', statusCode: 200 });
    job.loaded = true;
    if ( outcome === 'exclude' ) {
        state.advertising = true;
        assert.equal(hooks.filterInspectionRequest(request(), { requestId: 'ad' }).cancel, true);
    } else {
        await hooks.completed(job, job.navigationId);
        await clock.advance(26000);
    }
    await clock.advance(0);
    assert.equal(results.length, 1);
    assert.equal(results[0].verdict, outcome, 'A recovered new document still receives normal checks');
    if ( outcome === 'exclude' ) { assert.equal(results[0].reasons[0].kind, 'advertising'); }
    assert.equal(clock.timers.size, 0);
}
console.log('Passed: replacement documents can pass normally or be excluded for advertising');

for ( const outcome of [ 'exclude', 'cancel' ] ) {
    const { clock, hooks, job, results, state, request, fail } = recoveryFixture();
    fail();
    const staleCallback = clock.timers.get(job.recovery.timer).callback;
    job.timeout = clock.setTimeout(() => assert.fail('Overall timeout survived completion'), 70000);
    hooks.scheduleCompletion(job);
    if ( outcome === 'exclude' ) {
        state.advertising = true;
        assert.equal(hooks.filterInspectionRequest(request(), { requestId: 'ad' }).cancel, true);
    } else {
        hooks.cancelJobs(new Set([ job ]), 'source_closed', 'fixture cancellation');
    }
    assert.equal(job.finished, true, `${outcome}: no grace delay for exclusion or cancellation`);
    assert.equal(job.recovery, undefined);
    assert.equal(clock.timers.size, 0, 'Recovery, overall and settle timers are cleared');
    await clock.advance(0);
    assert.equal(results.length, 1);
    assert.equal(results[0].verdict, outcome === 'exclude' ? 'exclude' : 'unresolved');
    assert.equal(results[0].reasons[0].kind, outcome === 'exclude' ? 'advertising' : 'source_closed');
    staleCallback();
    await clock.advance(70000);
    assert.equal(results.length, 1, 'Queued callbacks cannot resolve a finished job twice');
    assert.equal(state.cleanups, 1);
    assert.equal(state.detachments, 1);
}
console.log('Passed: immediate exclusions and cancellation clear timers and finalize once');

{
    const { clock, hooks, job, results, state } = recoveryFixture();
    await hooks.completed(job, 1);
    await clock.advance(0);
    assert.equal(results[0].verdict, 'candidate', 'Clean pages do not acquire an extra twenty-second delay');
    assert.equal(state.reloads.length, 0, 'Ordinary responses do not cause a second page load');
    assert.equal(clock.timers.size, 0);
    assert.equal(state.cleanups, 1);
}
for ( const signal of [ 'title', 'url' ] ) {
    const { clock, hooks, job, results, state } = recoveryFixture();
    if ( signal === 'title' ) { state.tab.title = 'Just a moment...'; }
    else { state.tab.url = job.destinationURL = `${url}?challenge=1`; }
    await hooks.completed(job, 1);
    const recovery = job.recovery;
    const timer = job.recovery.timer;
    assert.equal(job.recovery.reason.kind, 'challenge_page');
    assert.equal(state.scripts.length, 0, 'Challenge content is not inspected as a clean page');
    await clock.advance(3000);
    assert.equal(job.recovery.timer, timer, 'Challenge polling does not restart the grace period');
    state.tab.title = 'Personal article';
    state.tab.url = job.destinationURL = url;
    await hooks.completed(job, 1);
    assert.equal(job.recovery.reason, undefined, 'Challenge-only recovery can clear in the same document');
    assert.notEqual(job.recovery, recovery, 'Challenge clearance invalidates work from the old recovery episode');
    assert.equal(job.recovery.deadline, 120000, 'Challenge clearance retains the first deadline');
    assert.equal(clock.timers.has(timer), false);
    assert.equal(state.scrolls, 1, 'Recovered content must be scrolled again');
    assert.equal(job.contentReadyAt, undefined, 'Recovered content needs a fresh observation window');
    assert.equal(job.navigationId, 1, 'Recovery does not require a replacement document');
    await clock.advance(22999);
    assert.equal(results.length, 0, 'The normal observation window must still elapse');
    await clock.advance(1);
    assert.equal(results[0].verdict, 'candidate');
    assert.equal(clock.timers.size, 0);
}
console.log('Passed: challenge-only title/URL recovery resumes scrolling and normal observation without a grace penalty');

for ( const failure of [ 'http', 'navigation' ] ) {
    const { clock, hooks, job, results, state, fail } = recoveryFixture();
    state.tab.title = 'Verify you are human';
    await hooks.completed(job, 1);
    const timer = job.recovery.timer;
    await clock.advance(4000);
    fail(failure === 'http' ? { type: 'main_frame' } : { error: 'NS_ERROR_FAILURE' });
    assert.equal(job.recovery.timer, timer, 'Actual failure during a challenge retains the first deadline');
    state.tab.title = 'Personal article';
    await hooks.completed(job, 1);
    assert.equal(state.scripts.length, 0, 'Title disappearance cannot erase actual failure evidence');
    assert.notEqual(job.recovery, undefined);
    await clock.advance(15999);
    assert.equal(results.length, 0);
    await clock.advance(1);
    assert.equal(results[0].verdict, 'unresolved');
    assert.equal(results[0].reasons[0].kind, failure === 'http' ? 'http_error' : 'navigation_failed');
}
console.log('Passed: clearing a challenge title cannot erase HTTP or navigation failure evidence');

for ( const relapse of [ 'challenge', 'navigation', 'expired' ] ) {
    const { clock, hooks, job, results, state, fail } = recoveryFixture();
    state.tab.title = 'Just a moment';
    await hooks.completed(job, 1);
    const original = job.recovery;
    await clock.advance(4000);
    state.tab.title = 'Personal article';
    await hooks.completed(job, 1);
    const cleared = job.recovery;
    assert.notEqual(cleared, original);
    assert.equal(cleared.reason, undefined);
    assert.equal(cleared.deadline, original.deadline);
    if ( relapse === 'expired' ) { await clock.advance(17000); }
    if ( relapse === 'challenge' ) {
        state.tab.title = 'Attention required';
        await hooks.completed(job, 1);
    } else { fail({ error: 'NS_ERROR_FAILURE' }); }
    assert.notEqual(job.recovery, cleared, 'A new episode gets a new identity');
    assert.equal(job.recovery.deadline, original.deadline, 'A new episode retains the document deadline');
    assert.equal(clock.timers.get(job.recovery.timer).at,
        Math.max(clock.Date.now(), original.deadline));
    if ( relapse !== 'expired' ) {
        await clock.advance(15999);
        assert.equal(results.length, 0);
        await clock.advance(1);
    } else { await clock.advance(0); }
    assert.equal(results.length, 1);
    assert.equal(results[0].verdict, 'unresolved');
    assert.equal(results[0].reasons[0].kind,
        relapse === 'challenge' ? 'challenge_page' : 'navigation_failed');
}
console.log('Passed: challenge clearance retains the deadline across new and already-expired recovery episodes');

for ( const phase of [ 'lookup', 'readiness', 'commerce' ] ) {
    const { clock, hooks, job, results, state } = recoveryFixture();
    const gate = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const original = state[phase];
    const value = phase === 'commerce' ? { kind: 'affiliate_link' } : original();
    state[phase] = () => { entered.resolve(); return gate.promise; };
    const pending = hooks.completed(job, 1);
    await entered.promise;
    hooks.recoverBeforeFailure(job, { kind: 'challenge_page' });
    hooks.resumeAfterChallenge(job);
    state[phase] = original;
    gate.resolve(value);
    await pending;
    assert.equal(job.finished, false, `${phase}: work predating a cleared recovery must be ignored`);
    assert.equal(state.scrolls, 0, 'Stale completion must not advance the recovered page');
    assert.equal(results.length, 0, 'Stale commerce exclusions must also be ignored');
    if ( phase === 'lookup' ) { assert.equal(state.scripts.length, 0); }
    await hooks.completed(job, 1);
    await clock.advance(23000);
    assert.equal(results[0].verdict, 'candidate', 'Fresh work can pass with only a retained deadline');
}
for ( const phase of [ 'capture', 'lookup' ] ) {
    for ( const priorRecovery of [ false, true ] ) {
        const { hooks, job, state } = recoveryFixture();
        if ( priorRecovery ) {
            hooks.recoverBeforeFailure(job, { kind: 'challenge_page' });
            hooks.resumeAfterChallenge(job);
        }
        job.captureDocument = phase === 'capture';
        const gate = Promise.withResolvers();
        const entered = Promise.withResolvers();
        const value = state[phase]();
        state[phase] = () => { entered.resolve(); return gate.promise; };
        const pending = hooks.candidateRecord(job, 1, url);
        await entered.promise;
        const before = job.recovery;
        hooks.recoverBeforeFailure(job, { kind: 'challenge_page' });
        hooks.resumeAfterChallenge(job);
        assert.notEqual(job.recovery, before);
        gate.resolve(value);
        assert.equal(await pending, undefined,
            `${phase}: candidate evidence cannot cross a recovery episode, even after clearance`);
    }
}
console.log('Passed: completed and candidate snapshots reject async work crossing a cleared recovery episode');

for ( const interruption of [ 'clear', 'replacement', 'cancel', 'navigation' ] ) {
    const { clock, hooks, handlers, job, results, state, request, fail } = recoveryFixture();
    state.tab.title = 'Just a moment';
    await hooks.completed(job, 1);
    const recovery = job.recovery;
    await clock.advance(19999);
    const gate = Promise.withResolvers();
    const entered = Promise.withResolvers();
    state.lookup = () => { entered.resolve(); return gate.promise; };
    const expiring = clock.advance(1);
    await entered.promise;
    state.tab.title = 'Personal article';
    state.lookup = () => state.tab;
    if ( interruption === 'clear' ) {
        await hooks.completed(job, 1);
        assert.notEqual(job.recovery, recovery);
        assert.equal(job.recovery.reason, undefined);
    } else if ( interruption === 'replacement' ) {
        handlers.updated(1, { status: 'loading' });
        hooks.filterInspectionRequest(request('main_frame'), { requestId: 'replacement' });
        fail({ error: 'NS_ERROR_NET_TIMEOUT' });
    } else if ( interruption === 'cancel' ) {
        hooks.cancelJobs(new Set([ job ]), 'source_closed');
    } else { fail({ error: 'NS_ERROR_FAILURE' }); }
    gate.resolve({ ...state.tab, title: 'Just a moment' });
    await expiring;
    if ( interruption === 'cancel' || interruption === 'navigation' ) {
        assert.equal(results.length, 1);
        assert.equal(results[0].verdict, 'unresolved');
        assert.equal(results[0].reasons[0].kind,
            interruption === 'cancel' ? 'source_closed' : 'navigation_failed');
        assert.equal(state.cleanups, 1);
    } else {
        assert.equal(results.length, 0, 'An awaited old expiry must not emit a stale or malformed unresolved result');
        assert.equal(job.finished, false);
        if ( interruption === 'clear' ) {
            await clock.advance(23000);
            assert.equal(results[0].verdict, 'candidate');
        } else {
            await clock.advance(19999);
            assert.equal(results.length, 0, 'Replacement recovery keeps its own deadline');
            await clock.advance(1);
            assert.equal(results[0].reasons[0].detail, 'NS_ERROR_NET_TIMEOUT');
        }
    }
}
console.log('Passed: awaiting challenge expiry rechecks recovery identity and reason after clearance, navigation, cancellation or failure');

{
    const { clock, hooks, job, results, state } = recoveryFixture();
    state.tab.title = 'Just a moment';
    await hooks.completed(job, 1);
    await clock.advance(19999);
    state.tab.title = 'Personal article';
    await clock.advance(1);
    assert.equal(job.finished, false, 'Expiry must re-read the tab instead of rejecting an already-cleared challenge');
    assert.equal(job.recovery.reason, undefined);
    assert.equal(state.scrolls, 1, 'Expiry clearance resumes normal checks');
    await clock.advance(23000);
    assert.equal(results[0].verdict, 'candidate');
}
console.log('Passed: expiry observes a last-moment challenge clearance and resumes normal inspection');

{
    const { clock, hooks, job, results, state } = recoveryFixture();
    hooks.inspectionRequestFinished({
        tabId: 1, requestId: 'untracked', type: 'main_frame', error: 'NS_ERROR_FAILURE',
    });
    assert.equal(job.recovery, undefined, 'Untracked navigation errors must not start recovery');
    state.tab.title = 'Attention required';
    await hooks.completed(job, 1);
    await clock.advance(20000);
    assert.equal(results[0].verdict, 'unresolved');
    assert.equal(results[0].reasons[0].kind, 'challenge_page');
    assert.equal(clock.timers.size, 0, 'Persistent challenge expiry also clears its polling timer');
}
console.log('Passed: persistent challenges expire unresolved and untracked navigation errors stay ignored');

const bundledCache = new Map();
const bundledUploads = [];
let bundledFingerprint = 'first-policy';
let bundledContext = {
    URL, needsCharacteristicChecks, normalizeShareableURL,
    sessionMalwareDecision: () => undefined, rememberMalware: () => false, settingsRevision: 0, inspectionTabGeneration: 0,
    communityDomainFromHostname, matchPersonalCategory, personalDisplayRecord,
    profileRefresh: undefined,
    mobileTabs: { android: false, initialize: async () => {} },
    inspectionTabs: new Map(), µb: { isReadyPromise: Promise.resolve() },
    setInspectionHistoryEnabled() {},
    browser: { tabs: {
        get: async id => ({ id, windowId: 1, url: 'https://www.google.com/search?q=tools' }),
        sendMessage: async () => {},
    } },
    recoverInspectionTabs() {},
    settings: () => ({ personalCategories: [], enabled: true, simultaneousInspections: 2, sourceControls: {} }),
    sourceAdmissions: new Map(), sourceStates: new Map(), sourceJobs: new Map(), policyGeneration: 0,
    cancelSourceWork() {},
    releaseIdleProfile() {},
    searchPageURL: value => value,
    loadEngine: async () => {},
    loadTrackingEngine: async () => {},
    loadMalwareEngine: async () => {},
    loadDomainIndex: async () => {},
    getMalwareGeneration: () => 0,
    malwareDecision: () => undefined, recheckMalwareResult: result => result,
    deterministicProfile: {},
    safetyExclusionReasons: () => [],
    decisionPolicyFingerprint: async () => bundledFingerprint,
    cachedRecord: (item, observation) => ({ ...item, ...observation, cached: true }),
    sharedDecisionCompatibility: async () => ({}), sharedCompatibility: {},
    profile: { version: 'a'.repeat(64) },
    getContributionEpoch: () => 1,
    sourceDecision: () => undefined,
    deterministicExclusionReasons: () => [{ kind: 'commercial_store' }],
    decisionCache: {
        get: async (url, fingerprint) => bundledCache.get(fingerprint + url),
        getObservation: async (url, fingerprint) => {
            const verdict = await bundledContext.decisionCache.get(url, fingerprint);
            return verdict === undefined ? undefined : { verdict };
        },
        put: async (decisions, fingerprint) => {
            for ( const decision of decisions ) {
                bundledCache.set(fingerprint + decision.url, decision.verdict);
            }
        },
    },
    record: (item, verdict, reasons) => ({ id: item.id, url: item.url, verdict, reasons }),
    enqueueObservations: async decisions => { bundledUploads.push(...decisions); },
    lookupSharedObservations: async () => [],
    dispatchPaused: false, dispatch() {},
    setTimeout: () => 1, clearTimeout() {},
    profilePreparationTimeout: 90000,
};
const bundledControllerCode = controllerSection('export async function inspectResults(',
    'export function isInspectionTab(').slice('export '.length) + ';inspectResults';
let inspectBundled = vm.runInNewContext(bundledControllerCode, bundledContext);
const bundledItem = { id: 'bundled', url: 'https://store.example/item' };
let bundledBatch = 0;
const inspectBundledAgain = () => inspectBundled(
    1, [bundledItem], `bundled-batch-${++bundledBatch}`
);
{
    let releaseCache, enabled = true, queued = 0;
    const context = {
        ...bundledContext, sourceAdmissions: new Map(), sourceStates: new Map(), sourceJobs: new Map(),
        settings: () => ({ ...bundledContext.settings(), enabled }),
        decisionCache: { getObservation: () => new Promise(resolve => { releaseCache = resolve; }) },
        enqueue: () => { queued += 1; throw Error('Stale batch reached queue'); },
    };
    const inspect = vm.runInNewContext(bundledControllerCode, context);
    const pending = inspect(1, [bundledItem], 'stale-cache-read');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof releaseCache, 'function');
    enabled = false;
    releaseCache(undefined);
    const [result] = await pending;
    assert.equal(result.reasons[0].kind, 'filtering_disabled');
    assert.equal(queued, 0, 'A batch disabled during its cache read cannot start inspections');
}
console.log('Passed: stale batches cannot start new inspections after an awaited cache read');
{
    const savedSettings = bundledContext.settings;
    let finishStartup;
    let reads = 0;
    bundledContext.µb.isReadyPromise = new Promise(resolve => { finishStartup = resolve; });
    bundledContext.settings = () => { reads += 1; return { enabled: false }; };
    const pending = inspectBundledAgain();
    await Promise.resolve();
    assert.equal(reads, 0, 'Batch settings are captured only after native readiness');
    finishStartup();
    assert.deepEqual(Array.from(await pending), []);
    assert.equal(reads, 1);
    bundledContext.settings = savedSettings;
    bundledContext.µb.isReadyPromise = Promise.resolve();
    bundledContext.inspectionTabs.set(1, {});
    assert.deepEqual(Array.from(await inspectBundledAgain()), [], 'Inspection tabs cannot start nested inspections');
    assert.equal(bundledUploads.length, 0);
    bundledContext.inspectionTabs.clear();
}
const firstBundled = (await inspectBundledAgain())[0];
assert.equal(firstBundled.verdict, 'exclude', JSON.stringify(firstBundled));
assert.equal(bundledUploads.length, 1);
assert.equal((await inspectBundledAgain())[0].cached, true);
assert.equal(bundledUploads.length, 1, 'Unchanged bundled exclusions must not upload repeatedly');
bundledFingerprint = 'updated-policy';
// Bundled source changes take effect in a new controller, not a live profile.
bundledContext = { ...bundledContext };
inspectBundled = vm.runInNewContext(bundledControllerCode, bundledContext);
await inspectBundledAgain();
assert.equal(bundledUploads.length, 2, 'Updated bundled lists must still publish corrections');
bundledContext.decisionCache.get = async () => {
    bundledContext.policyGeneration += 1;
    return undefined;
};
const cacheBeforeStale = bundledCache.size;
assert.equal((await inspectBundledAgain())[0].verdict, 'unresolved');
assert.equal(bundledUploads.length, 2, 'Stale cache lookups must not publish exclusions');
assert.equal(bundledCache.size, cacheBeforeStale, 'A stale batch must not suppress a future correction');
bundledContext.decisionCache.get = async () => undefined;
bundledContext.decisionCache.put = async () => { throw new Error('Storage unavailable'); };
assert.equal((await inspectBundledAgain())[0].verdict, 'exclude', 'Cache failures must not stop filtering');
bundledContext.getContributionEpoch = () => undefined;
bundledContext.decisionCache.getObservation = async () => undefined;
bundledContext.decisionCache.get = async () => { throw new Error('Non-contributors do not need this lookup'); };
assert.equal((await inspectBundledAgain())[0].verdict, 'exclude');
console.log('Passed: bundled exclusions contribute once per policy without losing corrections');
for ( const flags of [
    {}, { shopping_signals: false }, { shopping_signals: true },
] ) {
    let enqueued = 0;
    const context = {
        ...bundledContext,
        sourceAdmissions: new Map(), sourceStates: new Map(), sourceJobs: new Map(),
        settings: () => ({ personalCategories: [], enabled: true, requireSingleDomain: false, simultaneousInspections: 2, sourceControls: {} }),
        deterministicExclusionReasons: () => [],
        decisionCache: {
            getObservation: async () => ({ verdict: 'candidate', ...flags }),
            put: async () => {},
        },
        cachedRecord: (item, observation) => ({ ...item, ...observation, cached: true }),
        normalizeShareableURL: () => undefined,
        enqueue: async (_sourceId, _windowId, item) => {
            enqueued += 1;
            return { ...item, verdict: 'candidate', shopping_signals: false };
        },
        enqueueObservations: async () => {},
    };
    const inspect = vm.runInNewContext(bundledControllerCode, context);
    const [ decision ] = await inspect(1, [ bundledItem ], 'candidate-flags');
    const complete = typeof flags.shopping_signals === 'boolean';
    assert.equal(enqueued, complete ? 0 : 1, JSON.stringify(flags));
    assert.equal(decision.cached === true, complete, 'Full candidate reuse requires a boolean shopping observation');
    assert.equal(decision.verdict, 'candidate', 'Shopping metadata is not an intrinsic exclusion');
}
console.log('Passed: full candidate cache reuse requires a Shopping signals observation');
{
    const queued = [];
    bundledContext.deterministicExclusionReasons = () => [];
    bundledContext.decisionCache.get = async () => undefined;
    bundledContext.normalizeShareableURL = () => undefined;
    let classifications = 0;
    bundledContext.sourceDecision = () => {
        classifications += 1;
        return { categories: [] };
    };
    bundledContext.enqueue = (sourceTabId, sourceWindowId, item, jobs, sharedLookup) => new Promise(resolve => {
        const job = { item, resolve, sourceTabId, sourceWindowId,
            sharedLookups: new Set(sharedLookup === undefined ? [] : [ sharedLookup ]) };
        queued.push(job);
        jobs.add(job);
    });
    const pending = inspectBundledAgain();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(queued.length, 1);
    assert.equal(classifications, 1, 'Queueing reuses the initial source classification');
    assert.deepEqual(Array.from(queued[0].item.sourceCategories), []);
    queued[0].resolve({ ...queued[0].item, verdict: 'unresolved', reasons: [ { kind: 'incomplete_load' } ] });
    const result = await pending;
    assert.equal(result[0].verdict, 'unresolved');
    assert.equal(result[0].reasons[0].kind, 'incomplete_load');
    assert.equal(await inspectBundled(1, [bundledItem], `bundled-batch-${bundledBatch}`), result);
    assert.equal(queued.length, 1, 'Returning to a completed search does not restart it');

    const tabLookups = [];
    bundledContext.browser.tabs.get = async id => {
        tabLookups.push(id);
        return { id, windowId: 23, url: 'https://www.google.com/search?q=current' };
    };
    quereeMessagingContext.inspectResults = inspectBundled;
    const sender = {
        tabId: 17, frameURL: 'https://www.google.com/search?q=sender', windowId: 99,
    };
    let messageResult;
    const request = {
        what: 'inspectResults', items: [ bundledItem ], batchId: 'sender-window-batch',
        tabId: 99, sourceTabId: 99, windowId: 99, sourceWindowId: 99,
        tabURL: 'https://spoof.example/', sourceURL: 'https://www.google.com/search?q=sender',
    };
    await quereeMessageListener(request, sender, result => { messageResult = result; });
    assert.equal(messageResult[0].reasons[0].kind, 'source_changed');
    assert.equal(queued.length, 1, 'A stale scan must not admit work for the new search');
    request.sourceURL = 'https://www.google.com/search?q=current';
    const inspection = quereeMessageListener(request, sender, result => { messageResult = result; });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(tabLookups, [ sender.tabId, sender.tabId ]);
    assert.equal(queued.length, 2);
    assert.equal(queued[1].sourceTabId, sender.tabId);
    assert.equal(queued[1].sourceWindowId, 23, 'Inspection uses the source tab window, not a supplied window ID');
    assert.equal(bundledContext.sourceStates.get(sender.tabId).pageURL,
        request.sourceURL, 'The live tab must match the scan, not the port connection URL');
    queued[1].resolve({ ...queued[1].item, verdict: 'candidate' });
    await inspection;
    assert.equal(messageResult[0].id, bundledItem.id);
    assert.equal(messageResult[0].verdict, 'candidate');
}
console.log('Passed: actual message handler uses native tab/window identity and validates the scan URL');

{
    const f = resultPresentationFixture({ names: [ 'category-restart' ] });
    const controlsRead = [];
    const notifications = [];
    let storageChanged;
    const searchURL = 'https://www.google.com/search?q=birds';
    const context = {
        ...bundledContext,
        sourceAdmissions: new Map(), sourceStates: new Map(), sourceJobs: new Map(),
        maxSimultaneousInspections: 8,
        cancelSource() {},
        µb: { isReadyPromise: Promise.resolve(), hiddenSettings: {}, userSettings: {
            quereeEnabled: true, quereePersonalCategories: [],
            quereeExcludeAdvertisingSignals: true, quereeExcludeShoppingSignals: true,
            quereeIncludeCommercialCorporate: false,
        } },
        sourceDecision: (_url, controls) => {
            controlsRead.push(controls.commercial_corporate);
            return controls.commercial_corporate ? { categories: [ 'commercial_corporate' ] } : {
                categories: [ 'commercial_corporate' ], verdict: 'exclude',
                reasons: [ { kind: 'source_category', category: 'commercial_corporate' } ],
            };
        },
        decisionCache: { getObservation: async () => ({ verdict: 'candidate', shopping_signals: false }) },
        browser: {
            storage: { onChanged: { addListener: listener => { storageChanged = listener; } } },
            tabs: {
                get: async id => ({ id, windowId: 1, url: searchURL }),
                query: async () => [ { id: 1 } ],
                sendMessage: async (_id, message) => {
                    notifications.push(message);
                    f.onMessage(message);
                },
            },
        },
    };
    const { inspectResults: inspect, notifyEnabledChanged: notify } = vm.runInNewContext(
        controller.slice(controller.indexOf('function settings()'), controller.indexOf('async function sha256(')).replace(/^export /gm, '') +
        controller.slice(controller.indexOf('async function notifyEnabledChanged('), controller.indexOf('async function refreshProfile(')) +
        controller.slice(controller.indexOf('browser.storage.onChanged.addListener('), controller.indexOf('\nonBroadcast(message =>')) +
        controllerSection('export async function inspectResults(', 'export function isInspectionTab(')
            .replace(/^export /gm, '') + ';({ inspectResults, notifyEnabledChanged })', context);
    f.context.vAPI.messaging.send = (_channel, request) => inspect(1, request.items, request.batchId, searchURL);
    await notify(true);
    await f.scan();
    assert.equal(f.context.recorded.get(f.items[0].url).verdict, 'exclude');
    assert.equal(f.context.selectorReasons.has('#category-restart'), true);
    Object.assign(f.context, { paginationAuto: false, paginationTarget: 30, paginationNext: 'next-page', paginationSource: 'same-search' });
    context.µb.userSettings.quereeIncludeCommercialCorporate = true;
    storageChanged({ quereeIncludeCommercialCorporate: { oldValue: false, newValue: true } }, 'local');
    await new Promise(resolve => setImmediate(resolve));
    await f.context.stylesheetOperation;
    assert.equal(notifications.find(message => message.sourceControls?.commercial_corporate)?.what, 'quereeSettingsChanged');
    assert.deepEqual(controlsRead, [ false, true ], 'Restarted inspection rereads the actual controller source controls');
    assert.equal(f.context.recorded.get(f.items[0].url).verdict, 'candidate');
    assert.equal(f.styles.size, 0, 'A changed source control releases the old hide without reloading the page');
    assert.equal(f.context.paginationAuto, false, 'A source-control restart must not undo Stop loading');
    assert.equal(f.context.paginationTarget, 30);
    assert.equal(f.context.paginationNext, 'next-page');
    assert.equal(f.context.paginationSource, 'same-search');
}
console.log('Passed: actual source-control storage notifications restart classification without unpausing pagination');

const sourceCode = controller.slice(
    controller.indexOf('function sourceDecision('),
    controller.indexOf('function searchPageURL(')
);
const determineExclusions = vm.runInNewContext(
    sourceCode + ';deterministicExclusionReasons', {
        URL, listedDomainReasons, listedSourceDomainReasons, listedPromotionalURLReasons,
        shoppingDomainLists: domainIndexData.categories.shopping_domain,
    }
);
assert.equal(determineExclusions('https://amazon.com/').length, 0,
    'Shopping-list matches never stop a page before inspection');
assert.equal(determineExclusions('https://goodilmp.click/').length, 0,
    'Scam domains are handled by mandatory safety, not optional shopping');
assert.ok(determineExclusions('https://slashdot.org/content/sponsor/').some(reason =>
    reason.list === promotionSources[0].name && reason.kind === 'advertising'));
assert.match(controller, /const reasons = deterministicExclusionReasons\(item\.url\)/);
assert.match(controller, /: deterministicExclusionReasons\(url\)/);
console.log('Passed: preflight and redirect exclusion share both website-list inputs');

const safetyExclusions = vm.runInNewContext(sourceCode + ';safetyExclusionReasons', {
    listedDomainReasons, adultDomainLists: adultLists,
    scamDomainLists: domainIndexData.categories.scam_domain,
});
const safetyPrepareCode = controllerSection('async function classifyItem(', 'export function isInspectionTab(');
for ( const [ url, kind ] of [
    [ 'https://goodilmp.click/article', 'scam' ],
    [ 'https://sub.goodilmp.click/article', 'scam' ],
    [ 'https://i.4cdn.org/article', 'adult_domain' ],
] ) {
    for ( const verdict of [ undefined, 'candidate', 'exclude' ] ) {
        const prepare = vm.runInNewContext(`(${safetyPrepareCode})`, {
            getContributionEpoch: () => undefined, safetyExclusionReasons: safetyExclusions,
            sharedCompatibility: {},
            malwareDecision: () => undefined, recheckMalwareResult: result => result,
            record: (item, verdict, reasons) => ({ ...item, verdict, reasons }),
            cacheFingerprint: 'policy-24',
            decisionCache: { getObservation: async () => verdict === undefined ? undefined : {
                verdict, reasons: [ { kind: 'commercial_store' } ], observed_at: new Date(1000).toISOString(),
            } },
            sourceDecision: () => assert.fail('Mandatory safety reached category/social handling'),
        });
        const prepared = await prepare({ url, sourceReasons: [ { kind: 'search_advertising' } ] });
        assert.equal(prepared.decision.verdict, 'exclude');
        assert.equal(prepared.decision.reasons[0].kind, kind,
            'Cached shopping/ad decisions cannot replace current mandatory safety');
        assert.equal(prepared.decision.cached, undefined);
        assert.equal(prepared.cacheDecision, true, 'Safety caches even with contribution disabled');
    }
}
console.log('Passed: fake stores and adult domains precede supplied reasons, categories and cached observations at startup');

let redirectMode;
let redirectDecision;
const redirectTabs = new Map();
const redirectTimers = new Map();
let nextRedirectTimer = 0;
const redirectHooks = vm.runInNewContext(
    controller.slice(controller.indexOf('function rememberExclusion('), controller.indexOf('function malwareDecision(')) +
    recoveryHelpersCode +
    controller.slice(controller.indexOf('function scheduleCompletion('), controller.indexOf('function resetScroll(')) +
    controller.slice(controller.indexOf('function record('), controller.indexOf('function cachedRecord(')) +
    controller.slice(controller.indexOf('export function filterInspectionRequest('),
        controller.indexOf('function cancelJobs(')).replace(/^export /gm, '') +
    ';({ filterInspectionRequest, filterInspectionHeaders, scheduleCompletion, inspectionRequestFinished })', {
        inspectionTabs: redirectTabs, inspectionPopups: new Set(),
        Date, URL, communityDomainFromHostname, firefoxRestrictedHosts,
        matchPersonalCategory, personalDisplayRecord, needsCharacteristicChecks,
        settings: () => ({ personalCategories: [] }), inspectionPollInterval: 3000,
        matchMalwareRequest: () => ({ result: 0 }),
        matchMalwareHeaders: () => ({ result: 0 }),
        matchTrackingRequest: () => ({ result: redirectMode.startsWith('request-tracking') ? 1 : 0 }),
        setTimeout: callback => { redirectTimers.set(++nextRedirectTimer, callback); return nextRedirectTimer; },
        clearTimeout: id => redirectTimers.delete(id),
        completed: () => { redirectDecision = 'completed'; },
        safetyExclusionReasons: () => redirectMode === 'adult' || redirectMode === 'scam'
            ? [ { kind: redirectMode === 'adult' ? 'adult_domain' : 'scam', list: 'hagezi_nsfw', matched_hostname: 'store.example' } ] : [],
        resetScroll: () => {},
        now: () => new Date().toISOString(),
        profile: undefined,
        deterministicProfile: { adult_lists: [ {
            name: 'hagezi_nsfw', sha256: 'a'.repeat(64),
        } ] },
        sharedCompatibility: { adult_domain: `sha256:${'b'.repeat(64)}` },
        sourceDecision: rawURL => communityDomainFromHostname(new URL(rawURL).hostname)
            ? { categories: [ 'community_contribution' ] }
            : redirectMode === 'category'
                ? { verdict: 'exclude', reasons: [ { kind: 'source_category' } ] }
                : undefined,
        deterministicExclusionReasons: () => redirectMode === 'domain'
            ? [ { kind: 'commercial_store', matched_hostname: 'store.example' } ] : [],
        policyCommand: request => ({
            result: (
                (redirectMode === 'request-ad' && request.what === 'matchRequest') ||
                (redirectMode === 'request-tracking-ad' && request.what === 'matchRequest') ||
                (redirectMode === 'header-ad' && request.what === 'matchHeaders') ||
                redirectMode === 'native-urlskip-block'
            ) ? 1 : 0,
            redirectURL: redirectMode.startsWith('native-urlskip')
                ? 'https://personal.example/cleaned' : undefined,
        }),
        contextDetails: () => ({}),
        advertisingReason: (fctxt, _match, url = fctxt.url) => ({ kind: 'advertising', request_url: url }),
        trackingReason: (fctxt, _match, url = fctxt.url) => ({ kind: 'cross_site_tracking', request_url: url }),
        isLANAddress: () => false,
        finish: (_job, decision) => { redirectDecision = decision; },
    }
);
const redirectSource = 'https://shortcut.example/article';
const blockedTarget = 'https://store.example/product';
for ( const mode of [ 'adult', 'scam', 'domain', 'category', 'request-ad', 'request-tracking',
    'request-tracking-ad', 'header-ad', 'subresource-ad', 'original-route' ] ) {
    redirectMode = mode === 'original-route' ? 'domain' : mode;
    redirectDecision = undefined;
    const original = mode === 'original-route' ? `${redirectSource}#/chapter` : redirectSource;
    const expected = mode === 'original-route' ? original : blockedTarget;
    const job = {
        id: 1, url: original, observedURL: 'https://personal.example/old-article',
        requests: new Set(), requestHosts: new Set(), navigationId: 1,
    };
    redirectTabs.set(1, job);
    const fctxt = {
        tabId: 1, type: 'main_frame',
        url: mode === 'original-route' ? redirectSource : blockedTarget,
        isRootDocument: () => true, getIPAddress: () => '203.0.113.10',
    };
    redirectHooks.filterInspectionRequest(fctxt, { requestId: 'root' });
    if ( mode === 'header-ad' ) {
        redirectHooks.filterInspectionHeaders(fctxt, [], [], 200, undefined, { requestId: 'root' });
    }
    if ( mode === 'subresource-ad' ) {
        assert.equal(redirectDecision, undefined);
        job.observedURL = blockedTarget;
        redirectMode = 'request-ad';
        redirectHooks.filterInspectionRequest({
            ...fctxt, url: 'https://advertiser.example/pixel', type: 'image',
            isRootDocument: () => false,
        }, { requestId: 'subresource' });
    }
    assert.equal(redirectDecision.url, expected, mode);
    assert.equal(redirectDecision.final_url, expected, mode);
    assert.equal(redirectDecision.original_url, original, mode);
    if ( mode === 'category' ) { continue; }
    const uploaded = contributionObservation(redirectDecision, { policy_revision: 'test' });
    assert.equal(uploaded.result.url, original, mode);
    assert.equal(uploaded.decision.final_url, expected, mode);
    assert.equal(uploaded.document, undefined, 'Blocked destinations contribute no page text');
    if ( mode.startsWith('request-tracking') ) {
        assert.deepEqual(Array.from(uploaded.decision.reasons, reason => reason.kind),
            mode === 'request-tracking-ad' ? [ 'cross_site_tracking', 'advertising' ] : [ 'cross_site_tracking' ]);
        assert.ok(redirectDecision.reasons.every(reason => reason.request_url === blockedTarget));
        assert.ok(uploaded.decision.reasons.every(reason => reason.host === 'store.example'));
    }
    if ( mode === 'adult' ) {
        assert.equal(uploaded.decision.reasons[0].kind, 'adult_domain');
        assert.deepEqual(uploaded.decision.sender_profile,
            { adult_lists: [ {
                name: 'hagezi_nsfw', sha256: 'a'.repeat(64),
            } ] });
    }
}
console.log('Passed: blocked redirect destinations survive request/header exclusions and contribution');

for ( const host of communityDomains ) {
    for ( const mode of [ 'domain', 'adult', 'scam', 'category', 'request-ad', 'header-ad',
        'subresource-ad', 'subresource-header-ad' ] ) {
        redirectMode = mode;
        redirectDecision = undefined;
        const targetURL = `https://${host}/article`;
        const job = {
            id: 1, url: targetURL, requests: new Set(), requestHosts: new Set(),
            navigationId: 1,
        };
        redirectTabs.set(1, job);
        const fctxt = {
            tabId: 1, url: targetURL, type: 'main_frame',
            isRootDocument: () => true, getIPAddress: () => '203.0.113.10',
        };
        let canceled = redirectHooks.filterInspectionRequest(fctxt, { requestId: 'root' })?.cancel;
        assert.equal(redirectDecision.reasons[0].category, 'community_contribution');
        assert.equal(redirectDecision.verdict, 'uninspected', `${host}: ${mode}`);
        assert.equal(canceled, true, 'A listed Social destination is not loaded');
    }
}
console.log('Passed: listed Social destinations stop before loading regardless of page exclusions or source controls');

{
    const from = 'https://personal.example/article';
    const to = 'https://reddit.com/article';
    redirectMode = 'socket';
    redirectDecision = undefined;
    const job = { id: 1, url: from, requests: new Set(), requestHosts: new Set(), navigationId: 1 };
    redirectTabs.set(1, job);
    const request = target => ({
        tabId: 1, url: target, type: 'main_frame', isRootDocument: () => true,
    });
    redirectHooks.filterInspectionRequest(request(from), { requestId: 'first' });
    redirectMode = 'domain';
    redirectHooks.filterInspectionRequest(request(to), { requestId: 'redirect' });
    assert.equal(redirectDecision.reasons[0].category, 'community_contribution');
    assert.equal(redirectDecision.verdict, 'uninspected');
    assert.equal(redirectDecision.final_url, to);
}
console.log('Passed: an ordinary redirect to a listed Social destination ends inspection immediately');

{
    redirectMode = 'socket';
    const job = {
        id: 1, url: redirectSource, observedURL: redirectSource,
        requests: new Set(), requestHosts: new Set(), navigationId: 1,
        loaded: true, finished: false, sourceCategories: [],
    };
    redirectTabs.set(1, job);
    const request = { tabId: 1, url: 'wss://personal.example/live', type: 'websocket', isRootDocument: () => false };
    redirectHooks.scheduleCompletion(job);
    const timer = job.settleTimer;
    assert.equal(redirectHooks.filterInspectionRequest(request, { requestId: 'socket' }), undefined);
    assert.equal(job.requestHosts.has('personal.example'), true);
    redirectHooks.inspectionRequestFinished({ tabId: 1, requestId: 'socket', type: 'websocket', statusCode: 101 });
    assert.equal(job.requests.size, 0);
    assert.equal(redirectTimers.has(timer), true, 'A late socket preserves the document completion timer');
    const complete = redirectTimers.get(timer);
    redirectTimers.delete(timer);
    complete();
    assert.equal(redirectDecision, 'completed');
    redirectHooks.scheduleCompletion(job);
    const pendingTimer = job.settleTimer;
    redirectHooks.filterInspectionRequest({ ...request, type: 'xmlhttprequest' }, { requestId: 'fetch' });
    assert.equal(redirectTimers.has(pendingTimer), true, 'Background requests leave the inspection clock running');
    assert.equal(job.requests.has('fetch'), true);
    redirectHooks.inspectionRequestFinished({ tabId: 1, requestId: 'fetch', type: 'xmlhttprequest', statusCode: 200 });
    assert.equal(job.settleTimer, pendingTimer, 'Finishing a background request does not postpone inspection');
    redirectMode = 'request-ad';
    redirectDecision = undefined;
    assert.equal(redirectHooks.filterInspectionRequest(request, { requestId: 'ad-socket' }).cancel, true);
    assert.equal(redirectDecision.verdict, 'exclude', 'WebSocket advertising is still checked');
}
console.log('Passed: late WebSockets preserve completion and advertising remains checked on inspected pages');

const decideSource = vm.runInNewContext(
    sourceCode + ';sourceDecision',
    {
        URL,
        communityDomainFromHostname,
        corporateDomainLists: domainIndexData.categories.commercial_corporate,
        governmentDomainLists: domainIndexData.categories.government_education,
        institutionalDomainLists: domainIndexData.categories.professional_publication,
        listedDomainReasons,
        listedSourceDomainReasons,
        publicInterestDomainLists: domainIndexData.categories.public_interest_organization,
        publicSuffixList: {
            getDomain: hostname => hostname.split('.').slice(-2).join('.'),
        },
        restrictedSourceNamespaceFromHostname,
    }
);
const defaultSources = {
    commercial_corporate: false,
    government_education: true,
    professional_publication: true,
    public_interest_organization: true,
};
for ( const source of reviewed ) {
    for ( const host of source.domains ) {
        for ( const hostname of [ host, `www.${host}` ] ) {
            const decision = decideSource(`https://${hostname}/article`, defaultSources);
            const expected = communityDomainFromHostname(hostname) ? 'community_contribution'
                : source.category === 'unclassified' ? undefined : source.category;
            assert.equal(decision?.categories[0], expected, `Reviewed source ${hostname}`);
        }
    }
}
assert.equal(decideSource('https://homepage2.nifty.com/person/', defaultSources), undefined);
console.log('Passed: all reviewed source decisions through the compact index, including shared personal homepages');
const overlapCorporate = [ {} ];
const overlapPublications = [ {} ];
const overlapCharities = [ {} ];
const decideOverlapSource = vm.runInNewContext(
    sourceCode + ';sourceDecision',
    {
        URL,
        communityDomainFromHostname,
        corporateDomainLists: overlapCorporate,
        governmentDomainLists: [],
        institutionalDomainLists: overlapPublications,
        listedSourceDomainReasons: (_url, lists) => lists.length !== 0
            ? [ { matched_hostname: 'overlap.example', list: 'fixture' } ]
            : [],
        publicInterestDomainLists: overlapCharities,
        publicSuffixList: { getDomain: hostname => hostname },
        restrictedSourceNamespaceFromHostname: () => undefined,
    }
);
assert.deepEqual(
    Array.from(decideOverlapSource('https://overlap.example/', defaultSources).categories),
    [ 'commercial_corporate' ],
    'Corporate ownership must take precedence over a publication label'
);
for ( const [ category, matches ] of [
    [ 'commercial_corporate', overlapCorporate ],
    [ 'professional_publication', overlapPublications ],
    [ 'public_interest_organization', overlapCharities ],
] ) {
    for ( const included of [ false, true ] ) {
        const decision = decideOverlapSource('https://overlap.example/', {
            ...defaultSources, [category]: included,
        });
        assert.deepEqual(Array.from(decision.categories), [ category ]);
        assert.equal(decision.reasons[0].category, category);
        assert.equal(decision.verdict, included ? undefined : 'exclude');
    }
    matches.length = 0;
}
assert.equal(decideOverlapSource('https://overlap.example/', defaultSources), undefined);
assert.equal(decideSource('https://www.bing.com/search?q=test',defaultSources),undefined);
assert.equal(decideSource('https://www.google.com/search?q=test',defaultSources),undefined);
console.log('Passed: charity records cannot classify shared search engines');
for ( const url of [
    'https://en.wikipedia.org/wiki/Example',
    'https://www.wikimedia.org/',
    'https://abuse.ch/',
    'https://urlhaus.abuse.ch/',
] ) {
    assert.equal(decideSource(url, defaultSources), undefined, url);
}
assert.doesNotMatch(controller, /company-filter|companyDomainReason|loadCompanyFilter|companyFilterData/);
console.log('Passed: removed PDL cannot classify Wikipedia, Wikimedia or abuse.ch');
const communityDefault = decideSource(
    'https://www.reddit.com/r/example',
    { ...defaultSources, commercial_corporate: true }
);
assert.equal(communityDefault.verdict, undefined);
assert.deepEqual(Array.from(communityDefault.categories), [ 'community_contribution' ]);
const communityDisabled = decideSource(
    'https://www.reddit.com/r/example',
    defaultSources
);
assert.equal(communityDisabled.verdict, undefined, 'Internal Social classification never controls visibility');
assert.equal(communityDisabled.reasons[0].kind, 'source_category');
const governmentDefault = decideSource('https://www.nps.gov/example', defaultSources);
assert.equal(governmentDefault.verdict, undefined);
assert.deepEqual(Array.from(governmentDefault.categories), [ 'government_education' ]);
for ( const url of [
    'https://register-of-charities.charitycommission.gov.uk/example',
    'https://www.cam.ac.uk/example',
    'https://www.example.edu/example',
    'https://www.example.mil/example',
    'https://register.charities.govt.nz/example',
] ) {
    assert.deepEqual(
        Array.from(decideSource(url, defaultSources).categories),
        [ 'government_education' ]
    );
}
assert.equal(
    decideSource('https://nps.gov.evil.test/example', defaultSources),
    undefined
);
assert.equal(
    decideSource('https://example.ac.uk.evil.test/example', defaultSources),
    undefined
);
assert.equal(
    decideSource('https://example.school.nz/example', defaultSources),
    undefined
);
const publicationDefault = decideSource(
    'https://www.addisonindependent.com/example',
    defaultSources
);
assert.equal(publicationDefault.verdict, undefined);
assert.deepEqual(Array.from(publicationDefault.categories), [ 'professional_publication' ]);
const publicationDisabled = decideSource(
    'https://www.addisonindependent.com/example',
    { ...defaultSources, professional_publication: false }
);
assert.equal(publicationDisabled.verdict, 'exclude');
const massMedia = decideSource('https://www.theguardian.com/example', defaultSources);
assert.equal(massMedia.verdict, 'exclude');
assert.deepEqual(Array.from(massMedia.categories), [ 'commercial_corporate' ]);
assert.equal(decideSource('https://www.theguardian.com/example', {
    ...defaultSources, commercial_corporate: true,
}).verdict, undefined);
for ( const host of [ 'city.kagoshima.lg.jp', 'city.saitama.jp', 'city.kawasaki.jp', 'berlin.de', 'argentina.gob.ar' ] ) {
    const url = `https://${host}/article`;
    assert.deepEqual(Array.from(decideSource(url, defaultSources).categories), [ 'government_education' ], host);
    assert.equal(decideSource(url, defaultSources).verdict, undefined, host);
    assert.equal(decideSource(url, { ...defaultSources, government_education: false }).verdict, 'exclude', host);
}
for ( const host of [ 'socar.az', 'ana.co.jp', 'jal.co.jp' ] ) {
    assert.deepEqual(Array.from(decideSource(`https://${host}/article`, defaultSources).categories),
        [ 'commercial_corporate' ], 'Reviewed publisher identity overrides misleading institutional records');
}
assert.deepEqual(Array.from(decideSource('https://fab.mil.br/article', defaultSources).categories), [ 'government_education' ]);
for ( const host of [ 'rlh.be', 'svanen.se' ] ) {
    assert.deepEqual(Array.from(decideSource(`https://${host}/article`, defaultSources).categories), [ 'public_interest_organization' ]);
}
const corporateDefault = decideSource('https://www.apple.com/example', defaultSources);
assert.equal(corporateDefault.verdict, 'exclude');
assert.deepEqual(Array.from(corporateDefault.categories), [ 'commercial_corporate' ]);
assert.equal(corporateDefault.reasons[0].list, 'wikidata_public_companies');
const corporateEnabled = decideSource(
    'https://www.apple.com/example',
    { ...defaultSources, commercial_corporate: true }
);
assert.equal(corporateEnabled.verdict, undefined);
const ycCompany = decideSource('https://www.skyvern.com/blog/article', defaultSources);
assert.equal(ycCompany.verdict, 'exclude');
assert.equal(ycCompany.reasons[0].list, 'yc_companies');
assert.deepEqual(Array.from(ycCompany.categories), [ 'commercial_corporate' ]);
assert.equal(decideSource('https://www.skyvern.com/blog/article', {
    ...defaultSources, commercial_corporate: true,
}).verdict, undefined);
for ( const url of [
    'https://watsi.org/',
    'https://writer.substack.com/article',
    'https://news.ycombinator.com/item?id=1',
    'https://github.com/person/project',
    'https://gitlab.com/person/project',
    'https://beacons.ai/person',
    'https://skyvern.com.example.org/review',
] ) {
    assert.notEqual(decideSource(url, defaultSources)?.categories[0], 'commercial_corporate', url);
}
const corporateCharityOverlap = decideSource(
    'https://www.morganstanley.com/example',
    defaultSources
);
assert.deepEqual(
    Array.from(corporateCharityOverlap.categories),
    [ 'commercial_corporate' ]
);
const charityDefault = decideSource('https://www.rspb.org.uk/birds/', defaultSources);
assert.equal(charityDefault.verdict, undefined);
assert.deepEqual(
    Array.from(charityDefault.categories),
    [ 'public_interest_organization' ]
);
const charityDisabled = decideSource(
    'https://www.rspb.org.uk/birds/',
    { ...defaultSources, public_interest_organization: false }
);
assert.equal(charityDisabled.verdict, 'exclude');
const australianCharity = decideSource(
    'https://www.planthealthaustralia.com.au/about-us/',
    defaultSources
);
assert.equal(australianCharity.verdict, undefined);
assert.deepEqual(
    Array.from(australianCharity.categories),
    [ 'public_interest_organization' ]
);
assert.equal(australianCharity.reasons[0].list, 'acnc_australia');
const usCharity = decideSource('https://hullscoveschoolhouse.org/about', defaultSources);
assert.equal(usCharity.verdict, undefined);
assert.deepEqual(Array.from(usCharity.categories), [ 'public_interest_organization' ]);
assert.equal(usCharity.reasons[0].list, 'irs_charities');
assert.equal(decideSource('https://hullscoveschoolhouse.org/about', {
    ...defaultSources, public_interest_organization: false,
}).verdict, 'exclude');
for ( const host of [
    'eff.org', 'python.org', 'wikimediafoundation.org', 'khanacademy.org',
    'consumerreports.org', 'mayoclinic.org', 'clevelandclinic.org',
] ) {
    const result = decideSource(`https://${host}/about`, defaultSources);
    assert.equal(result.verdict, undefined, host);
    assert.equal(result.categories[0], 'public_interest_organization', host);
    assert(result.reasons.some(reason => reason.list === 'irs_charities'), host);
}
const museum = decideSource(
    'https://www.desertmuseum.org/about/',
    defaultSources
);
assert.equal(museum.verdict, undefined);
assert.deepEqual(
    Array.from(museum.categories),
    [ 'public_interest_organization' ]
);
assert.equal(museum.reasons[0].list, 'wikidata_museums_botanical_gardens');
assert.equal(
    decideSource('https://www.facebook.com/example', defaultSources).categories[0],
    'community_contribution'
);
for ( const hostname of [
    'bbc.co.uk',
    'github.com',
    'hotmail.com',
    'humanitix.com',
    'wix.com',
    'wordpress.com',
] ) {
    assert.deepEqual(
        listedSourceDomainReasons(
            `https://${hostname}/example`,
            domainIndexData.categories.public_interest_organization,
            'source_category'
        ),
        [],
        hostname
    );
}
assert.equal(
    listedSourceDomainReasons(
        'https://boorowamuseum.wordpress.com/example',
        domainIndexData.categories.public_interest_organization,
        'source_category'
    )[0]?.list,
    'wikidata_museums_botanical_gardens'
);
console.log('Passed: source categories use independent visibility controls');

const evidenceBundle = html => ({
    url: 'https://example.test/article',
    finalUrl: 'https://example.test/article',
    status: 200,
    headers: {},
    setCookies: [],
    html,
    renderedHtml: html,
    scriptSrcs: [],
    scriptContents: [],
    stylesheetSrcs: [],
    cssContents: [],
    metas: {},
    requestHosts: [],
    jsGlobals: {},
    domSelectors: new Set(),
    dns: { txt: [], mx: [], cname: [], ns: [], a: [] },
    certSubdomains: [],
    npmDeps: [],
    probes: {},
    warnings: [],
    timings: {},
});
const wooHTML = '<link href="/wp-content/plugins/woocommerce/assets/store.css">';
const commerce = detect(commerceFingerprints, {
    ...evidenceBundle(wooHTML), metas: { generator: 'WordPress 6.8' },
    jsGlobals: { woocommerce_params: 'defined' },
}, 50);
assert.equal(commerce.some(item => item.name === 'WooCommerce'), true);
const mention = detect(
    commerceFingerprints,
    evidenceBundle('<p>I considered WooCommerce but do not run a store.</p>'),
    50
);
assert.equal(mention.some(item => item.name === 'WooCommerce'), false);
const broadDom = detect(
    commerceFingerprints,
    { ...evidenceBundle('<link rel="stylesheet">'), domSelectors: new Set([ 'link' ]) },
    50
);
assert.equal(broadDom.some(item => item.name === 'SummerCart'), false);
console.log('Passed: upstream commerce fingerprints require concrete artifacts');
assert.match(commerceProbe, /a\[href\]\[rel~="sponsored"\]/);
console.log('Passed: declared sponsored links are page-level affiliate evidence');

const commercialDomains = url => listedSourceDomainReasons(
    url,
    domainIndexData.categories.shopping_domain,
    'commercial_store'
);
const amazon = commercialDomains('https://www.amazon.com/example');
assert.equal(amazon.some(item => item.list === 'ut1_shopping'), true);
assert.equal(commercialDomains('https://amazon.com.evil.test/').length, 0);
assert.equal(commercialDomains('https://personal.example/').length, 0);
assert.equal(commercialDomains('https://www.theguardian.com/example').length, 0);
assert.equal(commercialDomains('https://www.nps.gov/example').length, 0);
assert.equal(commercialDomains('https://nps.gov.evil.test/').length, 0);
console.log('Passed: attributed domain categories respect hostname boundaries');
assert.equal(Object.hasOwn(domainIndexData.categories, 'commercial_domain'), false);
assert.deepEqual(domainIndexData.categories.shopping_domain.map(list => list.name),
    [ 'ut1_shopping', 'dropship_retailers' ]);
assert.deepEqual(domainIndexData.categories.scam_domain.map(list => list.name),
    storefrontSources.map(list => list.name));
const classifyBank = vm.runInNewContext(sourceCode + ';sourceDecision', {
    URL, communityDomainFromHostname, restrictedSourceNamespaceFromHostname,
    listedSourceDomainReasons, corporateDomainLists: domainIndexData.categories.commercial_corporate,
    governmentDomainLists: domainIndexData.categories.government_education,
    institutionalDomainLists: [], publicInterestDomainLists: [],
});
for ( const hostname of [ 'bnpparibas.com', 'www.bnpparibas.com', 'sub.bnpparibas.com' ] ) {
    assert.equal(commercialDomains(`https://${hostname}/article`).length, 0, hostname);
    for ( const included of [ false, true ] ) {
        const decision = classifyBank(`https://${hostname}/article`, { commercial_corporate: included });
        assert.deepEqual(Array.from(decision.categories), [ 'commercial_corporate' ]);
        assert.equal(decision.verdict, included ? undefined : 'exclude');
        assert.ok(decision.reasons.some(reason => reason.list === 'ut1_bank'));
    }
}
for ( const hostname of [ 'bnpparibas.com.evil.test', 'notbnpparibas.com' ] ) {
    assert.equal(classifyBank(`https://${hostname}/`, {}), undefined, hostname);
}
for ( const hostname of [ 'goodilmp.click', 'sub.goodilmp.click' ] ) {
    assert.ok(listedDomainReasons(`https://${hostname}/`, domainIndexData.categories.scam_domain, 'scam')
        .some(reason => reason.kind === 'scam'));
    assert.equal(commercialDomains(`https://${hostname}/`).length, 0);
}
assert.equal(listedDomainReasons('https://goodilmp.click.evil.test/',
    domainIndexData.categories.scam_domain, 'scam').length, 0);
console.log('Passed: banks stay corporate, fake stores stay mandatory, and neither group leaks into shopping');

const selectionCode = controller.slice(
    controller.indexOf('function selectCommerceDetection('),
    controller.indexOf('async function completed(')
);
const selectCommerce = vm.runInNewContext(selectionCode + ';selectCommerceDetection');
const cartDetection = { name: 'Cart Functionality', categories: [ 'ecommerce' ] };
const wooDetection = { name: 'WooCommerce', categories: [ 'ecommerce' ] };
assert.equal(selectCommerce([ cartDetection ]), undefined);
assert.equal(selectCommerce([ wooDetection ]).name, 'WooCommerce');
assert.equal(selectCommerce([ cartDetection, wooDetection ]).name, 'WooCommerce');
console.log('Passed: shopping software observation ignores generic cart evidence');

{
    const scripts = new Map([ 'inspection-dom', 'vendor/commerce-signals', 'commerce-probe' ].map(name => [
        `/js/queree/${name}.js`, readFileSync(`${root}/src/js/queree/${name}.js`, 'utf8'),
    ]));
    function actualCommerceFixture() {
        const h = recoveryFixture('https://personal.example/article');
        Object.assign(h.job, { contentReadyAt: undefined, rootHeaders: {}, setCookies: [], xRobotsTags: [],
            captureDocument: true });
        h.job.requestHosts.add('personal.example');
        h.state.record = vm.runInNewContext(controller.slice(controller.indexOf('function record('),
            controller.indexOf('function exclusionRecord(')) + ';record', {
            deterministicProfile: {}, now: () => '2026-11-13T00:00:00.000Z',
        });
        const page = { offer: false, purchase: false, affiliate: false, fail: false, calls: 0 };
        const document = {
            defaultView: { frameElement: null },
            documentElement: { outerHTML: '<html><body>Fictional article</body></html>',
                checkVisibility: () => true },
            querySelectorAll(selector) {
                if ( selector === 'script[type="application/ld+json"]' && page.offer ) {
                    return [ { ownerDocument: document, textContent: JSON.stringify({
                        '@type': 'Product', offers: { '@type': 'Offer', price: 12 },
                    }) } ];
                }
                if ( selector.includes('[name="add-to-cart"]') && page.purchase ) {
                    return [ { ownerDocument: document, checkVisibility: () => true } ];
                }
                if ( selector === 'a[href],area[href]' && page.affiliate ) {
                    return [ { ownerDocument: document, href: 'https://affiliate.godaddy.com/one',
                        checkVisibility: () => true } ];
                }
                return [];
            },
        };
        document.documentElement.ownerDocument = document;
        const context = vm.createContext({ document, URL, wrappedJSObject: {},
            location: { get href() { return h.state.tab.url; }, origin: new URL(h.job.url).origin } });
        const observe = vm.runInNewContext(controller.slice(controller.indexOf('async function commerceDecision('),
            controller.indexOf('async function completed(')) + ';commerceDecision', {
            commerceConfidence: 50, commerceFingerprints, detect, listedAffiliateLinkReasons,
            listedSourceDomainReasons, shoppingDomainLists: domainIndexData.categories.shopping_domain,
            browser: { tabs: { executeScript: async (_tab, { file }) => {
                if ( file.endsWith('commerce-probe.js') ) {
                    page.calls++;
                    if ( page.fail ) { throw new Error('Synthetic injection failure'); }
                }
                return [ vm.runInContext(scripts.get(file), context) ];
            } } },
        });
        h.state.commerce = observe;
        return { ...h, page };
    }
    {
        const h = actualCommerceFixture();
        h.state.settings = { excludeAdvertisingSignals: true };
        h.page.affiliate = true;
        const observe = h.state.commerce;
        let release;
        let calls = 0;
        h.state.commerce = (...args) => ++calls === 1
            ? new Promise(resolve => { release = () => resolve(observe(...args)); }) : observe(...args);
        const pending = h.hooks.completed(h.job, h.job.navigationId);
        while ( release === undefined ) { await Promise.resolve(); }
        h.state.sectionIDs.add('intro');
        h.state.tab.url = `${h.job.url}#intro`;
        h.state.readiness = () => [ { url: h.state.tab.url, complete: true, content: true } ];
        await h.handlers.updated(1, { url: h.state.tab.url });
        await h.clock.advance(0);
        assert.equal(h.results.length, 1, 'A section retries an interrupted early probe without waiting 20 seconds');
        assert.equal(h.results[0].reasons[0].kind, 'affiliate_tracked_link');
        assert.equal(h.results[0].final_url, h.state.tab.url);
        release();
        await pending;
        assert.equal(h.results.length, 1, 'The old probe cannot publish a second result');
    }
    for ( const failure of [ false, true ] ) {
        const h = actualCommerceFixture();
        h.page.fail = failure;
        h.state.readiness = () => [ { url: h.state.tab.url, complete: true, content: true } ];
        await h.hooks.completed(h.job, h.job.navigationId);
        for ( const id of [ 'intro', 'pricing' ] ) {
            h.state.sectionIDs.add(id);
            h.state.tab.url = `${h.job.url}#${id}`;
            await h.handlers.updated(1, { url: h.state.tab.url });
            await h.clock.advance(0);
        }
        assert.equal(h.page.calls, 1, 'A completed early probe, including an error, remains one-shot across sections');
        h.page.fail = false;
        h.page.affiliate = true;
        await h.clock.advance(20000);
        assert.equal(h.page.calls, 2, 'The final probe still sees later evidence');
        assert.equal(h.results[0].reasons[0].kind, 'affiliate_tracked_link');
    }
    for ( const [ early, positive ] of [ [ true, false ], [ true, true ], [ false, false ] ] ) {
        const h = actualCommerceFixture();
        h.state.settings = { excludeAdvertisingSignals: early, excludeCrossSiteTracking: false,
            excludeShoppingSignals: true };
        h.page.affiliate = early;
        h.page.offer = positive;
        await h.hooks.completed(h.job, h.job.navigationId);
        if ( early === false ) {
            h.page.affiliate = true;
            await h.clock.advance(20000);
        }
        const decision = h.results[0];
        assert.equal(decision.verdict, 'exclude');
        assert.equal(decision.checks_complete, !early);
        assert.equal(decision.shopping_signals, positive ? true : early ? undefined : false,
            'Incomplete negative shopping is unknown, not false');
        const payload = contributionObservation(decision, {}).decision;
        assert.equal(payload.shopping_signals, decision.shopping_signals);
        if ( early && !positive ) {
            assert.equal(decision.shopping_evidence, undefined);
            assert.equal(payload.shopping_evidence, undefined,
                'Partial-negative evidence cannot let the receiver reconstruct shopping=false');
        } else {
            assert.equal(payload.shopping_evidence.product_offer, positive);
        }
        const storage = {};
        const cache = createDecisionCache({
            get: async () => storage, set: async entries => Object.assign(storage, entries),
            remove: async keys => { for ( const key of keys ) { delete storage[key]; } },
            keys: async () => Object.keys(storage),
        }, { now: () => Date.parse(decision.observed_at) });
        const fingerprint = 'a'.repeat(64);
        await cache.put([ decision ], fingerprint);
        const cached = await cache.getObservation(h.job.url, fingerprint);
        assert.equal(cached.shopping_signals, decision.shopping_signals);
        assert.equal(needsCharacteristicChecks(cached, {
            excludeAdvertisingSignals: false, excludeCrossSiteTracking: false, excludeShoppingSignals: true,
        }), early && !positive, 'Switching off Advertising must recheck unknown shopping, but reuse true or complete false');
    }
    for ( const [ finding, settings, early ] of [
        [ 'affiliate', {}, true ],
        [ 'store', {}, true ],
        [ 'offer', {}, false ],
        [ 'affiliate', { excludeAdvertisingSignals: false, excludeCrossSiteTracking: true }, false ],
        [ 'store', { excludeShoppingSignals: false, excludeAdvertisingSignals: true }, false ],
        [ 'affiliate', { personalCategories: [ { name: 'Allowed', enabled: true,
            entries: [ 'personal.example/*' ] } ] }, true ],
        [ 'affiliate', { excludeAdvertisingSignals: false, excludeCrossSiteTracking: false,
            excludeShoppingSignals: false }, true ],
    ] ) {
        const h = actualCommerceFixture();
        h.state.settings = { excludeAdvertisingSignals: true, excludeCrossSiteTracking: true,
            excludeShoppingSignals: true, ...settings };
        h.page.affiliate = finding === 'affiliate';
        h.page.offer = finding === 'store' || finding === 'offer';
        h.page.purchase = finding === 'store';
        await h.hooks.completed(h.job, 1);
        assert.equal(h.page.calls, 1, finding);
        assert.equal(h.results.length, early ? 1 : 0, `${finding}: ${JSON.stringify(settings)}`);
        if ( early ) {
            assert.equal(h.results[0].verdict, 'exclude');
            assert.equal(h.results[0].checks_complete, false);
            assert.equal(h.results[0].reasons[0].kind,
                finding === 'affiliate' ? 'affiliate_tracked_link' : 'commercial_store');
            continue;
        }
        await h.clock.advance(19999);
        assert.equal(h.results.length, 0, 'Nondecisive early evidence cannot waive observation');
        await h.clock.advance(1);
        assert.equal(h.page.calls, 2, 'The actual collector runs again at the deadline');
        assert.equal(h.results[0].checks_complete, true);
        assert.equal(h.results[0].verdict, finding === 'offer' ? 'candidate' : 'exclude');
        if ( finding === 'offer' ) {
            assert.equal(h.results[0].shopping_signals, true);
            assert.ok(h.results[0].document, 'Shopping alone remains eligible for document capture');
        }
    }
    for ( const failure of [ false, true ] ) {
        const h = actualCommerceFixture();
        h.page.fail = failure;
        await h.hooks.completed(h.job, 1);
        assert.equal(h.results.length, 0);
        h.page.fail = false;
        h.page.affiliate = true;
        await h.clock.advance(20000);
        assert.equal(h.page.calls, 2);
        assert.equal(h.results[0].reasons[0].kind, 'affiliate_tracked_link',
            'A negative or failed early probe cannot suppress later evidence');
    }
    {
        const h = actualCommerceFixture();
        h.state.settings = { excludeAdvertisingSignals: true, excludeCrossSiteTracking: false,
            excludeShoppingSignals: true };
        h.state.tracking = true;
        h.hooks.filterInspectionRequest(h.request(), { requestId: 'tracker' });
        assert.equal(h.results.length, 0, 'A waived tracker still needs display checks');
        h.page.offer = true;
        await h.hooks.completed(h.job, 1);
        assert.equal(h.results[0].reasons[0].kind, 'cross_site_tracking');
        assert.equal(h.results[0].shopping_signals, true,
            'Shopping settles display when a prior tracker already excludes the index');
    }
    {
        const h = actualCommerceFixture();
        h.page.offer = true;
        await h.hooks.completed(h.job, 1);
        h.page.offer = false;
        await h.clock.advance(20000);
        assert.equal(h.results[0].verdict, 'candidate');
        assert.equal(h.results[0].shopping_signals, true);
        assert.equal(h.results[0].shopping_evidence.product_offer, true,
            'A later negative must not erase early shopping evidence');
        assert.ok(h.results[0].document);
    }
    for ( const interruption of [ 'route', 'recovery' ] ) {
        const h = actualCommerceFixture();
        let resolve;
        h.state.commerce = () => new Promise(done => { resolve = done; });
        const pending = h.hooks.completed(h.job, 1);
        while ( resolve === undefined ) { await Promise.resolve(); }
        if ( interruption === 'route' ) {
            await h.handlers.history({ tabId: 1, frameId: 0, url: `${h.job.url}#next` });
        } else {
            h.job.recovery = { reason: { kind: 'challenge_page' } };
        }
        resolve({ kind: 'shopping_signals', shopping_signals: true,
            shopping_evidence: { product_offer: true, purchase: true, software: false },
            reasons: [ { kind: 'commercial_store' } ] });
        await pending;
        assert.equal(h.results.length, 0, `A stale early probe cannot finish after ${interruption}`);
        assert.equal(h.job.shoppingSignals, undefined);
    }
    for ( const kind of [ 'advertising', 'tracking' ] ) {
        const h = actualCommerceFixture();
        h.page.offer = true;
        await h.hooks.completed(h.job, 1);
        h.state[kind] = true;
        h.hooks.filterInspectionRequest(h.request(), { requestId: 'late' });
        assert.equal(h.results[0].reasons[0].kind,
            kind === 'tracking' ? 'cross_site_tracking' : 'advertising');
        assert.equal(h.results[0].shopping_signals, true, 'Early shopping evidence is retained');
    }
    {
        const h = actualCommerceFixture();
        h.page.affiliate = true;
        h.state.settings = { excludeAdvertisingSignals: false, excludeCrossSiteTracking: true,
            excludeShoppingSignals: false };
        await h.hooks.completed(h.job, 1);
        h.page.affiliate = false;
        await h.clock.advance(20000);
        assert.equal(h.results[0].reasons[0].kind, 'affiliate_tracked_link',
            'A later negative must not erase an observed index exclusion');
    }
    {
        const h = actualCommerceFixture();
        h.state.settings = { excludeAdvertisingSignals: false, excludeCrossSiteTracking: true,
            excludeShoppingSignals: false };
        h.page.affiliate = true;
        h.page.offer = true;
        await h.hooks.completed(h.job, 1);
        const requestReason = { kind: 'advertising', request_type: 'script' };
        h.job.exclusionReasons.push(requestReason);
        await h.handlers.history({ tabId: 1, frameId: 0, url: `${h.job.url}#next` });
        assert.deepEqual(Array.from(h.job.exclusionReasons), [ requestReason ],
            'A route change discards commerce findings but keeps request evidence');
        assert.equal(h.job.shoppingSignals, undefined);
        assert.equal(h.job.shoppingEvidence, undefined);
        assert.equal(h.job.earlyCommerce, false, 'The new route gets its own early probe');
    }
    console.log('Passed: early and final commerce use the real DOM probe and detector with display, index and late-evidence checks');
}

{
    const probe = {
        url, sponsoredLinks: [], shoppingEvidence: { product_offer: false, purchase: false }, domSelectors: [], html: '',
        scriptSrcs: [], scriptContents: [], stylesheetSrcs: [], metas: {}, jsGlobals: {},
    };
    const observe = vm.runInNewContext(
        controller.slice(controller.indexOf('async function commerceDecision('),
            controller.indexOf('async function completed(')) + ';commerceDecision', {
            commerceConfidence: 50, commerceFingerprints, detect,
            listedAffiliateLinkReasons, listedSourceDomainReasons,
            shoppingDomainLists: domainIndexData.categories.shopping_domain,
            browser: { tabs: { executeScript: async () => [ probe ] } },
        });
    for ( const [ destination, sponsored ] of [
        [ 'https://open.spotify.com/track/fictional', false ],
        [ 'https://newsletter.example/subscribe', false ],
        [ 'https://sponsor.example/offer', true ],
    ] ) {
        probe.html = `<a ${sponsored ? 'rel="sponsored" ' : ''}href="${destination}">Read more</a>`.repeat(3);
        probe.sponsoredLinks = sponsored ? [ destination ] : [];
        const { hooks, job, clock, state, results } = recoveryFixture();
        Object.assign(job, { url, rootHeaders: {}, setCookies: [] });
        state.commerce = observe;
        await hooks.completed(job, 1);
        await clock.advance(0);
        assert.equal(results[0].verdict, sponsored ? 'exclude' : 'candidate', destination);
        if ( sponsored ) {
            assert.equal(results[0].reasons[0].kind, 'affiliate_link');
            assert.equal(results[0].reasons[0].relation, 'sponsored');
        }
    }
    const listedURL = 'https://kristallwelten.swarovski.com/information';
    for ( const purchase of [ false, true ] ) {
        probe.url = listedURL;
        probe.html = '';
        probe.sponsoredLinks = [];
        probe.shoppingEvidence = { product_offer: purchase, purchase };
        const { hooks, job, clock, state, results } = recoveryFixture(listedURL);
        Object.assign(job, { rootHeaders: {}, setCookies: [] });
        state.commerce = observe;
        await hooks.completed(job, 1);
        await clock.advance(0);
        assert.equal(results[0].verdict, purchase ? 'exclude' : 'candidate');
        assert.equal(job.shoppingSignals, true);
        assert.equal(job.shoppingEvidence.product_offer, purchase);
        assert.equal(job.shoppingEvidence.purchase, purchase);
        assert.equal(results[0].reasons[0]?.kind, purchase ? 'commercial_store' : undefined);
    }
    probe.sponsoredLinks = [ 'https://sponsor.example/offer' ];
    const { hooks, job, clock, state, results } = recoveryFixture(listedURL);
    Object.assign(job, { rootHeaders: {}, setCookies: [] });
    state.commerce = observe;
    await hooks.completed(job, 1);
    await clock.advance(0);
    assert.deepEqual(Array.from(results[0].reasons, reason => reason.kind),
        [ 'affiliate_link', 'commercial_store' ]);
    assert.equal(job.shoppingSignals, true, 'Sponsored links do not discard shopping evidence');
    assert.equal(job.shoppingEvidence.purchase, true);

    probe.sponsoredLinks = [];
    probe.url = url;
    probe.shoppingEvidence = { product_offer: false, purchase: false };
    probe.outboundURLs = [ 'https://affiliate.godaddy.com/one' ];
    const single = recoveryFixture();
    Object.assign(single.job, { url, rootHeaders: {}, setCookies: [] });
    single.state.commerce = observe;
    await single.hooks.completed(single.job, 1);
    await single.clock.advance(0);
    const linked = single.results[0];
    assert.equal(linked.verdict, 'exclude');
    assert.equal(linked.reasons[0].kind, 'affiliate_tracked_link',
        'One matching link is sufficient without a three-link threshold');
    const contribution = contributionObservation({
        url, verdict: 'exclude', observed_at: new Date().toISOString(), reasons: linked.reasons,
    }, {});
    assert.equal(contribution.decision.reasons[0].list, 'soteria_affiliate_endpoints');
    assert.equal(contribution.decision.reasons[0].host, 'affiliate.godaddy.com');
    assert.equal(JSON.stringify(contribution).includes('outboundURLs'), false);
    for ( const target of [ 'https://go.banggood.com/one', 'https://s.click.aliexpress.com/two' ] ) {
        probe.outboundURLs = [ target ];
        const observed = await observe({
            url, loaded: true, navigationId: 1, rootHeaders: {}, setCookies: [],
            requestHosts: new Set(),
        }, 1, url);
        assert.equal(observed.reasons[0].kind, 'affiliate_tracked_link');
        assert.equal(observed.reasons[0].list, 'dropship_affiliate_redirects');
    }
}
console.log('Passed: sponsored links exclude while ordinary Spotify and newsletter links remain candidates');

{
    const resets = [];
    let malwareResets = 0;
    let trackingResets = 0;
    const refreshes = [];
    const state = {
        engineReady: Promise.resolve(),
        profileRefresh: undefined, pendingProfileUpdate: undefined,
        sourceStates: new Map([[1, { pending: true }]]),
        settings: () => ({ personalCategories: [], enabled: false }),
        resetMalwareEngine: () => { malwareResets += 1; },
        resetTrackingEngine: () => { trackingResets += 1; },
        refreshProfile: message => { refreshes.push([ 'advertising', message ]); },
        refreshMalwareEngine: message => { refreshes.push([ 'malware', message ]); },
        refreshTrackingEngine: message => { refreshes.push([ 'tracking', message ]); },
        resetProfile: kind => {
            resets.push(kind);
            state.engineReady = undefined;
        },
    };
    const release = vm.runInNewContext(controller.slice(
        controller.indexOf('function releaseIdleProfile('),
        controller.indexOf('function resetProfile(')
    ) + ';releaseIdleProfile', state);
    release();
    assert.equal(resets.length, 0, 'Idle cleanup cannot reset an engine while a batch is pending');
    assert.equal(malwareResets, 0);
    assert.equal(trackingResets, 0);
    state.sourceStates.get(1).pending = false;
    release();
    assert.deepEqual(resets, [], 'The disable event owns engine reset, not idle cleanup');
    assert.equal(malwareResets, 0);
    assert.equal(trackingResets, 0);
    assert.equal(state.pendingProfileUpdate, undefined);
    state.engineReady = undefined;
    release();
    assert.equal(malwareResets, 0, 'Repeated idle cleanup does not reset malware');
    assert.equal(trackingResets, 0, 'Repeated idle cleanup does not reset tracking');
    const message = { assetKey: 'fixture-profile-update' };
    state.settings = () => ({ enabled: true });
    state.pendingProfileUpdate = message;
    state.sourceStates.get(1).pending = true;
    release();
    assert.equal(refreshes.length, 0, 'Profile updates wait for active batches to drain');
    state.sourceStates.get(1).pending = false;
    release();
    await state.profileRefresh;
    assert.deepEqual(refreshes, [ [ 'advertising', message ], [ 'malware', message ], [ 'tracking', message ] ]);
    assert.equal(state.profileRefresh, undefined);
    assert.equal(state.pendingProfileUpdate, undefined);
}

for ( const stalledEngine of [ 'advertising', 'tracking' ] ) {
    let expire;
    let finishLoad;
    let loadFinished = false;
    const sharedLoad = new Promise(resolve => { finishLoad = resolve; })
        .then(() => { loadFinished = true; });
    const context = {
        ...bundledContext,
        sourceAdmissions: new Map(), sourceStates: new Map(), sourceJobs: new Map(),
        policyGeneration: 0,
        settings: () => ({ personalCategories: [], enabled: true, simultaneousInspections: 2, sourceControls: {} }),
        loadEngine: () => stalledEngine === 'advertising' ? sharedLoad : Promise.resolve(),
        loadTrackingEngine: () => stalledEngine === 'tracking' ? sharedLoad : Promise.resolve(),
        setTimeout: callback => { expire = callback; return 1; },
    };
    const inspect = vm.runInNewContext(bundledControllerCode, context);
    const pending = inspect(1, [bundledItem], 'profile-deadline');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof expire, 'function');
    expire();
    const results = await pending;
    assert.equal(results[0].verdict, 'unresolved');
    assert.equal(results[0].reasons[0].kind, 'profile_unavailable');
    assert.match(results[0].reasons[0].detail, /timed out/);
    assert.equal(loadFinished, false, `A timed-out batch leaves the shared ${stalledEngine} load intact`);
    finishLoad();
    await sharedLoad;
    assert.equal(loadFinished, true);
}

for ( const blocked of [ false, true ] ) {
    redirectMode = blocked ? 'native-urlskip-block' : 'native-urlskip';
    redirectDecision = undefined;
    redirectTabs.set(1, {
        id: 1, url: redirectSource, requests: new Set(), requestHosts: new Set(),
        navigationId: 0,
    });
    const result = redirectHooks.filterInspectionRequest({
        tabId: 1, type: 'main_frame', url: redirectSource,
        isRootDocument: () => true,
    }, { requestId: 'native-root' });
    if ( blocked ) {
        assert.equal(result.cancel, true);
        assert.equal(result.redirectUrl, undefined, 'Cancellation wins over URL cleaning');
    } else {
        assert.equal(result.redirectUrl, 'https://personal.example/cleaned');
        assert.equal(redirectDecision, undefined);
    }
}
console.log('Passed: profile deadlines, drain-before-release and native root redirects');

{
    const script = readFileSync(root + '/src/js/queree/search-links.js', 'utf8');
    const registration = JSON.parse(firefoxManifest).content_scripts.find(entry =>
        entry.js.includes('/js/queree/search-links.js')
    );
    assert.equal(registration.all_frames, false);
    assert.equal(registration.run_at, 'document_idle');
    assert.deepEqual(registration.include_globs, [
        '*://www.google.*/*', '*://www.bing.com/*', '*://duckduckgo.com/*',
        '*://yandex.*/*', '*://www.mojeek.com/*', '*://quer.ee/*',
    ]);
    function searchLinksPage(url) {
        const body = resultElement('body');
        const cleanup = [];
        const document = {
            body,
            getElementById: id => body.querySelector(`#${id}`),
            createElement(tag) {
                const node = resultElement(tag);
                node.style = {};
                node.events = {};
                node.addEventListener = (type, callback) => { node.events[type] = callback; };
                return node;
            },
        };
        const context = vm.createContext({
            document, location: new URL(url), URL, URLSearchParams,
            vAPI: { shutdown: { add: callback => cleanup.push(callback) } },
        });
        const inject = () => vm.runInContext(script, context);
        inject();
        return { body, document, context, cleanup, inject };
    }
    const query = 'cats & dogs + 50%';
    const incoming = [
        [ 'Google', 'https://www.google.com/search', 'q' ],
        [ 'Google', 'https://www.google.com.pe/search', 'q' ],
        [ 'Google', 'https://www.google.co.uk/search', 'q' ],
        [ 'Bing', 'https://www.bing.com/search', 'q' ],
        [ 'DuckGo', 'https://duckduckgo.com/', 'q' ],
        [ 'Yandex', 'https://yandex.ru/search/', 'text' ],
        [ 'Mojeek', 'https://www.mojeek.com/search', 'q' ],
        [ 'Quer.ee', 'https://quer.ee/', 'q' ],
    ];
    for ( const [ current, rawURL, param ] of incoming ) {
        const url = new URL(rawURL);
        if ( current === 'Quer.ee' ) { url.hash = new URLSearchParams({ q: query }); }
        else { url.searchParams.set(param, query); }
        const f = searchLinksPage(url.href);
        const box = f.body.children[0];
        const links = box.querySelectorAll('a');
        assert.equal(links.length, 5, current);
        assert.equal(links.some(link => link.textContent === current), false);
        assert.equal(links.some(link => link.textContent === 'DuckDuckGo'), false);
        assert.equal(box.style.position, 'fixed');
        assert.equal(box.style.top, '6px');
        assert.equal(box.style.right, '10px');
        assert.equal(box.style.background, 'transparent');
        assert.equal(box.style.pointerEvents, 'none');
        for ( const link of links ) {
            const target = new URL(link.href);
            const params = link.textContent === 'Quer.ee'
                ? new URLSearchParams(target.hash.slice(1)) : target.searchParams;
            assert.equal(params.get(link.textContent === 'Yandex' ? 'text' : 'q'), query);
            assert.equal(target.searchParams.has('q'), link.textContent !== 'Quer.ee' && link.textContent !== 'Yandex');
            assert.equal(link.style.pointerEvents, 'auto');
        }
        for ( const type of [ 'pointerdown', 'focusin', 'click' ] ) {
            const nextQuery = `new query ${type}`;
            if ( current === 'Quer.ee' ) { f.context.location.hash = new URLSearchParams({ q: nextQuery }); }
            else { f.context.location.searchParams.set(param, nextQuery); }
            box.events[type]();
            const link = links.find(item => item.textContent !== 'Quer.ee' && item.textContent !== 'Yandex');
            assert.equal(new URL(link.href).searchParams.get('q'), nextQuery);
        }
        f.inject();
        assert.equal(f.body.children.length, 1, 'Reinjection replaces the old strip');
        f.cleanup[0]();
        assert.equal(f.body.children.length, 1, 'Old cleanup cannot remove the replacement');
        f.cleanup[1]();
        assert.equal(f.body.children.length, 0);
    }
    for ( const url of [ 'https://example.com/?q=test', 'https://quer.ee/support/',
        'https://notduckduckgo.com/?q=test', 'https://www.bing.com.evil.test/search?q=test',
        'https://www.google.evil.example/search?q=test', 'https://yandex.evil.example/?text=test' ] ) {
        assert.equal(searchLinksPage(url).body.children.length, 0, url);
    }
    const empty = searchLinksPage('https://duckduckgo.com/');
    assert.ok(empty.body.querySelectorAll('a').every(link => new URL(link.href).search === ''));
    console.log('Passed: floating search links preserve queries, native link actions, transparent placement and reinjection across six engines');
}
