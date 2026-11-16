import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../src/js/queree/commerce-probe.js', import.meta.url), 'utf8');
const rootsSource = readFileSync(new URL('../../src/js/queree/inspection-dom.js', import.meta.url), 'utf8');
const product = { '@type': 'Product', offers: { '@type': 'Offer', price: 12 } };
const document = {
    defaultView: { frameElement: null },
    documentElement: { outerHTML: '<html><body>Fictional article</body></html>' },
    querySelector: () => null,
    querySelectorAll(selector) {
        if ( selector === 'script[type="application/ld+json"]' ) {
            return [ { ownerDocument: document, textContent: JSON.stringify(product) } ];
        }
        return selector.includes('[rel~="sponsored"]') ? links : [];
    },
};
document.documentElement.ownerDocument = document;
document.documentElement.checkVisibility = () => true;
const links = [ false, true, true, true, true ].map((visible, index) => ({
    ownerDocument: document,
    href: `https://merchant.example/product-${index}`,
    checkVisibility(options) {
        assert.equal(options.opacityProperty, true);
        assert.equal(options.visibilityProperty, true);
        return visible;
    },
}));
const context = vm.createContext({
    __quereeCommerceSignals: { js: [ 'wc_add_to_cart_params' ] },
    document,
    location: { href: 'https://personal.example/article', origin: 'https://personal.example' },
    URL,
    wrappedJSObject: { wc_add_to_cart_params: {} },
});
assert.throws(() => vm.runInContext(source, context), /__quereeInspectionRoots/,
    'A missing shared helper is an injection error, not a light-DOM fallback');
vm.runInContext(rootsSource, context);
let result = vm.runInContext(source, context);
assert.deepEqual(Array.from(result.sponsoredLinks), links.slice(1, 4).map(link => link.href),
    'Hidden template links do not count or displace visible sponsored evidence');
assert.equal(result.jsGlobals.wc_add_to_cart_params, 'defined', 'Read page globals through the Xray wrapper');
assert.deepEqual({ ...result.shoppingEvidence }, { product_offer: true, purchase: true },
    'Product markup and the purchase API in the same document establish a shop');
context.wrappedJSObject = {};
assert.equal(vm.runInContext(source, context).jsGlobals.wc_add_to_cart_params, undefined);
Object.defineProperty(context.wrappedJSObject, 'wc_add_to_cart_params', {
    get() { throw new Error('Page getter failed'); },
});
result = vm.runInContext(source, context);
assert.equal(result.jsGlobals.wc_add_to_cart_params, undefined);
assert.equal(result.sponsoredLinks.length, 3, 'An inaccessible page global does not discard other evidence');
links.splice(1);
assert.equal(vm.runInContext(source, context).sponsoredLinks.length, 0,
    'A hidden link alone is not declared promotion evidence');
console.log('Passed: commerce collection ignores hidden sponsored links and reads page globals safely');

const purchaseSelectors = [
    '[name="add-to-cart"]',
    '.add_to_cart_button', '[class*="add-to-cart" i]',
];
for ( const selector of [ ...purchaseSelectors, '[data-product_id]', 'a[href="/cart"]', 'a[href="/checkout"]' ] ) {
    context.document.querySelectorAll = query => query.split(',').includes(selector)
        ? [ { ownerDocument: document, checkVisibility: () => true } ]
        : query === 'script[type="application/ld+json"]'
            ? [ { ownerDocument: document, textContent: JSON.stringify(product) } ] : [];
    assert.equal(vm.runInContext(source, context).shoppingEvidence.purchase,
        purchaseSelectors.includes(selector), selector);
}
context.document.querySelector = () => null;

