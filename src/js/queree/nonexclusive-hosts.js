// Shared services and mixed-purpose hosts: declarations do not establish whole-host ownership.
export const nonExclusiveHosts = new Set([
    'about.me',
    'acnc.gov.au',
    'affirm.com',
    'angelfire.com',
    'aol.com',
    'apps.apple.com',
    'att.net',
    'bbc.co.uk',
    'beacons.ai',
    'bellsouth.net',
    'bing.com',
    'bit.ly',
    'bluesombrero.com',
    'bridgewebs.com',
    'charter.net',
    'clubrunner.ca',
    'clubs.bluesombrero.com',
    'comcast.net',
    'cox.net',
    'donorbox.org',
    'e-clubhouse.org',
    'earthlink.net',
    'eteamz.com',
    'fb.com',
    'fb.me',
    'freewebs.com',
    'geocities.com',
    'github.com',
    'gitlab.com',
    'givebacks.com',
    'givebutter.com',
    'gmail.com',
    'gofundme.com',
    'gomotionapp.com',
    'goo.gl',
    'google.com',
    'groups.io',
    'homeschool-life.com',
    'hotmail.com',
    'humanitix.com',
    'icloud.com',
    'instagram.com',
    'leagueathletics.com',
    'leaguelineup.com',
    'leagues.bluesombrero.com',
    'leagues.teamlinkt.com',
    'linktr.ee',
    'live.com',
    'lnkd.in',
    'me.com',
    'meetup.com',
    'msn.com',
    'myspace.com',
    'neighborhoodlink.com',
    'notion.site',
    'notion.so',
    'outlook.com',
    'patreon.com',
    'paypal.com',
    'play.google.com',
    'portal.clubrunner.ca',
    'protonmail.com',
    'qsl.net',
    'registration-setup.bluesombrero.com',
    'replit.com',
    'rootsweb.ancestry.com',
    'runsignup.com',
    'sbcglobal.net',
    'sites.google.com',
    'sports.bluesombrero.com',
    'squarespace.com',
    'squareup.com',
    'substack.com',
    'teamsnap.com',
    'teamunify.com',
    'tiktok.com',
    'tinyurl.com',
    'troopwebhost.org',
    'tshq.bluesombrero.com',
    'verizon.net',
    'weebly.com',
    'wix.com',
    'wordpress.com',
    'yahoo.com',
    'ycombinator.com',
    'ymail.com',
    'youtu.be',
    'zeffy.com',
]);

export const nonExclusiveHostSuffixes = [ 'google.com', 'instagram.com' ];

export function isNonExclusiveHost(domain) {
    // These service namespaces are shared, unlike tenant-specific builder hosts.
    return nonExclusiveHosts.has(domain) ||
        nonExclusiveHostSuffixes.some(suffix => domain.endsWith(`.${suffix}`));
}

export function nonExclusiveHostFromHostname(hostname) {
    let domain = hostname.replace(/^www\./, '');
    for (;;) {
        if ( isNonExclusiveHost(domain) ) { return domain; }
        const dot = domain.indexOf('.');
        if ( dot === -1 ) { return; }
        domain = domain.slice(dot + 1);
    }
}
