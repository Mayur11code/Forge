// src/lib/security/ssrf.ts
//
// CANONICAL SSRF DEFENSE ENGINE (FC-022).
//
// Invariants enforced:
// 1. Strict blocked IP ranges:
//    - Loopback: 127.0.0.0/8, ::1/128
//    - Cloud metadata: 169.254.0.0/16, fe80::/10
//    - RFC 1918 Private subnets: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
//    - Unique local IPv6: fc00::/7
//    - Carrier-grade NAT: 100.64.0.0/10
//    - Current network / unspecified: 0.0.0.0/8, ::/128
//    - Multicast & Broadcast: 224.0.0.0/4, 255.255.255.255/32, ff00::/8
//    - IPv4-mapped IPv6: ::ffff:0:0/96 (unwrapped and classified)
// 2. DNS Rebinding Mitigation (TOCTOU Defense):
//    - Hostname pre-resolved with all A and AAAA records.
//    - All resolved IPs validated against blocklist.
//    - Socket connection pinned directly to validated IP.
// 3. Redirect Interception:
//    - Max 3 hops, manual Location inspection.
//    - HTTPS -> HTTP downgrade blocked.
//    - Credentials stripped across origin boundaries.
// 4. Resource Bounds:
//    - 5s connect timeout, 10s read timeout, 1 MB response streaming cap.

import http from "node:http";
import https from "node:https";
import dns from "node:dns/promises";
import net from "node:net";
import { URL } from "node:url";

export const MAX_CONNECT_TIMEOUT_MS = 5_000;
export const MAX_READ_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 1_048_576; // 1 MB
export const MAX_REDIRECTS = 3;

export class SSRFError extends Error {
  code: string;
  constructor(message: string, code = "SSRF_PROHIBITED") {
    super(message);
    this.name = "SSRFError";
    this.code = code;
  }
}

/**
 * Checks if a string is a valid IPv4 dotted-decimal address.
 */
function isIPv4(ip: string): boolean {
  return net.isIPv4(ip);
}

/**
 * Checks if a string is a valid IPv6 address.
 */
function isIPv6(ip: string): boolean {
  return net.isIPv6(ip);
}

/**
 * Converts dotted-decimal IPv4 to a 32-bit unsigned integer.
 */
function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * Checks if an IPv4 address belongs to a CIDR range.
 */
function ipv4InCidr(ip: string, cidr: string): boolean {
  const [rangeIp, prefixStr] = cidr.split("/");
  const prefix = Number(prefixStr);
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(rangeIp);
  return (ipInt & mask) === (rangeInt & mask);
}

/**
 * Normalizes an IPv6 address to an array of 8 16-bit hex words.
 */
function parseIPv6Words(ip: string): number[] | null {
  let cleanIp = ip.toLowerCase();
  // Handle zone index e.g. fe80::1%eth0
  const zoneIndex = cleanIp.indexOf("%");
  if (zoneIndex !== -1) {
    cleanIp = cleanIp.slice(0, zoneIndex);
  }

  // Handle IPv4-mapped IPv6 e.g. ::ffff:192.168.1.1
  if (cleanIp.includes(".")) {
    const lastColon = cleanIp.lastIndexOf(":");
    if (lastColon === -1) return null;
    const v4Part = cleanIp.slice(lastColon + 1);
    if (!isIPv4(v4Part)) return null;
    const v4Int = ipv4ToInt(v4Part);
    const high = (v4Int >>> 16) & 0xffff;
    const low = v4Int & 0xffff;
    cleanIp = `${cleanIp.slice(0, lastColon)}:${high.toString(16)}:${low.toString(16)}`;
  }

  const parts = cleanIp.split(":");
  const doubleColonIndex = parts.indexOf("");

  if (doubleColonIndex !== -1) {
    const emptyCount = parts.filter((p) => p === "").length;
    // double colon can be '::' at start/end or inside
    const nonColons = parts.filter((p) => p !== "");
    const missing = 8 - nonColons.length;
    const expanded: string[] = [];

    let inserted = false;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === "") {
        if (!inserted) {
          for (let j = 0; j < missing; j++) expanded.push("0");
          inserted = true;
        }
      } else {
        expanded.push(parts[i]);
      }
    }
    while (expanded.length < 8) expanded.push("0");
    return expanded.slice(0, 8).map((h) => parseInt(h, 16) || 0);
  }

  if (parts.length !== 8) return null;
  return parts.map((h) => parseInt(h, 16) || 0);
}

