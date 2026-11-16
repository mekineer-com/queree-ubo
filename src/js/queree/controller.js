/*******************************************************************************

    Quer.ee inspection controller
    Copyright (C) 2026-present Marcos

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*/

/* globals browser */

import { affiliateLinkSources, promotionSources } from './vendor/website-lists.js';
import {
    beginInspectionHistory,
    discardInspectionHistory,
    finishInspectionHistory,
    observeHistoryCommit,
    setInspectionHistoryEnabled,
    trackInspectionRedirect,
} from './inspection-history.js';
import commerceFingerprints, { commerceEngineSource, commerceFingerprintsSHA256, commerceFingerprintsSource } from './vendor/commerce-fingerprints.js';
import {
    createDecisionCache,
    decisionPolicyFingerprint,
    needsCharacteristicChecks,
    sharedDecisionCompatibility,
    withoutTextDirective,
} from './decision-cache.js';
import {
    createInspectionCookieStore,
    removeInspectionCookieStore,
} from './inspection-context.js';
import {
    domainIndexData,
    listedDomainReasons,
    listedSourceDomainReasons,
    loadDomainIndex,
} from './domain-index.js';
import { eligibilityExceptions, initializeAdProfileAssets, requiredLists, requiredMalwareLists } from './ad-profile.js';
import { enqueueObservations, getContributionEpoch, lookupSharedObservations } from './contribution.js';
import {
    getMalwareGeneration,
    loadMalwareEngine,
    matchMalwareHeaders,
    matchMalwareRequest,
    refreshMalwareEngine,
    resetMalwareEngine,
} from './malware-profile.js';
import { listedAffiliateLinkReasons, listedPromotionalURLReasons, urlPatternMatcher } from './website-lists.js';
import {
    loadPolicyFrame,
    policyCommand,
    policyFrame,
    waitForPolicyEngine,
} from './policy-frame.js';
import {
    loadTrackingEngine, matchTrackingRequest, refreshTrackingEngine, resetTrackingEngine,
} from './tracking-profile.js';
import {
    markInspectionTab,
    startInspectionTabRecovery,
} from './inspection-tab-recovery.js';
import { matchPersonalCategory, personalDisplayRecord } from './personal-categories.js';
import {
    restrictedSourceNamespaceFromHostname,
    restrictedSourceNamespaces,
} from './restricted-namespaces.js';
import { trackingAssetKey, trackingSource } from './tracking-sources.js';
import assets from '../assets.js';
import cacheStorage from '../cachestorage.js';
import { communityDomainFromHostname } from './community-domains.js';
import { createMobileInspectionTabs } from './mobile-inspection-tabs.js';
import { detect } from './vendor/opentechalyzer/detect/engine.js';
import { domainFromHostname } from '../uri-utils.js';
import { isLANAddress } from '../static-net-filtering.js';
import { normalizeShareableURL } from './contribution-core.js';
import { onBroadcast } from '../broadcast.js';
import publicSuffixList from '../../lib/publicsuffixlist/publicsuffixlist.js';
import µb from '../background.js';

const profileId = 'queree-ads';
const inspectionPollInterval = 3000;
const scrollInterval = 750;
const scrollLimit = 20;
const observationPeriod = 20000;
const inspectionTimeout = 70000;
const failureGrace = 20000;
const profilePreparationTimeout = 90000;
const queueStallTimeout = inspectionTimeout + 10000;
const resourceCleanupTimeout = 5000;
const maxSimultaneousInspections = 8;
const maxAwaySearches = 2;
const mobileTabs = createMobileInspectionTabs({
    browser,
    enabled: () => settings().enabled,
    limit: () => settings().simultaneousInspections,
    wake: () => dispatch(),
    takenOver: tabId => {
        const job = inspectionTabs.get(tabId);
        if ( job === undefined ) { return; }
        inspectionTabs.delete(tabId);
        job.cancelled = true;
        finish(job, record(job, 'unresolved', [ { kind: 'inspection_taken_over' } ]));
    },
    changed: state => {
        mobileStateRevision = state.revision;
        queueMicrotask(() => {
            dispatch();
            browser.tabs.query({}).then(tabs => {
                if ( state.revision !== mobileStateRevision ) { return; }
                for ( const tab of tabs ) {
                    if ( tab.incognito ) { continue; }
                    browser.tabs.sendMessage(tab.id, {
                        what: 'quereeMobileInspectionState', ...state,
                    }).catch(() => {});
                }
            }).catch(() => {});
        });
    },
});

export async function getMobileInspectionState() {
    return mobileTabs.status();
}

export async function prepareMobileInspections(sourceId) {
    await µb.isReadyPromise;
    const tab = await browser.tabs.get(sourceId).catch(() => undefined);
    if ( tab?.incognito !== false || tab.active !== true ||
        /^https:\/\/(?:www\.google\.com(?:\.pe)?|www\.bing\.com)\//.test(tab.url) === false ) {
        return { problem: 'source_unavailable' };
    }
    return mobileTabs.prepare(sourceId);
}
const commerceConfidence = 50;
const challengeTitle = /(?:just a moment|attention required|verify you are human|prove your humanity)/i;
const challengeURL = /[?&](?:captcha|challenge)=/i;
const shoppingDomainLists = domainIndexData.categories.shopping_domain;
const scamDomainLists = domainIndexData.categories.scam_domain;
const adultDomainLists = domainIndexData.categories.adult_domain;
const corporateDomainLists = domainIndexData.categories.commercial_corporate;
const governmentDomainLists = domainIndexData.categories.government_education;
const institutionalDomainLists = domainIndexData.categories.professional_publication;
const publicInterestDomainLists = domainIndexData.categories.public_interest_organization;
const deterministicProfile = {
    domain_index: {
        sha256: domainIndexData.sha256,
        byte_length: domainIndexData.byte_length,
    },
    engine: commerceEngineSource,
    fingerprints: {
        source: commerceFingerprintsSource,
        sha256: commerceFingerprintsSHA256,
    },
    malware_lists: requiredMalwareLists,
    tracking_lists: [ trackingSource ],
    shopping_lists: shoppingDomainLists.map(item => ({
        name: item.name,
        sha256: item.sha256,
    })),
    scam_lists: scamDomainLists.map(({ name, sha256 }) => ({ name, sha256 })),
    adult_lists: adultDomainLists.map(({ name, sha256 }) => ({ name, sha256 })),
    url_pattern_matcher: urlPatternMatcher,
    promotion_lists: promotionSources.map(({ name, sha256 }) => ({ name, sha256 })),
    affiliate_link_lists: affiliateLinkSources.map(({ name, sha256 }) => ({ name, sha256 })),
    corporate_lists: corporateDomainLists.map(item => ({
        name: item.name,
        sha256: item.sha256,
        retrieved_at: item.retrieved_at,
    })),
    institutional_lists: institutionalDomainLists.map(item => ({
        name: item.name,
        sha256: item.sha256,
    })),
    restricted_source_namespaces: restrictedSourceNamespaces,
    public_interest_lists: publicInterestDomainLists.map(item => ({
        name: item.name,
        sha256: item.sha256,
        extract_date: item.extract_date,
        retrieved_at: item.retrieved_at,
        rule: item.rule,
    })),
};
const decisionCache = createDecisionCache(cacheStorage, {
    onError: reason => console.info('Quer.ee decision cache:', reason),
});

const inspectionTabs = new Map();
const inspectionPopups = new Set();
const pendingJobs = [];
let queueTimer;
const sourceJobs = new Map();
const sourceStates = new Map();
const sourceAdmissions = new Map();
const sessionMalware = new Map();
let settingsRevision = 0;
// Retained-tab links must not outlive debug-off cleanup.
let inspectionTabGeneration = 0;
let mobileStateRevision;

let activeJobs = 0;
let dispatchPaused = false;
let engineReady;
let policyGeneration = 0;
let profile;
let pendingProfileUpdate;
let profileRefresh;

function now() {
    return new Date().toISOString();
}

function settings() {
    return {
        enabled: µb.userSettings.quereeEnabled === true,
        requireSingleDomain: µb.userSettings.quereeRequireSingleDomain === true,
        excludeAdvertisingSignals: µb.userSettings.quereeExcludeAdvertisingSignals === true,
        excludeCrossSiteTracking: µb.userSettings.quereeExcludeCrossSiteTracking === true,
        excludeShoppingSignals: µb.userSettings.quereeExcludeShoppingSignals === true,
        cleanHistory: µb.userSettings.quereeCleanHistory === true,
        personalCategories: µb.userSettings.quereePersonalCategories,
        sourceControls: {
            commercial_corporate:
                µb.userSettings.quereeIncludeCommercialCorporate === true,
            government_education:
                µb.userSettings.quereeIncludeGovernmentEducation === true,
            professional_publication:
                µb.userSettings.quereeIncludeProfessionalPublications === true,
            public_interest_organization:
                µb.userSettings.quereeIncludePublicInterestOrganizations === true,
        },
        simultaneousInspections: Math.max(
            1,
            Math.min(
                maxSimultaneousInspections,
                Math.floor(Number(µb.userSettings.quereeSimultaneousInspections) || 6)
            )
        ),
    };
}

export function settingsSnapshot() {
    return {
        ...settings(),
        keepUnresolvedTabs: µb.hiddenSettings.quereeKeepUnresolvedTabs === true,
        inspectionTabGeneration,
        revision: settingsRevision,
    };
}

async function sha256(parts) {
    const bytes = new TextEncoder().encode(parts.join('\n'));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte =>
        byte.toString(16).padStart(2, '0')
    ).join('');
}

function profileCompiledLists(lists) {
    return [
        ...lists.map(details => details.content),
        µb.compileFilters(
            eligibilityExceptions.join('\n'),
            { assetKey: 'queree-eligibility-exceptions', trustedSource: true }
        ),
    ];
}

async function loadEngine() {
    if ( engineReady !== undefined ) { return engineReady; }
    const generation = policyGeneration;
    const promise = (async ( ) => {
        await initializeAdProfileAssets(µb, assets);
        const frame = await waitForPolicyEngine();
        const lists = await Promise.all(requiredLists.map(key =>
            µb.getCompiledFilterList(key, { favorLocal: true })
        ));
        if ( lists.some(details =>
            typeof details.content !== 'string' ||
            details.content.includes('NETWORK_FILTERS:GOOD') === false
        ) ) {
            throw new Error('Quer.ee filter profile is incomplete');
        }
        const compiledLists = profileCompiledLists(lists);
        const pslSelfie = structuredClone(publicSuffixList.toSelfie());
        const version = await sha256([ ...compiledLists, JSON.stringify(pslSelfie) ]);
        if ( generation !== policyGeneration ) {
            throw new Error('Quer.ee filter profile changed while loading');
        }
        await loadPolicyFrame(frame, {
            compiledLists,
            pslSelfie,
        });
        if ( generation !== policyGeneration ) {
            throw new Error('Quer.ee filter profile changed while loading');
        }
        profile = { id: profileId, version };
        return frame;
    })();
    const handled = promise.catch(reason => {
        if ( engineReady === handled ) { engineReady = undefined; }
        throw reason;
    });
    engineReady = handled;
    return engineReady;
}

