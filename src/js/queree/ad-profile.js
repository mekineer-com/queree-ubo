/* Quer.ee advertising profile; GPL-3.0-or-later. */

export const popupAdsAssetKey =
    'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/popupads.txt';

export const requiredLists = [
    'adguard-generic',
    'ublock-filters',
    'easylist',
    'spa-0',
    popupAdsAssetKey,
];

export const requiredMalwareLists = [ 'ublock-badware', 'urlhaus-1' ];

export const eligibilityExceptions = [
    '@@||google-analytics.com^',
    '@@||stats.g.doubleclick.net^',
    '@@||static.ads-twitter.com/uwt.js',
    '@@||twnmm.com/js/*/adobe_audience_manager$script',
    '@@||secure.quantserve.com^$object',
    '@@||googletagmanager.com^',
    '||googletagmanager.com^$script,domain=foxnews.com,important,badfilter',
];

export const popupAdsAsset = {
    content: 'filters',
    contentURL: [
        popupAdsAssetKey,
        'assets/queree/popupads.txt',
    ],
    title: 'HaGeZi Pop-Up Ads (Quer.ee)',
    group: 'custom',
    external: true,
    off: true,
    submitter: 'queree',
    updateAfter: 8 / 24,
};

const bundledFallbacks = {
    'adguard-generic': 'assets/queree/adguard-ads.txt',
    'spa-0': 'assets/queree/easylist-spanish.txt',
    [popupAdsAssetKey]: 'assets/queree/popupads.txt',
};

export function preserveAdProfileFallbacks(sources) {
    const changed = [];
    for ( const [ key, fallback ] of Object.entries(bundledFallbacks) ) {
        const source = sources[key];
        if ( source === undefined ) { continue; }
        const urls = [].concat(source.contentURL || []);
        if ( urls.includes(fallback) ) { continue; }
        source.contentURL = [ ...urls, fallback ];
        changed.push(key);
    }
    return changed;
}

export async function initializeAdProfileAssets(ublock, assets) {
    if ( ublock.quereeFilterLists.size !== 0 ) { return; }
    await assets.registerAssetSource(popupAdsAssetKey, popupAdsAsset);
    const sources = await assets.metadata();
    for ( const key of preserveAdProfileFallbacks(sources) ) {
        await assets.registerAssetSource(key, { contentURL: sources[key].contentURL });
    }
    // Also initialize native bad-list data when ordinary filters used a selfie.
    await ublock.loadBadLists({ favorLocal: true });
    for ( const key of [ ...requiredLists, ...requiredMalwareLists ] ) {
        ublock.quereeFilterLists.add(key);
    }
}
