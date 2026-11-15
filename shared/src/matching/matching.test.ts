import { describe, it, expect } from "vitest";
import { matchesPage, pageSiteKey, recordSiteKey } from "./matching.js";

type Row = [description: string, record: string, page: string, expected: boolean];

const rows: Row[] = [
  // Basic matches
  ["same origin", "https://example.com", "https://example.com/login", true],
  ["subdomain of the saved domain", "https://example.com", "https://accounts.example.com/", true],
  ["saved subdomain, page on apex", "https://login.example.com", "https://example.com/", true],
  ["record without scheme means https", "example.com", "https://example.com/", true],
  ["uppercase and trailing dot", "https://EXAMPLE.com", "https://www.example.com./x", true],
  ["different port, same site", "https://example.com", "https://example.com:8443/", true],
  ["multi-label public suffix", "https://example.co.uk", "https://www.example.co.uk/", true],
  ["saved http record, https page", "http://example.com", "https://example.com/", true],

  // Must not match
  ["different site", "https://example.com", "https://example.org/", false],
  [
    "suffix-only lookalike (co.uk is not a site)",
    "https://example.co.uk",
    "https://evil.co.uk/",
    false,
  ],
  ["sibling under a public suffix", "https://example.co.uk", "https://other.co.uk/", false],
  [
    "domain used as a subdomain of another site",
    "https://example.com",
    "https://example.com.evil.com/",
    false,
  ],
  ["domain embedded in a longer name", "https://example.com", "https://evil-example.com/", false],
  [
    "domain as a prefix of another name",
    "https://example.com",
    "https://example.community/",
    false,
  ],
  ["page is http", "https://example.com", "http://example.com/", false],
  ["page is http and record is http", "http://example.com", "http://example.com/", false],
  ["userinfo trick as page", "https://example.com", "https://example.com@evil.com/", false],
  ["userinfo trick with credentials", "https://example.com", "https://user:pw@example.com/", false],
  ["userinfo trick in the saved URL", "https://example.com@evil.com", "https://evil.com/", false],
  ["punycode lookalike (accent)", "https://example.com", "https://xn--xample-9ua.com/", false],
  ["unicode lookalike (cyrillic a)", "https://example.com", "https://exаmple.com/", false],
  ["unicode lookalike saved, ascii page", "https://exаmple.com", "https://example.com/", false],
  [
    "punycode page equals punycode record",
    "https://xn--xample-9ua.com",
    "https://éxample.com/",
    true,
  ],
  [
    "private suffix siblings (github.io)",
    "https://alice.github.io",
    "https://bob.github.io/",
    false,
  ],
  ["same private-suffix site", "https://alice.github.io", "https://alice.github.io/page", true],
  ["IP address page", "https://192.168.0.1", "https://192.168.0.1/", false],
  ["IPv6 page", "https://[2001:db8::1]", "https://[2001:db8::1]/", false],
  ["single-label host", "https://intranet", "https://intranet/", false],
  ["javascript: page", "https://example.com", "javascript:alert(1)", false],
  ["data: page", "https://example.com", "data:text/html,<p>x</p>", false],
  ["ftp page", "https://example.com", "ftp://example.com/", false],
  ["chrome-extension page", "https://example.com", "chrome-extension://abc/popup.html", false],
  ["garbage page", "https://example.com", "not a url", false],
  ["empty page", "https://example.com", "", false],
  ["empty record", "", "https://example.com/", false],
  ["whitespace record", "   ", "https://example.com/", false],
  ["ftp record", "ftp://example.com", "https://example.com/", false],
];

describe("matchesPage (production rules)", () => {
  for (const [description, record, page, expected] of rows) {
    it(`${expected ? "matches" : "rejects"}: ${description}`, () => {
      expect(matchesPage(record, page)).toBe(expected);
    });
  }
});

describe("localhost dev flag", () => {
  it("never matches localhost without the flag", () => {
    expect(matchesPage("http://localhost:3000", "http://localhost:3000/login")).toBe(false);
    expect(matchesPage("https://localhost", "https://localhost/")).toBe(false);
    expect(matchesPage("http://127.0.0.1:8080", "http://127.0.0.1:8080/")).toBe(false);
  });

  it("matches localhost over http only with the flag", () => {
    const opts = { allowLocalhost: true };
    expect(matchesPage("http://localhost:3000", "http://localhost:5173/login", opts)).toBe(true);
    expect(matchesPage("localhost", "http://localhost:5173/", opts)).toBe(true);
    expect(matchesPage("http://127.0.0.1:8080", "http://127.0.0.1:9000/", opts)).toBe(true);
  });

  it("the flag does not loosen anything for normal sites or cross-matching", () => {
    const opts = { allowLocalhost: true };
    expect(matchesPage("https://example.com", "http://example.com/", opts)).toBe(false);
    expect(matchesPage("http://localhost", "http://127.0.0.1/", opts)).toBe(false);
    expect(matchesPage("https://example.com", "http://localhost/", opts)).toBe(false);
    expect(matchesPage("http://localhost", "http://localhost.evil.com/", opts)).toBe(false);
    expect(matchesPage("http://localhost", "http://user@localhost/", opts)).toBe(false);
  });
});

describe("site keys", () => {
  it("returns the registrable domain", () => {
    expect(pageSiteKey("https://a.b.example.co.uk/x")).toBe("example.co.uk");
    expect(recordSiteKey("login.example.com")).toBe("example.com");
  });

  it("is null for ineligible pages", () => {
    expect(pageSiteKey("http://example.com")).toBeNull();
    expect(pageSiteKey("https://example.com@evil.com")).toBeNull();
  });
});
