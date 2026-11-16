import { affiliateSources, storefrontSources } from '../src/js/queree/vendor/website-lists.js';
import { applyReviewedCategory, reviewed, withoutInvalidOwnershipHosts, withoutSharedHostDeclarations } from './queree-ownership-sources.mjs';
import commercial from '../src/js/queree/vendor/commercial-domains.js';
import { communityDomains } from '../src/js/queree/community-domains.js';
import corporate from '../src/js/queree/vendor/corporate-domains.js';
import institutional from '../src/js/queree/vendor/institutional-domains.js';
import { loadAdultSources } from './queree-adult-sources.mjs';
import publicInterest from '../src/js/queree/vendor/public-interest-domains.js';
import { restrictedSourceNamespaces } from '../src/js/queree/restricted-namespaces.js';
import wikidataBroad from './vendor/wikidata-broad-domains.js';

const reviewedSources = category => reviewed.filter(source => source.category === category);

export const sourceGroups = {
    adult_domain: loadAdultSources(),
    shopping_domain: commercial.filter(source => source.name !== 'ut1_bank'),
    scam_domain: storefrontSources,
    affiliate_publisher: affiliateSources,
    government_education: [ ...(wikidataBroad.government_education || []), ...reviewedSources('government_education') ]
        .map(source => applyReviewedCategory(source, 'government_education'))
        .map(withoutSharedHostDeclarations).map(withoutInvalidOwnershipHosts),
    commercial_corporate: [ ...corporate, ...commercial.filter(source => source.name === 'ut1_bank'),
        ...(wikidataBroad.commercial_corporate || []), ...reviewedSources('commercial_corporate') ]
        .map(source => applyReviewedCategory(source, 'commercial_corporate')).map(withoutInvalidOwnershipHosts),
    professional_publication: [ ...institutional, ...reviewedSources('professional_publication') ]
        .map(source => applyReviewedCategory(source, 'professional_publication')).map(withoutInvalidOwnershipHosts),
    public_interest_organization: [ ...publicInterest, ...(wikidataBroad.public_interest_organization || []), ...reviewedSources('public_interest_organization') ]
        .map(source => applyReviewedCategory(source, 'public_interest_organization'))
        .map(withoutSharedHostDeclarations).map(withoutInvalidOwnershipHosts),
};

export const taxonomyGroups = {
    adult_domain: sourceGroups.adult_domain,
    community_contribution: [ { name: 'approved_platforms', domains: communityDomains } ],
    government_education: [ {
        name: 'restricted_namespaces',
        domains: restrictedSourceNamespaces.map(item => item.namespace),
        sources: Array.from(new Set(restrictedSourceNamespaces.map(item => item.source))).sort(),
    }, ...sourceGroups.government_education ],
    professional_publication: sourceGroups.professional_publication,
    commercial_corporate: sourceGroups.commercial_corporate,
    shopping_domain: sourceGroups.shopping_domain,
    scam_domain: sourceGroups.scam_domain,
    affiliate_publisher: sourceGroups.affiliate_publisher,
    public_interest_organization: sourceGroups.public_interest_organization,
};
