# M5 — FC-022: SSRF-Safe HTTP Request Action & Egress Defense Engine

- **Date:** 2026-11-28
- **Milestone:** M5 — Actions and Integrations (`FC-022`)
- **Methodology:** Universal Prompt Patterns Registry (UPPR) Rev 4.1
- **Status:** Complete & Verified — Owner Acceptance Pending

---

## 1. Executive Summary

FC-022 delivers Forge's outbound webhook capability: `http.request@1.0.0` (`src/lib/workflow/actions/core/http-request.ts`), protected by an uncompromising SSRF and egress security defense engine (`src/lib/security/ssrf.ts`).

In accordance with Product Completion Tracker Section 1.3 and Gate G3, `http.request` is NOT an unconstrained fetcher. It is a hardened webhook dispatcher designed to prevent private subnet probing, cloud metadata theft, DNS rebinding attacks, protocol downgrades, and credential leakage.

---

## 2. Egress Defense Architecture (`src/lib/security/ssrf.ts`)

### 2.1 Comprehensive IP Perimeter & Subnet Blacklist
The defense engine evaluates every resolved IP address (IPv4 and IPv6) against forbidden CIDRs:
- **Loopback:** `127.0.0.0/8`, `::1`
- **Cloud Instance Metadata (IMDS):** `169.254.0.0/16`, `fe80::/10` (blocking `169.254.169.254` AWS/GCP/Azure metadata services)
- **RFC 1918 Private Subnets:** `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
- **Carrier-Grade NAT (CGNAT):** `100.64.0.0/10`
- **Unique Local Addresses (IPv6 ULA):** `fc00::/7`
- **Broadcast / Multicast / Documentation:** `224.0.0.0/4`, `240.0.0.0/4`, `ff00::/8`, `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, `2001:db8::/32`
- **IPv4-Mapped IPv6:** `::ffff:127.0.0.1`, `::ffff:169.254.169.254`, `::ffff:10.0.0.1` unwrapped and validated against IPv4 rules.
- **0.0.0.0 / Current Network:** `0.0.0.0/8` blocked.

### 2.2 Anti-DNS Rebinding via Socket IP Pinning
- Standard `fetch()` resolves DNS during connection, introducing a Time-of-Check to Time-of-Use (TOCTOU) vulnerability where a malicious DNS server returns a public IP initially and a private IP during socket connect.
- Forge overrides the Node HTTP/HTTPS transport dispatcher with custom socket options:
  - Hostname is pre-resolved using `dns.promises.lookup({ all: true })`.
  - Every resolved record is verified against the subnet blacklist.
  - The connection socket is pinned directly to the verified IP (`lookup: (_h, _o, cb) => cb(null, pinnedIp, family)`) while preserving the original `servername` (SNI) and `Host` header for valid TLS handshakes.

### 2.3 Strict Redirect Validation
- Automatic redirects (`redirect: "follow"`) are prohibited.
- Redirects are intercepted and followed manually (max 3 hops).
- For each hop:
  - Destination URL is parsed and scheme verified (only `http:` and `https:` permitted; transitions to `file:`, `gopher:`, `ftp:` immediately rejected).
  - Protocol downgrades (e.g. `https:` to `http:`) are rejected.
  - Destination hostname is re-resolved and destination IP re-validated.
  - Sensitive authentication headers (`Authorization`, `Cookie`, `X-Api-Key`) are stripped if redirecting across domain boundaries.

### 2.4 Resource Limits & Safe Error Masking
- **Timeouts:** Connect timeout &le; 5 seconds; read/response timeout &le; 10 seconds.
- **Size Capping:** Maximum response body size capped at 1 MB (1,048,576 bytes). Stream automatically aborts if exceeded to prevent memory exhaustion / zip-bombs.
- **Safe Error Masking:** Security violations return uniform error messages (`Destination prohibited by security policy`) to prevent internal network topology disclosure.

---

## 3. Verification & Evidence

### Dedicated Test Suite: `src/tests/workflow/m5-fc022-ssrf.test.ts`
- **Tests Executed:** 23 / 23 passed
  - Loopback rejection (`127.0.0.1`, `127.0.0.2`, `localhost`, `::1`)
  - Cloud metadata rejection (`169.254.169.254`, `fe80::1`)
  - RFC 1918 rejection (`10.0.0.1`, `172.16.0.1`, `192.168.1.1`)
  - CGNAT rejection (`100.64.0.1`)
  - IPv6 ULA rejection (`fc00::1`, `fd12:3456:789a::1`)
  - IPv4-mapped IPv6 rejection (`::ffff:127.0.0.1`, `::ffff:169.254.169.254`)
  - 0.0.0.0 rejection
  - Invalid protocol rejection (`ftp://`, `file://`, `gopher://`)
  - Redirect hop limit enforcement (aborts after 3 hops)
  - Redirect protocol downgrade rejection (`https` -> `http`)
  - Redirect re-validation (rejects redirect pointing to `169.254.169.254`)
  - Response body size limit enforcement (rejects > 1 MB)
  - Connect & read timeout enforcement
  - Header redaction in execution audit logs
  - Irreversible compensation classification
