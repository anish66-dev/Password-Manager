import { getDomain } from "tldts";

export interface MatchOptions {
  /** Development only: treat localhost and loopback addresses as matchable, over http too. */
  allowLocalhost?: boolean;
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function normalizedHostname(url: URL): string {
  // URL already lower-cases and converts Unicode hosts to punycode (so look-alikes differ).
  return url.hostname.replace(/\.$/, "");
}

/**
 * Registrable domain (eTLD+1, Public Suffix List including private suffixes such as
 * github.io) of an already parsed http(s) URL, or "localhost"-style hosts in dev mode.
 * Returns null for anything that must never match: userinfo, IP addresses, unknown suffixes.
 */
function siteKey(url: URL, options: MatchOptions): string | null {
  if (url.username !== "" || url.password !== "") return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const hostname = normalizedHostname(url);
  if (LOCAL_HOSTNAMES.has(hostname)) {
    return options.allowLocalhost ? hostname : null;
  }
  return getDomain(hostname, { allowPrivateDomains: true });
}

/**
 * The registrable domain of a page that may receive suggestions, or null when the page
 * is not eligible. Pages must use https (http only for localhost in dev mode).
 */
export function pageSiteKey(pageUrl: string, options: MatchOptions = {}): string | null {
  const url = parseUrl(pageUrl);
  if (!url) return null;
  const key = siteKey(url, options);
  if (key === null) return null;
  const isLocal = LOCAL_HOSTNAMES.has(normalizedHostname(url));
  if (url.protocol === "https:") return key;
  return isLocal && options.allowLocalhost ? key : null;
}

/**
 * The registrable domain a saved login belongs to. A missing scheme means https.
 * The saved URL's scheme is otherwise ignored: only the page must be https.
 */
export function recordSiteKey(recordUrl: string, options: MatchOptions = {}): string | null {
  const trimmed = recordUrl.trim();
  if (trimmed === "") return null;
  const url = parseUrl(SCHEME_RE.test(trimmed) ? trimmed : `https://${trimmed}`);
  return url ? siteKey(url, options) : null;
}

/** True when a saved login may be offered on, and filled into, the given page. */
export function matchesPage(
  recordUrl: string,
  pageUrl: string,
  options: MatchOptions = {}
): boolean {
  const page = pageSiteKey(pageUrl, options);
  if (page === null) return false;
  return page === recordSiteKey(recordUrl, options);
}