for ( const name of [ 'Handmade bowl', 'Cuenco artesanal', '\u624b\u4f5c\u308a\u306e\u5668' ] ) {
    const product = { '@type': 'Product', name, offers: { '@type': 'Offer', price: '12.00' } };
    context.document.querySelectorAll = selector => selector === 'script[type="application/ld+json"]'
        ? [ { ownerDocument: document, textContent: JSON.stringify(product) } ] : [];
    result = vm.runInContext(source, context);
    assert.deepEqual({ ...result.shoppingEvidence }, { product_offer: true, purchase: false },
        'Product-offer markup needs neither a cart nor recognized software or English text');
}
for ( const [ offer, expected ] of [
    [ { price: null }, false ], [ { price: '' }, false ], [ { price: '  ' }, false ],
    [ { price: false }, false ], [ { priceSpecification: {} }, false ],
    [ { priceSpecification: [ null, {} ] }, false ],
    [ { price: 0 }, true ], [ { price: '12.00' }, true ],
    [ { priceSpecification: { price: 12 } }, true ],
    [ { priceSpecification: [ {}, { price: '12.00' } ] }, true ],
] ) {
    context.document.querySelectorAll = selector => selector === 'script[type="application/ld+json"]'
        ? [ { ownerDocument: document, textContent: JSON.stringify({
            '@type': 'Product', offers: { '@type': 'Offer', ...offer },
        }) } ] : [];
    assert.equal(vm.runInContext(source, context).shoppingEvidence.product_offer, expected,
        `Only actual price values count: ${JSON.stringify(offer)}`);
}

const makeScope = (html, host) => {
    const elements = new Map();
    const scope = {
        host,
        defaultView: { frameElement: null, wrappedJSObject: {} },
        documentElement: { outerHTML: html },
        innerHTML: html,
        elements,
        querySelector: selector => elements.get(selector)?.[0] || null,
        querySelectorAll: selector => elements.get(selector) || [],
    };
    scope.documentElement.ownerDocument = scope;
    scope.documentElement.checkVisibility = () => true;
    return scope;
};
const top = makeScope('<html>Top article</html>');
const shadow = makeScope('<a>Closed shadow evidence</a>', {});
const frame = makeScope('<html>Same-origin frame</html>');
const nested = makeScope('<p>Frame shadow evidence</p>', {});
shadow.host = { ownerDocument: top, checkVisibility: () => true };
shadow.ownerDocument = top;
nested.host = { ownerDocument: frame, checkVisibility: () => true };
nested.ownerDocument = frame;
const frameElement = {
    localName: 'iframe', contentDocument: frame, ownerDocument: top,
    checkVisibility: () => true,
};
frame.defaultView.frameElement = frameElement;
frame.defaultView.wrappedJSObject = { wc_add_to_cart_params: {} };
top.elements.set('*', [ { openOrClosedShadowRoot: shadow } ]);
shadow.elements.set('*', [ frameElement ]);
frame.elements.set('*', [ { openOrClosedShadowRoot: nested } ]);
const link = (doc, href) => ({ ownerDocument: doc, href, checkVisibility: () => true });
const anchorSelector = 'a[href],area[href]';
const sponsoredSelector = 'a[href][rel~="sponsored"],area[href][rel~="sponsored"]';
shadow.elements.set(anchorSelector, [ link(top, 'https://open.spotify.com/track/fictional') ]);
frame.elements.set(anchorSelector, [ link(frame, 'https://newsletter.example/subscribe') ]);
nested.elements.set(sponsoredSelector, [ link(frame, 'https://merchant.example/sponsored') ]);
nested.elements.set('script[type="application/ld+json"]', [ { ownerDocument: frame, textContent: JSON.stringify({
    '@type': 'Product', offers: { '@type': 'Offer', price: 12 },
}) } ]);
shadow.elements.set('script', [ { src: 'https://assets.example/shadow.js' } ]);
frame.elements.set('script', [ { textContent: 'frameShoppingSoftware = true;' } ]);
nested.elements.set('link[rel~="stylesheet"][href]', [ { href: 'https://assets.example/store.css' } ]);
const meta = content => ({ getAttribute: () => 'generator', content });
top.elements.set('meta[name],meta[property]', [ meta('Article generator') ]);
nested.elements.set('meta[name],meta[property]', [ meta('Frame shop generator') ]);
context.document = top;
context.wrappedJSObject = {};
result = vm.runInContext(source, context);
assert.equal(result.url, context.location.href, 'Frame evidence retains the top document identity');
assert.deepEqual(Array.from(result.outboundURLs), [
    'https://open.spotify.com/track/fictional', 'https://newsletter.example/subscribe',
], 'Visible outbound links reach the maintained-list check without being followed');
assert.deepEqual(Array.from(result.sponsoredLinks), [ 'https://merchant.example/sponsored' ]);
assert.deepEqual({ ...result.shoppingEvidence }, { product_offer: true, purchase: true });
assert.equal(Object.hasOwn(result, 'domSelectors'), false, 'Omitted fingerprint rules need no browser-side collection');
assert.equal(result.jsGlobals.wc_add_to_cart_params, 'defined');
assert.equal(result.metas.generator, 'Article generator\nFrame shop generator');
assert.deepEqual(Array.from(result.scriptSrcs), [ 'https://assets.example/shadow.js' ]);
assert.deepEqual(Array.from(result.scriptContents), [ 'frameShoppingSoftware = true;' ]);
assert.deepEqual(Array.from(result.stylesheetSrcs), [ 'https://assets.example/store.css' ]);
for ( const markup of [ top, shadow, frame, nested ] ) {
    assert.ok(result.html.includes(markup.innerHTML), 'Every reachable scope contributes HTML evidence');
}
frameElement.checkVisibility = () => false;
result = vm.runInContext(source, context);
assert.equal(result.sponsoredLinks.length, 0, 'Links in hidden frames are not visible promotion');
assert.deepEqual(Array.from(result.outboundURLs), [ 'https://open.spotify.com/track/fictional' ],
    'A hidden frame cannot supply an affiliate-link exclusion');