function record(job, verdict, reasons = []) {
    const known = job.exclusionReasons || [];
    // A failed display check cannot undo an observed index exclusion.
    const incomplete = verdict === 'unresolved' && known.length !== 0 && job.cancelled !== true;
    const finalURL = incomplete ? job.observedURL || (job.destinationURL === job.url.split('#', 1)[0]
        ? job.url : job.destinationURL) : job.observedURL;
    return {
        schema: 1,
        id: job.id,
        url: finalURL || job.url,
        original_url: job.url,
        final_url: finalURL,
        result_title: job.result_title,
        result_description: job.result_description,
        contribution_epoch: job.localConnection ? undefined : job.contributionEpoch,
        shared_compatibility: job.sharedCompatibility,
        verdict: incomplete ? 'exclude' : verdict,
        reasons: incomplete ? known : verdict === 'unresolved' ? reasons
            : [ ...known, ...reasons.filter(reason => known.some(item => item.kind === reason.kind) === false) ],
        ...(incomplete ? { inspection_error: reasons[0] } : {}),
        checks_complete: false,
        profile: job.profile,
        deterministic_profile: deterministicProfile,
        ...(job.shoppingEvidence !== undefined
            ? { shopping_evidence: job.shoppingEvidence } : {}),
        ...(typeof job.shoppingSignals === 'boolean'
            ? { shopping_signals: job.shoppingSignals } : {}),
        source_categories: job.sourceCategories || [],
        observed_at: now(),
    };
}

function exclusionRecord(job, reasons) {
    const url = job.observedURL || (job.destinationURL === job.url.split('#', 1)[0]
        ? job.url : job.destinationURL);
    return { ...record(job, 'exclude', reasons), url: url || job.url, final_url: url };
}

function cachedRecord(item, observation) {
    return {
        schema: 1,
        id: item.id,
        url: item.url,
        original_url: item.url,
        ...observation,
        reasons: observation.reasons || [],
        cached: true,
    };
}

async function candidateRecord(job, navigationId, url) {
    if ( job.recovery?.reason !== undefined ) { return; }
    const recovery = job.recovery;
    let document;
    let documentError;
    const capture = job.captureDocument === true && !job.exclusionReasons?.length &&
        job.sourceCategories?.includes('commercial_corporate') !== true;
    if ( capture && job.localConnection ) {
        documentError = 'Local-network page not captured';
    } else if ( capture ) {
        try {
            [ document ] = await browser.tabs.executeScript(job.tabId, {
                file: '/js/queree/document-capture.js',
                runAt: 'document_end',
            });
        } catch (reason) {
            documentError = String(
                reason instanceof Error ? reason.message : reason
            ).slice(0, 256);
        }
    }
    if (
        job.finished || job.navigationId !== navigationId || job.recovery !== recovery ||
        job.loaded !== true
    ) { return; }
    let tab;
    try {
        tab = await browser.tabs.get(job.tabId);
    } catch {
        return;
    }
    if (
        job.finished || job.navigationId !== navigationId || job.recovery !== recovery ||
        job.loaded !== true
    ) { return; }
    if ( challengeTitle.test(tab.title || '') || challengeURL.test(tab.url) ) {
        recoverBeforeFailure(job, { kind: 'challenge_page' });
        scheduleCompletion(job);
        return;
    }
    if (
        tab.url.split('#', 1)[0] !== job.destinationURL ||
        withoutTextDirective(tab.url) !== url ||
        (
            document !== undefined &&
            withoutTextDirective(document?.url || '') !== url
        )
    ) {
        return record(job, 'unresolved', [ { kind: 'stale_observation' } ]);
    }
    const result = record(job, job.exclusionReasons?.length ? 'exclude' : 'candidate');
    result.checks_complete = true;
    result.shopping_signals = job.shoppingSignals === true;
    result.url = result.final_url = withoutTextDirective(tab.url);
    const hostname = new URL(tab.url).hostname;
    const domain = domainFromHostname(hostname) || hostname;
    const external = Array.from(job.requestHosts).some(host =>
        (domainFromHostname(host) || host) !== domain
    );
    if ( external || job.requestHosts.has(hostname) ) {
        result.single_domain = external === false;
    }
    if ( documentError !== undefined ) { result.document_error = documentError; }
    if ( document === undefined ) { return result; }
    document.indexing_directives.complete =
        document.indexing_directives.complete === true &&
        job.xRobotsTags.length <= 8 &&
        job.xRobotsTags.every(value => value.length <= 1024);
    document.indexing_directives.x_robots_tag = job.xRobotsTags
        .slice(0, 8)
        .map(value => value.slice(0, 1024));
    result.document = document;
    return result;
}

function detachFromSource(job) {
    const jobs = sourceJobs.get(job.sourceTabId);
    if ( jobs === undefined ) { return; }
    jobs.delete(job);
    if ( jobs.size === 0 ) {
        sourceJobs.delete(job.sourceTabId);
    }
}

function releaseSlot(job, pending = Promise.resolve()) {
    if ( job.started === false ) { return; }
    Promise.resolve(pending).catch(( ) => { }).finally(( ) => {
        if ( job.slotReleased || (inspectionTabs.get(job.tabId) === job && job.kept !== true) ) { return; }
        job.slotReleased = true;
        activeJobs -= 1;
        if ( dispatchPaused === false ) { dispatch(); }
    });
}

async function cleanupJobResources(job) {
    if ( job.kept === true ) {
        // The user may explore this page; stop inspection-only history tracking.
        discardInspectionHistory(job.tabId);
        if ( job.mobileTab === true ) { mobileTabs.keep(job.tabId); }
        return true;
    }
    if ( job.mobileTab === true ) {
        if ( job.tabId === undefined ) { return true; }
        const cleaned = await mobileTabs.release(job.tabId);
        // The pool may already have lent this ID to the next job.
        if ( inspectionTabs.get(job.tabId) === job ) { inspectionTabs.delete(job.tabId); }
        return cleaned;
    }
    let cookieStoreId = job.cookieStoreId;
    if ( cookieStoreId === undefined && job.contextPromise !== undefined ) {
        try {
            cookieStoreId = await job.contextPromise;
            job.cookieStoreId = cookieStoreId;
        } catch {
        }
    }
    let tabId = job.tabId;
    if ( tabId === undefined && job.tabPromise !== undefined ) {
        try {
            const tab = await job.tabPromise;
            tabId = tab.id;
            job.tabId = tabId;
        } catch {
        }
    }
    if ( tabId !== undefined ) {
        // Late tab creation still owns capacity until that tab really closes.
        inspectionTabs.set(tabId, job);
        let tabClosed = false;
        for ( let attempt = 0; attempt < 2 && tabClosed === false; attempt++ ) {
            try {
                await browser.tabs.remove(tabId);
                tabClosed = true;
            } catch {
                try {
                    const tabs = await browser.tabs.query({});
                    tabClosed = tabs.some(tab => tab.id === tabId) === false;
                } catch {
                }
            }
        }
        if ( tabClosed === false ) {
            discardInspectionHistory(tabId);
            if ( cookieStoreId !== undefined ) {
                removeInspectionCookieStore(cookieStoreId).catch(( ) => { });
            }
            return false;
        }
        inspectionTabs.delete(tabId);
        finishInspectionHistory(tabId).catch(( ) => { });
    }
    if ( cookieStoreId !== undefined ) {
        return removeInspectionCookieStore(cookieStoreId);
    }
    return true;
}

function finalizeJobResources(job) {
    const cleanup = cleanupJobResources(job);
    cleanup.catch(( ) => { });
    if ( job.started ) { releaseSlot(job, cleanup); }
    return new Promise(resolve => {
        const timer = setTimeout(( ) => {
            // A finished job cannot create a tab after a delayed context resolves.
            if ( job.tabPromise === undefined ) { releaseSlot(job); }
            resolve(false);
        }, resourceCleanupTimeout);
        cleanup.then(value => {
            clearTimeout(timer);
            resolve(value);
        }, ( ) => {
            clearTimeout(timer);
            resolve(false);
        });
    });
}

function clearRecovery(job) {
    clearTimeout(job.recovery?.timer);
    job.recovery = undefined;
}

function resumeAfterChallenge(job) {
    clearTimeout(job.recovery.timer);
    job.recovery = { deadline: job.recovery.deadline };
    job.contentReadyAt = undefined;
    resetScroll(job);
}

function recoverBeforeFailure(job, reason) {
    if ( job.finished ) { return; }
    if ( job.rootHeaders?.['cf-mitigated'] === 'challenge' ) {
        reason = { ...reason, challenge_provider: 'cloudflare' };
    }
    if ( reason.kind === 'http_error' && reason.detail === '429' && job.rootHeaders?.['retry-after'] ) {
        reason = { ...reason, retry_after: job.rootHeaders['retry-after'] };
    }
    if ( job.recovery?.reason !== undefined ) {
        // A failed request remains evidence even if the challenge title clears.
        if ( job.recovery.reason.kind === 'challenge_page' ) {
            job.recovery.reason = reason;
        }
        return;
    }
    // Keep the first deadline across repeated failures in this document.
    const recovery = { reason, deadline: job.recovery?.deadline ?? Date.now() + failureGrace };
    job.recovery = recovery;
    recovery.timer = setTimeout(async ( ) => {
        if ( job.finished || job.recovery !== recovery || recovery.reason === undefined ) { return; }
        if ( recovery.reason.kind === 'challenge_page' ) {
            let tab;
            try { tab = await browser.tabs.get(job.tabId); } catch { }
            if ( job.finished || job.recovery !== recovery || recovery.reason === undefined ) { return; }
            if ( recovery.reason?.kind === 'challenge_page' && tab?.status === 'complete' &&
                Number(job.statusCode) < 400 &&
                challengeTitle.test(tab.title || '') === false &&
                challengeURL.test(tab.url) === false ) {
                resumeAfterChallenge(job);
                scheduleCompletion(job, 0);
                return;
            }
        }
        finish(job, record(job, 'unresolved', [ recovery.reason ]));
    }, Math.max(0, recovery.deadline - Date.now()));
}

function finish(job, result) {
    if ( job.finished ) { return; }
    if ( result.verdict === 'candidate' && job.recovery?.reason !== undefined ) { return; }
    job.finished = true;
    rememberMalware(result);
    job.kept = result.verdict === 'unresolved' && job.cancelled !== true &&
        inspectionTabs.get(job.tabId) === job && µb.hiddenSettings.quereeKeepUnresolvedTabs === true;
    if ( job.kept ) {
        result = { ...result, inspection_tab_id: job.tabId, inspection_tab_generation: inspectionTabGeneration };
    }
    clearRecovery(job);
    clearTimeout(job.timeout);
    clearTimeout(job.settleTimer);
    detachFromSource(job);
    finalizeJobResources(job).then(cleaned => {
        if ( cleaned === false ) { console.error('Quer.ee could not clean up an inspection tab'); }
    }, reason => {
        console.error('Quer.ee inspection cleanup failed', reason);
    });
    job.resolve(result);
    if ( (job.started === false || job.kept) && dispatchPaused === false ) { dispatch(); }
}

function releaseKeptInspection(job) {
    job.kept = false;
    finalizeJobResources(job).then(cleaned => {
        if ( cleaned === false ) { console.error('Quer.ee could not release a retained inspection tab'); }
    });
}

function scheduleCompletion(job, delay = inspectionPollInterval) {
    if ( job.finished || job.loaded !== true || job.settleTimer !== undefined ) { return; }
    const navigationId = job.navigationId;
    job.settleTimer = setTimeout(( ) => {
        job.settleTimer = undefined;
        return completed(job, navigationId);
    }, delay);
}

function resetScroll(job) {
    clearTimeout(job.settleTimer);
    job.settleTimer = undefined;
    job.scrollSteps = 0;
    job.scrollEndAt = undefined;
    job.scrollDone = false;
    job.earlyCommerce = false;
}

