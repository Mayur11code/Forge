import {
  encryptCredential,
  decryptCredential,
  parseVaultKey,
  deriveKeyBuffer,
  resolveVaultKey,
  VaultEncryptionError,
  VaultDecryptionError,
  VaultConfigurationError,
} from "@/lib/security/vault/encryption";
import crypto from "crypto";

describe("BYOK Phase 1.1 — Hardened Vault Key Material & Strict Validation", () => {
  // Test vectors: 32 bytes of deterministic test key material
  const testKeyBytes = Buffer.from(
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "hex"
  );
  const testHexKey = testKeyBytes.toString("hex"); // 64 hex characters
  const testBase64Key = testKeyBytes.toString("base64"); // 44 base64 characters

  const testKeyV2Hex = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
  const testKeyV2B64 = Buffer.from(testKeyV2Hex, "hex").toString("base64");

  const overrideKeyring = {
    v1: testHexKey,
    v2: testKeyV2Hex,
  };

  const sampleContext = {
    orgId: "org_test_12345",
    provider: "GEMINI",
    purpose: "GENERATION",
    keyVersion: "v1",
  };

  const samplePlaintext = "AIzaSyTestApiKeyForVerification1234567890";

  describe("Strict Key Validation & Encodings", () => {
    it("accepts valid 64-character hexadecimal keys and parses to 32 bytes", () => {
      const buf = parseVaultKey(testHexKey);
      expect(buf).toBeInstanceOf(Buffer);
      expect(buf.length).toBe(32);
      expect(buf.equals(testKeyBytes)).toBe(true);
    });

    it("accepts valid 44-character Base64 keys decoding to 32 bytes", () => {
      const buf = parseVaultKey(testBase64Key);
      expect(buf).toBeInstanceOf(Buffer);
      expect(buf.length).toBe(32);
      expect(buf.equals(testKeyBytes)).toBe(true);
    });

    it("accepts valid Base64URL keys decoding to 32 bytes", () => {
      const b64urlKey = testKeyBytes.toString("base64url");
      const buf = parseVaultKey(b64urlKey);
      expect(buf).toBeInstanceOf(Buffer);
      expect(buf.length).toBe(32);
      expect(buf.equals(testKeyBytes)).toBe(true);
    });

    it("ensures equivalent Hex and Base64 representations yield identical 32-byte key material", () => {
      const bufHex = parseVaultKey(testHexKey);
      const bufB64 = parseVaultKey(testBase64Key);
      expect(bufHex.equals(bufB64)).toBe(true);
    });

    it("allows cross-encoding decryption (encrypted with Hex, decrypted with Base64)", () => {
      const encWithHex = encryptCredential(samplePlaintext, sampleContext, { v1: testHexKey });
      const decWithB64 = decryptCredential(encWithHex, sampleContext, { v1: testBase64Key });
      expect(decWithB64).toBe(samplePlaintext);
    });

    it("supports backward-compatible deriveKeyBuffer export", () => {
      const buf = deriveKeyBuffer(testHexKey);
      expect(buf.length).toBe(32);
      expect(buf.equals(testKeyBytes)).toBe(true);
    });
  });

  describe("Strict Rejection of Weak, Ambiguous, or Malformed Key Material", () => {
    it("strictly rejects arbitrary passphrases without silent hashing", () => {
      expect(() => parseVaultKey("a-very-long-secure-passphrase-for-testing")).toThrow(
        VaultConfigurationError
      );
      expect(() => parseVaultKey("another-plain-text-passphrase-123456")).toThrow(
        VaultConfigurationError
      );
    });

    it("strictly rejects raw 32-character UTF-8 strings", () => {
      expect(() => parseVaultKey("12345678901234567890123456789012")).toThrow(
        VaultConfigurationError
      );
    });

    it("strictly rejects short or empty strings", () => {
      expect(() => parseVaultKey("")).toThrow(VaultConfigurationError);
      expect(() => parseVaultKey("short-secret")).toThrow(VaultConfigurationError);
    });

    it("strictly rejects hex keys of invalid length", () => {
      // 63 characters
      expect(() => parseVaultKey(testHexKey.slice(0, 63))).toThrow(VaultConfigurationError);
      // 65 characters
      expect(() => parseVaultKey(testHexKey + "a")).toThrow(VaultConfigurationError);
    });

    it("strictly rejects 64-character strings containing non-hex characters", () => {
      const invalidHex = testHexKey.slice(0, 63) + "Z";
      expect(() => parseVaultKey(invalidHex)).toThrow(VaultConfigurationError);
    });

    it("strictly rejects Base64 keys that decode to invalid byte lengths", () => {
      // 16 bytes base64 = 24 chars
      const b64_16bytes = crypto.randomBytes(16).toString("base64");
      expect(() => parseVaultKey(b64_16bytes)).toThrow(VaultConfigurationError);

      // 24 bytes base64 = 32 chars
      const b64_24bytes = crypto.randomBytes(24).toString("base64");
      expect(() => parseVaultKey(b64_24bytes)).toThrow(VaultConfigurationError);
    });

    it("strictly rejects malformed Base64 characters", () => {
      const invalidB64 = testBase64Key.slice(0, 42) + "!?";
      expect(() => parseVaultKey(invalidB64)).toThrow(VaultConfigurationError);
    });
  });

  describe("Keyring Resolution & Historical Validation", () => {
    it("resolves key from overrideKeyring for specified version", () => {
      const { keyBuffer, resolvedVersion } = resolveVaultKey("v2", overrideKeyring);
      expect(resolvedVersion).toBe("v2");
      expect(keyBuffer.length).toBe(32);
    });

    it("fails closed when requested key version is missing in keyring", () => {
      expect(() => resolveVaultKey("v99", overrideKeyring)).toThrow(VaultConfigurationError);
    });

    it("strictly validates historical keys in keyring and refuses fallback", () => {
      const corruptedKeyring = {
        v1: testHexKey,
        v0: "invalid-historical-passphrase", // Invalid key material
      };

      // v1 resolves fine
      expect(resolveVaultKey("v1", corruptedKeyring).resolvedVersion).toBe("v1");

      // v0 MUST fail with VaultConfigurationError and MUST NOT fall back to v1
      expect(() => resolveVaultKey("v0", corruptedKeyring)).toThrow(VaultConfigurationError);
    });

    it("resolves keys across mixed valid Hex and Base64 versions", () => {
      const mixedKeyring = {
        v1: testHexKey,
        v2: testKeyV2B64,
      };

      const v1 = resolveVaultKey("v1", mixedKeyring);
      const v2 = resolveVaultKey("v2", mixedKeyring);

      expect(v1.keyBuffer.length).toBe(32);
      expect(v2.keyBuffer.length).toBe(32);
      expect(v1.resolvedVersion).toBe("v1");
      expect(v2.resolvedVersion).toBe("v2");
    });
  });

  describe("Encrypt/Decrypt Round-Trip", () => {
    it("successfully encrypts and decrypts a credential", () => {
      const encrypted = encryptCredential(samplePlaintext, sampleContext, overrideKeyring);
      expect(encrypted.encryptedKey).toBeDefined();
      expect(encrypted.keyIv).toHaveLength(24); // 12 bytes = 24 hex chars
      expect(encrypted.keyAuthTag).toHaveLength(32); // 16 bytes = 32 hex chars
      expect(encrypted.keyVersion).toBe("v1");

      const decrypted = decryptCredential(encrypted, sampleContext, overrideKeyring);
      expect(decrypted).toBe(samplePlaintext);
    });

    it("generates distinct nonces (IVs) for repeated encryptions of identical plaintext", () => {
      const enc1 = encryptCredential(samplePlaintext, sampleContext, overrideKeyring);
      const enc2 = encryptCredential(samplePlaintext, sampleContext, overrideKeyring);

      expect(enc1.keyIv).not.toBe(enc2.keyIv);
      expect(enc1.encryptedKey).not.toBe(enc2.encryptedKey);

      expect(decryptCredential(enc1, sampleContext, overrideKeyring)).toBe(samplePlaintext);
      expect(decryptCredential(enc2, sampleContext, overrideKeyring)).toBe(samplePlaintext);
    });
  });

  describe("Tampering and Context Mismatch Detection (AAD)", () => {
    it("fails closed when ciphertext is modified", () => {
      const encrypted = encryptCredential(samplePlaintext, sampleContext, overrideKeyring);
      const lastChar = encrypted.encryptedKey.slice(-1);
      const flipped = lastChar === "0" ? "1" : "0";
      const tamperedCiphertext = encrypted.encryptedKey.slice(0, -1) + flipped;

      expect(() =>
        decryptCredential(
          { ...encrypted, encryptedKey: tamperedCiphertext },
          sampleContext,
          overrideKeyring
        )
      ).toThrow(VaultDecryptionError);
    });

    it("fails closed when authentication tag is modified", () => {
      const encrypted = encryptCredential(samplePlaintext, sampleContext, overrideKeyring);
      const lastChar = encrypted.keyAuthTag.slice(-1);
      const flipped = lastChar === "0" ? "1" : "0";
      const tamperedTag = encrypted.keyAuthTag.slice(0, -1) + flipped;

      expect(() =>
        decryptCredential(
          { ...encrypted, keyAuthTag: tamperedTag },
          sampleContext,
          overrideKeyring
        )
      ).toThrow(VaultDecryptionError);
    });

    it("fails closed when organization ID does not match AAD", () => {
      const encrypted = encryptCredential(samplePlaintext, sampleContext, overrideKeyring);

      expect(() =>
        decryptCredential(
          encrypted,
          { ...sampleContext, orgId: "attacker_org_999" },
          overrideKeyring
        )
      ).toThrow(VaultDecryptionError);
    });

    it("fails closed when provider does not match AAD", () => {
      const encrypted = encryptCredential(samplePlaintext, sampleContext, overrideKeyring);

      expect(() =>
        decryptCredential(
          encrypted,
          { ...sampleContext, provider: "OPENAI" },
          overrideKeyring
        )
      ).toThrow(VaultDecryptionError);
    });

    it("fails closed when purpose does not match AAD", () => {
      const encrypted = encryptCredential(samplePlaintext, sampleContext, overrideKeyring);

      expect(() =>
        decryptCredential(
          encrypted,
          { ...sampleContext, purpose: "EMBEDDING" },
          overrideKeyring
        )
      ).toThrow(VaultDecryptionError);
    });

    it("fails closed when key version does not match AAD", () => {
      const encrypted = encryptCredential(samplePlaintext, sampleContext, overrideKeyring);

      expect(() =>
        decryptCredential(
          { ...encrypted, keyVersion: "v2" },
          sampleContext,
          overrideKeyring
        )
      ).toThrow(VaultDecryptionError);
    });
  });

  describe("Malformed Envelope and Boundary Rejection", () => {
    it("rejects non-hex or invalid-length IVs", () => {
      const encrypted = encryptCredential(samplePlaintext, sampleContext, overrideKeyring);

      expect(() =>
        decryptCredential(
          { ...encrypted, keyIv: "tooshort" },
          sampleContext,
          overrideKeyring
        )
      ).toThrow(VaultDecryptionError);

      expect(() =>
        decryptCredential(
          { ...encrypted, keyIv: "zzzzzzzzzzzzzzzzzzzzzzzz" },
          sampleContext,
          overrideKeyring
        )
      ).toThrow(VaultDecryptionError);
    });

    it("rejects non-hex or invalid-length AuthTags", () => {
      const encrypted = encryptCredential(samplePlaintext, sampleContext, overrideKeyring);

      expect(() =>
        decryptCredential(
          { ...encrypted, keyAuthTag: "tag-too-short" },
          sampleContext,
          overrideKeyring
        )
      ).toThrow(VaultDecryptionError);
    });

    it("rejects empty or whitespace-only plaintext on encryption", () => {
      expect(() => encryptCredential("", sampleContext, overrideKeyring)).toThrow(VaultEncryptionError);
      expect(() => encryptCredential("   ", sampleContext, overrideKeyring)).toThrow(VaultEncryptionError);
    });
  });

  describe("Secret Masking in Diagnostic Errors", () => {
    it("does not disclose plaintext key or secret in thrown error messages", () => {
      const secretKey = "AIzaSySUPER_SECRET_KEY_1234567890";
      try {
        encryptCredential(secretKey, { orgId: "", provider: "GEMINI", purpose: "GENERATION" }, overrideKeyring);
        fail("Should have thrown VaultEncryptionError");
      } catch (err: unknown) {
        const message = (err as Error).message;
        expect(message).not.toContain(secretKey);
        expect(message).not.toContain("SUPER_SECRET_KEY");
      }
    });

    it("does not leak encryption keys or ciphertext in decryption failure errors", () => {
      const encrypted = encryptCredential(samplePlaintext, sampleContext, overrideKeyring);
      try {
        decryptCredential(
          { ...encrypted, encryptedKey: "0000" + encrypted.encryptedKey.slice(4) },
          sampleContext,
          overrideKeyring
        );
        fail("Should have thrown VaultDecryptionError");
      } catch (err: unknown) {
        const message = (err as Error).message;
        expect(message).not.toContain(testHexKey);
        expect(message).not.toContain(samplePlaintext);
        expect(message).toContain("Failed to authenticate or decrypt credential material");
      }
    });
  });
});
