/* Quer.ee isolated tracking profile; GPL-3.0-or-later. */

import { loadPolicyFrame, policyCommand, policyFrame, waitForPolicyEngine } from './policy-frame.js';
import { trackingAssetKey, trackingRules, trackingSource } from './tracking-sources.js';
import { CompiledListReader } from '../static-filtering-io.js';
import assets from '../assets.js';
import publicSuffixList from '../../lib/publicsuffixlist/publicsuffixlist.js';
import µb from '../background.js';

const frameId = 'quereeTrackingEngine';
let registered;
let loading;
let readyFrame;
let generation = 0;
let version;
let sourceEpoch = 0;
let writes;

function compileTrackingRules(content) {
    const lists = [];
    trackingRules(content, (key, filters) => {
        const compiled = µb.compileFilters(filters.join('\n'), {
            assetKey: trackingAssetKey, trustedSource: false,
        });
        const reader = new CompiledListReader(compiled);
        if ( !reader.blocks.get('NETWORK_FILTERS:GOOD')?.trim() ) {
            throw new Error(`Quer.ee tracking product has no usable rules: ${key}`);
        }
        lists.push(compiled);
    });
    return lists;
}

// Metadata can advance before the downloaded data finishes writing.
assets.addObserver((topic, details) => {
    if ( details.assetKey === µb.pslAssetKey ) {
        if ( topic === 'after-asset-updated' ) { sourceEpoch += 1; }
        return;
    }
    if ( details.assetKey !== trackingAssetKey ) { return; }
    if ( topic === 'before-asset-cache-write' ) {
        writes ??= { ...Promise.withResolvers(), count: 0 };
        writes.count += 1;
        compileTrackingRules(details.content);
    } else if ( topic === 'after-asset-cache-write' ) {
        writes.count -= 1;
        if ( writes.count === 0 ) {
            writes.resolve();
            writes = undefined;
        }
    }
    if ( topic === 'after-asset-updated' ) {
        sourceEpoch += 1;
    }
});

async function initialize() {
    registered ??= assets.registerAssetSource(trackingAssetKey, {
        content: 'text',
        contentURL: [ trackingSource.url ],
        title: 'Ghostery TrackerDB (Quer.ee tracking)',
        submitter: 'queree',
        updateAfter: 1,
    });
    await registered;
}

async function sourceVersion() {
    const metadata = await assets.metadata();
    return [ metadata[trackingAssetKey]?.writeTime || 0,
        metadata[µb.pslAssetKey]?.writeTime || 0, sourceEpoch ].join('|');
}

export function resetTrackingEngine() {
    generation += 1;
    loading = undefined;
    readyFrame = undefined;
    version = undefined;
    policyFrame(frameId)?.postMessage({ what: 'reset' }, location.origin);
}

export function loadTrackingEngine() {
    if ( loading !== undefined ) { return loading; }
    const current = generation;
    const task = (async () => {
        await initialize();
        const frame = await waitForPolicyEngine(frameId);
        let before;
        let after;
        do {
            if ( writes !== undefined ) { await writes.promise; }
            before = await sourceVersion();
            const details = await assets.get(trackingAssetKey);
            if ( details.content === '' || details.content === undefined ) {
                throw new Error(details.error || 'Quer.ee tracking data is unavailable');
            }
            const compiledLists = compileTrackingRules(details.content);
            if ( current !== generation ) { throw new Error('Quer.ee tracking profile changed while loading'); }
            const result = await loadPolicyFrame(frame, {
                compiledLists, pslSelfie: publicSuffixList.toSelfie(),
            });
            if ( !(result.filterCount > 0) ) { throw new Error('Quer.ee tracking profile has no usable rules'); }
            if ( current !== generation ) { throw new Error('Quer.ee tracking profile changed while loading'); }
            // A first download writes the cache too; reread it, rather than fail.
            after = await sourceVersion();
            if ( current !== generation ) { throw new Error('Quer.ee tracking profile changed while loading'); }
        } while ( writes !== undefined || before !== after );
        readyFrame = frame;
        version = before;
        return frame;
    })();
    const handled = task.catch(reason => {
        if ( loading === handled ) { loading = undefined; readyFrame = undefined; }
        throw reason;
    });
    loading = handled;
    return handled;
}

export function matchTrackingRequest(details) {
    if ( readyFrame === undefined ) { throw new Error('Quer.ee tracking engine is not ready'); }
    return policyCommand({ what: 'matchRequest', details }, frameId);
}

export async function refreshTrackingEngine(message) {
    if ( version === undefined ) { return; }
    const keys = message?.listKeys || message?.assetKeys ||
        (message?.key === undefined ? undefined : [ message.key ]);
    if ( keys?.length && keys.includes(trackingAssetKey) === false &&
        keys.includes(µb.pslAssetKey) === false ) { return; }
    if ( version !== await sourceVersion() ) { resetTrackingEngine(); }
}