async function advanceScroll(job, navigationId) {
    if ( job.scrollPending || job.scrollDone ) {
        scheduleCompletion(job);
        return;
    }
    job.scrollPending = true;
    const recovery = job.recovery;
    const routeId = job.routeId;
    let state;
    try {
        [ state ] = await browser.tabs.executeScript(job.tabId, {
            file: '/js/queree/scroll.js',
            runAt: 'document_end',
        });
    } catch {
        if (
            job.finished || job.navigationId !== navigationId || job.recovery !== recovery ||
            job.loaded !== true
        ) { return; }
        finish(job, record(job, 'unresolved', [ { kind: 'scroll_unavailable' } ]));
        return;
    } finally {
        job.scrollPending = false;
    }
    // Section changes invalidate URL snapshots, not successful moves in this sample.
    if (
        job.finished || (job.navigationId !== navigationId &&
            (job.routeId !== routeId || state?.moved !== true)) || job.recovery !== recovery ||
        job.loaded !== true
    ) { return; }
    if ( state?.moved === true ) {
        job.scrollSteps += 1;
        job.scrollEndAt = undefined;
        job.contentReadyAt = undefined;
        if ( job.scrollSteps >= scrollLimit ) { job.scrollDone = true; }
        scheduleCompletion(job, job.scrollDone ? 0 : scrollInterval);
        return;
    }
    if ( state?.moved !== false ) {
        finish(job, record(job, 'unresolved', [ { kind: 'scroll_unavailable' } ]));
        return;
    }
    if ( job.scrollEndAt === undefined ) {
        job.scrollEndAt = Date.now();
        scheduleCompletion(job);
        return;
    }
    const remaining = inspectionPollInterval - (Date.now() - job.scrollEndAt);
    if ( remaining > 0 ) {
        scheduleCompletion(job, remaining);
        return;
    }
    job.scrollDone = true;
    job.contentReadyAt = undefined;
    scheduleCompletion(job, 0);
}

async function commerceDecision(job, navigationId, url) {
    let state;
    try {
        await browser.tabs.executeScript(job.tabId, {
            file: '/js/queree/inspection-dom.js',
            runAt: 'document_end',
        });
        if ( job.finished || job.navigationId !== navigationId ) { return; }
        await browser.tabs.executeScript(job.tabId, {
            file: '/js/queree/vendor/commerce-signals.js',
            runAt: 'document_end',
        });
        if ( job.finished || job.navigationId !== navigationId ) { return; }
        [ state ] = await browser.tabs.executeScript(job.tabId, {
            file: '/js/queree/commerce-probe.js',
            runAt: 'document_end',
        });
    } catch {
        return { kind: 'commerce_probe_unavailable' };
    }
    if (
        job.finished || job.navigationId !== navigationId ||
        job.loaded !== true
    ) { return; }
    if ( state?.url !== url ) { return { kind: 'stale_observation' }; }
    let detections;
    try {
        detections = detect(commerceFingerprints, {
            url: job.url,
            finalUrl: url,
            status: Number(job.statusCode),
            headers: job.rootHeaders,
            setCookies: job.setCookies,
            html: state.html,
            renderedHtml: state.html,
            scriptSrcs: state.scriptSrcs,
            scriptContents: state.scriptContents,
            stylesheetSrcs: state.stylesheetSrcs,
            cssContents: [],
            metas: state.metas,
            requestHosts: [ ...job.requestHosts ],
            jsGlobals: state.jsGlobals,
            dns: { txt: [], mx: [], cname: [], ns: [], a: [] },
            certSubdomains: [],
            npmDeps: [],
            probes: {},
            warnings: [],
            timings: {},
        }, commerceConfidence);
    } catch (reason) {
        return {
            kind: 'commerce_engine_error',
            detail: reason instanceof Error ? reason.message : String(reason),
        };
    }
    const shoppingEvidence = {
        software: selectCommerceDetection(detections) !== undefined,
        ...state.shoppingEvidence,
    };
    const reasons = listedAffiliateLinkReasons(state.outboundURLs);
    if ( state.sponsoredLinks.length !== 0 ) {
        reasons.push({ kind: 'affiliate_link', relation: 'sponsored', links: state.sponsoredLinks });
    }
    if ( shoppingEvidence.product_offer && shoppingEvidence.purchase ) {
        reasons.push({ kind: 'commercial_store', rule: 'product-offer-and-purchase' });
    }
    return {
        kind: 'shopping_signals',
        shopping_signals: shoppingEvidence.software || shoppingEvidence.product_offer ||
            listedSourceDomainReasons(url, shoppingDomainLists).length !== 0,
        shopping_evidence: shoppingEvidence,
        reasons,
    };
}

function selectCommerceDetection(detections) {
    return detections.find(item =>
        item.categories.includes('ecommerce') && item.name !== 'Cart Functionality'
    );
}

async function completed(job, navigationId) {
    if ( job.finished ) { return; }
    let recovery = job.recovery;
    let tab;
    try {
        tab = await browser.tabs.get(job.tabId);
    } catch {
        return;
    }
    if (
        job.finished || job.navigationId !== navigationId || job.recovery !== recovery ||
        job.committedNavigationId !== navigationId ||
        tab.url.split('#', 1)[0] !== job.destinationURL
    ) {
        return;
    }
    const url = withoutTextDirective(tab.url);
    if ( challengeTitle.test(tab.title || '') || challengeURL.test(url) ) {
        recoverBeforeFailure(job, { kind: 'challenge_page' });
        scheduleCompletion(job);
        return;
    }
    if ( job.recovery?.reason?.kind === 'challenge_page' ) {
        resumeAfterChallenge(job);
        recovery = job.recovery;
    }
    if ( job.statusCode === undefined ) {
        if ( job.responseReloaded || recovery?.reason !== undefined ) { return; }
        // A service worker can hide tab-linked response headers. Obtain a real
        // response with one native hard reload, keeping the original deadline.
        job.responseReloaded = true;
        try {
            await browser.tabs.reload(job.tabId, { bypassCache: true });
        } catch (reason) {
            if ( job.finished || job.navigationId !== navigationId || job.recovery !== recovery ) { return; }
            recoverBeforeFailure(job, { kind: 'navigation_failed', detail: String(reason) });
        }
        return;
    }
    const adultReasons = safetyExclusionReasons(url);
    if ( adultReasons.length !== 0 ) {
        finish(job, { ...record(job, 'exclude', adultReasons), url, final_url: url });
        return;
    }
    if ( Number(job.statusCode) >= 400 ) {
        recoverBeforeFailure(job, {
            kind: 'http_error',
            detail: String(job.statusCode),
        });
        return;
    }
    if ( job.recovery?.reason !== undefined ) { return; }
    let state;
    try {
        await browser.tabs.executeScript(job.tabId, {
            file: '/js/queree/inspection-dom.js',
            runAt: 'document_start',
        });
        if ( job.finished || job.navigationId !== navigationId || job.recovery !== recovery ) { return; }
        [ state ] = await browser.tabs.executeScript(job.tabId, {
            file: '/js/queree/readiness.js',
            runAt: 'document_start',
        });
    } catch {
        if (
            job.finished || job.navigationId !== navigationId || job.recovery !== recovery ||
            job.loaded !== true
        ) { return; }
        finish(job, record(job, 'unresolved', [ { kind: 'readiness_unavailable' } ]));
        return;
    }
    if (
        job.finished || job.navigationId !== navigationId || job.recovery !== recovery ||
        job.loaded !== true
    ) { return; }
    if ( state?.content !== true ) {
        job.contentReadyAt = undefined;
    }
    if ( state?.url !== url || state.complete !== true || state.content !== true ) {
        scheduleCompletion(job);
        return;
    }
    if ( job.scrollDone !== true ) {
        await advanceScroll(job, navigationId);
        return;
    }
    job.contentReadyAt ??= Date.now();
    let remaining = observationPeriod - (Date.now() - job.contentReadyAt);
    const early = remaining > 0;
    if ( early && job.earlyCommerce ) {
        scheduleCompletion(job, remaining);
        return;
    }
    if ( early ) { job.earlyCommerce = 'pending'; }
    const commerce = await commerceDecision(job, navigationId, url);
    if ( job.finished || job.navigationId !== navigationId || job.recovery !== recovery ||
        job.loaded !== true ) { return; }
    if ( early ) { job.earlyCommerce = true; }
    if ( commerce?.kind === 'shopping_signals' ) {
        if ( commerce.shopping_signals === true || early === false ) {
            job.shoppingSignals = job.shoppingSignals === true || commerce.shopping_signals;
        }
        if ( commerce.shopping_evidence !== undefined && (early === false ||
            commerce.shopping_evidence.software || commerce.shopping_evidence.product_offer) ) {
            job.shoppingEvidence = job.shoppingEvidence === undefined ? commerce.shopping_evidence
                : Object.fromEntries(Object.entries(commerce.shopping_evidence)
                    .map(([ key, value ]) => [ key, value || job.shoppingEvidence[key] === true ]));
        }
        if ( commerce.reasons.length !== 0 ) { rememberExclusion(job, commerce.reasons); }
        if ( early && job.exclusionReasons?.length &&
            (commerce.reasons.length !== 0 || commerce.shopping_signals === true) ) {
            if ( observeExclusion(job, []) ) { return; }
        }
    } else if ( early === false && commerce !== undefined ) {
        finish(job, record(job, 'unresolved', [ commerce ]));
        return;
    }
    if ( early ) {
        remaining = observationPeriod - (Date.now() - job.contentReadyAt);
        scheduleCompletion(job, Math.max(0, remaining));
        return;
    }
    const result = await candidateRecord(job, navigationId, url);
    if ( result !== undefined ) { finish(job, result); }
}

async function start(job) {
    job.started = true;
    activeJobs += 1;
    job.timeout = setTimeout(( ) => {
        finish(job, record(job, 'unresolved', [ job.recovery?.reason || { kind: 'incomplete_load' } ]));
    }, inspectionTimeout);
    try {
        if ( mobileTabs.android ) {
            job.mobileTab = true;
            job.tabId = mobileTabs.acquire();
            if ( job.tabId === undefined ) {
                finish(job, record(job, 'unresolved', [ { kind: 'private_tab_needed' } ]));
                return;
            }
            inspectionTabs.set(job.tabId, job);
            await browser.tabs.update(job.tabId, {
                url: browser.runtime.getURL('queree-inspection.html') +
                    '?url=' + encodeURIComponent(job.url),
            });
            return;
        }
        job.contextPromise = createInspectionCookieStore();
        const cookieStoreId = await job.contextPromise;
        job.cookieStoreId = cookieStoreId;
        if ( job.finished ) { return; }
        job.tabPromise = browser.tabs.create({
            active: false,
            cookieStoreId,
            url: 'about:blank',
            windowId: job.sourceWindowId,
        });
        const tab = await job.tabPromise;
        job.tabId = tab.id;
        if ( job.finished ) { return; }
        inspectionTabs.set(tab.id, job);
        try {
            await markInspectionTab(tab.id);
        } catch (reason) {
            if ( job.finished ) { return; }
            finish(job, record(job, 'unresolved', [ {
                kind: 'inspection_tag_failed',
                detail: reason instanceof Error ? reason.message : String(reason),
            } ]));
            return;
        }
        if ( job.finished ) { return; }
        let hiddenTabIds;
        try {
            hiddenTabIds = await browser.tabs.hide(tab.id);
        } catch (reason) {
            if ( job.finished ) { return; }
            finish(job, record(job, 'unresolved', [ {
                kind: 'inspection_hide_failed',
                detail: reason instanceof Error ? reason.message : String(reason),
            } ]));
            return;
        }
        if ( job.finished ) { return; }
        if ( hiddenTabIds?.includes(tab.id) !== true ) {
            finish(job, record(job, 'unresolved', [ {
                kind: 'inspection_hide_failed',
            } ]));
            return;
        }
        await beginInspectionHistory(tab.id, job.url, job.cleanHistory);
        if ( job.finished ) { return; }
        await browser.tabs.update(tab.id, { url: job.url });
    } catch (reason) {
        if ( job.finished ) {
            releaseSlot(job);
            return;
        }
        finish(job, record(job, 'unresolved', [ {
            kind: job.mobileTab !== true && job.tabPromise === undefined
                ? 'inspection_context_failed'
                : 'navigation_failed',
            detail: reason instanceof Error ? reason.message : String(reason),
        } ]));
    }
}

