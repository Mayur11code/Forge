import { ExecuteFunction, WorkflowAction } from "../../../workflow-types/type";
import { executeSendEmail } from "@/lib/emails/core-service";

/**
 * Inputs are resolved from arbitrary upstream step output, so they arrive typed
 * as `JsonValue` and every field is narrowed here. A workflow whose `to` or
 * `subject` pointer resolves to a number or an object is a configuration
 * error, and it should fail as one rather than being handed to the email client
 * and coerced into something plausible-looking.
 */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorName(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string"
    ? error.name
    : undefined;
}

const execute: ExecuteFunction = async (ctx) => {
  try {
    const { toEmail, subject, bodyText, attachmentUrl, attachmentName } = ctx.inputs;

    if (typeof toEmail !== "string" || typeof subject !== "string") {
      return { success: false, error: "Missing required fields", isRetriable: false };
    }

    const htmlTemplate = `
      <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #f9f9f9;">
        <h2 style="color: #333;">${subject}</h2>
        <p style="color: #555; font-size: 16px;">${bodyText ?? ""}</p>
      </div>
    `;

    // CALL THE SHARED CORE
    const result = await executeSendEmail({
      to: toEmail,
      subject,
      html: htmlTemplate,
      attachmentUrl: optionalString(attachmentUrl),
      attachmentName: optionalString(attachmentName),
    });

    // `?? null` rather than passing `result.id` through: Resend types `id` as
    // optional, and `undefined` is not representable in the JSONB column this
    // is written to. A missing id is genuinely "no id", not "absent key".
    return {
      success: true,
      data: { resendId: result.id ?? null, deliveredTo: result.deliveredTo },
    };

  } catch (error) {
    // Resend rejects a malformed address with a `validation_error`. Retrying
    // that is pointless and burns the step's retry budget, so it is the one
    // case marked non-retriable.
    const isValidationError = errorName(error) === "validation_error";

    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to send email",
      isRetriable: !isValidationError,
    };
  }
};

export const sendEmailAction: WorkflowAction = {
  id: "communication.send_email",
  execute,
};