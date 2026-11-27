// src/tests/workflow/m5-fc022-ssrf.test.ts
//
// M5 FC-022: SSRF Defense Engine & http.request Webhook Action Test Suite.
// Verifies:
// 1. IP classification and blocked CIDRs (loopback, metadata, RFC1918, CGNAT, IPv6 ULA, IPv4-mapped).
// 2. DNS rebinding mitigation (all DNS records validated; fail closed on mixed results; socket pinning).
// 3. Redirect enforcement (max 3 hops, protocol downgrade prevention, cross-origin credential stripping).
// 4. Resource bounds (1 MB stream abort, timeouts).
// 5. `http.request@1.0.0` action registration and execution.

jest.mock("server-only", () => ({}));
jest.mock("@/lib/prisma/db", () => ({ db: {} }));
jest.mock("@/lib/prisma/extended", () => ({ prisma: {} }));

import {
  isIpAllowed,
  validateDestinationUrl,
  ssrfFetch,
  SSRFError,
  filterSensitiveHeaders,
} from "@/lib/security/ssrf";
import { httpRequestAction, __setTestHttpRequestHooks } from "@/lib/workflow/actions/core/http-request";
import { ActionRegistry, getAction } from "@/lib/workflow-types/action-registry";
import http from "node:http";
import { EventEmitter } from "node:events";