function dispatch() {
    if ( pendingJobs.length !== 0 && mobileTabs.android && mobileTabs.size === 0 && mobileTabs.replenishing !== true ) {
        const unavailable = [];
        for ( let i = pendingJobs.length - 1; i >= 0; i-- ) {
            if ( pendingJobs[i].finished !== true && pendingJobs[i].sharedLookups.size ) { continue; }
            const [ job ] = pendingJobs.splice(i, 1);
            if ( job.finished !== true ) { unavailable.push(job); }
        }
        if ( unavailable.length !== 0 ) { cancelJobs(unavailable, 'private_tab_needed'); }
        return;
    }
    const limit = settings().simultaneousInspections;
    const activeBefore = activeJobs;
    while ( activeJobs < limit && pendingJobs.length !== 0 ) {
        if ( mobileTabs.android && mobileTabs.available === 0 ) { break; }
        const job = pendingJobs.shift();
        if ( job.finished ) { continue; }
        start(job);
    }
    while ( pendingJobs[0]?.finished === true ) { pendingJobs.shift(); }
    const awaitingPrivateTabs = mobileTabs.android && mobileTabs.size === 0 && mobileTabs.replenishing;
    if ( activeJobs !== activeBefore || pendingJobs.length === 0 || awaitingPrivateTabs ) {
        clearTimeout(queueTimer);
        queueTimer = undefined;
    }
    // Explicit private-tab setup is not a page failure; FIFO bounds other stalled waits.
    if ( pendingJobs.length !== 0 && awaitingPrivateTabs !== true ) {
        queueTimer ??= setTimeout(( ) => {
            queueTimer = undefined;
            cancelJobs(pendingJobs.splice(0), 'inspection_queue_stalled');
        }, queueStallTimeout);
    }
}

function enqueue(sourceTabId, sourceWindowId, item, batchJobs, sharedLookup) {
    let jobs = sourceJobs.get(sourceTabId);
    if ( jobs === undefined ) {
        jobs = new Set();
        sourceJobs.set(sourceTabId, jobs);
    }
    // A reload changes result IDs, not the page already being inspected.
    for ( const job of jobs ) {
        if ( job.url === item.url && job.contributionEpoch === item.contributionEpoch ) {
            batchJobs.add(job);
            job.sharedLookups.add(sharedLookup);
            return job.promise;
        }
    }
    const { promise, resolve } = Promise.withResolvers();
    const job = {
        id: item.id,
        url: item.url,
        result_title: item.result_title,
        result_description: item.result_description,
        sourceTabId,
        sourceWindowId,
        promise,
        resolve,
        started: false,
        finished: false,
        requests: new Set(),
        requestHosts: new Set(),
        rootHeaders: {},
        xRobotsTags: [],
        setCookies: [],
        sourceControls: item.sourceControls,
        cleanHistory: settings().cleanHistory,
        captureDocument: item.captureDocument === true,
        exclusionReasons: item.exclusionReasons,
        contributionEpoch: item.contributionEpoch,
        sharedCompatibility: item.sharedCompatibility,
        profile: profile && { id: profile.id, version: profile.version },
        sourceCategories: item.sourceCategories || [],
        navigationId: 0,
        scrollSteps: 0,
        scrollDone: false,
        sharedLookups: new Set([ sharedLookup ]),
    };
    batchJobs.add(job);
    jobs.add(job);
    pendingJobs.push(job);
    dispatch();
    return promise;
}

function sourceDecision(rawURL, controls) {
    let url;
    try {
        url = new URL(rawURL);
    } catch {
        return;
    }
    const communityDomain = communityDomainFromHostname(url.hostname);
    if ( communityDomain !== undefined ) {
        const category = 'community_contribution';
        return {
            categories: [ category ],
            reasons: [ { kind: 'source_category', category, matched_hostname: communityDomain } ],
        };
    }
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    const restrictedNamespace = restrictedSourceNamespaceFromHostname(hostname);
    if ( restrictedNamespace !== undefined ) {
        const category = 'government_education';
        return {
            categories: [ category ],
            reasons: [ {
                kind: 'source_category',
                category,
                list: 'restricted_namespace',
                matched_hostname: hostname,
                namespace: restrictedNamespace.namespace,
            } ],
            verdict: controls[category] ? undefined : 'exclude',
        };
    }
    for ( const [ category, lists ] of [
        [ 'government_education', governmentDomainLists ],
        [ 'commercial_corporate', corporateDomainLists ],
        [ 'professional_publication', institutionalDomainLists ],
        [ 'public_interest_organization', publicInterestDomainLists ],
    ] ) {
        const matches = listedSourceDomainReasons(rawURL, lists, 'source_category');
        if ( matches.length === 0 ) { continue; }
        return {
            categories: [ category ],
            reasons: matches.map(reason => ({ ...reason, category })),
            verdict: controls[category] ? undefined : 'exclude',
        };
    }
}

// Hunk-port of single_domain_search/research/website_categories.mjs.
function deterministicExclusionReasons(rawURL) {
    return listedPromotionalURLReasons(rawURL);
}

function safetyExclusionReasons(rawURL) {
    return [
        ...listedDomainReasons(rawURL, adultDomainLists, 'adult_domain'),
        ...listedDomainReasons(rawURL, scamDomainLists, 'scam'),
    ];
}

function searchPageURL(rawURL) {
    const url = new URL(rawURL);
    const bing = url.hostname === 'www.bing.com';
    if ( bing === false && /(^|\.)google\./.test(url.hostname) === false ) {
        url.hash = '';
        return url.href;
    }
    // Keep identity keys and query normalization aligned with the content-script adapters.
    const keys = bing ? [ 'q', 'filters', 'qft', 'scope', 'cc', 'setlang', 'mkt', 'adlt' ]
        : [ 'q', 'tbs', 'tbm', 'udm', 'safe', 'filter', 'nfpr', 'lr', 'cr', 'gl', 'hl',
            'as_q', 'as_epq', 'as_oq', 'as_eq', 'as_sitesearch', 'as_occt', 'as_filetype', 'as_rights' ];
    const stable = new URL(`${url.origin}${url.pathname}`);
    for ( const key of keys ) {
        for ( const value of url.searchParams.getAll(key) ) {
            stable.searchParams.append(key, key === 'q' ? value.trim() : value);
        }
    }
    const offsetKey = bing ? 'first' : 'start';
    const offset = Number(url.searchParams.get(offsetKey));
    if ( offset !== 0 ) { stable.searchParams.set(offsetKey, String(offset)); }
    return stable.href;
}

export async function inspectResults(
    sourceTabId,
    items,
    batchId,
    sourceURL
) {
    if ( inspectionTabs.has(sourceTabId) ) { return []; }
    recoverInspectionTabs();
    const admission = sourceAdmissions.get(sourceTabId) || { kind: 'source_changed', pending: 0 };
    admission.pending += 1;
    sourceAdmissions.set(sourceTabId, admission);
    let sourceTab;
    let currentSettings;
    try {
        await µb.isReadyPromise;
        if ( settings().enabled === false ) { return []; }
        await mobileTabs.initialize();
        if ( mobileTabs.android ) {
            await mobileTabs.status();
            mobileTabs.topUp();
        }
        do {
            while ( profileRefresh !== undefined ) { await profileRefresh; }
            sourceTab = await browser.tabs.get(sourceTabId).catch(( ) => undefined);
        } while ( profileRefresh !== undefined );
        const kind = sourceAdmissions.get(sourceTabId) !== admission ? admission.kind
            : sourceTab === undefined ? 'source_closed'
                : sourceTab.incognito === true ? 'private_window_unsupported'
                    : sourceURL !== undefined && searchPageURL(sourceTab.url) !== searchPageURL(sourceURL)
                        ? 'source_changed' : undefined;
        if ( kind !== undefined ) {
            return items.map(item => record(item, 'unresolved', [ { kind } ]));
        }
        currentSettings = settings();
        if ( currentSettings.enabled === false ) { return []; }
        setInspectionHistoryEnabled(currentSettings.cleanHistory);
    } finally {
        admission.pending -= 1;
        if ( admission.pending === 0 && sourceAdmissions.get(sourceTabId) === admission ) {
            sourceAdmissions.delete(sourceTabId);
        }
    }
    const pageURL = searchPageURL(sourceTab.url);
    const previous = sourceStates.get(sourceTabId);
    const sameSearch = previous?.pageURL === pageURL &&
        previous.policyGeneration === policyGeneration &&
        previous.malwareGeneration === getMalwareGeneration();
    if ( sameSearch ) {
        if ( previous.batchId === batchId ) { return previous.promise; }
        const pending = previous.batches.get(batchId);
        if ( pending !== undefined ) { return pending; }
    }
    let source = previous;
    if ( sameSearch === false || previous.pending === false ) {
        cancelSourceWork(sourceTabId, 'source_changed');
        source = {
            generation: 0, pageURL, policyGeneration,
            malwareGeneration: getMalwareGeneration(), batches: new Map(),
        };
        sourceStates.set(sourceTabId, source);
    }
    source.batchId = batchId;
    source.pending = true;
    source.promise = inspectBatch(sourceTab, items, batchId, source, currentSettings)
        .catch(reason => items.map(item => record(item, 'unresolved', [ {
            kind: 'inspection_failed', detail: String(reason),
        } ])))
        .then(results => results.map(result => personalDisplayRecord(result, currentSettings.personalCategories)))
        .finally(( ) => {
            source.batches.delete(batchId);
            source.pending = source.batches.size !== 0;
            releaseIdleProfile();
        });
    source.batches.set(batchId, source.promise);
    return source.promise;
}

// Firefox's default extensions.webextensions.restrictedDomains. No extension API
// exposes the preference; keep in sync with modules/libpref/init/all.js upstream.
const firefoxRestrictedHosts = new Set([
    'accounts-static.cdn.mozilla.net', 'accounts.firefox.com',
    'addons.cdn.mozilla.net', 'addons.mozilla.org',
    'api.accounts.firefox.com', 'content.cdn.mozilla.net',
    'discovery.addons.mozilla.org', 'oauth.accounts.firefox.com',
    'profile.accounts.firefox.com', 'support.mozilla.org', 'sync.services.mozilla.com',
]);

async function prepareProfile(promise, deadline) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('Filter profile preparation timed out')),
                    Math.max(0, deadline - Date.now()));
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

// The deterministic profile is fixed for this controller's lifetime.
let cacheFingerprintPromise;
let sharedCompatibilityPromise;