assert.deepEqual({ ...result.shoppingEvidence }, { product_offer: false, purchase: false },
    'Hidden frames supply no purchase or product evidence');
frameElement.checkVisibility = () => true;
frame.defaultView.wrappedJSObject = {};
const productScript = nested.elements.get('script[type="application/ld+json"]');
const purchaseSelector = purchaseSelectors.join(',');
const cart = { ownerDocument: top, checkVisibility: () => true };
top.elements.set(purchaseSelector, [ cart ]);
result = vm.runInContext(source, context);
assert.ok(result.shoppingEvidence.product_offer);
assert.equal(result.shoppingEvidence.purchase, false,
    'Product markup in a frame cannot combine with an unrelated top-page cart');
nested.elements.delete('script[type="application/ld+json"]');
shadow.elements.set('script[type="application/ld+json"]', productScript.map(script => ({
    ...script, ownerDocument: top,
})));
result = vm.runInContext(source, context);
assert.ok(result.shoppingEvidence.purchase,
    'A visible shadow-root offer and cart in the same document remain a purchase');
cart.checkVisibility = () => false;
assert.equal(vm.runInContext(source, context).shoppingEvidence.purchase, false,
    'A hidden cart template cannot establish a purchase');
top.elements.delete(purchaseSelector);
shadow.elements.delete('script[type="application/ld+json"]');
nested.elements.set('script[type="application/ld+json"]', productScript);

// Collection bounds apply to the aggregate, not separately to each DOM scope.
const many = (count, create) => Array.from({ length: count }, (_, i) => create(i));
top.elements.set(sponsoredSelector, many(2, i => link(top, `https://merchant.example/top-${i}`)));
shadow.elements.set(sponsoredSelector, [ link(top, 'https://merchant.example/shadow') ]);
result = vm.runInContext(source, context);
assert.deepEqual(Array.from(result.sponsoredLinks), [
    'https://merchant.example/top-0', 'https://merchant.example/top-1',
    'https://merchant.example/shadow',
], 'The sponsored-link cap is shared across scopes');
top.elements.set('script[type="application/ld+json"]', many(32, () => ({ textContent: '{}' })));
assert.equal(vm.runInContext(source, context).shoppingEvidence.product_offer, false,
    'The total JSON-LD bound is not restarted at a frame');