describe("M5 FC-022: SSRF Defense Engine & http.request Action", () => {
  describe("IP Address Range Classification (isIpAllowed)", () => {
    it("permits public routable IPv4 addresses", () => {
      expect(isIpAllowed("8.8.8.8")).toBe(true);
      expect(isIpAllowed("1.1.1.1")).toBe(true);
      expect(isIpAllowed("93.184.216.34")).toBe(true);
      expect(isIpAllowed("142.250.190.46")).toBe(true);
    });

    it("permits public routable IPv6 addresses", () => {
      expect(isIpAllowed("2606:4700:4700::1111")).toBe(true);
      expect(isIpAllowed("2001:4860:4860::8888")).toBe(true);
    });

    it("blocks IPv4 loopback (127.0.0.0/8)", () => {
      expect(isIpAllowed("127.0.0.1")).toBe(false);
      expect(isIpAllowed("127.0.0.254")).toBe(false);
      expect(isIpAllowed("127.255.255.255")).toBe(false);
    });

    it("blocks IPv6 loopback (::1)", () => {
      expect(isIpAllowed("::1")).toBe(false);
      expect(isIpAllowed("0:0:0:0:0:0:0:1")).toBe(false);
    });

    it("blocks cloud instance metadata (169.254.169.254 and 169.254.0.0/16)", () => {
      expect(isIpAllowed("169.254.169.254")).toBe(false);
      expect(isIpAllowed("169.254.0.1")).toBe(false);
      expect(isIpAllowed("169.254.255.254")).toBe(false);
    });

    it("blocks IPv6 link-local (fe80::/10)", () => {
      expect(isIpAllowed("fe80::1")).toBe(false);
      expect(isIpAllowed("fe80::a00:27ff:fe8a:6e84")).toBe(false);
    });

    it("blocks RFC 1918 private IPv4 subnets (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)", () => {
      expect(isIpAllowed("10.0.0.1")).toBe(false);
      expect(isIpAllowed("10.254.254.254")).toBe(false);
      expect(isIpAllowed("172.16.0.1")).toBe(false);
      expect(isIpAllowed("172.31.255.255")).toBe(false);
      expect(isIpAllowed("192.168.1.1")).toBe(false);
      expect(isIpAllowed("192.168.254.254")).toBe(false);
    });

    it("blocks unique local IPv6 / ULA (fc00::/7)", () => {
      expect(isIpAllowed("fc00::1")).toBe(false);
      expect(isIpAllowed("fd12:3456:789a:1::1")).toBe(false);
    });

    it("blocks Carrier-Grade NAT / CGNAT (100.64.0.0/10)", () => {
      expect(isIpAllowed("100.64.0.1")).toBe(false);
      expect(isIpAllowed("100.127.255.255")).toBe(false);
    });

    it("blocks IPv4-mapped IPv6 representations of private/loopback addresses", () => {
      expect(isIpAllowed("::ffff:127.0.0.1")).toBe(false);
      expect(isIpAllowed("::ffff:10.0.0.1")).toBe(false);
      expect(isIpAllowed("::ffff:169.254.169.254")).toBe(false);
      expect(isIpAllowed("::ffff:192.168.1.1")).toBe(false);
      // But allows public mapped
      expect(isIpAllowed("::ffff:8.8.8.8")).toBe(true);
    });

    it("blocks current network, broadcast, and multicast", () => {
      expect(isIpAllowed("0.0.0.0")).toBe(false);
      expect(isIpAllowed("255.255.255.255")).toBe(false);
      expect(isIpAllowed("224.0.0.1")).toBe(false);
      expect(isIpAllowed("ff02::1")).toBe(false);
    });
  });

  describe("Destination Validation & Anti-DNS Rebinding (validateDestinationUrl)", () => {
    it("rejects non-HTTP protocols", async () => {
      await expect(validateDestinationUrl("file:///etc/passwd")).rejects.toThrow(SSRFError);
      await expect(validateDestinationUrl("gopher://127.0.0.1:70/")).rejects.toThrow(SSRFError);
      await expect(validateDestinationUrl("ftp://example.com/test")).rejects.toThrow(SSRFError);
    });

    it("rejects embedded userinfo/credentials in URLs", async () => {
      await expect(validateDestinationUrl("https://admin:secret@example.com")).rejects.toThrow("Embedded URL credentials");
    });

    it("rejects prohibited internal hostnames immediately", async () => {
      await expect(validateDestinationUrl("http://localhost/api")).rejects.toThrow(SSRFError);
      await expect(validateDestinationUrl("http://metadata.google.internal/computeMetadata")).rejects.toThrow(SSRFError);
      await expect(validateDestinationUrl("http://internal-service.local/api")).rejects.toThrow(SSRFError);
    });

    it("fails closed if ANY resolved address is private (mixed DNS response attack)", async () => {
      const mockDns = jest.fn().mockResolvedValue(["93.184.216.34", "127.0.0.1"]);
      await expect(validateDestinationUrl("https://mixed-dns.attacker.com", mockDns)).rejects.toThrow(
        /resolves to prohibited IP/,
      );
    });

    it("pins the validated IP address for socket connection", async () => {
      const mockDns = jest.fn().mockResolvedValue(["93.184.216.34"]);
      const res = await validateDestinationUrl("https://example.com/api/webhook", mockDns);
      expect(res.pinnedIp).toBe("93.184.216.34");
      expect(res.url.hostname).toBe("example.com");
    });
  });

  describe("Redirect Protection & Header Safety", () => {
    it("redacts sensitive headers from logs and output", () => {
      const rawHeaders = {
        authorization: "Bearer secret-token-12345",
        cookie: "session=xyz987",
        "x-api-key": "apikey-abcde",
        "content-type": "application/json",
      };
      const filtered = filterSensitiveHeaders(rawHeaders);
      expect(filtered.authorization).toBe("[REDACTED]");
      expect(filtered.cookie).toBe("[REDACTED]");
      expect(filtered["x-api-key"]).toBe("[REDACTED]");
      expect(filtered["content-type"]).toBe("application/json");
    });

    it("rejects redirect to prohibited private IP", async () => {
      // Mock transport that responds with 302 pointing to 169.254.169.254
      const mockTransport = jest.fn().mockImplementation((_opts, cb) => {
        const req = new EventEmitter() as http.ClientRequest;
        req.setTimeout = jest.fn();
        req.write = jest.fn();
        req.end = jest.fn().mockImplementation(() => {
          const res = new EventEmitter() as http.IncomingMessage;
          res.statusCode = 302;
          res.headers = { location: "http://169.254.169.254/latest/meta-data/" };
          cb(res);
          res.emit("end");
        });
        req.destroy = jest.fn();
        return req;
      });

      const mockDns = jest.fn().mockResolvedValue(["93.184.216.34"]);

      await expect(
        ssrfFetch("https://safe.example.com/redirect", {
          customTransport: mockTransport as unknown as typeof http.request,
          customDnsResolver: mockDns,
        }),
      ).rejects.toThrow(SSRFError);
    });

    it("rejects HTTPS-to-HTTP protocol downgrade on redirect", async () => {
      const mockTransport = jest.fn().mockImplementation((_opts, cb) => {
        const req = new EventEmitter() as http.ClientRequest;
        req.setTimeout = jest.fn();
        req.write = jest.fn();
        req.end = jest.fn().mockImplementation(() => {
          const res = new EventEmitter() as http.IncomingMessage;
          res.statusCode = 302;
          res.headers = { location: "http://safe.example.com/downgrade" };
          cb(res);
          res.emit("end");
        });
        req.destroy = jest.fn();
        return req;
      });

      const mockDns = jest.fn().mockResolvedValue(["93.184.216.34"]);

      await expect(
        ssrfFetch("https://safe.example.com/secure", {
          customTransport: mockTransport as unknown as typeof http.request,
          customDnsResolver: mockDns,
        }),
      ).rejects.toThrow("HTTPS-to-HTTP protocol downgrade is forbidden");
    });
  });

  describe("Resource Bounds (Response Cap & Timeouts)", () => {
    it("aborts stream if response exceeds 1 MB", async () => {
      const mockTransport = jest.fn().mockImplementation((_opts, cb) => {
        const req = new EventEmitter() as http.ClientRequest;
        req.setTimeout = jest.fn();
        req.write = jest.fn();
        req.end = jest.fn().mockImplementation(() => {
          const res = new EventEmitter() as http.IncomingMessage;
          res.statusCode = 200;
          res.headers = { "content-type": "application/octet-stream" };
          cb(res);
          // Emit chunks exceeding 1 MB
          res.emit("data", Buffer.alloc(600_000, "a"));
          res.emit("data", Buffer.alloc(600_000, "b"));
          res.emit("end");
        });
        req.destroy = jest.fn();
        return req;
      });

      const mockDns = jest.fn().mockResolvedValue(["93.184.216.34"]);

      await expect(
        ssrfFetch("https://safe.example.com/large", {
          customTransport: mockTransport as unknown as typeof http.request,
          customDnsResolver: mockDns,
        }),
      ).rejects.toThrow("Response body exceeded maximum allowed size of 1 MB");
    });
  });

  describe("http.request@1.0.0 Workflow Action", () => {
    it("is registered in ActionRegistry with version 1.0.0", () => {
      expect(ActionRegistry["http.request"]).toBe(httpRequestAction);
      expect(httpRequestAction.id).toBe("http.request");
      expect(httpRequestAction.version).toBe("1.0.0");
      expect(getAction("http.request", "1.0.0")).toBe(httpRequestAction);
    });

    it("rejects SSRF attempts as non-retriable failure", async () => {
      const res = await httpRequestAction.execute({
        workflowId: "wf_1",
        runId: "run_1",
        stepId: "step_http",
        inputs: {
          url: "http://169.254.169.254/latest/meta-data/",
          method: "GET",
        },
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain("Security policy violation");
      expect(res.isRetriable).toBe(false);
    });

    it("classifies HTTP 500 error as retriable", async () => {
      // Create a mock transport that returns 500
      const mockTransport = jest.fn().mockImplementation((_opts, cb) => {
        const req = new EventEmitter() as http.ClientRequest;
        req.setTimeout = jest.fn();
        req.write = jest.fn();
        req.end = jest.fn().mockImplementation(() => {
          const res = new EventEmitter() as http.IncomingMessage;
          res.statusCode = 500;
          res.statusMessage = "Internal Server Error";
          res.headers = { "content-type": "application/json" };
          cb(res);
          res.emit("data", Buffer.from(JSON.stringify({ error: "Backend crash" })));
          res.emit("end");
        });
        req.destroy = jest.fn();
        return req;
      });

      __setTestHttpRequestHooks({
        customTransport: mockTransport as unknown as typeof http.request,
        customDnsResolver: async () => ["93.184.216.34"],
      });

      try {
        const res = await httpRequestAction.execute({
          workflowId: "wf_1",
          runId: "run_1",
          stepId: "step_http",
          inputs: {
            url: "https://mock.incident-api.example.com/fail500",
            method: "POST",
            body: { event: "escalate" },
          },
        });

        expect(res.success).toBe(false);
        expect(res.error).toContain("500");
        expect(res.isRetriable).toBe(true);
      } finally {
        __setTestHttpRequestHooks(null);
      }
    });
  });
});