async function inspectBatch(sourceTab, allItems, batchId, source, currentSettings) {
    const batchStartedAt = Date.now();
    const sourceTabId = sourceTab.id;
    const sourceGeneration = source.generation;
    const expectedPolicyGeneration = policyGeneration;
    const expectedMalwareGeneration = getMalwareGeneration();
    const staleBatchReason = ( ) => {
        if ( source.generation !== sourceGeneration ) { return 'source_changed'; }
        if ( settings().enabled === false ) { return 'filtering_disabled'; }
        if ( policyGeneration !== expectedPolicyGeneration ||
            getMalwareGeneration() !== expectedMalwareGeneration ) {
            return 'profile_updated';
        }
    };
    const cacheFingerprint = await (cacheFingerprintPromise ??=
        decisionPolicyFingerprint(deterministicProfile));
    let completed = 0;
    const report = result => {
        completed += 1;
        if ( source.generation !== sourceGeneration ) { return result; }
        browser.tabs.sendMessage(sourceTabId, {
            what: 'quereeInspectionProgress',
            batchId,
            completed,
            total: allItems.length,
            decision: {
                id: result.id,
                verdict: result.verdict,
                reasons: result.reasons,
                single_domain: result.single_domain,
                shopping_signals: result.shopping_signals,
                domain_only: result.domain_only,
                checks_complete: result.checks_complete,
                inspection_error: result.inspection_error,
                inspection_tab_id: result.inspection_tab_id,
                inspection_tab_generation: result.inspection_tab_generation,
                cached: result.cached,
                personal_category: personalDisplayRecord(result, currentSettings.personalCategories).personal_category,
            },
        }).catch(( ) => { });
        return result;
    };
    const saved = await Promise.all(allItems.map(item =>
        savedDecision(item, currentSettings, cacheFingerprint)
    ));
    const unavailable = (item, kind, detail) => record(item, 'unresolved',
        [ detail === undefined ? { kind } : { kind, detail } ]);
    if ( settings().enabled === false || source.generation !== sourceGeneration ) {
        const kind = settings().enabled === false ? 'filtering_disabled' : 'source_changed';
        return allItems.map(item => unavailable(item, kind));
    }
    for ( const decision of saved ) { if ( decision !== undefined ) { report(decision); } }
    const items = allItems.filter((_, i) => saved[i] === undefined);
    const merge = fresh => {
        let i = 0;
        return saved.map(decision => decision ?? fresh[i++]);
    };
    if ( items.length === 0 ) { return saved; }
    const profileDeadline = Date.now() + profilePreparationTimeout;
    try {
        await prepareProfile(loadDomainIndex(), profileDeadline);
    } catch (reason) {
        return merge(items.map(item => unavailable(item, 'profile_unavailable', String(reason))));
    }
    const staleReason = staleBatchReason();
    if ( staleReason !== undefined ) {
        return merge(items.map(item => unavailable(item, staleReason)));
    }
    const sharedCompatibility = await (sharedCompatibilityPromise ??=
        sharedDecisionCompatibility(deterministicProfile));
    const setupStaleReason = staleBatchReason();
    if ( setupStaleReason !== undefined ) {
        return merge(items.map(item => unavailable(item, setupStaleReason)));
    }
    const batchJobs = new Set();
    const listed = await Promise.all(items.map(rawItem =>
        classifyItem(rawItem, sharedCompatibility, currentSettings)
    ));
    const privateTabNeeded = mobileTabs.android === true && mobileTabs.size === 0 && mobileTabs.replenishing !== true;
    const canInspectOrLookup = privateTabNeeded === false || getContributionEpoch() !== undefined;
    let malwareFailure;
    if ( canInspectOrLookup && listed.some(entry => entry.item !== undefined) ) {
        try {
            await prepareProfile(loadMalwareEngine(), profileDeadline);
        } catch (reason) {
            malwareFailure = String(reason);
        }
    }
    const prepared = listed.map(entry => {
        if ( entry.item === undefined ) { return entry; }
        if ( canInspectOrLookup === false ) {
            return { decision: unavailable(entry.item, 'private_tab_needed') };
        }
        if ( malwareFailure !== undefined ) {
            return { decision: unavailable(entry.item, 'malware_profile_unavailable', malwareFailure) };
        }
        try {
            const decision = entry.item.exclusionReasons?.length ? undefined : malwareDecision(entry.item);
            return decision === undefined ? entry : { decision };
        } catch (reason) {
            return { decision: unavailable(entry.item, 'malware_profile_unavailable', String(reason)) };
        }
    });
    const shared = lookupSharedObservations(
        prepared.filter(entry => entry.item).map(entry => entry.item.url), sharedCompatibility
    ).then(hits => new Map(hits.map(hit => [ hit.url, hit ]))).catch(() => new Map());
    const sharedObservation = async (url, hit) => {
        let cached;
        let generation;
        do {
            generation = decisionCache.writeGeneration;
            cached = await decisionCache.getObservation(url, cacheFingerprint);
            if ( staleBatchReason() !== undefined ) { return; }
        } while ( generation !== decisionCache.writeGeneration );
        // Work completed during this batch wins even if the server clock is ahead.
        const local = cached !== undefined && (hit === undefined ||
            Date.parse(cached.observed_at) >= batchStartedAt ||
            Date.parse(cached.observed_at) > Date.parse(hit.observed_at));
        const observation = local ? cached : hit;
        if ( observation === undefined ) { return; }
        const personal = matchPersonalCategory(url, currentSettings.personalCategories);
        // Reloaded results can join this job after characteristic settings change.
        if ( (observation.verdict === 'candidate' && typeof observation.shopping_signals !== 'boolean') ||
            needsCharacteristicChecks({ ...observation, personal_category: personal }, settings()) ) { return; }
        return { ...observation, server_sourced: local === false, cached: true };
    };
    let adFailure;
    if ( prepared.some(entry => entry.item !== undefined) ) {
        try {
            await prepareProfile(Promise.all([ loadEngine(), loadTrackingEngine() ]), profileDeadline);
        } catch (reason) {
            adFailure = String(reason);
        }
    }
    const profileStaleReason = staleBatchReason();
    if ( profileStaleReason !== undefined ) {
        return merge(items.map(item => unavailable(item, profileStaleReason)));
    }
    shared.then(async byURL => {
        if ( staleBatchReason() !== undefined ) { return; }
        for ( const job of batchJobs ) {
            if ( job.finished || job.exclusionReasons?.length ) { continue; }
            const destination = job.observedURL || job.destinationURL || job.url;
            if ( normalizeShareableURL(destination) !== normalizeShareableURL(job.url) ) { continue; }
            const hit = byURL.get(normalizeShareableURL(job.url));
            if ( hit === undefined ) { continue; }
            const observation = await sharedObservation(job.url, hit);
            if ( observation === undefined || job.finished || job.exclusionReasons?.length ||
                sessionMalwareDecision(job.url) !== undefined ||
                normalizeShareableURL(job.observedURL || job.destinationURL || job.url) !==
                    normalizeShareableURL(job.url) ) { continue; }
            finish(job, {
                ...record(job, observation.verdict, observation.reasons || []),
                ...observation,
            });
        }
    }).catch(( ) => { }).finally(() => {
        for ( const job of batchJobs ) {
            job.sharedLookups.delete(shared);
            if ( mobileTabs.android !== true || mobileTabs.size !== 0 || mobileTabs.replenishing === true ||
                job.sharedLookups.size !== 0 ) { continue; }
            if ( job.finished ) { continue; }
            if ( job.started === false ) { job.cancelled = true; }
            finish(job, unavailable(job, 'private_tab_needed'));
        }
    });
    const results = await Promise.all(prepared.map(async entry => {
        const staleReason = staleBatchReason();
        if ( staleReason !== undefined ) {
            return record(entry.item || entry.decision, 'unresolved', [ {
                kind: staleReason,
            } ]);
        }
        if ( entry.decision ) {
            return entry.decision;
        }
        const item = entry.item;
        if ( adFailure !== undefined ) {
            const byURL = await shared;
            const observation = await sharedObservation(item.url, byURL.get(normalizeShareableURL(item.url)));
            const malware = sessionMalwareDecision(item.url);
            if ( malware !== undefined ) { return cachedRecord(item, malware); }
            if ( observation !== undefined ) { return cachedRecord(item, observation); }
            return unavailable(item, 'profile_unavailable', adFailure);
        }
        const epoch = normalizeShareableURL(item.url) === undefined
            ? undefined
            : getContributionEpoch();
        const pending = enqueue(sourceTabId, sourceTab.windowId, {
            ...item,
            captureDocument: epoch !== undefined,
            contributionEpoch: epoch,
            sourceControls: currentSettings.sourceControls,
        }, batchJobs, shared);
        return pending.then(result => ({ ...result, id: item.id }));
    }).map((pending, index) => Promise.resolve(pending).then(result =>
        publishResult(result, index)
    )));
    const finalStaleReason = staleBatchReason();
    return merge(finalStaleReason === undefined ? results
        : results.map(result => result.verdict === 'unresolved'
            ? result : unavailable(result, finalStaleReason)));

    function publishResult(result, index) {
        const staleReason = staleBatchReason();
        if ( staleReason !== undefined && result.verdict !== 'unresolved' ) {
            result = unavailable(result, staleReason);
        }
        if ( staleReason === undefined && prepared[index].item !== undefined ) {
            result = recheckMalwareResult(result);
        }
        const knownMalware = staleReason === undefined ? sessionMalwareDecision(result.url) : undefined;
        if ( knownMalware !== undefined && result.reasons?.some(reason => reason.kind === 'malware') !== true ) {
            result = cachedRecord(result, knownMalware);
        }
        const malware = rememberMalware(result);
        if ( malware ) {
            decisionCache.remove(result.url, cacheFingerprint).catch(() => {});
        }
        const visible = { ...result };
        delete visible.document;
        delete visible.document_error;
        delete visible.contribution_epoch;
        const reusable = staleReason === undefined && visible.domain_only !== true &&
            (visible.verdict === 'candidate' || visible.verdict === 'exclude') &&
            (prepared[index].item !== undefined || prepared[index].cacheDecision === true) &&
            visible.reasons?.some(reason => reason.kind === 'malware') !== true;
        // Loaded rules stay fixed for the batch. Publish each checked completion
        // before cleanup or sibling pages can delay newer local evidence.
        if ( reusable ) {
            decisionCache.put([ visible ], cacheFingerprint).catch(( ) => { });
        }
        // Malware is a text-free index withdrawal, never a reusable saved check.
        if ( (reusable || malware) && result.cached !== true ) {
            enqueueObservations([ result ]).catch(( ) => { });
        }
        return report(visible);
    }
}

async function savedDecision(item, currentSettings, cacheFingerprint) {
    try {
        if ( /^https?:$/.test(new URL(item.url).protocol) === false ) { throw new Error('Not HTTP'); }
    } catch {
        return record(item, 'unresolved', [ { kind: 'invalid_url' } ]);
    }
    const personal = matchPersonalCategory(item.url, currentSettings.personalCategories);
    if ( personal?.enabled === false ) {
        return record(item, 'exclude', [ { kind: 'personal_category', category: personal.name } ]);
    }
    // Internal Social addresses never need eligibility or malware processing.
    const community = communityDomainFromHostname(new URL(item.url).hostname);
    if ( community !== undefined ) {
        return record(item, 'uninspected', [ {
            kind: 'source_category', category: 'community_contribution', matched_hostname: community,
        } ]);
    }
    // Search ads are specific to this result, not to the saved destination.
    if ( item.sourceReasons?.length ) { return; }
    let malware = sessionMalwareDecision(item.url);
    if ( malware !== undefined ) { return cachedRecord(item, malware); }
    const observation = await decisionCache.getObservation(item.url, cacheFingerprint);
    malware = sessionMalwareDecision(item.url);
    if ( malware !== undefined ) { return cachedRecord(item, malware); }
    if ( (observation?.verdict === 'exclude' ||
        (observation?.verdict === 'candidate' && typeof observation.shopping_signals === 'boolean')) &&
        needsCharacteristicChecks({ ...observation, personal_category: personal }, currentSettings) === false ) {
        if ( personal === undefined ) {
            await loadDomainIndex();
            const source = sourceDecision(item.url, currentSettings.sourceControls);
            if ( source?.verdict !== undefined ) {
                return cachedRecord(item, {
                    ...observation, verdict: source.verdict,
                    reasons: [ ...(observation.reasons || []), ...source.reasons ],
                });
            }
        }
        return cachedRecord(item, observation);
    }
    if ( firefoxRestrictedHosts.has(new URL(item.url).hostname) ) {
        return record(item, 'unresolved', [ { kind: 'firefox_restricted' } ]);
    }
}