/**
 * Validates whether an IP address (IPv4 or IPv6) is globally routable and permitted.
 * Returns false if the IP is private, loopback, link-local, cloud metadata, or reserved.
 */
export function isIpAllowed(rawIp: string): boolean {
  if (!rawIp || typeof rawIp !== "string") return false;
  const ip = rawIp.trim();

  // 1. IPv4 Validation
  if (isIPv4(ip)) {
    // 0.0.0.0/8 (Current network)
    if (ipv4InCidr(ip, "0.0.0.0/8")) return false;
    // 127.0.0.0/8 (Loopback)
    if (ipv4InCidr(ip, "127.0.0.0/8")) return false;
    // 10.0.0.0/8 (RFC 1918 Private)
    if (ipv4InCidr(ip, "10.0.0.0/8")) return false;
    // 172.16.0.0/12 (RFC 1918 Private)
    if (ipv4InCidr(ip, "172.16.0.0/12")) return false;
    // 192.168.0.0/16 (RFC 1918 Private)
    if (ipv4InCidr(ip, "192.168.0.0/16")) return false;
    // 169.254.0.0/16 (Link-local / Cloud metadata: 169.254.169.254)
    if (ipv4InCidr(ip, "169.254.0.0/16")) return false;
    // 100.64.0.0/10 (Carrier-Grade NAT)
    if (ipv4InCidr(ip, "100.64.0.0/10")) return false;
    // 192.0.0.0/24 (IETF Protocol Assignments)
    if (ipv4InCidr(ip, "192.0.0.0/24")) return false;
    // 192.0.2.0/24 (TEST-NET-1)
    if (ipv4InCidr(ip, "192.0.2.0/24")) return false;
    // 198.51.100.0/24 (TEST-NET-2)
    if (ipv4InCidr(ip, "198.51.100.0/24")) return false;
    // 203.0.113.0/24 (TEST-NET-3)
    if (ipv4InCidr(ip, "203.0.113.0/24")) return false;
    // 198.18.0.0/15 (Benchmarking)
    if (ipv4InCidr(ip, "198.18.0.0/15")) return false;
    // 224.0.0.0/4 (Multicast)
    if (ipv4InCidr(ip, "224.0.0.0/4")) return false;
    // 240.0.0.0/4 (Reserved / Future use)
    if (ipv4InCidr(ip, "240.0.0.0/4")) return false;
    // 255.255.255.255/32 (Broadcast)
    if (ip === "255.255.255.255") return false;

    return true;
  }

  // 2. IPv6 Validation
  if (isIPv6(ip)) {
    const words = parseIPv6Words(ip);
    if (!words) return false;

    // ::/128 (Unspecified)
    if (words.every((w) => w === 0)) return false;

    // ::1/128 (Loopback)
    if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return false;

    // ::ffff:0:0/96 (IPv4-mapped IPv6)
    if (words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0xffff) {
      const v4 = `${(words[6] >> 8) & 0xff}.${words[6] & 0xff}.${(words[7] >> 8) & 0xff}.${words[7] & 0xff}`;
      return isIpAllowed(v4);
    }

    // fe80::/10 (Link-local unicast & cloud metadata)
    if ((words[0] & 0xffc0) === 0xfe80) return false;

    // fc00::/7 (Unique local address / ULA - private IPv6)
    if ((words[0] & 0xfe00) === 0xfc00) return false;

    // ff00::/8 (Multicast)
    if ((words[0] & 0xff00) === 0xff00) return false;

    // 2001:db8::/32 (Documentation)
    if (words[0] === 0x2001 && words[1] === 0x0db8) return false;

    // 100::/64 (Discard-only)
    if (words[0] === 0x0100 && words[1] === 0 && words[2] === 0 && words[3] === 0) return false;

    return true;
  }

  return false;
}

const PROHIBITED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "instance-data",
  "metadata",
  "169.254.169.254",
]);

/**
 * Validates a target URL and pre-resolves its DNS records to prevent DNS rebinding.
 */