top.elements.set('script', many(255, () => ({ src: 'https://assets.example/top.js' })));
top.elements.set('meta[name],meta[property]', many(256, () => meta('Top generator')));
top.elements.set('link[rel~="stylesheet"][href]', many(256, () => ({ href: 'https://assets.example/top.css' })));
result = vm.runInContext(source, context);
assert.equal(result.scriptSrcs.length, 256);
assert.equal(result.scriptSrcs.at(-1), 'https://assets.example/shadow.js');
assert.equal(result.scriptContents.length, 0, 'The total script count includes external scripts');
assert.equal(result.stylesheetSrcs.length, 256);
assert.equal(result.stylesheetSrcs.includes('https://assets.example/store.css'), false);
assert.equal(result.metas.generator.includes('Frame shop generator'), false);
top.elements.set('script', many(3, () => ({ textContent: 't'.repeat(128 * 1024) })));
shadow.elements.set('script', many(3, () => ({ textContent: 's'.repeat(128 * 1024) })));
result = vm.runInContext(source, context);
assert.equal(result.scriptContents.length, 4);
assert.equal(result.scriptContents.every(value => value.length === 64 * 1024), true);
assert.equal(result.scriptContents.join('').length, 256 * 1024);
top.documentElement.outerHTML = 'x'.repeat(512 * 1024 - 8);
result = vm.runInContext(source, context);
assert.equal(result.html.length, 512 * 1024);
assert.equal(result.html.slice(-8), '\n<a>Clos');

const replacement = makeScope('<html>Replacement frame</html>');
replacement.defaultView.frameElement = frameElement;
frameElement.contentDocument = replacement;
top.elements.delete(sponsoredSelector);
shadow.elements.delete(sponsoredSelector);
result = vm.runInContext(source, context);
assert.equal(result.sponsoredLinks.length, 0,
    'Frame navigation discards the previous document and its nested evidence');
assert.equal(result.jsGlobals.wc_add_to_cart_params, undefined);
const later = makeScope('<p>Later shadow</p>', {});
later.host = { ownerDocument: replacement, checkVisibility: () => true };
later.ownerDocument = replacement;
later.elements.set(sponsoredSelector, [ link(replacement, 'https://merchant.example/later') ]);
replacement.elements.set('*', [ { openOrClosedShadowRoot: later } ]);
assert.deepEqual(Array.from(vm.runInContext(source, context).sponsoredLinks), [
    'https://merchant.example/later',
], 'Commerce rediscovers later roots just as readiness does');
console.log('Passed: paired shadow/frame commerce evidence retains aggregate collection limits');

top.elements.set(anchorSelector, [
    link(top, `${context.location.origin}/local`),
    link(top, 'mailto:friend@example.test'),
    link(top, 'javascript:void(0)'),
    { ...link(top, 'https://affiliate.godaddy.com/hidden'), checkVisibility: () => false },
    link(top, 'https://affiliate.godaddy.com/one#first'),
    link(top, 'https://affiliate.godaddy.com/one#duplicate'),
]);
shadow.elements.delete(anchorSelector);
assert.deepEqual(Array.from(vm.runInContext(source, context).outboundURLs), [
    'https://affiliate.godaddy.com/one',
], 'Hidden, same-origin and non-web links do not count; fragments do not duplicate evidence');
top.elements.set(anchorSelector, many(255, i => link(top, `https://merchant.example/${i}`)));
shadow.elements.set(anchorSelector, many(3, i => link(top, `https://merchant.example/shadow-${i}`)));
result = vm.runInContext(source, context);
assert.equal(result.outboundURLs.length, 256);
assert.equal(result.outboundURLs.at(-1), 'https://merchant.example/shadow-0');
top.elements.set(anchorSelector, many(2048, () => link(top, `${context.location.origin}/local`)));
assert.equal(vm.runInContext(source, context).outboundURLs.length, 0,
    'The anchor inspection bound is shared across roots, even for ignored local links');
console.log('Passed: restored outbound-link collection stays visible, local and bounded');
