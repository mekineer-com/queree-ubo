export function parseMatchPattern(pattern) {
    const execResult = matchPatternRegExp.exec(pattern);
    if (!execResult) {
        return null;
    }
    const groups = execResult.groups;
    return groups.allURLs != null
        ? { allURLs: true }
        : {
            allURLs: false,
            scheme: groups.scheme.toLowerCase(),
            host: groups.host.toLowerCase(),
            path: groups.path,
        };
}
const matchPatternRegExp = (() => {
    const allURLs = "(?<allURLs><all_urls>)";
    const scheme = String.raw `(?<scheme>\*|[A-Za-z][0-9A-Za-z+.-]*)`;
    const label = "(?:[0-9A-Za-z](?:[0-9A-Za-z-]*[0-9A-Za-z])?)";
    const host = String.raw `(?<host>(?:\*|${label})(?:\.${label})*)`;
    const path = String.raw `(?<path>/(?:\*|[0-9A-Za-z._~:/?[\]@!$&'()+,;=-]|%[0-9A-Fa-f]{2})*)`;
    return new RegExp(`^(?:${allURLs}|${scheme}://${host}${path})$`);
})();
export class MatchPatternMap {
    static supportedSchemes = ["http", "https"];
    allURLs;
    hostMap;
    constructor(json) {
        if (json) {
            this.allURLs = json[0];
            this.hostMap = json[1];
        }
        else {
            this.allURLs = [];
            this.hostMap = [[], []];
        }
    }
    toJSON() {
        return [this.allURLs, this.hostMap];
    }
    get(url) {
        const { protocol, hostname: host, pathname, search } = new URL(url);
        const scheme = protocol.slice(0, -1);
        const path = `${pathname}${search}`;
        if (!MatchPatternMap.supportedSchemes.includes(scheme)) {
            return [];
        }
        const values = [...this.allURLs];
        let node = this.hostMap;
        for (const label of host.split(".").reverse()) {
            collectBucket(node[1], scheme, path, values);
            if (!node[2]?.[label]) {
                return values;
            }
            node = node[2][label];
        }
        collectBucket(node[1], scheme, path, values);
        collectBucket(node[0], scheme, path, values);
        return values;
    }
    set(pattern, value) {
        const parseResult = parseMatchPattern(pattern);
        if (!parseResult) {
            throw new Error(`Invalid match pattern: ${pattern}`);
        }
        if (parseResult.allURLs) {
            this.allURLs.push(value);
            return;
        }
        const { scheme, host, path } = parseResult;
        if (scheme !== "*" && !MatchPatternMap.supportedSchemes.includes(scheme)) {
            throw new Error(`Unsupported scheme: ${scheme}`);
        }
        const labels = host.split(".").reverse();
        const anySubdomain = labels[labels.length - 1] === "*";
        if (anySubdomain) {
            labels.pop();
        }
        let node = this.hostMap;
        for (const label of labels) {
            node[2] ||= {};
            node = node[2][label] ||= [[], []];
        }
        node[anySubdomain ? 1 : 0].push(path === "/*"
            ? scheme === "*"
                ? [value]
                : [value, scheme]
            : [value, scheme, path]);
    }
}
export class MatchPattern {
    constructor(patterns) {
        this.#map = new MatchPatternMap();
        for (const pattern of patterns) {
            this.#map.set(pattern, true);
        }
    }
    test(url) {
        return this.#map.get(url).length !== 0;
    }
    #map;
}
function collectBucket(bucket, scheme, path, values) {
    for (const [value, schemePattern = "*", pathPattern = "/*"] of bucket) {
        if (testScheme(schemePattern, scheme) && testPath(pathPattern, path)) {
            values.push(value);
        }
    }
}
function testScheme(schemePattern, scheme) {
    return schemePattern === "*"
        ? scheme === "http" || scheme === "https"
        : scheme === schemePattern;
}
function testPath(pathPattern, path) {
    if (pathPattern === "/*") {
        return true;
    }
    const [first, ...rest] = pathPattern.split("*");
    if (rest.length === 0) {
        return path === first;
    }
    if (!path.startsWith(first)) {
        return false;
    }
    let pos = first.length;
    for (const part of rest.slice(0, -1)) {
        const partPos = path.indexOf(part, pos);
        if (partPos === -1) {
            return false;
        }
        pos = partPos + part.length;
    }
    // biome-ignore lint/style/noNonNullAssertion: `rest` is not empty
    return path.slice(pos).endsWith(rest[rest.length - 1]);
}
