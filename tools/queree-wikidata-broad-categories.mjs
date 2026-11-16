// A state-owned company is not necessarily a government portal. Direct
// institutional selections can establish that category without the broad flag.
export function broadRecordCategories(record) {
    const company = [ ...record.claims.values() ].includes('commercial_corporate');
    if ( company && record.government ) {
        return [ ...record.claims ].filter(([ name ]) =>
            name === 'government-direct' || name === 'public-universities'
        ).map(([ name ]) => [ name, 'government_education' ]);
    }
    const selected = record.flags.has('government_education') ? 'government_education'
        : record.flags.has('public_interest_organization') ? 'public_interest_organization' : undefined;
    return [ ...record.claims ].map(([ name, category ]) => [ name, selected || category ]);
}
