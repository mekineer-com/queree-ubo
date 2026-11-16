/*******************************************************************************

    Quer.ee community-source category data
    Copyright (C) 2026-present Marcos

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*/

export const communityDomains = [
    'askubuntu.com',
    'facebook.com',
    'instagram.com',
    'linkedin.com',
    'mathoverflow.net',
    'quora.com',
    'reddit.com',
    'serverfault.com',
    'stackapps.com',
    'stackexchange.com',
    'stackoverflow.com',
    'superuser.com',
    'threads.com',
    'threads.net',
    'tiktok.com',
    'twitter.com',
    'x.com',
    'youtube.com',
];

export function communityDomainFromHostname(hostname) {
    hostname = hostname.toLowerCase().replace(/\.$/, '');
    return communityDomains.find(domain =>
        hostname === domain || hostname.endsWith(`.${domain}`)
    );
}
