/* Quer.ee tracking source selection; GPL-3.0-or-later. */

export const trackingAssetKey = 'queree-tracking-data';
export const trackingSource = {
    name: 'ghostery-trackerdb',
    url: 'https://github.com/ghostery/trackerdb/releases/latest/download/trackerdb.json',
    patterns: [
        'adobe_advertising_cloud',
        'adroll_pixel',
        'adroll_roundtrip',
        'bing_ads',
        'criteo',
        'doubleclick_ad_buyer',
        'doubleclick_floodlight',
        'facebook_custom_audience',
        'google_remarketing',
        'linkedin_ads',
        'linkedin_analytics',
        'outbrain_amplify',
        'outbrain_pixel',
        'pinterest_conversion_tracker',
        'reddit_ads',
        'snapchat',
        'tradedesk',
        'twitter_conversion_tracking',
        'yahoo_dot_tag',
    ],
};

export function trackingRules(content, validate) {
    const data = JSON.parse(content);
    const rules = new Set();
    for ( const key of trackingSource.patterns ) {
        const filters = data.patterns?.[key]?.filters;
        if ( Array.isArray(filters) === false || filters.length === 0 ||
            filters.some(rule => typeof rule !== 'string' || rule.trim() === '' || /[\r\n]/.test(rule)) ) {
            throw new Error(`Quer.ee tracking rules are missing or invalid: ${key}`);
        }
        if ( validate !== undefined ) { validate(key, filters); }
        for ( const rule of filters ) { rules.add(rule); }
    }
    return Array.from(rules).join('\n');
}
