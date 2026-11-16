export function snapshotDate(value) {
    if ( /^\d{4}-\d{2}-\d{2}$/.test(value || '') === false ||
        new Date(value).toISOString().slice(0, 10) !== value ) {
        throw new Error('Supply the source retrieval date as YYYY-MM-DD');
    }
    return value;
}
