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
  stageAndActivateCredential,
  revokeOrganizationCredential,
  getOrganizationCredentialMetadata,
  listOrganizationCredentials,
  getDecryptedOrganizationCredential,
  updateCredentialStatus,
  recordCredentialUsage,
  deleteOrganizationCredential,
  VaultStatusError,
  VaultValidationError,
  VaultConcurrencyError,
  safeCredentialSelect,
  type OrganizationCredentialMetadata,
  type StoreCredentialInput,
  type StageAndActivateInput,
  type DecryptedCredentialResult,
} from "./service";

export {
  resolveOrganizationAiPolicy,
  type OrganizationAiPolicy,
  type PolicyResolverOptions,
} from "./policy";

export {
  validateGeminiKey,
  classifyGeminiValidationError,
  VALIDATION_MODELS,
  type ValidationCategory,
  type KeyValidationResult,
  type ValidateKeyOptions,
} from "./validation";
