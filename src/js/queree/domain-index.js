import HNTrieContainer from '../hntrie.js';
import domainIndexData from './vendor/domain-index-data.js';
import { nonExclusiveHostFromHostname } from './nonexclusive-hosts.js';

const container = new HNTrieContainer();
let loaded = false;
let loading;

export function loadDomainIndexFromBuffer(buffer) {
    if ( buffer.byteLength !== domainIndexData.byte_length || buffer.byteLength % 4 !== 0 ) {
        throw new Error('Quer.ee domain index has the wrong size');
    }
    const buf32 = new Uint32Array(buffer);
    if ( container.fromSelfie({ buf32, checksum: domainIndexData.checksum }) === false ) {
        throw new Error('Quer.ee domain index failed validation');
    }
    loaded = true;
}

export async function loadDomainIndex() {
    if ( loaded ) { return; }
    loading ??= (async ( ) => {
        const response = await fetch(domainIndexData.asset, { signal: AbortSignal.timeout(90000) });
        if ( response.ok === false ) {
            throw new Error(`Quer.ee domain index failed to load: ${response.status}`);
        }
        loadDomainIndexFromBuffer(await response.arrayBuffer());
    })().finally(( ) => { loading = undefined; });
    return loading;
}

export function listedDomainReasons(rawURL, lists, kind) {
    if ( loaded === false ) { throw new Error('Quer.ee domain index is not loaded'); }
    let url;
    try {
        url = new URL(rawURL);
    } catch {
        return [];
    }
    if ( url.protocol !== 'http:' && url.protocol !== 'https:' ) { return []; }
    return listedHostnameReasons(url.hostname, lists, kind);
}

export function listedSourceDomainReasons(rawURL, lists, kind = 'source_category') {
    let url;
    try {
        url = new URL(rawURL);
    } catch {
        return [];
    }
    if ( url.protocol !== 'http:' && url.protocol !== 'https:' ) { return []; }
    const target = url.hostname.toLowerCase().replace(/\.$/, '');
    const boundary = nonExclusiveHostFromHostname(target);
    const reasons = listedHostnameReasons(target, lists, kind, boundary);
    for ( const list of lists ) {
        const matched = list.nonexclusive_domains?.find(domain =>
            target === domain || target === `www.${domain}`
        );
        if ( matched === undefined || reasons.some(reason => reason.list === list.name) ) {
            continue;
        }
        reasons.push({ kind, list: list.name, matched_hostname: matched });
    }
    return reasons;
}

export function listedHostnameReasons(rawHostname, lists, kind, boundary) {
    if ( loaded === false ) { throw new Error('Quer.ee domain index is not loaded'); }
    if ( typeof rawHostname !== 'string' ) { return []; }
    const target = rawHostname.toLowerCase().replace(/\.$/, '');
    let parsed;
    try {
        parsed = new URL(`https://${target}/`).hostname;
    } catch {
        return [];
    }
    if ( target === '' || target.length > 253 || parsed !== target || target.split('.').some(label =>
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) === false
    ) ) { return []; }
    container.setNeedle(target);
    const reasons = [];
    for ( const list of lists ) {
        const root = boundary === undefined ? list.root : list.scoped_roots?.[boundary];
        if ( root === undefined ) { continue; }
        const index = container.matches(root);
        if ( index === -1 ) { continue; }
        reasons.push({
            kind,
            list: list.name,
            matched_hostname: target.slice(index),
        });
    }
    return reasons;
}

export { domainIndexData };