async function classifyItem(rawItem, sharedCompatibility, currentSettings) {
    const item = { ...rawItem, sharedCompatibility, contributionEpoch: getContributionEpoch() };
    const adultReasons = safetyExclusionReasons(item.url);
    if ( adultReasons.length !== 0 ) {
        const decision = record(item, 'exclude', adultReasons);
        return { decision, cacheDecision: true };
    }
    const source = sourceDecision(item.url, currentSettings.sourceControls);
    const categorizedItem = {
        ...item,
        sourceCategories: source?.categories || [],
    };
    if ( item.sourceReasons?.length ) {
        // An ad result is uninspected, but known destination controls still apply.
        const reasons = [ ...item.sourceReasons ];
        if ( source?.verdict !== undefined ) { reasons.push(...source.reasons); }
        const intrinsicReasons = deterministicExclusionReasons(item.url);
        reasons.push(...intrinsicReasons);
        if ( listedSourceDomainReasons(item.url, shoppingDomainLists).length !== 0 ) {
            categorizedItem.shoppingSignals = true;
        }
        return { decision: record(categorizedItem, 'exclude', reasons),
            cacheDecision: intrinsicReasons.length !== 0 };
    }
    if ( source?.verdict !== undefined &&
        matchPersonalCategory(item.url, currentSettings.personalCategories)?.enabled !== true ) {
        return { decision: record(categorizedItem, source.verdict, source.reasons) };
    }
    const reasons = deterministicExclusionReasons(item.url);
    if ( reasons.length !== 0 ) {
        const decision = record(categorizedItem, 'exclude', reasons);
        if ( needsCharacteristicChecks(personalDisplayRecord(decision, currentSettings.personalCategories),
            currentSettings) === false ) {
            return { decision, cacheDecision: true };
        }
        categorizedItem.exclusionReasons = reasons;
    }
    return { item: categorizedItem };
}

export function isInspectionTab(tabId) {
    return inspectionTabs.has(tabId) || inspectionPopups.has(tabId);
}

export async function openInspectionTab(sourceTabId, tabId) {
    const job = inspectionTabs.get(tabId);
    if ( µb.hiddenSettings.quereeKeepUnresolvedTabs !== true ||
        job?.kept !== true || job.sourceTabId !== sourceTabId ) { return false; }
    try {
        if ( job.mobileTab !== true ) { await browser.tabs.show(tabId); }
        await vAPI.tabs.select(tabId);
        return true;
    } catch {
        return false;
    }
}

export async function filterInspectionPopup(sourceTabId, tabId, url, sourceFrameId = 0) {
    const job = inspectionTabs.get(sourceTabId);
    if ( job?.kept ) { return false; }
    inspectionPopups.add(tabId);
    if ( job === undefined || job.finished || !url ) { return true; }
    const navigationId = job.navigationId;
    let openerURL = job.observedURL || job.destinationURL || job.url;
    const tabOrigin = new URL(openerURL).origin;
    if ( sourceFrameId !== 0 ) {
        const frame = await browser.webNavigation.getFrame({ tabId: sourceTabId, frameId: sourceFrameId })
            .catch(() => undefined);
        if ( job.finished || job.navigationId !== navigationId ) { return true; }
        // A missing opening frame cannot be replaced by the top frame's origin.
        if ( frame === undefined ) { return true; }
        openerURL = frame.url;
    }
    const origin = new URL(openerURL).origin;
    const details = { url, type: 'popup', method: 'GET', ipaddress: '',
        originURL: origin, tabOriginURL: tabOrigin };
    try {
        // The target is a new document; advertising uses native popup semantics.
        const malware = job.exclusionReasons?.length || /^https?:/.test(url) === false ? { result: 0 }
            : matchMalwareRequest({ ...details, type: 'main_frame',
                originURL: url, tabOriginURL: url });
        if ( malware.result === 1 ) {
            finish(job, exclusionRecord(job, [ malwareReason(url, malware, 'popup') ]));
            return true;
        }
        const tracking = matchTrackingRequest(details);
        const match = policyCommand({ what: 'matchRequest', details });
        if ( tracking.result === 1 ) {
            const reasons = [ trackingReason(details, tracking) ];
            if ( match.result === 1 ) { reasons.push(advertisingReason(details, match)); }
            observeExclusion(job, reasons);
            return true;
        }
        if ( match.result === 1 ) { cancelAdvertisingRequest(job, details, match); }
    } catch (reason) {
        finish(job, record(job, 'unresolved', [ { kind: 'policy_engine_error', detail: String(reason) } ]));
    }
    return true;
}

export async function getDecisionCacheState() {
    return { count: await decisionCache.count() };
}

export async function clearDecisionCache() {
    sessionMalware.clear();
    await decisionCache.clear();
    return { count: 0 };
}

export async function toggleKeepUnresolvedTabs() {
    await µb.isReadyPromise;
    const keepUnresolvedTabs = µb.hiddenSettings.quereeKeepUnresolvedTabs !== true;
    µb.changeHiddenSettings({ ...µb.hiddenSettings, quereeKeepUnresolvedTabs: keepUnresolvedTabs });
    return { keepUnresolvedTabs };
}

function contextDetails(fctxt) {
    return {
        ipaddress: fctxt.getIPAddress(),
        method: fctxt.getMethodName(),
        originURL: fctxt.getDocOrigin() || fctxt.getTabOrigin() || fctxt.url,
        tabOriginURL: fctxt.getTabOrigin() || fctxt.getDocOrigin() || fctxt.url,
        url: fctxt.url,
        type: fctxt.type,
    };
}

function advertisingReason(fctxt, match, url = fctxt.url) {
    return {
        kind: 'advertising',
        list: profileId,
        rule: match.raw,
        request_url: url,
        request_type: fctxt.type,
    };
}

function trackingReason(fctxt, match, url = fctxt.url) {
    return {
        kind: 'cross_site_tracking', list: trackingSource.name,
        rule: match.raw, request_url: url, request_type: fctxt.type,
    };
}

function malwareReason(url, match, type = 'main_frame') {
    return { kind: 'malware', rule: match.raw, request_url: url, request_type: type };
}

function rememberMalware(result) {
    if ( result.reasons?.some(reason => reason.kind === 'malware') !== true ) { return false; }
    sessionMalware.set(normalizeShareableURL(result.url) || result.url, {
        generation: getMalwareGeneration(),
        decision: { verdict: 'exclude', reasons: result.reasons, observed_at: result.observed_at },
    });
    return true;
}

function sessionMalwareDecision(url) {
    const key = normalizeShareableURL(url) || url;
    const entry = sessionMalware.get(key);
    if ( entry === undefined ) { return; }
    if ( entry.generation !== getMalwareGeneration() ) {
        sessionMalware.delete(key);
        return;
    }
    return entry.decision;
}

function rememberExclusion(job, reasons) {
    job.exclusionReasons ??= [];
    for ( const reason of reasons ) {
        // A route-specific URL verdict must not hide same-document request evidence.
        if ( job.exclusionReasons.some(item => item.kind === reason.kind &&
            (item.request_type !== undefined) === (reason.request_type !== undefined)) ) { continue; }
        job.exclusionReasons.push(reason);
    }
}

function observeExclusion(job, reasons) {
    rememberExclusion(job, reasons);
    const decision = exclusionRecord(job, []);
    const currentSettings = settings();
    // A canceled document cannot finish its other checks; do not wait for its failure timer.
    const rootBlocked = reasons.some(reason => reason.request_type === 'main_frame');
    if ( rootBlocked === false &&
        needsCharacteristicChecks(personalDisplayRecord(decision, currentSettings.personalCategories),
            currentSettings) ) { return false; }
    finish(job, decision);
    return true;
}

function malwareDecision(item, url = item.url) {
    const requestURL = url.split('#', 1)[0];
    const match = matchMalwareRequest({
        url: requestURL, type: 'main_frame', method: 'GET',
        frameId: 0, parentFrameId: -1,
        originURL: requestURL, tabOriginURL: requestURL,
    });
    if ( match.result === 1 ) {
        return { ...record(item, 'exclude', [ malwareReason(requestURL, match) ]), url, final_url: url };
    }
}

function recheckMalwareResult(result) {
    if ( result.verdict === 'uninspected' ||
        (result.verdict === 'exclude' && result.reasons?.length) ) { return result; }
    let decision;
    try {
        decision = malwareDecision(result);
        if ( decision === undefined ) { return result; }
    } catch (reason) {
        decision = record(result, 'unresolved', [ {
            kind: 'malware_profile_unavailable', detail: String(reason),
        } ]);
    }
    // This runs after cache/server replies and asynchronous tab cleanup.
    return { ...decision, contribution_epoch: result.contribution_epoch,
        shared_compatibility: result.shared_compatibility, source_categories: result.source_categories,
        shopping_signals: result.shopping_signals,
        original_url: result.original_url, final_url: result.final_url || result.url };
}

export function filterInspectionRequest(fctxt, details, replay = false) {
    if ( inspectionPopups.has(fctxt.tabId) ) { return { cancel: true }; }
    const { requestId } = details;
    const job = inspectionTabs.get(fctxt.tabId);
    if ( job === undefined ) { return; }
    if ( replay && details.quereeJob !== job ) { return; }
    if ( replay === false ) { details.quereeJob = job; }
    if ( job.finished ) { return job.kept ? {} : { cancel: true }; }
    if ( replay === false && fctxt.isRootDocument() ) {
        resetDestination(job, fctxt.url);
        job.navigationId += 1;
        job.rootRequestId = requestId;
    }
    if ( replay === false ) { details.quereeRoute = job.routeId || 0; }
    const current = requestFromDestination(job, fctxt, details);
    if ( replay && current && details.aliasURL !== undefined ) {
        (job.requestAliases ??= new Map()).set(requestId, details.url);
    }
    if ( replay === false && current ) {
        job.requests.add(requestId);
    }
    if ( replay === false && current ) {
        try {
            job.requestHosts.add(new URL(fctxt.url).hostname);
        } catch {
        }
    }
    if ( replay === false && fctxt.isRootDocument() &&
        communityDomainFromHostname(new URL(fctxt.url).hostname) !== undefined ) {
        finish(job, { ...record(job, 'uninspected', [ {
            kind: 'source_category', category: 'community_contribution',
        } ]), url: fctxt.url, final_url: fctxt.url });
        return { cancel: true };
    }
    if ( replay === false && fctxt.isRootDocument() && finishKnownDestination(job, fctxt.url) ) {
        return { cancel: true };
    }
    try {
        const url = replay ? details.url : fctxt.url;
        const match = job.exclusionReasons?.length ? { result: 0 }
            : matchMalwareRequest({ ...contextDetails(fctxt), url });
        if ( match.result === 1 ) {
            if ( current ) {
                finish(job, exclusionRecord(job, [ malwareReason(url, match, fctxt.type) ]));
            }
            return { cancel: true };
        }
    } catch (reason) {
        if ( current ) {
            finish(job, record(job, 'unresolved', [ {
                kind: 'malware_profile_unavailable', detail: String(reason),
            } ]));
        }
        return { cancel: true };
    }
    let match;
    let tracking;
    try {
        const request = { ...contextDetails(fctxt), url: replay ? details.url : fctxt.url };
        tracking = matchTrackingRequest(request);
        match = policyCommand({
            what: 'matchRequest',
            details: request,
        });
    } catch (reason) {
        if ( current === false ) { return { cancel: true }; }
        finish(job, record(job, 'unresolved', [ {
            kind: 'policy_engine_error',
            detail: reason instanceof Error ? reason.message : String(reason),
        } ]));
        return { cancel: true };
    }
    if ( tracking.result === 1 ) {
        if ( current ) {
            const url = replay ? details.url : fctxt.url;
            const reasons = [ trackingReason(fctxt, tracking, url) ];
            if ( match?.result === 1 ) { reasons.push(advertisingReason(fctxt, match, url)); }
            observeExclusion(job, reasons);
        }
        return { cancel: true };
    }
    if ( match?.result === 1 ) {
        if ( current === false ) { return { cancel: true }; }
        return cancelAdvertisingRequest(job, fctxt, match, replay ? details.url : fctxt.url);
    }
    if ( details.aliasURL === undefined && match?.redirectURL !== undefined ) {
        return { redirectUrl: match.redirectURL };
    }
}