export async function validateDestinationUrl(
  rawUrl: string,
  customDnsResolver?: (hostname: string) => Promise<string[]>,
): Promise<{
  url: URL;
  resolvedIps: string[];
  pinnedIp: string;
  isIpv6: boolean;
}> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SSRFError(`Malformed URL: "${rawUrl}"`, "MALFORMED_URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SSRFError(
      `Prohibited protocol "${url.protocol}". Only HTTP and HTTPS are permitted.`,
      "INVALID_PROTOCOL",
    );
  }

  if (url.username || url.password) {
    throw new SSRFError("Embedded URL credentials (userinfo) are prohibited.", "CREDENTIALS_PROHIBITED");
  }

  const hostname = url.hostname.toLowerCase();

  if (PROHIBITED_HOSTNAMES.has(hostname) || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new SSRFError(`Destination hostname "${hostname}" is prohibited by security policy.`, "BLOCKED_HOSTNAME");
  }

  // 1. Literal IP Address
  if (net.isIP(hostname)) {
    if (!isIpAllowed(hostname)) {
      throw new SSRFError(`Destination IP ${hostname} is prohibited by security policy.`, "BLOCKED_IP");
    }
    return {
      url,
      resolvedIps: [hostname],
      pinnedIp: hostname,
      isIpv6: isIPv6(hostname),
    };
  }

  // 2. Resolve DNS (all A and AAAA records)
  let resolvedIps: string[] = [];
  try {
    if (customDnsResolver) {
      resolvedIps = await customDnsResolver(hostname);
    } else {
      const records = await dns.lookup(hostname, { all: true });
      resolvedIps = records.map((r) => r.address);
    }
  } catch (dnsErr) {
    throw new SSRFError(
      `DNS resolution failed for hostname "${hostname}": ${dnsErr instanceof Error ? dnsErr.message : "Unknown DNS error"}`,
      "DNS_RESOLUTION_FAILED",
    );
  }

  if (!resolvedIps || resolvedIps.length === 0) {
    throw new SSRFError(`No IP records resolved for hostname "${hostname}".`, "NO_DNS_RECORDS");
  }

  // 3. Strict Check: ALL returned addresses must be public and permitted.
  // Fail closed if a mixed response (public + private) is returned.
  for (const ip of resolvedIps) {
    if (!isIpAllowed(ip)) {
      throw new SSRFError(
        `Destination address for "${hostname}" resolves to prohibited IP ${ip}.`,
        "BLOCKED_IP",
      );
    }
  }

  const pinnedIp = resolvedIps[0];
  return {
    url,
    resolvedIps,
    pinnedIp,
    isIpv6: isIPv6(pinnedIp),
  };
}

export type SSRFRequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  connectTimeoutMs?: number;
  readTimeoutMs?: number;
  maxRedirects?: number;
  customTransport?: typeof http.request;
  customDnsResolver?: (hostname: string) => Promise<string[]>;
};

export type SSRFResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: unknown;
  text: string;
  bytesReceived: number;
  redirectCount: number;
  effectiveUrl: string;
  pinnedIp: string;
};

const SENSITIVE_HEADER_REGEX = /^(authorization|cookie|set-cookie|x-api-key|proxy-authorization)$/i;

/**
 * Filter and redact sensitive headers for output logging.
 */
export function filterSensitiveHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(headers)) {
    if (!val) continue;
    if (SENSITIVE_HEADER_REGEX.test(key)) {
      result[key.toLowerCase()] = "[REDACTED]";
    } else {
      result[key.toLowerCase()] = Array.isArray(val) ? val.join(", ") : String(val);
    }
  }
  return result;
}

/**
 * Execute an SSRF-safe HTTP request with strict socket pinning, redirect interception,
 * and streaming resource bounds.
 */
