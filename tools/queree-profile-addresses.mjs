import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const input = readFileSync(new URL('./vendor/maigret/data.json', import.meta.url));
const data = JSON.parse(input);
export const profileAddressSource = {
    source: 'https://github.com/soxoj/maigret/blob/main/maigret/resources/data.json',
    sha256: createHash('sha256').update(input).digest('hex'),
    license: 'MIT',
};

const patterns = new Map();
const normalizedHost = url => url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const expression = value => new RegExp(`^${value.split('QUEREEPROFILETOKEN').map(escape).join('[^/?#]+')}$`);
const profilePath = value => value.replace(/%([\da-f]{2})/gi, (encoded, hex) => {
    const character = String.fromCharCode(Number.parseInt(hex, 16));
    return /^[a-z\d._~-]$/i.test(character) ? character : encoded;
});
for ( const entry of Object.values(data.sites) ) {
    const site = { ...data.engines[entry.engine]?.site, ...entry };
    if ( site.disabled || typeof site.url !== 'string' ) { continue; }
    const template = site.url.replaceAll('{urlMain}', site.urlMain || '')
        .replaceAll('{urlSubpath}', site.urlSubpath || '');
    if ( template.includes('{username}') === false || /[{}]/.test(template.replaceAll('{username}', '')) ) {
        continue;
    }
    let url;
    try { url = new URL(template.replaceAll('{username}', 'QUEREEPROFILETOKEN')); }
    catch { continue; }
    if ( ![ 'http:', 'https:' ].includes(url.protocol) || url.port || url.username || url.password ||
        url.hostname.includes('quereeprofiletoken') ) { continue; }
    const path = url.pathname.replace(/\/$/, '') + url.search;
    if ( path.includes('QUEREEPROFILETOKEN') === false ) { continue; }
    if ( Array.from(url.searchParams.keys()).some(key => key.includes('QUEREEPROFILETOKEN')) ) { continue; }
    const host = normalizedHost(url);
    if ( patterns.has(host) === false ) { patterns.set(host, []); }
    patterns.get(host).push({
        path: expression(profilePath(url.pathname).replace(/\/$/, '')),
        query: Array.from(url.searchParams, ([ key, value ]) => [ key, expression(value) ]),
    });
}
if ( patterns.size === 0 ) { throw new Error('Maigret contains no usable profile patterns'); }

// Offline import guard only. It recognizes address shapes, not verified accounts.
export function isProfileAddress(raw) {
    let url;
    try {
        const value = raw.trim();
        url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
    } catch { return false; }
    if ( ![ 'http:', 'https:' ].includes(url.protocol) || url.username || url.password ) { return false; }
    const path = profilePath(url.pathname).replace(/\/$/, '');
    if ( path === '' && url.search === '' ) { return false; }
    return patterns.get(normalizedHost(url))?.some(pattern =>
        pattern.path.test(path) && pattern.query.every(([ key, value ]) =>
            url.searchParams.getAll(key).some(actual => value.test(actual))
        )
    ) === true;
}
