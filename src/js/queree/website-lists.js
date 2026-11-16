import { affiliateLinkSources, promotionSources } from './vendor/website-lists.js';
import { MatchPatternMap } from './vendor/ublacklist/match-pattern.js';

export const urlPatternMatcher = '@ublacklist/match-pattern@2.0.0';

const promotionPatterns = new MatchPatternMap();
const affiliateLinkPatterns = new MatchPatternMap();
for ( const source of affiliateLinkSources ) {
    for ( const domain of source.domains ) {
        const rule = `*://*.${domain}/*`;
        affiliateLinkPatterns.set(rule, { kind: 'affiliate_tracked_link', list: source.name, rule });
    }
}
for ( const source of promotionSources ) {
    for ( const rule of source.rules ) {
        promotionPatterns.set(rule, { kind: source.kind || 'advertising', list: source.name, rule });
    }
}

export function listedPromotionalURLReasons(rawURL) {
    let url;
    try {
        url = new URL(rawURL);
    } catch {
        return [];
    }
    if ( url.protocol !== 'http:' && url.protocol !== 'https:' ) { return []; }
    return promotionPatterns.get(url.href).map(reason => ({
        ...reason,
        request_url: url.href,
    }));
}

export function listedAffiliateLinkReasons(urls = []) {
    const reasons = new Map();
    for ( const rawURL of urls ) {
        let url;
        try { url = new URL(rawURL); } catch { continue; }
        if ( url.protocol !== 'http:' && url.protocol !== 'https:' ) { continue; }
        for ( const reason of affiliateLinkPatterns.get(url.href) ) {
            if ( reasons.has(reason.list) ) { continue; }
            reasons.set(reason.list, { ...reason, matched_hostname: url.hostname });
        }
    }
    return Array.from(reasons.values());
}