export function filterInspectionHeaders(
    fctxt,
    responseHeaders,
    requestHeaders,
    statusCode,
    proxyInfo,
    details
) {
    const { requestId } = details;
    if ( inspectionPopups.has(fctxt.tabId) ) { return { cancel: true }; }
    const job = inspectionTabs.get(fctxt.tabId);
    if ( job === undefined ) { return; }
    if ( job.finished ) { return job.kept ? {} : { cancel: true }; }
    const current = requestFromDestination(job, fctxt, details) && job.requests.has(requestId);
    const request = { ...contextDetails(fctxt), url: job.requestAliases?.get(requestId) || fctxt.url };
    try {
        const match = job.exclusionReasons?.length ? { result: 0 }
            : matchMalwareHeaders(request, responseHeaders, requestHeaders);
        if ( match.result === 1 ) {
            if ( current ) {
                finish(job, exclusionRecord(job, [ malwareReason(request.url, match, fctxt.type) ]));
            }
            return { cancel: true };
        }
    } catch (reason) {
        if ( current ) {
            finish(job, record(job, 'unresolved', [ {
                kind: 'malware_profile_unavailable', detail: String(reason),
            } ]));
        }
        return { cancel: true };
    }
    const downloadable = (statusCode < 300 || statusCode >= 400) &&
        responseHeaders.some(header => {
            const name = header.name.toLowerCase();
            const value = String(header.value || '').split(';', 1)[0].trim().toLowerCase();
            if ( name === 'content-disposition' && value === 'attachment' ) { return true; }
            // Even stale roots must not reach Firefox's external/download handler.
            return name === 'content-type' && fctxt.isRootDocument() && value !== '' &&
                /^(?:(?:text|image|audio|video)\/|application\/(?:[^/]+\+(?:json|xml)|json|xml|pdf|ogg|(?:x-)?javascript)$)/.test(value) === false;
        });
    if ( current && fctxt.isRootDocument() ) {
        job.statusCode = statusCode;
        job.localConnection = (!proxyInfo || proxyInfo.type === 'direct') && fctxt.getIPAddress().toLowerCase().split(/\s+/).some(address =>
            isLANAddress(address) || /^fe[89ab][0-9a-f]:/.test(address)
        );
        job.rootHeaders = {};
        job.setCookies = [];
        for ( const header of responseHeaders ) {
            const name = header.name.toLowerCase();
            if ( name === 'x-robots-tag' ) {
                job.xRobotsTags.push(String(header.value || ''));
            }
            if ( name === 'set-cookie' ) {
                job.setCookies.push(...String(header.value || '').split(/\r?\n/).filter(Boolean));
                job.rootHeaders[name] = job.setCookies.join('\n');
                continue;
            }
            const value = header.value || '';
            job.rootHeaders[name] = job.rootHeaders[name]
                ? `${job.rootHeaders[name]}, ${value}`
                : value;
        }
    }
    const contentType = responseHeaders.find(header =>
        header.name.toLowerCase() === 'content-type'
    )?.value?.split(';', 1)[0].trim().toLowerCase();
    if ( fctxt.isRootDocument() && statusCode >= 200 && statusCode < 300 && statusCode !== 204 && statusCode !== 205 &&
        /^[^\s/;,]+\/[^\s/;,]+$/.test(contentType || '') &&
        contentType !== 'text/html' && contentType !== 'application/xhtml+xml' ) {
        if ( current ) {
            job.shoppingSignals = listedSourceDomainReasons(fctxt.url, shoppingDomainLists).length !== 0;
            const result = { ...record(job, job.exclusionReasons?.length ? 'exclude' : 'uninspected'),
                url: fctxt.url, final_url: fctxt.url, domain_only: true };
            finish(job, result);
        }
        return { cancel: true };
    }
    let match;
    try {
        match = policyCommand({
            what: 'matchHeaders',
            details: request,
            responseHeaders,
            requestHeaders,
        });
    } catch (reason) {
        if ( current === false ) { return { cancel: true }; }
        finish(job, record(job, 'unresolved', [ {
            kind: 'policy_engine_error',
            detail: reason instanceof Error ? reason.message : String(reason),
        } ]));
        return { cancel: true };
    }
    if ( match?.result === 1 ) {
        if ( current === false ) { return { cancel: true }; }
        return cancelAdvertisingRequest(job, fctxt, match, request.url);
    }
    if ( downloadable ) {
        if ( current && fctxt.isRootDocument() ) {
            finish(job, record(job, 'unresolved', [ { kind: 'download_response' } ]));
        }
        return { cancel: true };
    }
    return {};
}

function resetDestination(job, url) {
    job.routeId = (job.routeId || 0) + 1;
    clearRecovery(job);
    job.destinationURL = url.split('#', 1)[0];
    if ( job.observedURL?.split('#', 1)[0] !== job.destinationURL ) {
        job.observedURL = undefined;
    }
    job.rootRequestId = undefined;
    job.documentURLs = new Set([ job.destinationURL ]);
    job.loaded = false;
    job.contentReadyAt = undefined;
    job.committedNavigationId = undefined;
    job.requests.clear();
    job.requestAliases?.clear();
    job.requestHosts.clear();
    job.rootHeaders = {};
    job.shoppingSignals = undefined;
    job.shoppingEvidence = undefined;
    job.exclusionReasons = undefined;
    job.xRobotsTags = [];
    job.setCookies = [];
    job.statusCode = undefined;
    job.localConnection = false;
    resetScroll(job);
}

function finishKnownDestination(job, url) {
    if ( firefoxRestrictedHosts.has(new URL(url).hostname) ) {
        finish(job, { ...record(job, 'unresolved', [ { kind: 'firefox_restricted' } ]),
            url, final_url: url });
        return true;
    }
    const source = sourceDecision(url, job.sourceControls);
    job.sourceCategories = source?.categories || [];
    if ( job.sourceCategories.includes('community_contribution') ) {
        finish(job, { ...record(job, 'uninspected', source.reasons), url, final_url: url });
        return true;
    }
    const adultReasons = safetyExclusionReasons(url);
    const reasons = adultReasons.length !== 0 ? adultReasons
        : source?.verdict !== undefined &&
            matchPersonalCategory(job.url, settings().personalCategories)?.enabled !== true ? source.reasons
            : deterministicExclusionReasons(url);
    if ( reasons.length === 0 ) { return false; }
    return observeExclusion(job, reasons);
}

function requestFromDestination(job, fctxt, details) {
    if ( details.quereeRoute !== undefined && details.quereeRoute !== (job.routeId || 0) ) { return false; }
    if ( fctxt.isRootDocument() ) {
        return details.requestId === job.rootRequestId &&
            job.documentURLs.has(fctxt.url.split('#', 1)[0]);
    }
    const documentId = details.frameId === 0 ? details.documentId
        : details.parentFrameId === 0 ? details.parentDocumentId : undefined;
    if ( documentId && job.documentId ) {
        if ( job.committedNavigationId !== undefined ) {
            return documentId === job.documentId;
        }
        if ( documentId === job.documentId ) { return false; }
    }
    const url = details.frameId === 0 ? details.documentUrl
        : details.frameAncestors?.find(ancestor => ancestor.frameId === 0)?.url;
    // Missing identity cannot prove staleness. Ancestor URLs preserve genuine
    // subframe evidence; URLs alone cannot distinguish same-URL replacements.
    return url === undefined || job.documentURLs.has(url.split('#', 1)[0]);
}

function cancelAdvertisingRequest(job, fctxt, match, url = fctxt.url) {
    observeExclusion(job, [ advertisingReason(fctxt, match, url) ]);
    return { cancel: true };
}

export function inspectionRequestFinished(details) {
    const job = inspectionTabs.get(details.tabId);
    if ( job === undefined || job.requests.delete(details.requestId) === false ) { return; }
    job.requestAliases?.delete(details.requestId);
    if ( details.type === 'main_frame' && details.redirectUrl ) {
        trackInspectionRedirect(details.tabId, details.redirectUrl);
    }
    // A failed background request isn't proof the page is incomplete.
    if ( details.type === 'main_frame' && (details.error || details.statusCode >= 400) ) {
        recoverBeforeFailure(job, {
            kind: details.error ? 'navigation_failed' : 'http_error',
            detail: details.error || String(details.statusCode),
        });
        return;
    }
    scheduleCompletion(job);
}

function cancelJobs(jobs, kind, detail = '') {
    dispatchPaused = true;
    for ( const job of Array.from(jobs) ) {
        job.cancelled = true;
        finish(job, record(job, 'unresolved', [ { kind, detail } ]));
    }
    dispatchPaused = false;
    dispatch();
}

function cancelSource(tabId, kind = 'source_closed', detail = '') {
    const admission = sourceAdmissions.get(tabId);
    if ( admission !== undefined ) {
        admission.kind = kind;
        sourceAdmissions.delete(tabId);
    }
    cancelSourceWork(tabId, kind, detail);
}

function cancelSourceWork(tabId, kind, detail = '') {
    const source = sourceStates.get(tabId);
    if ( source !== undefined ) {
        clearTimeout(source.navigationTimer);
        source.generation += 1;
        sourceStates.delete(tabId);
    }
    const jobs = sourceJobs.get(tabId);
    if ( jobs === undefined ) { return; }
    cancelJobs(jobs, kind, detail);
}

// Search modes can change before any result has been inspected.
const sourceLocations = new Map();

function updateSourceLocation(tabId, url) {
    const source = sourceStates.get(tabId);
    const pageURL = searchPageURL(url);
    const previousURL = source?.pageURL ?? sourceLocations.get(tabId);
    const next = new URL(url);
    const isSearch = next.hostname === 'www.bing.com'
        ? /^\/(?:news\/)?search$/.test(next.pathname)
        : /(^|\.)google\./.test(next.hostname) && next.pathname === '/search';
    if ( isSearch ) {
        sourceLocations.set(tabId, pageURL);
    } else {
        sourceLocations.delete(tabId);
    }
    if ( pageURL === previousURL ) {
        if ( source !== undefined ) { source.awayAt = undefined; }
        return;
    }
    if ( isSearch ) {
        cancelSource(tabId, 'source_changed');
        browser.tabs.sendMessage(tabId, {
            what: 'quereeSearchURLChanged',
        }).catch(( ) => { });
        return;
    }
    if ( source === undefined ) { return; }
    source.awayAt ??= Date.now();
    const away = Array.from(sourceStates).filter(([, state]) =>
        state.pending && state.awayAt !== undefined
    ).sort((a, b) => a[1].awayAt - b[1].awayAt);
    while ( away.length > maxAwaySearches ) {
        cancelSource(away.shift()[0], 'away_search_limit');
    }
}

function releaseIdleProfile() {
    for ( const source of sourceStates.values() ) {
        if ( source.pending ) { return; }
    }
    if ( settings().enabled === false ) {
        pendingProfileUpdate = undefined;
        // The settings handler already canceled loads and released the engines.
        return;
    }
    if ( profileRefresh !== undefined || pendingProfileUpdate === undefined ) { return; }
    const message = pendingProfileUpdate;
    pendingProfileUpdate = undefined;
    // No batch can use a frame while it is being replaced.
    profileRefresh = Promise.allSettled([
        refreshProfile(message), refreshMalwareEngine(message), refreshTrackingEngine(message),
    ])
        .then(results => {
            for ( const result of results ) {
                if ( result.status === 'rejected' ) {
                    console.error('Quer.ee could not refresh inspection profiles', result.reason);
                }
            }
        }).finally(() => {
            profileRefresh = undefined;
            releaseIdleProfile();
        });
}