export async function ssrfFetch(
  targetUrl: string,
  options: SSRFRequestOptions = {},
): Promise<SSRFResponse> {
  let currentUrl = targetUrl;
  let redirectCount = 0;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const headers = { ...(options.headers || {}) };

  while (redirectCount <= maxRedirects) {
    const validation = await validateDestinationUrl(currentUrl, options.customDnsResolver);
    const { url, pinnedIp, isIpv6 } = validation;

    const isHttps = url.protocol === "https:";
    const port = url.port ? Number(url.port) : isHttps ? 443 : 80;

    // Body serialization
    let bodyBuffer: Buffer | undefined;
    if (options.body !== undefined && options.body !== null) {
      if (typeof options.body === "string") {
        bodyBuffer = Buffer.from(options.body, "utf8");
      } else if (Buffer.isBuffer(options.body)) {
        bodyBuffer = options.body;
      } else {
        bodyBuffer = Buffer.from(JSON.stringify(options.body), "utf8");
        if (!headers["content-type"] && !headers["Content-Type"]) {
          headers["Content-Type"] = "application/json";
        }
      }
      headers["Content-Length"] = String(bodyBuffer.byteLength);
    }

    const connectTimeout = Math.min(options.connectTimeoutMs ?? MAX_CONNECT_TIMEOUT_MS, MAX_CONNECT_TIMEOUT_MS);
    const readTimeout = Math.min(options.readTimeoutMs ?? MAX_READ_TIMEOUT_MS, MAX_READ_TIMEOUT_MS);

    // Socket IP Pinning:
    // In node:https/http, custom `lookup` guarantees connection exclusively to `pinnedIp`.
    const requestOptions: https.RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port,
      path: `${url.pathname}${url.search}`,
      method: options.method || "GET",
      headers: {
        ...headers,
        Host: url.host,
      },
      lookup: (_hostname, _opts, callback) => {
        // Enforces exact socket pinning: never performs a second unvalidated DNS query!
        callback(null, pinnedIp, isIpv6 ? 6 : 4);
      },
      // Preserves TLS hostname verification and SNI
      servername: url.hostname,
      timeout: readTimeout,
    };

    const transport = options.customTransport || (isHttps ? https.request : http.request);

    const response = await new Promise<{
      statusCode: number;
      statusMessage: string;
      headers: http.IncomingHttpHeaders;
      body: string;
      bytes: number;
    }>((resolve, reject) => {
      let isSettled = false;

      function fail(err: Error) {
        if (isSettled) return;
        isSettled = true;
        reject(err);
      }

      const req = transport(requestOptions, (res) => {
        let bytesReceived = 0;
        const chunks: Buffer[] = [];

        res.on("data", (chunk: Buffer) => {
          bytesReceived += chunk.length;
          if (bytesReceived > MAX_RESPONSE_BYTES) {
            req.destroy();
            fail(new SSRFError(`Response body exceeded maximum allowed size of 1 MB.`, "BODY_SIZE_EXCEEDED"));
            return;
          }
          chunks.push(chunk);
        });

        res.on("end", () => {
          if (isSettled) return;
          isSettled = true;
          const bodyStr = Buffer.concat(chunks).toString("utf8");
          resolve({
            statusCode: res.statusCode || 200,
            statusMessage: res.statusMessage || "OK",
            headers: res.headers,
            body: bodyStr,
            bytes: bytesReceived,
          });
        });

        res.on("error", (err) => fail(err));
      });

      req.on("error", (err) => fail(err));

      // Connection timeout
      req.setTimeout(connectTimeout, () => {
        req.destroy();
        fail(new SSRFError(`Connection timed out after ${connectTimeout}ms.`, "CONNECT_TIMEOUT"));
      });

      if (bodyBuffer) {
        req.write(bodyBuffer);
      }
      req.end();
    });

    // Check for Redirect (3xx)
    const isRedirect =
      response.statusCode >= 300 &&
      response.statusCode < 400 &&
      Boolean(response.headers.location);

    if (isRedirect) {
      redirectCount++;
      if (redirectCount > maxRedirects) {
        throw new SSRFError(`Exceeded maximum allowed redirect count of ${maxRedirects}.`, "TOO_MANY_REDIRECTS");
      }

      const location = response.headers.location as string;
      const nextUrl = new URL(location, currentUrl);

      // Protocol downgrade prevention: HTTPS -> HTTP is forbidden!
      if (url.protocol === "https:" && nextUrl.protocol === "http:") {
        throw new SSRFError(`HTTPS-to-HTTP protocol downgrade is forbidden.`, "PROTOCOL_DOWNGRADE");
      }

      // Strip sensitive credentials on cross-origin redirects
      if (nextUrl.origin !== url.origin) {
        for (const key of Object.keys(headers)) {
          if (SENSITIVE_HEADER_REGEX.test(key)) {
            delete headers[key];
          }
        }
      }

      currentUrl = nextUrl.toString();
      continue;
    }

    // Normal response processing
    let parsedData: unknown = null;
    try {
      parsedData = JSON.parse(response.body);
    } catch {
      parsedData = null;
    }

    return {
      status: response.statusCode,
      statusText: response.statusMessage,
      headers: filterSensitiveHeaders(response.headers),
      data: parsedData,
      text: response.body.slice(0, 5000), // bounded summary text
      bytesReceived: response.bytes,
      redirectCount,
      effectiveUrl: currentUrl,
      pinnedIp,
    };
  }

  throw new SSRFError(`Exceeded maximum redirect count.`, "TOO_MANY_REDIRECTS");
}
