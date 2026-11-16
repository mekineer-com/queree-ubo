/*******************************************************************************

    Quer.ee alternative search links
    Copyright (C) 2026-present Marcos
    SPDX-License-Identifier: GPL-3.0-or-later

    Adapted from Alternative Search Engines 2.2 by Marcos, with Nova.
    https://greasyfork.org/scripts/557168

*/

(( ) => {
    if ( typeof vAPI !== 'object' ) { return; }

    const engines = {
        Google: { url: 'https://www.google.com/search', param: 'q' },
        Bing: { url: 'https://www.bing.com/search', param: 'q' },
        DuckGo: { url: 'https://duckduckgo.com/', param: 'q' },
        Yandex: { url: 'https://yandex.com/search/', param: 'text' },
        Mojeek: { url: 'https://www.mojeek.com/search', param: 'q' },
        'Quer.ee': { url: 'https://quer.ee/', param: 'q' },
    };

    function currentEngine() {
        const host = location.hostname;
        if ( /^www\.google\.(?:com|[a-z]{2}|(?:com|co)\.[a-z]{2})$/.test(host) ) { return 'Google'; }
        if ( host === 'www.bing.com' ) { return 'Bing'; }
        if ( host === 'duckduckgo.com' ) { return 'DuckGo'; }
        if ( /^yandex\.(?:com|ru|by|kz|uz|com\.tr)$/.test(host) ) { return 'Yandex'; }
        if ( host === 'www.mojeek.com' ) { return 'Mojeek'; }
        if ( host === 'quer.ee' && location.pathname === '/' ) { return 'Quer.ee'; }
    }

    // Startup reinjection does not apply the manifest's URL restrictions.
    const current = currentEngine();
    if ( current === undefined ) { return; }
    const boxID = 'alt-search-engines-overlay';
    document.getElementById(boxID)?.remove();
    const box = document.createElement('nav');
    box.id = boxID;
    box.setAttribute('aria-label', 'Alternative search engines');
    Object.assign(box.style, {
        position: 'fixed', top: '6px', right: '10px', zIndex: '2147483647',
        font: '11px/1.4 Verdana, sans-serif', color: '#555',
        padding: '3px 6px', maxWidth: 'calc(100vw - 20px)', background: 'transparent',
        pointerEvents: 'none',
    });
    const label = document.createElement('span');
    label.textContent = 'Search also: ';
    box.append(label);
    const alternatives = Object.keys(engines).filter(name => name !== current);
    const links = [];
    alternatives.forEach((name, index) => {
        if ( index !== 0 ) {
            const separator = document.createElement('span');
            separator.textContent = '\u00b7';
            separator.setAttribute('aria-hidden', 'true');
            box.append(separator);
        }
        const link = document.createElement('a');
        link.textContent = name;
        Object.assign(link.style, {
            margin: '0 2px', textDecoration: 'underline', color: '#1a73e8',
            pointerEvents: 'auto',
        });
        box.append(link);
        links.push([ name, link ]);
    });

    function refreshLinks() {
        const source = new URL(location.href);
        const params = current === 'Quer.ee'
            ? new URLSearchParams(source.hash.slice(1)) : source.searchParams;
        const query = params.get(engines[current].param) || '';
        for ( const [ name, link ] of links ) {
            const destination = new URL(engines[name].url);
            if ( query !== '' ) {
                const params = new URLSearchParams({ [engines[name].param]: query });
                if ( name === 'Quer.ee' ) { destination.hash = params.toString(); }
                else { destination.search = params.toString(); }
            }
            link.href = destination.href;
        }
    }

    refreshLinks();
    // Preserve native links and long-press menus after same-page query changes.
    for ( const type of [ 'pointerdown', 'focusin', 'click' ] ) {
        box.addEventListener(type, refreshLinks);
    }
    document.body.append(box);
    vAPI.shutdown.add(( ) => box.remove());
})();
