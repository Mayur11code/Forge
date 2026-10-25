"use client";

import { useState, useTransition } from "react";
import { CredentialPurpose, type CredentialStatus } from "@prisma/client";
import {
  saveOrgApiKeyAction,
  revokeOrgApiKeyAction,
  deleteOrgApiKeyAction,
} from "@/app/actions/settings/apiKeyActions";
import type { OrganizationCredentialMetadata } from "@/lib/security/vault";
import {
  Key,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  Trash2,
  Ban,
  Sparkles,
  Database,
} from "lucide-react";

interface ApiKeyManagementCardProps {
  orgId: string;
  orgSlug: string;
  role: "ADMIN" | "MEMBER" | "MANAGER";
  initialKeys: OrganizationCredentialMetadata[];
}

export default function ApiKeyManagementCard({
  orgId,
  role,
  initialKeys,
}: ApiKeyManagementCardProps) {
  const [keys, setKeys] = useState<OrganizationCredentialMetadata[]>(initialKeys);
  const [generationKeyInput, setGenerationKeyInput] = useState("");
  const [embeddingKeyInput, setEmbeddingKeyInput] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [activeSlot, setActiveSlot] = useState<CredentialPurpose | null>(null);

  const isAdmin = role === "ADMIN";

  const getKeyForPurpose = (purpose: CredentialPurpose) => {
    return keys.find((k) => k.purpose === purpose) || null;
  };

  const handleSaveKey = (purpose: CredentialPurpose) => {
    const rawKey = purpose === CredentialPurpose.GENERATION ? generationKeyInput : embeddingKeyInput;
    if (!rawKey.trim()) return;

    setErrorMessage(null);
    setSuccessMessage(null);
    setActiveSlot(purpose);

    startTransition(async () => {
      try {
        const result = await saveOrgApiKeyAction({
          orgId,
          purpose,
          apiKey: rawKey.trim(),
        });

        // Always clear client-side plaintext key immediately
        if (purpose === CredentialPurpose.GENERATION) {
          setGenerationKeyInput("");
        } else {
          setEmbeddingKeyInput("");
        }

        if (result.success && result.data) {
          const updatedMeta = result.data.metadata;
          setKeys((prev) => [
            ...prev.filter((k) => k.purpose !== purpose),
            updatedMeta,
          ]);
          setSuccessMessage(
            `Successfully validated and activated ${purpose.toLowerCase()} key (tested with Google Gemini).`
          );
        } else {
          setErrorMessage(
            result.error || "Failed to validate candidate key. Your previous key remains active."
          );
        }
      } catch (err) {
        setErrorMessage(
          err instanceof Error ? err.message : "An unexpected error occurred during key validation."
        );
      } finally {
        setActiveSlot(null);
      }
    });
  };

  const handleRevokeKey = (purpose: CredentialPurpose) => {
    if (!confirm(`Are you sure you want to revoke the ${purpose.toLowerCase()} key? AI requests for this purpose will stop using this key.`)) {
      return;
    }

    setErrorMessage(null);
    setSuccessMessage(null);
    setActiveSlot(purpose);

    startTransition(async () => {
      try {
        const result = await revokeOrgApiKeyAction({ orgId, purpose });
        if (result.success && result.data) {
          const updatedMeta = result.data;
          setKeys((prev) => [
            ...prev.filter((k) => k.purpose !== purpose),
            updatedMeta,
          ]);
          setSuccessMessage(`Successfully revoked ${purpose.toLowerCase()} key.`);
        } else {
          setErrorMessage(result.error || "Failed to revoke key.");
        }
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "Failed to revoke key.");
      } finally {
        setActiveSlot(null);
      }
    });
  };

  const handleDeleteKey = (purpose: CredentialPurpose) => {
    if (!confirm(`Permanently remove this ${purpose.toLowerCase()} key from the vault?`)) {
      return;
    }

    setErrorMessage(null);
    setSuccessMessage(null);
    setActiveSlot(purpose);

    startTransition(async () => {
      try {
        const result = await deleteOrgApiKeyAction({ orgId, purpose });
        if (result.success) {
          setKeys((prev) => prev.filter((k) => k.purpose !== purpose));
          setSuccessMessage(`Successfully removed ${purpose.toLowerCase()} key from vault.`);
        } else {
          setErrorMessage(result.error || "Failed to remove key.");
        }
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "Failed to remove key.");
      } finally {
        setActiveSlot(null);
      }
    });
  };

  const renderStatusBadge = (status: CredentialStatus | "NOT_CONFIGURED") => {
    switch (status) {
      case "ACTIVE":
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 border border-emerald-200">
            <CheckCircle2 className="h-3 w-3" /> Active
          </span>
        );
      case "PENDING_VALIDATION":
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700 border border-amber-200">
            <Clock className="h-3 w-3" /> Pending Validation
          </span>
        );
      case "INVALID":
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-50 px-2.5 py-0.5 text-xs font-medium text-rose-700 border border-rose-200">
            <XCircle className="h-3 w-3" /> Invalid
          </span>
        );
      case "REVOKED":
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-600 border border-zinc-200">
            <Ban className="h-3 w-3" /> Revoked
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600 border border-slate-200">
            Not Configured
          </span>
        );
    }
  };

  const renderSlot = (
    purpose: CredentialPurpose,
    title: string,
    description: string,
    icon: React.ReactNode,
    value: string,
    setValue: (val: string) => void
  ) => {
    const cred = getKeyForPurpose(purpose);
    const isSlotBusy = isPending && activeSlot === purpose;

    return (
      <div className="p-6">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-100 text-zinc-700 border border-zinc-200">
              {icon}
            </div>
            <div>
              <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
              <p className="text-xs text-zinc-500 mt-0.5">{description}</p>
            </div>
          </div>
          <div>{renderStatusBadge(cred?.status ?? "NOT_CONFIGURED")}</div>
        </div>

        {cred ? (
          <div className="mt-4 rounded-lg bg-zinc-50 border border-zinc-200 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-mono text-zinc-700 font-medium">
                  ••••••••••••{cred.last4}
                </span>
                <span className="text-zinc-400">|</span>
                <span className="text-zinc-500">Key Version: {cred.keyVersion}</span>
              </div>
              <div className="flex items-center gap-3">
                {cred.lastValidatedAt && (
                  <span className="text-zinc-500">
                    Validated: {new Date(cred.lastValidatedAt).toLocaleDateString()}
                  </span>
                )}
                {isAdmin && (
                  <div className="flex items-center gap-2">
                    {cred.status === "ACTIVE" && (
                      <button
                        type="button"
                        onClick={() => handleRevokeKey(purpose)}
                        disabled={isSlotBusy}
                        className="inline-flex items-center gap-1 text-amber-600 hover:text-amber-700 font-medium text-xs disabled:opacity-50"
                      >
                        <Ban className="h-3 w-3" /> Revoke
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleDeleteKey(purpose)}
                      disabled={isSlotBusy}
                      className="inline-flex items-center gap-1 text-rose-600 hover:text-rose-700 font-medium text-xs disabled:opacity-50"
                    >
                      <Trash2 className="h-3 w-3" /> Remove
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <p className="mt-3 text-xs text-zinc-500 italic">
            No organization credential configured. Fallback to platform keys depends on subscription policy.
          </p>
        )}

        {isAdmin && (
          <div className="mt-4">
            <label
              htmlFor={`input-${purpose}`}
              className="block text-xs font-medium text-zinc-700 mb-1.5"
            >
              {cred ? `Replace ${title} (Safe Staged Validation)` : `Configure ${title}`}
            </label>
            <div className="flex gap-2">
              <input
                id={`input-${purpose}`}
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={cred ? "Enter new candidate API key to replace..." : "AIzaSy..."}
                disabled={isSlotBusy}
                className="flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm font-mono placeholder:font-sans placeholder:text-zinc-400 focus:border-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900 disabled:bg-zinc-50 disabled:text-zinc-500"
              />
              <button
                type="button"
                onClick={() => handleSaveKey(purpose)}
                disabled={isSlotBusy || !value.trim()}
                className="inline-flex items-center justify-center rounded-lg bg-zinc-900 px-4 py-2 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 transition-colors"
              >
                {isSlotBusy ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    Validating...
                  </>
                ) : (
                  "Validate & Save"
                )}
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-zinc-500">
              Candidate keys are validated against Google before activation. If validation fails, your existing active key remains intact.
            </p>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="max-w-2xl overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm mt-6">
      {/* Header */}
      <div className="border-b border-zinc-100 bg-zinc-50/50 p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Key className="h-5 w-5 text-zinc-700" />
            <h2 className="text-xl font-semibold tracking-tight text-zinc-900">
              AI Provider Credentials (BYOK)
            </h2>
          </div>
          <span className="inline-flex items-center gap-1 rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" /> AES-256-GCM Vault
          </span>
        </div>
        <p className="mt-1 text-sm text-zinc-500">
          Bring your own Google Gemini credentials for organization-scoped text generation and semantic embeddings.
        </p>
        {!isAdmin && (
          <div className="mt-3 flex items-center gap-2 rounded-lg bg-amber-50 border border-amber-200 p-2.5 text-xs text-amber-800">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
            <span>Only organization administrators have permission to manage AI credentials.</span>
          </div>
        )}
      </div>

      {/* Notifications */}
      {errorMessage && (
        <div className="border-b border-rose-100 bg-rose-50 p-4 text-xs text-rose-800 flex items-start gap-2">
          <XCircle className="h-4 w-4 shrink-0 text-rose-600 mt-0.5" />
          <div className="flex-1 font-medium">{errorMessage}</div>
        </div>
      )}
      {successMessage && (
        <div className="border-b border-emerald-100 bg-emerald-50 p-4 text-xs text-emerald-800 flex items-start gap-2">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 mt-0.5" />
          <div className="flex-1 font-medium">{successMessage}</div>
        </div>
      )}

      {/* Slots */}
      <div className="divide-y divide-zinc-100">
        {renderSlot(
          CredentialPurpose.GENERATION,
          "Text Generation Key",
          "Used for chat completions, triage categorization, and agent workflow reasoning.",
          <Sparkles className="h-5 w-5" />,
          generationKeyInput,
          setGenerationKeyInput
        )}

        {renderSlot(
          CredentialPurpose.EMBEDDING,
          "Vector Embedding Key",
          "Used for document chunking, semantic retrieval, and vector search embeddings.",
          <Database className="h-5 w-5" />,
          embeddingKeyInput,
          setEmbeddingKeyInput
        )}
      </div>
    </div>
  );
}