function cancelInspectionJobs(kind, detail = '') {
    const jobs = new Set();
    for ( const source of sourceJobs.values() ) {
        for ( const job of source ) { jobs.add(job); }
    }
    cancelJobs(jobs, kind, detail);
}

function resetProfile(kind, detail = '') {
    policyGeneration += 1;
    cancelInspectionJobs(kind, detail);
    policyFrame()?.postMessage({ what: 'reset' }, location.origin);
    engineReady = undefined;
    profile = undefined;
}

async function notifyEnabledChanged(enabled) {
    settingsRevision += 1;
    const snapshot = { ...settingsSnapshot(), enabled };
    const tabs = await browser.tabs.query({});
    if ( snapshot.revision !== settingsRevision ) { return; }
    for ( const tab of tabs ) {
        browser.tabs.sendMessage(tab.id, {
            what: 'quereeSettingsChanged',
            ...snapshot,
        }).catch(( ) => { });
    }
}

async function refreshProfile(message) {
    if ( engineReady === undefined ) { return; }
    const generation = policyGeneration;
    const ready = engineReady;
    try {
        const version = await prepareProfile((async () => {
            await ready;
            const lists = await Promise.all(requiredLists.map(key =>
                µb.getCompiledFilterList(key, { favorLocal: true })
            ));
            return sha256([
                ...profileCompiledLists(lists), JSON.stringify(publicSuffixList.toSelfie()),
            ]);
        })(), Date.now() + profilePreparationTimeout);
        if ( profile?.version === version ) { return; }
    } catch {
    }
    if ( generation !== policyGeneration || ready !== engineReady ) { return; }
    resetProfile(
        'profile_updated',
        JSON.stringify(message.listKeys || [])
    );
}

async function updateInspectionRoute(job, url) {
    const observedURL = withoutTextDirective(url);
    if ( job.committedNavigationId === undefined || job.observedURL === observedURL ) { return; }
    const pending = job.committedNavigationId !== job.navigationId;
    const previousURL = job.observedURL || job.destinationURL || job.url;
    const navigationId = ++job.navigationId;
    const recovery = job.recovery;
    job.observedURL = observedURL;
    clearTimeout(job.settleTimer);
    job.settleTimer = undefined;
    if ( pending === false && observedURL.split('#', 1)[0] === previousURL.split('#', 1)[0] &&
        new URL(observedURL).hash !== '' ) {
        let section;
        try {
            [ section ] = await browser.tabs.executeScript(job.tabId, {
                code: `(() => {
                    if ( location.href !== ${JSON.stringify(url)} ) { return false; }
                    try {
                        return document.getElementById(decodeURIComponent(${JSON.stringify(new URL(observedURL).hash.slice(1))})) !== null;
                    } catch { return false; }
                })()`,
                runAt: 'document_start',
            });
        } catch {
        }
        if ( job.finished || job.navigationId !== navigationId ) { return; }
        job.committedNavigationId = navigationId;
        if ( section === true && job.recovery === recovery ) {
            // Keep the sample and observation deadline, but retry old-URL snapshots.
            if ( job.earlyCommerce === 'pending' ) { job.earlyCommerce = false; }
            scheduleCompletion(job, 0);
            return;
        }
    }
    const previousReasons = deterministicExclusionReasons(previousURL);
    job.exclusionReasons = job.exclusionReasons?.filter(reason => reason.request_type !== undefined ||
        ([ 'affiliate_link', 'affiliate_tracked_link', 'commercial_store' ].includes(reason.kind) === false &&
        previousReasons.some(previous => previous.kind === reason.kind && previous.list === reason.list &&
            previous.rule === reason.rule && previous.request_url === reason.request_url) === false));
    job.shoppingSignals = undefined;
    job.shoppingEvidence = undefined;
    job.destinationURL = url.split('#', 1)[0];
    job.documentURLs.add(job.destinationURL);
    job.routeId = (job.routeId || 0) + 1;
    job.requests.clear();
    job.requestAliases?.clear();
    job.committedNavigationId = navigationId;
    job.contentReadyAt = undefined;
    resetScroll(job);
    if ( finishKnownDestination(job, url) === false ) { scheduleCompletion(job); }
}

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    const source = sourceStates.get(tabId);
    if ( changeInfo.url && source !== undefined ) {
        clearTimeout(source.navigationTimer);
        const sourceGeneration = source.generation;
        source.navigationTimer = setTimeout(async ( ) => {
            if (
                sourceStates.get(tabId) !== source ||
                source.generation !== sourceGeneration
            ) { return; }
            let tab;
            try {
                tab = await browser.tabs.get(tabId);
            } catch {
                return;
            }
            if (
                sourceStates.get(tabId) !== source ||
                source.generation !== sourceGeneration
            ) { return; }
            updateSourceLocation(tabId, tab.url);
        }, 1000);
    } else if ( changeInfo.url ) {
        updateSourceLocation(tabId, changeInfo.url);
    }
    const job = inspectionTabs.get(tabId);
    if ( job === undefined || job.finished ) { return; }
    if ( typeof changeInfo.url === 'string' && /^https?:/.test(changeInfo.url) &&
        changeInfo.url.split('#', 1)[0] === job.destinationURL ) {
        return updateInspectionRoute(job, changeInfo.url);
    }
    // Root requests and commits own readiness; tab status can lag or wait on optional resources.
});

browser.webNavigation.onCommitted.addListener(details => {
    if ( details.frameId !== 0 ) { return; }
    observeHistoryCommit(details);
    updateSourceLocation(details.tabId, details.url);
    const job = inspectionTabs.get(details.tabId);
    if ( job === undefined || job.finished ) { return; }
    if ( job.mobileTab === true &&
        [ 'typed', 'auto_bookmark', 'keyword' ].includes(details.transitionType) ) { return; }
    if ( /^https?:/.test(details.url) === false ) { return; }
    clearRecovery(job);
    // History restoration can commit a new document without a network request.
    const requested = job.committedNavigationId === undefined &&
        job.rootRequestId !== undefined &&
        details.url.split('#', 1)[0] === job.destinationURL;
    if ( requested === false ) {
        // Knowing the restored URL does not supply a response status or headers.
        resetDestination(job, details.url);
    }
    job.observedURL = withoutTextDirective(details.url);
    if ( finishKnownDestination(job, details.url) ) { return; }
    job.navigationId += 1;
    job.contentReadyAt = undefined;
    resetScroll(job);
    job.committedNavigationId = job.navigationId;
    job.documentId = details.documentId;
    // Optional resources need not finish before the parsed page can be inspected.
    job.loaded = true;
    scheduleCompletion(job);
    const navigationId = job.navigationId;
    browser.tabs.executeScript(details.tabId, {
        file: '/js/queree/inspection-dom.js',
        runAt: 'document_start',
    }).then(( ) => {
        if ( job.finished || job.navigationId !== navigationId || inspectionTabs.get(details.tabId) !== job ) { return; }
        return browser.tabs.executeScript(details.tabId, {
            file: '/js/queree/readiness.js',
            runAt: 'document_start',
        });
    }).catch(( ) => { });
});

browser.webNavigation.onHistoryStateUpdated.addListener(details => {
    if ( details.frameId !== 0 ) { return; }
    updateSourceLocation(details.tabId, details.url);
    const job = inspectionTabs.get(details.tabId);
    if ( job === undefined || job.finished ) { return; }
    return updateInspectionRoute(job, details.url);
});

browser.tabs.onRemoved.addListener(tabId => {
    inspectionPopups.delete(tabId);
    sourceLocations.delete(tabId);
    const job = inspectionTabs.get(tabId);
    if ( job !== undefined ) {
        inspectionTabs.delete(tabId);
        if ( job.kept ) { releaseKeptInspection(job); }
        else { finish(job, record(job, 'unresolved', [ { kind: 'inspection_closed' } ])); }
        releaseSlot(job);
    }
    cancelSource(tabId);
});

// Root failures arrive through inspectionRequestFinished with their native
// requestId. webNavigation errors have no requestId and can describe an old load.

browser.storage.onChanged.addListener((changes, area) => {
    if ( area !== 'local' ) { return; }
    const sourceControlsChanged = changes.quereeIncludeCommercialCorporate !== undefined ||
        changes.quereeIncludeGovernmentEducation !== undefined ||
        changes.quereeIncludeProfessionalPublications !== undefined ||
        changes.quereeIncludePublicInterestOrganizations !== undefined;
    if ( changes.quereePersonalCategories !== undefined || sourceControlsChanged ) {
        for ( const tabId of new Set([ ...sourceStates.keys(), ...sourceAdmissions.keys() ]) ) {
            cancelSource(tabId, 'source_changed');
        }
    }
    if ( changes.quereeEnabled !== undefined || changes.quereeRequireSingleDomain !== undefined ||
        changes.quereeExcludeAdvertisingSignals !== undefined ||
        changes.quereeExcludeCrossSiteTracking !== undefined ||
        changes.quereeExcludeShoppingSignals !== undefined ||
        changes.quereeSimultaneousInspections !== undefined || sourceControlsChanged ||
        changes.quereePersonalCategories !== undefined ) {
        const enabled = changes.quereeEnabled !== undefined
            ? changes.quereeEnabled.newValue !== false
            : µb.userSettings.quereeEnabled === true;
        if ( enabled === false ) { inspectionTabGeneration += 1; }
        notifyEnabledChanged(enabled);
        if ( enabled === false ) {
            for ( const job of inspectionTabs.values() ) {
                if ( job.kept ) { releaseKeptInspection(job); }
            }
            resetMalwareEngine();
            resetTrackingEngine();
            resetProfile('filtering_disabled');
        }
    }
    if ( changes.quereeSimultaneousInspections !== undefined ) {
        mobileTabs.topUp();
        dispatch();
    }
    if ( changes.quereeCleanHistory !== undefined ) {
        setInspectionHistoryEnabled(changes.quereeCleanHistory.newValue !== false);
    }
});

onBroadcast(message => {
    if ( message.what === 'hiddenSettingsChanged' ) {
        if ( µb.hiddenSettings.quereeKeepUnresolvedTabs !== true ) {
            inspectionTabGeneration += 1;
            for ( const job of inspectionTabs.values() ) {
                if ( job.kept ) { releaseKeptInspection(job); }
            }
        }
        notifyEnabledChanged(settings().enabled);
    }
    const suffixUpdated = message.what === 'assetUpdated' &&
        message.key === µb.pslAssetKey && message.cached === true;
    const malwareUpdated = message.what === 'quereeMalwareProfileChanged';
    const trackingUpdated = message.what === 'assetUpdated' &&
        message.key === trackingAssetKey && message.cached === true;
    if ( message.what === 'staticFilteringDataChanged' || suffixUpdated || malwareUpdated || trackingUpdated ) {
        const update = suffixUpdated ? { listKeys: [ message.key ] }
            : malwareUpdated ? { listKeys: requiredMalwareLists } : message;
        // Coalesced notices may concern different sources; check both profiles.
        pendingProfileUpdate = pendingProfileUpdate === undefined ? update : {};
        releaseIdleProfile();
    }
});

const recoverInspectionTabs = typeof browser.tabs.hide === 'function'
    ? startInspectionTabRecovery(tabId => {
        const job = inspectionTabs.get(tabId);
        return job?.finished === false || job?.kept === true;
    })
    : () => {};
