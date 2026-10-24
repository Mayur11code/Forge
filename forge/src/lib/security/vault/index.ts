import "server-only";

export {
  encryptCredential,
  decryptCredential,
  resolveVaultKey,
  parseVaultKey,
  deriveKeyBuffer,
  buildVaultAAD,
  VaultConfigurationError,
  VaultEncryptionError,
  VaultDecryptionError,
  type EncryptionContext,
  type EncryptedPayload,
} from "./encryption";

export {
  storeOrganizationCredential,
  getOrganizationCredentialMetadata,
  listOrganizationCredentials,
  getDecryptedOrganizationCredential,
  updateCredentialStatus,
  recordCredentialUsage,
  deleteOrganizationCredential,
  VaultStatusError,
  safeCredentialSelect,
  type OrganizationCredentialMetadata,
  type StoreCredentialInput,
  type DecryptedCredentialResult,
} from "./service";
