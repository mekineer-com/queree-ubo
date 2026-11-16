import { domainToASCII, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isIP } from 'node:net';
import { isNonExclusiveHost } from '../src/js/queree/nonexclusive-hosts.js';
import publicSuffixList from '../src/lib/publicsuffixlist/publicsuffixlist.js';
import { readFileSync } from 'node:fs';

execFileSync('sh', [ fileURLToPath(new URL('./check-queree-source.sh', import.meta.url)),
    fileURLToPath(new URL('../dist/build/uAssets/main', import.meta.url)), 'UASSETS_MAIN_COMMIT' ]);
const pslText = readFileSync(new URL(
    '../dist/build/uAssets/main/thirdparties/publicsuffix.org/list/effective_tld_names.dat',
    import.meta.url
), 'utf8');
publicSuffixList.parse(pslText, domainToASCII);
const privateRules = new Set(pslText.split('// ===BEGIN PRIVATE DOMAINS===')[1]
    .split(/\r?\n/).map(rule => rule.trim())
    .filter(rule => rule !== '' && rule.startsWith('//') === false)
    .map(domainToASCII));

export const ownershipCategories = new Set([
    'commercial_corporate', 'professional_publication', 'public_interest_organization',
]);

export function parseReviewedDomains(bytes) {
    const lines = bytes.toString('utf8').trimEnd().split(/\r?\n/);
    if ( lines.shift() !== 'domain\tcategory\torganisation\tevidence\treason' ) {
        throw Error('Expected the explicit review table, not collected or inferred source data');
    }
    const categories = new Set([ ...ownershipCategories, 'government_education', 'unclassified' ]);
    const seen = new Set();
    const groups = new Map();
    for ( const line of lines ) {
        const fields = line.split('\t');
        const [ domain, category, organisation, evidence, reason ] = fields;
        if ( fields.length !== 5 || !categories.has(category) || !organisation || !evidence || !reason ) {
            throw Error(`Incomplete or invalid reviewed decision: ${domain}`);
        }
        if ( domain.startsWith('www.') || ownershipHostnameKind(domain) === undefined || seen.has(domain) ) {
            throw Error(`Invalid or duplicate reviewed domain: ${domain}`);
        }
        seen.add(domain);
        if ( !groups.has(category) ) { groups.set(category, new Map()); }
        groups.get(category).set(domain, evidence);
    }
    if ( groups.size === 0 ) { throw Error('No reviewed decisions'); }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return [ ...groups ].sort(([ a ], [ b ]) => a.localeCompare(b)).map(([ category, domains ]) => ({
        name: `reviewed_domains_${category}`, category,
        source: 'Quer.ee individually reviewed domain classifications', license: 'GPL-3.0-only',
        sha256,
        rule: 'Explicit reviewed decisions only; no category inference from URLs or source types',
        domains: [ ...domains.keys() ].sort(),
        items_by_domain: Object.fromEntries([ ...domains.keys() ].sort().map(domain => [ domain, [ domains.get(domain) ] ])),
    }));
}

export const reviewed = parseReviewedDomains(readFileSync(new URL('./vendor/reviewed-domains/reviewed.tsv', import.meta.url)));
const reviewedCategories = new Map(reviewed.flatMap(source =>
    source.domains.map(domain => [domain, source.category])));

// Only explicit reviewed decisions override a supplier's classification.
export function applyReviewedCategory(source, category) {
    const domains = source.domains.filter(domain => {
        const decision = reviewedCategories.get(domain);
        return decision === undefined || decision === category;
    });
    return { ...source, domains, review_excluded: source.domains.length - domains.length,
        review_source_sha256: reviewed[0].sha256 };
}

// Reapply import guards to older declaration snapshots at both build boundaries.
export function withoutSharedHostDeclarations(source) {
    const domains = source.domains.filter(domain => isNonExclusiveHost(domain) === false);
    return {
        ...source,
        domains,
        shared_host_excluded: source.domains.length - domains.length,
    };
}

export function withoutInvalidOwnershipHosts(source) {
    const domains = source.domains.filter(domain => ownershipHostnameKind(domain) !== undefined);
    return { ...source, domains, invalid_host_excluded: source.domains.length - domains.length };
}

export function ownershipHostnameKind(hostname) {
    if ( hostname.length > 253 || hostname.split('.').some(label =>
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) === false
    ) ) { return; }
    let url;
    try { url = new URL(`https://${hostname}/`); } catch { return; }
    if ( url.hostname !== hostname || isIP(hostname) !== 0 ) { return; }
    const registrable = publicSuffixList.getDomain(hostname);
    if ( registrable === '' ) {
        const dot = hostname.indexOf('.');
        if (
            privateRules.has(hostname) === false &&
            (dot === -1 || privateRules.has(`*.${hostname.slice(dot + 1)}`) === false)
        ) { return; }
    }
    // A shared service may own its root, never every independent tenant.
    return registrable === '' || isNonExclusiveHost(hostname) ? 'exact' : 'inherited';
}
