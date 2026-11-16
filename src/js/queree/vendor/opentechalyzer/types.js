/**
 * Opentechalyzer core types.
 *
 * The detection model has three layers:
 *   1. Evidence  - raw observations collected from a target (headers, DOM, DNS, ...)
 *   2. Signals   - declarative patterns on a Fingerprint that match Evidence
 *   3. Detection - a technology plus the confidence and the evidence trail behind it
 *
 * Every detection carries its full evidence trail. A result you cannot audit is a
 * result you cannot trust, so nothing is reported without saying why.
 */
/**
 * Intrinsic reliability of each source, expressed as the probability that a single
 * match from that source is a true positive.
 *
 * These are deliberately conservative. Weak sources are kept in the model because
 * several weak signals combining is genuinely informative, but no single weak signal
 * should be enough to report a technology as present.
 */
export const SOURCE_RELIABILITY = {
    cookie: 0.94,
    'js-global': 0.9,
    meta: 0.9,
    probe: 0.9,
    'sourcemap-dep': 0.95,
    header: 0.88,
    dom: 0.82,
    'script-src': 0.8,
    'request-host': 0.8,
    'stylesheet-src': 0.78,
    // Compiled CSS is authoritative for CSS frameworks: Tailwind's `--tw-` custom properties
    // and Bootstrap's `--bs-` variables only exist if the framework actually generated the file.
    'css-content': 0.85,
    'cert-subdomain': 0.72,
    'dns-txt': 0.75,
    'dns-cname': 0.85,
    'dns-mx': 0.9,
    'dns-ns': 0.85,
    favicon: 0.7,
    'script-content': 0.66,
    robots: 0.7,
    html: 0.55,
    url: 0.6,
    implied: 0.0, // handled separately by the implication resolver
};
//# sourceMappingURL=types.js.map