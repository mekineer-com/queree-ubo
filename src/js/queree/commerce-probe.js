/*******************************************************************************

    Quer.ee deterministic commerce evidence collector
    Copyright (C) 2026-present Marcos
    SPDX-License-Identifier: GPL-3.0-or-later

*/

(( ) => {
    const roots = globalThis.__quereeInspectionRoots();
    const signals = globalThis.__quereeCommerceSignals;
    if ( signals === undefined ) { return; }
    const htmlLimit = 512 * 1024;
    const itemLimit = 256;
    const valueLimit = 2048;
    const anchorLimit = 2048;
    const outboundURLLimit = 256;
    const queryAll = function*(selector, limit = Infinity, scopes = roots) {
        let count = 0;
        for ( const root of scopes ) {
            for ( const element of root.querySelectorAll(selector) ) {
                if ( count++ === limit ) { return; }
                yield element;
            }
        }
    };
    const appendValue = (values, key, value) => {
        values[key] = values[key] === undefined
            ? value
            : `${values[key]}\n${value}`.slice(0, valueLimit);
    };
    const visible = element => {
        if ( element.checkVisibility({
            opacityProperty: true,
            visibilityProperty: true,
        }) === false ) { return false; }
        for ( let frame = element.ownerDocument.defaultView.frameElement; frame;
            frame = frame.ownerDocument.defaultView.frameElement ) {
            if ( frame.checkVisibility({
                opacityProperty: true,
                visibilityProperty: true,
            }) === false ) { return false; }
        }
        return true;
    };

    const commerceRoots = roots.filter(root => visible(root.host || root.documentElement));
    const purchaseDocuments = new Set();
    const offerDocuments = new Set();
    const jsGlobals = {};
    for ( const root of roots ) {
        if ( root.host ) { continue; }
        const page = root === document
            ? globalThis.wrappedJSObject
            : root.defaultView.wrappedJSObject;
        if ( page === undefined ) { continue; }
        try {
            if ( page.wc_add_to_cart_params !== undefined && commerceRoots.includes(root) ) {
                purchaseDocuments.add(root);
            }
        } catch {
        }
        for ( const path of signals.js ) {
            let value = page;
            try {
                for ( const part of path.split('.') ) {
                    value = value?.[part];
                    if ( value === undefined ) { break; }
                }
            } catch {
                value = undefined;
            }
            if ( value === undefined ) { continue; }
            appendValue(jsGlobals, path, typeof value === 'object' || typeof value === 'function'
                ? 'defined'
                : String(value).slice(0, valueLimit));
        }
    }

    const metas = {};
    for ( const meta of queryAll('meta[name],meta[property]', itemLimit) ) {
        const name = meta.getAttribute('name') || meta.getAttribute('property');
        if ( name ) {
            appendValue(metas, name.toLowerCase().slice(0, valueLimit),
                String(meta.content || '').slice(0, valueLimit));
        }
    }

    const purchaseSelector = [
        '[name="add-to-cart"]',
        '.add_to_cart_button', '[class*="add-to-cart" i]',
    ].join(',');
    for ( const control of queryAll(purchaseSelector, itemLimit, commerceRoots) ) {
        if ( visible(control) === false ) { continue; }
        purchaseDocuments.add(control.ownerDocument);
    }
    const hasPrice = value => typeof value === 'number'
        ? Number.isFinite(value)
        : typeof value === 'string' && value.trim() !== '';
    const hasMerchantOffer = value => {
        if ( Array.isArray(value) ) { return value.some(hasMerchantOffer); }
        if ( value === null || typeof value !== 'object' ) { return false; }
        const type = Array.isArray(value['@type']) ? value['@type'] : [ value['@type'] ];
        if ( type.includes('Product') ) {
            const offers = Array.isArray(value.offers) ? value.offers : [ value.offers ];
            if ( offers.some(offer => {
                if ( offer === null || typeof offer !== 'object' ) { return false; }
                const offerType = Array.isArray(offer['@type'])
                    ? offer['@type']
                    : [ offer['@type'] ];
                return offerType.includes('Offer') &&
                    (hasPrice(offer.price) || [].concat(offer.priceSpecification || [])
                        .some(spec => hasPrice(spec?.price)));
            }) ) { return true; }
        }
        return Object.values(value).some(hasMerchantOffer);
    };
    for ( const script of queryAll('script[type="application/ld+json"]', 32, commerceRoots) ) {
        if ( script.textContent.length > 256 * 1024 ) { continue; }
        try {
            if ( hasMerchantOffer(JSON.parse(script.textContent)) ) {
                offerDocuments.add(script.ownerDocument);
            }
        } catch {
        }
    }

    const sponsoredLinks = [];
    for ( const link of queryAll(
        'a[href][rel~="sponsored"],area[href][rel~="sponsored"]'
    ) ) {
        if ( visible(link) === false ) { continue; }
        sponsoredLinks.push(link.href);
        if ( sponsoredLinks.length === 3 ) { break; }
    }

    const outboundURLs = new Set();
    for ( const link of queryAll('a[href],area[href]', anchorLimit) ) {
        if ( visible(link) === false ) { continue; }
        let target;
        try { target = new URL(link.href); } catch { continue; }
        if ( target.protocol !== 'http:' && target.protocol !== 'https:' ) { continue; }
        target.hash = '';
        if ( target.origin === location.origin || target.href.length > valueLimit ) { continue; }
        outboundURLs.add(target.href);
        if ( outboundURLs.size === outboundURLLimit ) { break; }
    }

    const scriptSrcs = [];
    const scriptContents = [];
    let scriptContentLength = 0;
    for ( const script of queryAll('script', itemLimit) ) {
        if ( script.src ) {
            scriptSrcs.push(script.src.slice(0, valueLimit));
            continue;
        }
        if ( scriptContentLength >= 256 * 1024 ) { continue; }
        const content = script.textContent.slice(
            0,
            Math.min(64 * 1024, 256 * 1024 - scriptContentLength)
        );
        if ( content === '' ) { continue; }
        scriptContents.push(content);
        scriptContentLength += content.length;
    }

    let html = '';
    for ( const root of roots ) {
        if ( html.length === htmlLimit ) { break; }
        const markup = root.host ? root.innerHTML : root.documentElement.outerHTML;
        html += (html === '' ? markup : `\n${markup}`).slice(0, htmlLimit - html.length);
    }

    return {
        url: location.href,
        html,
        scriptSrcs,
        scriptContents,
        stylesheetSrcs: Array.from(
            queryAll('link[rel~="stylesheet"][href]', itemLimit),
            link => link.href.slice(0, valueLimit)
        ),
        metas,
        jsGlobals,
        shoppingEvidence: {
            product_offer: offerDocuments.size !== 0,
            // An article and an unrelated frame's cart are not a shop.
            purchase: [ ...offerDocuments ].some(doc => purchaseDocuments.has(doc)),
        },
        sponsoredLinks: sponsoredLinks.map(url => url.slice(0, valueLimit)),
        outboundURLs: Array.from(outboundURLs),
    };
})()
