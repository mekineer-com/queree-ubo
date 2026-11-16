/*******************************************************************************

    Quer.ee restricted government and education namespaces
    Copyright (C) 2026-present Marcos

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*/

const sources = {
    educause: 'https://net.educause.edu/faq/eligibility',
    ianaMil: 'https://www.iana.org/domains/root/db/mil',
    nz: 'https://dnc.org.nz/about/compliance-and-enforcement/moderated-second-levels/',
    uk: 'https://www.gov.uk/guidance/check-if-your-organisation-can-get-a-govuk-domain-name',
    usGov: 'https://get.gov/domains/eligibility/',
};

export const restrictedSourceNamespaces = [
    { namespace: 'gov', source: sources.usGov },
    { namespace: 'edu', source: sources.educause },
    { namespace: 'mil', source: sources.ianaMil },
    ...[ 'govt.nz', 'cri.nz', 'mil.nz', 'parliament.nz' ].map(
        namespace => ({ namespace, source: sources.nz })
    ),
    ...[
        'gov.uk', 'gov.scot', 'gov.wales', 'llyw.cymru',
        'mod.uk', 'mil.uk',
        'nhs.uk', 'nhs.wales', 'nhs.scot',
        'judiciary.uk', 'police.uk',
        'sch.uk', 'ac.uk', 'parliament.uk',
    ].map(namespace => ({ namespace, source: sources.uk })),
];

export function restrictedSourceNamespaceFromHostname(hostname) {
    const normalized = hostname.toLowerCase().replace(/\.$/, '');
    return restrictedSourceNamespaces.find(item =>
        normalized === item.namespace || normalized.endsWith(`.${item.namespace}`)
    );
}
