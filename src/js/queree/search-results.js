/*******************************************************************************

    Quer.ee search results integration
    Copyright (C) 2026-present Marcos

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*/

/* globals browser */

((async ( ) => {
    if ( typeof vAPI !== 'object' ) { return; }
    function isSearchPage() {
        return location.protocol === 'https:' &&
            /^(?:www\.google\.com(?:\.pe)?\/(?:search$|sorry\/)|www\.bing\.com\/(?:search$|news\/search$|turing\/))/.test(`${location.hostname}${location.pathname}`);
    }
    // Native startup reinjection does not apply the manifest's URL matches.
    if ( isSearchPage() === false ) { return; }

    let processed = new WeakMap();
    let shuttingDown = false;
    let enabled = false;
    let settingEnabled = false;
    let requireSingleDomain = false;
    let excludeAdvertisingSignals = true;
    let excludeCrossSiteTracking = true;
    let excludeShoppingSignals = true;
    let keepUnresolvedTabs = false;
    let inspectionTabGeneration = 0;
    let personalCategories;
    let sourceControls;
    let settingsRevision = -1;
    let simultaneousInspections = 6;
    let paginationTarget = 10;
    let paginationAuto = true;
    let paginationComplete = false;
    let paginationLoading = false;
    let paginationNext;
    let paginationCancel;
    let paginationButton;
    let paginationSource;
    let generation = 0;
    let batchSequence = 0;
    let settingsGeneration = 0;
    let running = false;
    let rescan = false;
    let excludedVisible = false;
    let hidingUnavailable = false;
    let stylesheetOperation = Promise.resolve();
    let stylesheetOperationsPending = 0;
    let observer;
    let panel;
    let status;
    let mobileInspection = { mobile: false, ready: false };
    let mobileQ;
    let mobileHelp;
    let backgroundSettingsCopied = false;
    let style;
    let toggle;
    let scanTimer;
    let progressTimer;
    let progressCompleted = 0;
    let progressTotal = 0;
    let progressDots = 0;
    let summaryTimer;
    let emptyTimer;
    let emptyStartedAt;
    let emptyStored = false;
    const activeBatches = new Set();
    const activeItems = new Map();
    const sourceSettleDelay = 5000;
    const unknownSourceDeadline = 120000;
    const maxExcludedSelectors = 256;
    const maxExclusionCSSLength = 64 * 1024;
    const summaryHoldDuration = 2000;
    const backgroundSettingsURL = 'chrome://geckoview/content/config.xhtml?filter=dom.suspend_inactive.enabled';
    const selectorReasons = new Map();
    const exclusionStylesheets = new Map();
    const appliedStylesheets = new Set();
    const recorded = new Map();

    function isGoogleImages() {
        if ( /(^|\.)google\./.test(location.hostname) === false ) { return false; }
        const params = new URL(location.href).searchParams;
        return params.getAll('udm').some(value => value === '2' || value === 'imgs') ||
            params.getAll('tbm').includes('isch');
    }

    function searchEngineAdapter(hostname, pathname) {
        if ( hostname === 'www.bing.com' ) {
            const news = pathname === '/news/search';
            return {
                name: 'Bing',
                headingSelector: news ? '.news-card a.title, .newscard a.title' : '#b_results > li.b_algo h2',
                panelRoot: news ? '#contentid, #coreid' : '#b_content',
                containerSelector: news ? ':is(.news-card, .newscard)' : '#b_results > li.b_algo',
                resultRoot: news ? '#algocore, #coreresults' : '#b_results',
                hasNativePagination() {
                    if ( news === false || document.querySelector('#infinite-scroll-config') === null ) { return false; }
                    const page = window.wrappedJSObject;
                    return typeof page?.ResponsiveNewsInfiniteScroll?.StartAjax === 'function' ||
                        typeof page?.MobileNewsVerticalInfiniteScrollVNext?.Init === 'function';
                },
                getNativeLoadMore() {
                    if ( this.hasNativePagination() === false ) { return; }
                    const loader = window.wrappedJSObject?.ResponsiveNewsInfiniteScroll;
                    if ( typeof loader?.StartAjax === 'function' ) {
                        return () => loader.StartAjax(true);
                    }
                },
                nextSelector: 'a.sb_pagN, a.sb_halfnext, a.sb_fullnpl, a[rel="next"]',
                offsetParameter: 'first',
                searchParameters: [ 'q', 'filters', 'qft', 'scope', 'cc', 'setlang', 'mkt', 'adlt' ],
                descriptionSelector: news ? '.snippet' : '.b_caption p',
                stableLinkParameters: [ 'u' ],
                isRedirectURL: url =>
                    url.hostname === 'www.bing.com' && url.pathname === '/ck/a',
                resultAnchor: heading => news ? heading : heading.querySelector('a[href]'),
                titlePath: linkSelector => news ? `a.title${linkSelector}` : `h2 ${linkSelector}`,
                exclusionSelectors(titlePaths) {
                    return titlePaths.map(path =>
                        `${this.containerSelector}:has(${path})`
                    );
                },
                resultURL(url) {
                    if ( url.hostname !== 'www.bing.com' || url.pathname !== '/ck/a' ) {
                        return url;
                    }
                    const encoded = url.searchParams.get('u');
                    if (
                        typeof encoded !== 'string' ||
                        encoded.startsWith('a1') === false
                    ) { return url; }
                    let base64 = encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/');
                    base64 += '='.repeat((4 - base64.length % 4) % 4);
                    try {
                        const bytes = Uint8Array.from(atob(base64), char =>
                            char.charCodeAt(0)
                        );
                        const target = new URL(new TextDecoder().decode(bytes));
                        if ( /^https?:$/.test(target.protocol) ) { return target; }
                    } catch {
                    }
                    return url;
                },
                sourceReasons(url) {
                    const source = url.searchParams.get('utm_source')?.toLowerCase();
                    const medium = url.searchParams.get('utm_medium')?.toLowerCase();
                    if (
                        source === 'bing' &&
                        /^(?:cpc|paidsearch|paid_search|ppc)$/.test(medium || '')
                    ) {
                        return [ {
                            kind: 'search_advertising',
                            engine: 'bing',
                            medium,
                        } ];
                    }
                    return [];
                },
                noResults: text => /there are no results for/i.test(text),
            };
        }
        if ( /(^|\.)google\./.test(hostname) ) {
            return {
                name: 'Google',
                headingSelector: 'h3, [role="heading"]',
                panelRoot: '#search',
                containerSelector: '.MjjYud',
                resultRoot: '#rso',
                nextSelector: 'a#pnnext, #nn',
                offsetParameter: 'start',
                searchParameters: [ 'q', 'tbs', 'tbm', 'udm', 'safe', 'filter', 'nfpr', 'lr', 'cr', 'gl', 'hl',
                    'as_q', 'as_epq', 'as_oq', 'as_eq', 'as_sitesearch', 'as_occt', 'as_filetype', 'as_rights' ],
                descriptionSelector: '[data-sncf], .VwiC3b, .UqSP2b',
                stableLinkParameters: [ 'q', 'url' ],
                isRedirectURL: url =>
                    /(^|\.)google\./.test(url.hostname) &&
                    /^\/(?:goto|url)$/.test(url.pathname),
                resultAnchor(heading) {
                    const anchor = heading.closest('a[href]');
                    if ( anchor?.closest(this.containerSelector) === null ) { return; }
                    return anchor || undefined;
                },
                titlePath: linkSelector => `${linkSelector} :is(h3, [role="heading"])`,
                exclusionSelectors(titlePaths) {
                    const container = `:is(${this.containerSelector}, .queree-result)`;
                    return titlePaths.map(path =>
                        `${container}:has(${path}):not(:has(${container} ${path}))`
                    );
                },
                resultURL(url) {
                    if ( /(^|\.)google\./.test(url.hostname) === false ) { return url; }
                    if ( /^\/(?:goto|url)$/.test(url.pathname) === false ) {
                        if ( url.hostname !== hostname ) { return url; }
                        return;
                    }
                    const target = url.searchParams.get('q') ||
                        url.searchParams.get('url');
                    if ( target === null ) { return; }
                    try {
                        return new URL(target);
                    } catch {
                        // Google's opaque /goto links resolve in the inspection tab.
                        if ( url.pathname === '/goto' ) { return url; }
                    }
                },
                sourceReasons: ( ) => [],
                noResults: text =>
                    /(?:did not match any documents|no results found for)/i.test(text) ||
                    document.querySelector('#topstuff [role="heading"]') !== null,
            };
        }
    }

    let adapter = searchEngineAdapter(location.hostname, location.pathname);
    if ( adapter === undefined ) { return; }
    let sourceSearchIdentity = searchIdentity(location.href, true);

    function resultAnchor(heading) {
        return adapter.resultAnchor(heading) || undefined;
    }

    function resultContent(heading, container) {
        if ( container.querySelectorAll(adapter.headingSelector).length <= 1 ) {
            return container;
        }
        // Google Videos can put ten independent cards in one result wrapper.
        let content = heading;
        while ( content.parentElement !== container &&
            content.parentElement.querySelectorAll(adapter.headingSelector).length === 1 ) {
            content = content.parentElement;
        }
        return content;
    }

    function hrefAttributeSelectors(anchor) {
        const selectors = new Set();
        const hrefs = new Set([ anchor.getAttribute('href'), anchor.href ]);
        let isRedirect = false;
        try {
            isRedirect = adapter.isRedirectURL(new URL(anchor.href));
        } catch {
        }
        for ( const href of hrefs ) {
            if ( typeof href !== 'string' || href === '' ) { continue; }
            if ( isRedirect === false ) {
                selectors.add(`[href=${CSS.escape(href)}]`);
                continue;
            }
            for ( const name of adapter.stableLinkParameters ) {
                const match = href.match(new RegExp(`[?&]${name}=([^&#]*)`));
                if ( match === null || match[1] === '' ) { continue; }
                for ( const separator of [ '?', '&' ] ) {
                    selectors.add(
                        `[href*=${CSS.escape(
                            `${separator}${name}=${match[1]}&`
                        )}]`
                    );
                    selectors.add(
                        `[href$=${CSS.escape(
                            `${separator}${name}=${match[1]}`
                        )}]`
                    );
                }
            }
        }
        return Array.from(selectors);
    }

    function selectorsForExcludedResult(anchor) {
        const links = hrefAttributeSelectors(anchor);
        // A compact News card can be the title link itself, not its descendant.
        if ( anchor.matches('.queree-result') ) {
            return links.map(link => `.queree-result${link}`);
        }
        const titlePaths = links.map(adapter.titlePath);
        return adapter.exclusionSelectors(titlePaths);
    }

    // Next-link selectors follow Pagetual's maintained Google/Bing rules:
    // github.com/hoothin/UserScripts/blob/master/Pagetual/pagetualRules.json
    function searchIdentity(rawURL, includeOffset = false) {
        const url = new URL(rawURL);
        // Google drops keyboard-added query padding from its next-page links.
        return JSON.stringify([ url.origin, url.pathname,
            ...adapter.searchParameters.map(name => [ name,
                url.searchParams.getAll(name).map(value => name === 'q' ? value.trim() : value),
            ]),
            ...(includeOffset ? [ Number(url.searchParams.get(adapter.offsetParameter)) ] : []),
        ]);
    }

    function nextResultURL(rawURL, baseURL) {
        let url;
        try { url = new URL(rawURL, baseURL); } catch { return null; }
        const offset = Number(url.searchParams.get(adapter.offsetParameter));
        if ( searchIdentity(url) !== searchIdentity(baseURL) ||
            Number.isSafeInteger(offset) === false ||
            offset <= Number(new URL(baseURL).searchParams.get(adapter.offsetParameter)) ) { return null; }
        return url.href;
    }

    function nextResultPage(root = document, baseURL = location.href) {
        for ( const node of root.querySelectorAll(adapter.nextSelector) ) {
            const anchor = node.closest('a[href]');
            if ( anchor === null ) { continue; }
            const url = nextResultURL(anchor.getAttribute('href'), baseURL);
            if ( url !== null ) { return url; }
        }
        return null;
    }

    function restorePagination() {
        // Open-page DOM survives content-script replacement during an update.
        const source = searchIdentity(location.href, true);
        if ( source === paginationSource ) { return; }
        paginationSource = source;
        paginationNext = undefined;
        paginationTarget = 10;
        paginationAuto = true;
        paginationComplete = false;
        let saved;
        try { saved = JSON.parse(document.documentElement.getAttribute('data-queree-pagination')); } catch { }
        if ( saved?.source !== source || typeof saved.auto !== 'boolean' ||
            Number.isSafeInteger(saved.target) === false || saved.target < 10 ) { return; }
        if ( saved.next !== undefined && saved.next !== null &&
            nextResultURL(saved.next, location.href) === null ) { return; }
        paginationNext = saved.next;
        paginationTarget = Math.min(saved.target,
            Math.max(10, document.querySelectorAll(adapter.headingSelector).length + 10));
        paginationAuto = saved.auto;
        paginationComplete = saved.complete === true;
    }

    function resultCounts() {
        const retained = new Set();
        const pending = new Set();
        for ( const heading of document.querySelectorAll(adapter.headingSelector) ) {
            const anchor = resultAnchor(heading);
            if ( anchor === undefined ) { continue; }
            const url = resultURL(anchor);
            if ( url === undefined ) { continue; }
            const decision = recorded.get(url.href);
            const boundary = resultContent(heading, anchor.closest(adapter.containerSelector));
            if ( boundary.checkVisibility({ visibilityProperty: true }) === false &&
                hiddenBySettings(decision) === false ) { continue; }
            if ( decision === undefined ||
                (needsCharacteristicMeasurement(decision) && decision.cached === true) ) {
                pending.add(url.href);
                continue;
            }
            if ( decision.verdict === 'unresolved' || needsCharacteristicMeasurement(decision) ) {
                continue;
            }
            if ( hiddenBySettings(decision) ) { continue; }
            retained.add(url.href);
        }
        return { retained: retained.size, pending: pending.size };
    }

    function loadNativeResultPage(loadMore) {
        return new Promise(resolve => {
            const count = document.querySelectorAll(adapter.headingSelector).length;
            const startedGeneration = generation;
            const deadline = Date.now() + 30000;
            let timer;
            const finish = result => {
                clearTimeout(timer);
                if ( paginationCancel === cancel ) { paginationCancel = undefined; }
                resolve(result);
            };
            // Stop pauses our chaining, not Bing's in-flight request. Keep its slot
            // until it finishes so pressing More again cannot start a duplicate.
            const cancel = () => {
                if ( enabled === false || generation !== startedGeneration ) { finish(undefined); }
            };
            paginationCancel = cancel;
            const check = () => {
                if ( enabled === false || generation !== startedGeneration ) { finish(undefined); return; }
                if ( document.querySelectorAll(adapter.headingSelector).length > count ||
                    adapter.getNativeLoadMore() === undefined ) { finish(document); return; }
                if ( Date.now() >= deadline ) { finish(undefined); return; }
                timer = setTimeout(check, 250);
            };
            try {
                loadMore();
                check();
            } catch {
                finish(undefined);
            }
        });
    }

    function loadNextResultPage(url, scrollNative = false) {
        return new Promise(resolve => {
            const known = scrollNative ? new Set(Array.from(document.querySelectorAll(adapter.headingSelector),
                heading => resultURL(resultAnchor(heading))?.href)) : undefined;
            const frame = document.createElement('iframe');
            frame.setAttribute('aria-hidden', 'true');
            frame.style.cssText = `position:fixed;left:-10000px;top:0;border:0;
                width:${window.innerWidth}px;height:${window.innerHeight}px;visibility:hidden;`;
            const deadline = Date.now() + 30000;
            let timer;
            const finish = result => {
                clearTimeout(timer);
                frame.remove();
                if ( paginationCancel === cancel ) { paginationCancel = undefined; }
                resolve(result);
            };
            const cancel = (navigating = false) => finish(navigating ? null : undefined);
            paginationCancel = cancel;
            const check = () => {
                let doc;
                try { doc = frame.contentDocument; } catch { }
                if ( doc?.URL !== 'about:blank' && doc?.readyState !== 'loading' ) {
                    if ( doc?.querySelector('form[action*="/sorry/"], #captcha-form') ||
                        /\/(?:sorry|turing\/)/.test(doc?.URL || '') ) { finish(undefined); return; }
                    if ( doc?.querySelector(adapter.headingSelector) ) {
                        if ( searchIdentity(doc.URL, true) !== searchIdentity(url, true) ) {
                            finish(undefined); return;
                        }
                        const fresh = known === undefined || Array.from(doc.querySelectorAll(adapter.headingSelector))
                            .some(heading => {
                                const link = resultURL(resultAnchor(heading));
                                return link !== undefined && known.has(link.href) === false;
                            });
                        // Native load completion, not a quiet-network requirement.
                        if ( fresh && (doc.readyState === 'complete' || Date.now() >= deadline) ) { finish(doc); return; }
                        // Mobile Bing exposes no load-more method. Scroll its hidden
                        // page instead, leaving the visible page and old cards intact.
                        if ( scrollNative && doc.readyState === 'complete' ) {
                            frame.contentWindow.scrollTo(0, doc.documentElement.scrollHeight);
                        }
                    }
                }
                if ( Date.now() >= deadline ) { finish(undefined); return; }
                timer = setTimeout(check, 250);
            };
            frame.src = url;
            document.body.append(frame);
            check();
        });
    }

    function appendResultPage(doc) {
        const root = document.querySelector(adapter.resultRoot) || document.querySelector(adapter.panelRoot);
        if ( root === null ) { return 0; }
        const urls = new Set();
        for ( const heading of document.querySelectorAll(adapter.headingSelector) ) {
            const anchor = resultAnchor(heading);
            const url = anchor && resultURL(anchor);
            if ( url !== undefined ) {
                urls.add(url.href);
            }
        }
        let added = 0;
        for ( const heading of doc.querySelectorAll(adapter.headingSelector) ) {
            const anchor = resultAnchor(heading);
            const url = anchor && resultURL(anchor);
            if ( url === undefined ) { continue; }
            if ( urls.has(url.href) ) { continue; }
            const original = heading.closest(adapter.containerSelector);
            if ( original === null ) { continue; }
            urls.add(url.href);
            // Keep native favicon, address, typography and spacing under the source page's CSS.
            // Import into this page's realm so Firefox recognizes links in native context menus.
            // Registered listeners are not copied; remove inline behavior and widgets too.
            let row;
            const content = resultContent(heading, original);
            if ( content !== original ) {
                row = document.importNode(original, false);
                row.append(document.importNode(content, true));
            } else {
                row = document.importNode(original, true);
            }
            row.classList.add('queree-appended-result');
            for ( const widget of row.querySelectorAll(
                'script, style, link, base, meta, template, animate, set, audio, video, iframe, object, embed, form, button, input, select, textarea, [role="button"]'
            ) ) { widget.remove(); }
            for ( const node of [ row, ...row.querySelectorAll('*') ] ) {
                for ( const attribute of [ ...node.attributes ] ) {
                    if ( /^on/i.test(attribute.name) || /^js(?:action|controller|data|name|model)$/.test(attribute.name) ||
                        [ 'id', 'ping', 'srcdoc' ].includes(attribute.name) ) {
                        node.removeAttribute(attribute.name);
                    }
                    if ( attribute.name === 'href' || attribute.name === 'xlink:href' ) {
                        let url;
                        try { url = new URL(attribute.value, doc.baseURI); } catch { }
                        if ( /^https?:$/.test(url?.protocol) === false ) {
                            node.removeAttribute(attribute.name);
                        } else {
                            node.setAttribute(attribute.name, url.href);
                        }
                    }
                }
            }
            root.insertBefore(row, root.querySelector(':scope > .b_pag'));
            added += 1;
        }
        if ( added !== 0 ) {
            // Later pages can introduce card styles absent from the first page.
            // Scope them to copied results instead of restyling the search page.
            const styles = new Set(Array.from(document.querySelectorAll('style'), node => node.textContent));
            for ( const original of doc.querySelectorAll('style') ) {
                // Use the browser's parsed rules; raw text can close the scope early.
                const rules = Array.from(original.sheet?.cssRules || [], rule => rule.cssText).join('\n');
                if ( rules === '' ) { continue; }
                // Native nesting works on our Firefox 140 minimum; @scope does not.
                const css = `:where(.queree-appended-result) {\n${rules}\n}`;
                if ( styles.has(original.textContent) || styles.has(css) ) { continue; }
                const style = document.createElement('style');
                style.className = 'queree-appended-style';
                style.textContent = css;
                root.append(style);
                styles.add(css);
            }
        }
        return added;
    }

    function renderPagination() {
        if ( panel === undefined ) { return; }
        restorePagination();
        const saved = JSON.stringify({ source:paginationSource, next:paginationNext,
            target:paginationTarget, auto:paginationAuto, complete:paginationComplete });
        if ( document.documentElement.getAttribute('data-queree-pagination') !== saved ) {
            document.documentElement.setAttribute('data-queree-pagination', saved);
        }
        const next = paginationNext === undefined ? nextResultPage() : paginationNext;
        const nativePaging = next === null && adapter.hasNativePagination?.() === true;
        if ( paginationButton === undefined && next === null && nativePaging === false ) { return; }
        if ( paginationButton === undefined ) {
            paginationButton = document.createElement('button');
            paginationButton.type = 'button';
            paginationButton.className = 'queree-more-results';
            panel.append(paginationButton);
            paginationButton.addEventListener('click', event => {
                if ( event.isTrusted !== true ) { return; }
                if ( paginationAuto && paginationComplete === false && (running || paginationLoading) ) {
                    paginationAuto = false;
                    paginationCancel?.();
                } else {
                    paginationTarget = resultCounts().retained + 10;
                    paginationAuto = true;
                    paginationComplete = false;
                    maybeLoadMore();
                }
                renderPagination();
            });
        }
        paginationButton.disabled = next === null && nativePaging === false && paginationLoading === false;
        const text = paginationButton.disabled ? 'No more results'
            : paginationAuto && paginationComplete === false && (running || paginationLoading) ? 'Stop loading'
                : paginationButton.dataset.problem || 'More results';
        if ( paginationButton.textContent !== text ) { paginationButton.textContent = text; }
    }

    async function maybeLoadMore() {
        restorePagination();
        if ( enabled === false || paginationAuto === false || paginationComplete ||
            recorded.size === 0 ) { renderPagination(); return; }
        const counts = resultCounts();
        if ( counts.retained >= paginationTarget ) {
            paginationComplete = true;
            paginationCancel?.();
            renderPagination();
            return;
        }
        // Refill before the last slow page finishes, without running pages ahead of the queue.
        if ( paginationLoading || counts.pending >= simultaneousInspections ) { renderPagination(); return; }
        // Setup pauses are not page failures or an explicit Stop.
        if ( (mobileInspection.mobile && mobileInspection.tabsReady === false) ||
            Array.from(recorded.values()).some(decision => decision.reasons?.some(reason =>
                reason.kind === 'private_window_unsupported' ||
                (reason.kind === 'private_tab_needed' && mobileInspection.tabsReady !== true))) ) {
            renderPagination();
            return;
        }
        const next = paginationNext === undefined ? nextResultPage() : paginationNext;
        const nativePaging = next === null && adapter.hasNativePagination?.() === true;
        if ( next === null && nativePaging === false ) { renderPagination(); return; }
        const nativeMore = nativePaging ? adapter.getNativeLoadMore() : undefined;
        paginationLoading = true;
        const currentGeneration = generation;
        const currentSearch = paginationSource;
        renderPagination();
        try {
            const doc = nativeMore !== undefined
                ? await loadNativeResultPage(nativeMore)
                : await loadNextResultPage(next || location.href, nativePaging);
            if ( enabled === false || generation !== currentGeneration ||
                searchIdentity(location.href, true) !== currentSearch ) { return; }
            // Leaving the page is not a failed fetch or an explicit Stop.
            if ( doc === null ) { return; }
            if ( doc === undefined ) {
                if ( paginationAuto && paginationComplete === false ) {
                    paginationButton.dataset.problem = 'Next page unavailable. Retry';
                }
                if ( paginationComplete === false ) { paginationAuto = false; }
                return;
            }
            delete paginationButton.dataset.problem;
            paginationNext = nextResultPage(doc, doc.URL);
            if ( doc !== document ) { appendResultPage(doc); }
            scheduleScan();
        } finally {
            paginationLoading = false;
            renderPagination();
        }
    }

    function exclusionCSS(selectors) {
        return `
            :is(${selectors.join(',\n')}) {
                display: none !important;
            }
        `;
    }

    function exclusionMarkerCSS(reasons) {
        const selectors = Array.from(reasons.keys());
        const targets = `:is(${selectors.join(',\n')})`;
        let css = `
            ${targets} {
                background-color: rgba(217, 145, 0, 0.12) !important;
                box-shadow: inset 4px 0 #a65f00 !important;
            }
            ${targets}::before {
                background: #8a4b00 !important;
                color: #fff !important;
                content: "Excluded by Quer.ee" !important;
                display: inline-block !important;
                font: 600 12px/1.4 sans-serif !important;
                margin: 0 0 6px 6px !important;
                padding: 2px 7px !important;
            }
        `;
        const labels = new Set(reasons.values());
        for ( const label of labels ) {
            if ( label === 'Excluded by Quer.ee' ) { continue; }
            const matching = selectors.filter(selector => reasons.get(selector) === label);
            const others = selectors.filter(selector => reasons.get(selector) !== label);
            const unambiguous = others.length === 0 ? '' : `:not(:is(${others.join(',\n')}))`;
            // Personal category names are text, not CSS syntax.
            const content = label.replace(/["\\\x00-\x1f\x7f]/g,
                character => `\\${character.charCodeAt(0).toString(16)} `);
            css += `\n:is(${matching.join(',\n')})${unambiguous}::before { content: "${content}" !important; }\n`;
        }
        return css;
    }

    function changeStylesheets(add, remove = []) {
        if ( add.length === 0 && remove.length === 0 ) {
            return stylesheetOperation;
        }
        if ( enabled === false ) {
            // Stop cleanup must run before native shutdown clears vAPI.
            return new Promise(resolve => {
                for ( const css of remove ) {
                    vAPI.userStylesheet.remove(css);
                    appliedStylesheets.delete(css);
                }
                vAPI.userStylesheet.apply(resolve);
            });
        }
        stylesheetOperationsPending += 1;
        const stylesheetGeneration = generation;
        stylesheetOperation = stylesheetOperation.then(( ) =>
            new Promise(resolve => {
                if ( shuttingDown || generation !== stylesheetGeneration ) {
                    resolve();
                    return;
                }
                for ( const css of remove ) {
                    vAPI.userStylesheet.remove(css);
                    appliedStylesheets.delete(css);
                }
                for ( const css of add ) {
                    vAPI.userStylesheet.add(css);
                    appliedStylesheets.add(css);
                }
                vAPI.userStylesheet.apply(resolve);
            })
        ).finally(( ) => { stylesheetOperationsPending -= 1; });
        return stylesheetOperation;
    }

    async function addExclusionSelectors(selectors, replace = false) {
        const reasons = replace ? new Map() : new Map(selectorReasons);
        let changed = replace;
        for ( const [ selector, label ] of selectors ) {
            const previous = reasons.get(selector);
            const next = previous === undefined || previous === label
                ? label : 'Excluded by Quer.ee';
            if ( previous !== next ) { changed = true; }
            reasons.set(selector, next);
        }
        if ( changed === false ) { return stylesheetOperation; }
        const sheets = new Map();
        const entries = Array.from(reasons);
        for ( let offset = 0; offset < entries.length; ) {
            let count = Math.min(maxExcludedSelectors, entries.length - offset);
            let chunk, hiddenCSS, markerCSS;
            while ( count > 0 ) {
                chunk = new Map(entries.slice(offset, offset + count));
                hiddenCSS = exclusionCSS(Array.from(chunk.keys()));
                if ( hiddenCSS.length <= maxExclusionCSSLength ) {
                    markerCSS = exclusionMarkerCSS(chunk);
                    if ( markerCSS.length <= maxExclusionCSSLength ) { break; }
                }
                count = Math.floor(count / 2);
            }
            if ( count === 0 ) {
                hidingUnavailable = true;
                return false;
            }
            sheets.set(hiddenCSS, markerCSS);
            offset += count;
        }
        const previous = Array.from(excludedVisible
            ? exclusionStylesheets.values() : exclusionStylesheets.keys());
        const next = Array.from(excludedVisible ? sheets.values() : sheets.keys());
        selectorReasons.clear();
        exclusionStylesheets.clear();
        for ( const [ selector, label ] of reasons ) { selectorReasons.set(selector, label); }
        for ( const [ hiddenCSS, markerCSS ] of sheets ) { exclusionStylesheets.set(hiddenCSS, markerCSS); }
        await changeStylesheets(
            next.filter(css => previous.includes(css) === false),
            previous.filter(css => next.includes(css) === false)
        );
    }

    function matchedExcludedContainers() {
        if ( selectorReasons.size === 0 ) { return []; }
        try {
            return Array.from(document.querySelectorAll(
                Array.from(selectorReasons.keys()).join(',')
            ));
        } catch ( reason ) {
            hidingUnavailable = true;
            console.error('Quer.ee could not match excluded results', reason);
            return [];
        }
    }

    function ensurePanel() {
        if ( panel !== undefined ) {
            if ( panel.isConnected === false ) {
                (document.querySelector(adapter.panelRoot) || document.body).prepend(panel);
            }
            return;
        }
        // Firefox can leave the previous content script's DOM on an open tab.
        const previous = document.querySelectorAll('#queree-results-control');
        for ( const node of previous ) { node.remove(); }
        document.getElementById('queree-results-style')?.remove();
        panel = document.createElement('aside');
        panel.id = 'queree-results-control';
        panel.innerHTML = '<strong>Quer.ee</strong> <span role="status"></span> <button type="button">Show excluded</button>';
        bindDebugGesture(panel.querySelector('strong'));
        renderInspectionDebugMode();
        status = panel.querySelector('span');
        if ( previous.length !== 0 ) { status.textContent = 'Restoring results'; }
        toggle = panel.querySelector('button');
        toggle.addEventListener('click', async event => {
            if ( event.isTrusted !== true ) { return; }
            const button = toggle;
            button.disabled = true;
            excludedVisible = !excludedVisible;
            const hidden = Array.from(exclusionStylesheets.keys());
            const markers = Array.from(exclusionStylesheets.values());
            await changeStylesheets(
                excludedVisible ? markers : hidden,
                excludedVisible ? hidden : markers
            );
            if ( enabled === false || toggle !== button ) { return; }
            button.textContent = excludedVisible ? 'Hide excluded' : 'Show excluded';
            button.disabled = false;
            holdStatusSummary();
            if ( excludedVisible ) {
                matchedExcludedContainers()[0]?.scrollIntoView({ block: 'center' });
            }
        });
        renderPagination();
        style = document.createElement('style');
        style.id = 'queree-results-style';
        style.textContent = `
            :is(${adapter.panelRoot}):has(> #queree-results-control) { isolation: isolate; }
            #queree-results-control {
                background: rgb(244 240 229 / 85%); border: 1px solid #8e7e54; color: #282417;
                align-items: center; display: flex; flex-wrap: wrap; font: 13px/1.4 sans-serif;
                gap: 8px; margin: 8px 0 calc(8px + 0.7em); padding: 7px 16px;
                box-sizing: border-box; max-width: 680px; position: sticky;
                width: 100%; z-index: 1;
            }
            #queree-results-control button { flex: none; margin-left: auto; }
            #queree-results-control strong { cursor: pointer; user-select: none; touch-action: manipulation; }
            #queree-results-control .queree-more-results { margin-left: 0; }
            #queree-results-control .queree-mobile-q {
                margin-left: 0; color: #17251b; background: #9ed6ad;
                border: 2px solid #275b36; border-radius: 50%; font-weight: bold;
                min-width: 34px; min-height: 34px; cursor: pointer;
            }
            #queree-results-control .queree-mobile-q[data-needed="true"] {
                background: #ffc04d; border-color: #754900;
                animation: queree-private-needed 1.6s ease-in-out infinite;
            }
            #queree-results-control .queree-mobile-help { flex-basis: 100%; }
            #queree-results-control .queree-reduced-motion { display: none; }
            @keyframes queree-private-needed { 50% { opacity: 0.35; } }
            @media (prefers-reduced-motion: reduce) {
                #queree-results-control .queree-mobile-q[data-needed="true"] { animation: none; }
                #queree-results-control .queree-mobile-q[data-needed="true"] .queree-reduced-motion { display: inline; }
            }
            .queree-unresolved, .queree-characteristic {
                display: block; color: #704000; background: #fff3d6; font: 12px/1.3 sans-serif;
            }
            .queree-unresolved[role="button"] { cursor: pointer; text-decoration: underline; }
        `;
        document.documentElement.append(style);
        (document.querySelector(adapter.panelRoot) || document.body).prepend(panel);
        panel.style.top = `${panel.offsetHeight * 1.8}px`;
        renderMobileInspection();
    }

    function showBackgroundSetup() {
        mobileHelp.textContent = (backgroundSettingsCopied
            ? 'Settings address copied. '
            : (mobileInspection.background === 'paused' ? 'Background pages are not running. ' : '') +
                'Tap Q to copy the settings address. ') +
            'Paste it into the address bar and set dom.suspend_inactive.enabled to false. ' +
            'Then return to your search. This affects all background tabs. ' +
            'Q checks again when you return to this search. ' + backgroundSettingsURL;
        mobileHelp.hidden = false;
    }

    function renderMobileInspection() {
        if ( panel === undefined || mobileInspection.mobile !== true ) { return; }
        if ( mobileQ === undefined ) {
            mobileQ = document.createElement('button');
            mobileQ.type = 'button';
            mobileQ.className = 'queree-mobile-q';
            mobileQ.innerHTML = 'Q<span class="queree-reduced-motion"> Setup needed</span>';
            panel.querySelector('strong').after(mobileQ);
            mobileHelp = document.createElement('div');
            mobileHelp.className = 'queree-mobile-help';
            mobileHelp.hidden = true;
            panel.append(mobileHelp);
            mobileQ.addEventListener('click', event => {
                if ( event.isTrusted !== true ) { return; }
                prepareMobileInspection();
            });
        }
        mobileQ.dataset.needed = String(mobileInspection.ready !== true);
        const label = mobileInspection.ready ? 'Background check passed'
            : mobileInspection.tabsReady ? 'Check background inspections' : 'Start private inspection tabs';
        mobileQ.title = label;
        mobileQ.setAttribute('aria-label', label);
        if ( mobileInspection.ready ) { mobileHelp.hidden = true; }
        if ( mobileInspection.background === 'paused' ) { showBackgroundSetup(); }
    }

    async function prepareMobileInspection(copySettings = true) {
        if ( mobileQ === undefined || mobileQ.disabled ) { return; }
        const button = mobileQ;
        const help = mobileHelp;
        const copied = copySettings
            ? navigator.clipboard.writeText(backgroundSettingsURL).then(() => true, () => false)
            : Promise.resolve(backgroundSettingsCopied);
        button.disabled = true;
        help.textContent = 'Preparing background inspections...';
        help.hidden = false;
        try {
            const reply = await vAPI.messaging.send('queree', { what: 'prepareMobileInspections' });
            if ( button !== mobileQ ) { return; }
            if ( reply?.mobile ) { setMobileInspection(reply); }
            const didCopy = await copied;
            if ( button !== mobileQ ) { return; }
            backgroundSettingsCopied = didCopy;
            if ( mobileInspection.ready ) { help.hidden = true; }
            else if ( mobileInspection.background === 'paused' ) {
                showBackgroundSetup();
            } else if ( mobileInspection.tabsReady ) {
                help.textContent = 'Could not check background execution. Tap Q to retry.';
            } else {
                help.textContent = reply?.problem === 'private_permission_needed'
                    ? 'In Fennec Extensions, allow uBlock Origin + Quer.ee to run in private browsing. Then tap Q again.'
                    : 'Open a private tab and enter about:blank. Quer.ee will prepare its inspection tabs; then return to your search.';
            }
        } catch {
            help.textContent = 'Could not complete setup. Tap Q to try again.';
        } finally {
            button.disabled = false;
        }
    }

    function renderInspectionDebugMode() {
        const heading = panel?.querySelector('strong');
        if ( heading ) { heading.textContent = keepUnresolvedTabs ? 'Quer.ee (debug)' : 'Quer.ee'; }
        for ( const label of document.querySelectorAll('.queree-unresolved') ) {
            renderInspectionTabLink(label);
        }
    }

    function setMobileInspection(next) {
        if ( next.revision <= mobileInspection.revision ) { return; }
        const becameReady = mobileInspection.ready !== true && next.ready === true;
        const tabsBecameReady = mobileInspection.tabsReady !== true && next.tabsReady === true;
        mobileInspection = next;
        renderMobileInspection();
        if ( becameReady && mobileHelp ) { mobileHelp.hidden = true; }
        if ( (becameReady || tabsBecameReady) && enabled ) {
            for ( const [ url, decision ] of recorded ) {
                if ( decision.reasons?.some(reason => reason.kind === 'private_tab_needed') ) {
                    recorded.delete(url);
                }
            }
            processed = new WeakMap();
            scheduleScan();
        }
        if ( tabsBecameReady && enabled && document.hidden === false && next.background === 'unchecked' ) {
            retryMobileInspection();
        }
    }

    function updateStatus() {
        if ( status === undefined || emptyStored || toggle?.disabled ) { return; }
        if ( stylesheetOperationsPending !== 0 ) { return; }
        const unresolved = document.querySelectorAll('.queree-unresolved').length;
        const excluded = matchedExcludedContainers();
        const presentationFailed =
            excludedVisible === false &&
            excluded.some(node => getComputedStyle(node).display !== 'none');
        const text = hidingUnavailable || presentationFailed
            ? `Result hiding unavailable, ${unresolved} unresolved`
            : `${excluded.length} excluded, ${unresolved} unresolved`;
        const summary = activeBatches.size !== 0
            ? `${text} (still checking)` : text;
        if ( status.textContent !== summary ) { status.textContent = summary; }
    }

    function renderProgress() {
        if ( status === undefined || summaryTimer !== undefined ) { return; }
        const text = `${progressCompleted} of ${progressTotal} results inspected`;
        if ( status.firstChild?.textContent !== text ) {
            status.textContent = text;
            const dots = document.createElement('span');
            dots.setAttribute('aria-hidden', 'true');
            status.append(dots);
        }
        status.lastElementChild.textContent = '.'.repeat(progressDots);
    }

    function stopProgress() {
        clearTimeout(progressTimer);
        progressTimer = undefined;
    }

    function animateProgress() {
        progressDots = (progressDots + 1) % 4;
        renderProgress();
        progressTimer = setTimeout(animateProgress, 400);
    }

    function startProgress(items) {
        stopProgress();
        progressCompleted = recorded.size;
        progressTotal = new Set([ ...recorded.keys(), ...Array.from(activeItems.values(), item => item.url),
            ...items.map(item => item.url) ]).size;
        progressDots = 0;
        // A quick cache reply can finish before the first visible tick.
        progressTimer = setTimeout(animateProgress, 400);
    }

    function updateProgress() {
        if ( progressTimer === undefined ) { return; }
        // Batch counters restart for each appended page; saved decisions cover the whole search.
        progressCompleted = recorded.size;
    }

    function holdStatusSummary() {
        clearTimeout(summaryTimer);
        updateStatus();
        summaryTimer = setTimeout(( ) => {
            summaryTimer = undefined;
            if ( progressTimer === undefined ) {
                updateStatus();
            } else {
                renderProgress();
            }
        }, summaryHoldDuration);
    }

    function resultTitle(heading) {
        const title = heading.cloneNode(true);
        for ( const label of title.querySelectorAll('.queree-unresolved, .queree-characteristic') ) {
            label.remove();
        }
        return title.textContent?.trim() || '';
    }

    function resultURL(anchor) {
        let url;
        try {
            url = new URL(anchor.href);
        } catch {
            return;
        }
        if ( /^https?:$/.test(url.protocol) === false || url.username !== '' || url.password !== '' ) { return; }
        url = adapter.resultURL(url);
        if ( url === undefined || /^https?:$/.test(url.protocol) === false ||
            url.username !== '' || url.password !== '' ) { return; }
        if ( url.hash.includes(':~:') ) {
            const hash = url.hash.split(':~:', 1)[0];
            url.hash = hash === '#' ? '' : hash;
        }
        return url;
    }

    function collect() {
        const out = [];
        for ( const heading of document.querySelectorAll(adapter.headingSelector) ) {
            const anchor = resultAnchor(heading);
            if ( anchor === undefined ) { continue; }
            if ( processed.get(anchor) === anchor.href ) { continue; }
            const url = resultURL(anchor);
            if ( url === undefined ) { continue; }
            if ( adapter.isRedirectURL(new URL(anchor.href)) && url.href !== anchor.href ) {
                anchor.setAttribute('href', url.href);
            }
            processed.set(anchor, anchor.href);
            const wrapper = anchor.closest(adapter.containerSelector);
            const container = resultContent(heading, wrapper);
            if ( container !== wrapper ) { container.classList.add('queree-result'); }
            out.push({
                id: `${Date.now()}-${out.length}`,
                url: url.href,
                anchor,
                sourceHref: anchor.href,
                heading,
                result_title: Array.from(resultTitle(heading)).slice(0, 512).join(''),
                result_description: Array.from(container?.querySelector(adapter.descriptionSelector)?.textContent?.trim() || '').slice(0, 1024).join(''),
                sourceReasons: adapter.sourceReasons(url),
            });
        }
        return out;
    }

    function reasonApplies(reason) {
        switch ( reason?.kind ) {
        case 'advertising':
        case 'search_advertising':
        case 'affiliate_link':
        case 'affiliate_publisher':
        case 'affiliate_tracked_link':
            return excludeAdvertisingSignals;
        case 'cross_site_tracking':
            return excludeCrossSiteTracking;
        case 'commercial_store':
            return excludeShoppingSignals;
        default:
            return true;
        }
    }

    function excludedBySettings(decision) {
        if ( decision?.personal_category !== undefined ) {
            return decision.personal_category.enabled === false;
        }
        if ( decision?.verdict !== 'exclude' ) { return false; }
        const reasons = decision.reasons || [];
        return reasons.length === 0 || reasons.some(reasonApplies);
    }

    function hiddenBySettings(decision) {
        return excludedBySettings(decision) || (decision?.personal_category === undefined && (
            (requireSingleDomain && decision?.domain_only !== true && decision?.single_domain !== true) ||
            (excludeShoppingSignals && decision?.shopping_signals === true)
        ));
    }

    function exclusionLabel(decision, characteristicMismatch, item, observed = false) {
        if ( decision?.personal_category?.enabled === false ) {
            return `Hidden by setting: ${decision.personal_category.name}`;
        }
        if ( observed === false && excludedBySettings(decision) === false && excludeShoppingSignals &&
            decision?.shopping_signals === true ) {
            return 'Hidden by setting: Shopping signals';
        }
        if ( characteristicMismatch ) {
            return decision?.single_domain === false
                ? 'Not single-domain' : 'Single-domain unconfirmed';
        }
        const labels = {
            advertising: 'Advertising',
            search_advertising: 'Ad result',
            affiliate_link: 'Affiliate links',
            affiliate_publisher: 'Listed affiliate publisher',
            affiliate_tracked_link: 'Affiliate or tracked link',
            cross_site_tracking: 'Cross-site tracking',
            commercial_store: 'Shopping',
            adult_domain: 'Adult content',
            scam: 'Fake store / scam',
            malware: 'Malware',
        };
        const categories = {
            community_contribution: 'Social platforms',
            public_interest_organization: 'Public-interest organizations',
            government_education: 'Government and education',
            professional_publication: 'Professional publications',
            commercial_corporate: 'Corporations',
        };
        for ( const reason of decision?.reasons || [] ) {
            if ( observed && reason?.kind === 'source_category' ) { continue; }
            if ( observed === false && reasonApplies(reason) === false ) { continue; }
            if ( reason?.kind === 'search_advertising' &&
                item.sourceReasons?.some(source => source.kind === 'search_advertising') !== true ) {
                return 'Excluded by Quer.ee';
            }
            if ( reason?.kind === 'source_category' && Object.hasOwn(categories, reason.category) ) {
                return `Hidden by setting: ${categories[reason.category]}`;
            }
            if ( Object.hasOwn(labels, reason?.kind) ) { return labels[reason.kind]; }
        }
        return observed ? 'Excluded from Quer.ee index' : 'Excluded by Quer.ee';
    }

    function unresolvedLabel(reason) {
        if ( reason?.kind === 'http_error' && reason.detail === '429' ) {
            return 'Site rate limit reached';
        }
        if ( reason?.challenge_provider === 'cloudflare' ) {
            return 'Cloudflare verification did not finish';
        }
        const labels = {
            challenge_page: 'Site verification did not finish',
            incomplete_load: 'Page inspection timed out',
            navigation_failed: 'Page could not load',
            private_tab_needed: 'Private inspection tab needed',
            firefox_restricted: 'Firefox does not allow inspection',
        };
        if ( Object.hasOwn(labels, reason?.kind) ) { return labels[reason.kind]; }
        if ( reason?.kind === 'http_error' && reason.detail ) {
            return `Site returned HTTP ${reason.detail}`;
        }
        return 'Quer.ee could not inspect this result';
    }

    function renderInspectionTabLink(label) {
        const interactive = label.dataset.inspectionTabId !== undefined && keepUnresolvedTabs &&
            label.dataset.inspectionTabGeneration === String(inspectionTabGeneration);
        if ( interactive ) {
            label.setAttribute('role', 'button');
            label.setAttribute('aria-label', `Open inspection tab: ${label.textContent}`);
        } else {
            label.removeAttribute('role');
            label.removeAttribute('aria-label');
        }
        label.tabIndex = interactive ? 0 : -1;
    }

    async function openInspectionTab(event) {
        if ( event.isTrusted !== true || keepUnresolvedTabs === false ||
            (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') ) { return; }
        const label = event.currentTarget;
        if ( label.className !== 'queree-unresolved' ) { return; }
        event.preventDefault();
        event.stopPropagation();
        if ( label.dataset.inspectionTabGeneration !== String(inspectionTabGeneration) ) { return; }
        const tabId = Number(label.dataset.inspectionTabId);
        if ( Number.isInteger(tabId) === false ) { return; }
        const opened = await vAPI.messaging.send('queree', { what: 'openInspectionTab', tabId });
        if ( opened === false ) {
            delete label.dataset.inspectionTabId;
            renderInspectionTabLink(label);
        }
    }

    function apply(item, decision, pendingSelectors) {
        if ( item.anchor.href !== item.sourceHref ) { return; }
        const verdict = decision?.verdict;
        const excluded = excludedBySettings(decision);
        const personal = decision?.personal_category !== undefined;
        const characteristicMismatch = personal === false && requireSingleDomain && decision?.domain_only !== true &&
            excluded === false && decision?.single_domain !== true;
        if ( hiddenBySettings(decision) ) {
            const selectors = selectorsForExcludedResult(item.anchor);
            if ( selectors.length === 0 ) {
                hidingUnavailable = true;
            } else {
                const label = exclusionLabel(decision, characteristicMismatch, item);
                pendingSelectors.push(...selectors.map(selector => [ selector, label ]));
            }
        }
        // Keep status in the title's orientation when result wrappers are transformed.
        const existing = item.heading.querySelector('.queree-unresolved, .queree-characteristic');
        const missingChecks = verdict === 'exclude' && needsCharacteristicMeasurement(decision);
        const incomplete = verdict === 'unresolved' || missingChecks;
        const observedExclusion = excluded === false && verdict === 'exclude';
        if ( incomplete === false && characteristicMismatch === false && observedExclusion === false ) {
            existing?.remove();
            return;
        }
        const label = existing || document.createElement('span');
        label.className = incomplete
            ? 'queree-unresolved' : 'queree-characteristic';
        if ( verdict === 'unresolved' && decision.inspection_tab_id !== undefined ) {
            label.dataset.inspectionTabId = String(decision.inspection_tab_id);
            label.dataset.inspectionTabGeneration = String(decision.inspection_tab_generation);
        } else {
            delete label.dataset.inspectionTabId;
            delete label.dataset.inspectionTabGeneration;
        }
        label.onclick = openInspectionTab;
        label.onkeydown = openInspectionTab;
        const reason = decision?.reasons?.[0];
        const failure = decision?.inspection_error || reason;
        label.dataset.reason = reason?.kind || 'unresolved';
        label.title = [ failure?.detail || reason?.detail,
            failure?.retry_after ? `Retry-After: ${failure.retry_after}` : '',
        ].filter(Boolean).join('; ');
        const text = missingChecks
            ? `${exclusionLabel(decision, false, item, true)}; remaining checks ${decision.cached ? 'pending' : 'incomplete'}`
            : observedExclusion ? exclusionLabel(decision, false, item, true)
                : verdict === 'unresolved' && reason !== undefined ? unresolvedLabel(reason)
                    : characteristicMismatch ? exclusionLabel(decision, true, item)
                        : unresolvedLabel(reason);
        if ( label.textContent !== text ) { label.textContent = text; }
        if ( existing === null ) { item.heading.append(label); }
        renderInspectionTabLink(label);
    }

    function rememberDecision(item, decision) {
        if ( mobileInspection.tabsReady && item.inspectionPoolState !== mobileInspection &&
            decision.reasons?.some(reason => reason.kind === 'private_tab_needed') ) {
            processed.delete(item.anchor);
            rescan = true;
            return false;
        }
        if ( needsCharacteristicMeasurement(decision) && (decision.cached === true ||
            (item.inspectionSettingsGeneration !== undefined &&
                item.inspectionSettingsGeneration !== settingsGeneration)) ) {
            decision = { ...decision, cached: true };
            processed.delete(item.anchor);
            rescan = true;
        }
        const previous = recorded.get(item.url);
        recorded.set(item.url, decision);
        return (previous?.verdict === 'exclude' && decision.verdict !== 'exclude') ||
            (previous?.verdict !== 'exclude' && (
                (requireSingleDomain && (decision.verdict === 'exclude' ||
                    previous?.single_domain !== decision.single_domain ||
                    previous?.domain_only !== decision.domain_only)) ||
                (excludeShoppingSignals &&
                    (previous?.shopping_signals === true) !== (decision.shopping_signals === true))
            ));
    }

    function needsCharacteristicMeasurement(decision) {
        if ( decision?.domain_only === true || decision?.personal_category !== undefined ||
            (decision?.verdict !== 'candidate' && decision?.verdict !== 'exclude') ||
            excludedBySettings(decision) ||
            (excludeShoppingSignals && decision.shopping_signals === true) ||
            (requireSingleDomain && decision.single_domain === false) ) { return false; }
        return (decision.verdict === 'exclude' && (
            (decision.checks_complete !== true && (excludeAdvertisingSignals || excludeCrossSiteTracking)) ||
            (excludeShoppingSignals && typeof decision.shopping_signals !== 'boolean'))) ||
            (requireSingleDomain && typeof decision.single_domain !== 'boolean');
    }

    async function refreshCharacteristic(remeasure = true) {
        hidingUnavailable = false;
        for ( const node of document.querySelectorAll('.queree-unresolved, .queree-characteristic') ) {
            node.remove();
        }
        if ( remeasure ) {
            for ( const [ url, decision ] of recorded ) {
                if ( needsCharacteristicMeasurement(decision) ) {
                    // Request missing checks without changing the known index exclusion.
                    recorded.set(url, { ...decision, cached: true });
                }
            }
        }
        processed = new WeakMap();
        const pendingSelectors = [];
        for ( const item of collect() ) {
            const decision = recorded.get(item.url);
            if ( decision === undefined || (needsCharacteristicMeasurement(decision) && decision.cached === true) ) {
                processed.delete(item.anchor);
            }
            apply(item, decision, pendingSelectors);
        }
        // Swap rules together, even while inspection has an unfinished batch.
        await addExclusionSelectors(pendingSelectors, true);
        if ( running === false ) { holdStatusSummary(); }
        scheduleScan();
    }

    function emptySourceStatus() {
        const text = `${document.title}\n${document.body?.textContent || ''}`;
        if (
            /\/(?:sorry|turing\/captcha)(?:\/|$)/.test(location.pathname) ||
            document.querySelector(
                'form[action*="/sorry/"], iframe[src*="recaptcha"], #captcha-form'
            ) !== null
        ) {
            return 'challenge';
        }
        if ( adapter.noResults(text) ) {
            return 'no_results';
        }
        return 'unrecognized_markup';
    }

    function hasResultAnchor() {
        return Array.from(document.querySelectorAll(adapter.headingSelector)).some(heading => {
            const anchor = resultAnchor(heading);
            return anchor !== undefined && resultURL(anchor) !== undefined;
        });
    }

    function scheduleEmptyResult(delay = sourceSettleDelay) {
        if ( emptyStored || emptyTimer !== undefined ) { return; }
        emptyStartedAt ??= Date.now();
        const remaining = unknownSourceDeadline - (Date.now() - emptyStartedAt);
        emptyTimer = setTimeout(async ( ) => {
            emptyTimer = undefined;
            if (
                enabled === false || running || document.readyState !== 'complete' ||
                hasResultAnchor()
            ) {
                scan();
                return;
            }
            const sourceStatus = emptySourceStatus();
            if (
                sourceStatus === 'unrecognized_markup' &&
                Date.now() - emptyStartedAt < unknownSourceDeadline
            ) {
                scheduleEmptyResult(unknownSourceDeadline - (Date.now() - emptyStartedAt));
                return;
            }
            emptyStored = true;
            ensurePanel();
            status.textContent = sourceStatus === 'challenge'
                ? `${adapter.name} blocked this automated search`
                : sourceStatus === 'no_results'
                    ? `No ${adapter.name} results`
                    : `${adapter.name} results could not be read`;
        }, Math.min(delay, Math.max(sourceSettleDelay, remaining)));
    }

    async function scan() {
        if ( enabled === false ) { return; }
        if ( isGoogleImages() ) {
            stop();
            return;
        }
        if ( panel?.isConnected === false ) { ensurePanel(); }
        const sourceURL = location.href;
        const items = collect();
        if ( items.length === 0 ) {
            if ( running === false ) { updateStatus(); }
            maybeLoadMore();
            if ( recorded.size === 0 && hasResultAnchor() === false ) {
                scheduleEmptyResult();
            }
            return;
        }
        clearTimeout(emptyTimer);
        emptyTimer = undefined;
        emptyStartedAt = undefined;
        emptyStored = false;
        running = true;
        const scanGeneration = generation;
        const batchId = `${scanGeneration}-${Date.now()}-${++batchSequence}`;
        activeBatches.add(batchId);
        const freshItems = [];
        try {
            ensurePanel();
            renderPagination();
            const pendingSelectors = [];
            const inspecting = new Set(Array.from(activeItems.values(), item => item.url));
            for ( const item of items ) {
                const decision = recorded.get(item.url);
                if ( decision === undefined || (needsCharacteristicMeasurement(decision) && decision.cached === true) ) {
                    if ( inspecting.has(item.url) ) {
                        processed.delete(item.anchor);
                        rescan = true;
                    } else {
                        freshItems.push(item);
                    }
                }
                apply(item, decision, pendingSelectors);
            }
            for ( const item of freshItems ) {
                item.inspectionSettingsGeneration = settingsGeneration;
                item.inspectionPoolState = mobileInspection;
                activeItems.set(item.id, item);
            }
            await addExclusionSelectors(pendingSelectors);
            if ( enabled === false || generation !== scanGeneration ) { return; }
            if ( freshItems.length === 0 ) { return; }
            startProgress(freshItems);
            let decisions;
            let replyError = 'Background returned no decision';
            try {
                const request = {
                    what: 'inspectResults',
                    batchId,
                    sourceURL,
                    items: freshItems.map(({ id, url, sourceReasons, result_title, result_description }) => ({
                        id,
                        url,
                        sourceReasons,
                        result_title,
                        result_description,
                    })),
                };
                let attempts = 0;
                do {
                    attempts += 1;
                    decisions = await vAPI.messaging.send('queree', request);
                } while (
                    decisions === undefined && attempts < 2 &&
                    enabled && generation === scanGeneration
                );
            } catch (reason) {
                replyError = String(reason);
            }
            if ( enabled === false || generation !== scanGeneration ) { return; }
            pendingSelectors.length = 0;
            let refresh = false;
            const byId = new Map((Array.isArray(decisions) ? decisions : []).map(decision => [ decision.id, decision ]));
            for ( const item of freshItems ) {
                const decision = byId.get(item.id) || recorded.get(item.url) || {
                    id: item.id, verdict: 'unresolved',
                    reasons: [ { kind: 'inspection_reply_unavailable', detail: replyError } ],
                };
                refresh = rememberDecision(item, decision) || refresh;
                apply(item, decision, pendingSelectors);
            }
            if ( refresh ) { await refreshCharacteristic(false); }
            else { await addExclusionSelectors(pendingSelectors); }
        } finally {
            if ( generation === scanGeneration ) {
                activeBatches.delete(batchId);
                for ( const item of freshItems ) { activeItems.delete(item.id); }
                running = activeBatches.size !== 0;
                if ( running === false ) { stopProgress(); }
                if ( freshItems.length !== 0 || running === false ) { holdStatusSummary(); }
                if ( rescan && running === false ) {
                    rescan = false;
                    scheduleScan();
                }
                maybeLoadMore();
            }
        }
    }

    function scheduleScan() {
        if ( enabled === false ) { return; }
        clearTimeout(scanTimer);
        scanTimer = setTimeout(( ) => {
            scanTimer = undefined;
            scan();
        }, 250);
    }

    function stop() {
        if ( enabled === false ) { return; }
        enabled = false;
        generation += 1;
        paginationCancel?.();
        clearTimeout(emptyTimer);
        clearTimeout(scanTimer);
        clearTimeout(summaryTimer);
        stopProgress();
        emptyTimer = undefined;
        scanTimer = undefined;
        summaryTimer = undefined;
        emptyStartedAt = undefined;
        emptyStored = false;
        observer?.disconnect();
        observer = undefined;
        changeStylesheets([], Array.from(appliedStylesheets));
        for ( const node of document.querySelectorAll('.queree-unresolved, .queree-characteristic') ) {
            node.remove();
        }
        selectorReasons.clear();
        exclusionStylesheets.clear();
        recorded.clear();
        activeItems.clear();
        activeBatches.clear();
        panel?.remove();
        style?.remove();
        panel = status = style = toggle = undefined;
        paginationButton = undefined;
        mobileQ = mobileHelp = undefined;
        backgroundSettingsCopied = false;
        processed = new WeakMap();
        running = false;
        rescan = false;
        excludedVisible = false;
        hidingUnavailable = false;
    }

    function start() {
        if ( enabled ) { return; }
        enabled = true;
        generation += 1;
        observer = new MutationObserver(records => {
            if ( records.every(record => panel?.contains(record.target)) ) { return; }
            if ( emptyStored === false && recorded.size === 0 ) {
                clearTimeout(emptyTimer);
                emptyTimer = undefined;
            }
            scheduleScan();
        });
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: [ 'href' ],
        });
        scan();
        retryMobileInspection();
    }

    function retryMobileInspection() {
        if ( enabled && document.hidden === false && mobileInspection.tabsReady &&
            mobileInspection.background === 'unchecked' ) {
            return prepareMobileInspection(false);
        }
    }

    function syncSearchMode() {
        if ( shuttingDown ) { return; }
        if ( settingEnabled && isSearchPage() && isGoogleImages() === false ) {
            start();
        } else {
            stop();
        }
    }

    async function refreshSettings() {
        const requestGeneration = ++settingsGeneration;
        for ( let attempt = 0; attempt < 2; attempt++ ) {
            let currentSettings;
            try {
                currentSettings = await vAPI.messaging.send('queree', {
                    what: 'getSettings',
                });
            } catch {
            }
            if ( shuttingDown || requestGeneration !== settingsGeneration ) { return; }
            if ( currentSettings === undefined ) { continue; }
            onMessage({ ...currentSettings, what: 'quereeSettingsChanged' });
            return;
        }
    }

    function bindDebugGesture(heading) {
        let clicks = 0;
        let previous = -Infinity;
        heading.addEventListener('click', event => {
            if ( event.isTrusted !== true ) { return; }
            clicks = event.timeStamp - previous <= 3000 ? clicks + 1 : 1;
            previous = event.timeStamp;
            if ( clicks !== 5 ) { return; }
            clicks = 0;
            vAPI.messaging.send('queree', { what: 'toggleKeepUnresolvedTabs' });
        });
    }

    function onResultClick(event) {
        if ( paginationCancel === undefined || event.isTrusted !== true || event.defaultPrevented ||
            event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ) { return; }
        const anchor = event.target.closest?.('a[href]');
        if ( anchor === null || anchor === undefined || anchor.hasAttribute('download') ||
            anchor.closest(adapter.containerSelector) === null || resultURL(anchor) === undefined ) { return; }
        const target = (anchor.getAttribute('target') ??
            document.querySelector('base[target]')?.getAttribute('target') ?? '').toLowerCase();
        if ( target !== '' && target !== '_self' && target !== '_top' && target !== '_parent' ) { return; }
        const url = new URL(anchor.href);
        if ( url.origin === location.origin && url.pathname === location.pathname &&
            url.search === location.search ) { return; }
        // Cancelling the frame can let Firefox keep this page for Back. Do not
        // latch a pause: downloads or cancelled navigation can leave it alive.
        paginationCancel(true);
    }

    async function onPageShow(event) {
        if ( event.persisted !== true ) { return; }
        // Cached pages can retain a port whose background reply was lost.
        vAPI.messaging.destroyPort();
        await refreshSettings();
        scheduleScan();
        retryMobileInspection();
    }

    function onMessage(message) {
        if ( shuttingDown ) { return; }
        if ( message?.what === 'quereeMobileInspectionState' ) {
            setMobileInspection(message);
            return;
        }
        if ( message?.what === 'quereeInspectionProgress' ) {
            if ( running && activeBatches.has(message.batchId) ) {
                const decision = message.decision;
                const item = activeItems.get(decision?.id);
                if (
                    item !== undefined &&
                    /^(?:candidate|exclude|unresolved|uninspected)$/.test(decision.verdict)
                ) {
                    if ( rememberDecision(item, decision) ) {
                        refreshCharacteristic(false);
                        updateProgress();
                        maybeLoadMore();
                        return;
                    }
                    const pendingSelectors = [];
                    apply(item, decision, pendingSelectors);
                    addExclusionSelectors(pendingSelectors).catch(( ) => { });
                }
                updateProgress();
                maybeLoadMore();
            }
            return;
        }
        if ( message?.what === 'quereeSettingsChanged' ) {
            if ( message.revision < settingsRevision ) { return; }
            settingsRevision = message.revision;
            settingsGeneration += 1;
            const wasEnabled = enabled;
            const nextCategories = JSON.stringify(message.personalCategories);
            const categoriesChanged = personalCategories !== undefined && nextCategories !== personalCategories;
            personalCategories = nextCategories;
            const nextSources = JSON.stringify(message.sourceControls);
            const sourcesChanged = sourceControls !== undefined && sourceControls !== nextSources;
            sourceControls = nextSources;
            simultaneousInspections = message.simultaneousInspections ?? simultaneousInspections;
            settingEnabled = message.enabled === true;
            keepUnresolvedTabs = message.keepUnresolvedTabs === true;
            inspectionTabGeneration = message.inspectionTabGeneration;
            renderInspectionDebugMode();
            if ( message.mobileInspection ) { setMobileInspection(message.mobileInspection); }
            const changed = requireSingleDomain !== (message.requireSingleDomain === true) ||
                excludeAdvertisingSignals !== (message.excludeAdvertisingSignals !== false) ||
                excludeCrossSiteTracking !== (message.excludeCrossSiteTracking !== false) ||
                excludeShoppingSignals !== (message.excludeShoppingSignals !== false);
            requireSingleDomain = message.requireSingleDomain === true;
            excludeAdvertisingSignals = message.excludeAdvertisingSignals !== false;
            excludeCrossSiteTracking = message.excludeCrossSiteTracking !== false;
            excludeShoppingSignals = message.excludeShoppingSignals !== false;
            if ( changed || categoriesChanged || sourcesChanged ) {
                paginationComplete = false;
            }
            if ( (categoriesChanged || sourcesChanged) && wasEnabled ) { stop(); }
            syncSearchMode();
            if ( changed && wasEnabled && enabled ) { refreshCharacteristic(); }
            maybeLoadMore();
            return;
        }
        if ( message?.what === 'quereeSearchURLChanged' ) {
            const identity = searchIdentity(location.href, true);
            if ( identity === sourceSearchIdentity ) { return; }
            sourceSearchIdentity = identity;
            stop();
            adapter = searchEngineAdapter(location.hostname, location.pathname);
            paginationSource = undefined;
            paginationNext = undefined;
            paginationTarget = 10;
            paginationAuto = true;
            paginationComplete = false;
            document.documentElement.removeAttribute('data-queree-pagination');
            for ( const row of document.querySelectorAll('.queree-appended-result, .queree-appended-style') ) { row.remove(); }
            syncSearchMode();
        }
    }

    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('click', onResultClick);
    document.addEventListener('visibilitychange', retryMobileInspection);
    document.addEventListener('visibilitychange', maybeLoadMore);
    browser.runtime.onMessage.addListener(onMessage);
    vAPI.shutdown.add(( ) => {
        shuttingDown = true;
        stop();
        window.removeEventListener('pageshow', onPageShow);
        window.removeEventListener('click', onResultClick);
        document.removeEventListener('visibilitychange', retryMobileInspection);
        document.removeEventListener('visibilitychange', maybeLoadMore);
        browser.runtime.onMessage.removeListener(onMessage);
    });

    await refreshSettings();
})());
