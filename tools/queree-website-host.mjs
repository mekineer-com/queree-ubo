import { domainToASCII } from 'node:url';
import { ownershipHostnameKind } from './queree-ownership-sources.mjs';

export function websiteHost(raw, allowBare = false) {
    const value = allowBare ? raw.trim() : raw;
    let url;
    try {
        url = new URL(allowBare && !/^[a-z][a-z0-9+.-]*:/i.test(value) ? `http://${value}` : value);
    } catch { return; }
    if ( ![ 'http:', 'https:' ].includes(url.protocol) || url.username || url.password ) { return; }
    const host = domainToASCII(url.hostname.toLowerCase().replace(/\.$/, '')).replace(/^www\./, '');
    if ( ownershipHostnameKind(host) === undefined ) { return; }
    return host;
}
