// src/lib/workflow/actions/utils/generate-report.ts
import { ExecuteFunction, CompensateFunction, WorkflowAction } from "../../../workflow-types/type";
import { utapi } from "@/lib/uploadThing/uploadthing-server";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

const execute: ExecuteFunction = async (ctx) => {
  try {
    // 1. Inputs are perfectly resolved by the engine
    const { userName, templateId } = ctx.inputs;

    // Narrowed rather than merely truthiness-checked: `userName` is
    // interpolated into a filename and slugified below, so a non-string here
    // would throw on `.replace` instead of failing as a config error.
    if (typeof userName !== "string") {
      return {
        success: false,
        error: "Missing required field: userName",
        isRetriable: false // Bad user config
      };
    }

    console.log(`[ACTION: utils.generate_report] Generating heavy payload for user "${userName}"...`);

    // 2. GENERATE THE HEAVY DATA (The Coat)
    // Simulating a heavy text/CSV/PDF generation
    const reportContent = `CONFIDENTIAL REPORT\nGenerated for: ${userName}\nTemplate: ${templateId ?? 'default'}\n\n` + "DATA... ".repeat(5000);

    const fileName = `report-${userName.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}.txt`;
    const file = new File([reportContent], fileName, {
      type: "text/plain",
    });

    console.log(`[ACTION: utils.generate_report] Uploading ${fileName} to UploadThing...`);

    // 3. THE COAT CHECK (Network I/O)
    const uploadResult = await utapi.uploadFiles(file);

    if (uploadResult.error) {
      return { 
        success: false, 
        error: `UploadThing Error: ${uploadResult.error.message}`, 
        isRetriable: true // Network/API errors should trigger exponential backoff
      };
    }

    // 4. RETURN THE TICKET
    // We return the URL for downstream nodes, AND the file key for the compensate function.
    return {
      success: true,
      data: { 
        documentUrl: uploadResult.data.url, 
        fileKey: uploadResult.data.key, // CRITICAL: Saved to historical outputs for rollbacks!
        fileName: uploadResult.data.name,
        sizeBytes: uploadResult.data.size
      } 
    };

  } catch (error) {
    return {
      success: false,
      error: errorMessage(error, "Failed to generate or upload report"),
      isRetriable: true
    };
  }
};

const compensate: CompensateFunction = async (ctx) => {
  try {
    // 1. Pull the exact historical output from the forward execution.
    // `outputs` is whatever the forward step wrote into the run context, so it
    // is narrowed to an object with a string `fileKey` rather than destructured
    // blindly - a compensated step whose outputs were truncated or re-serialised
    // must skip cleanly, not delete an unrelated file.
    const outputs = ctx.outputs;
    const fileKey =
      typeof outputs === "object" &&
      outputs !== null &&
      !Array.isArray(outputs) &&
      typeof outputs.fileKey === "string"
        ? outputs.fileKey
        : undefined;

    if (!fileKey) {
      console.warn(`[ACTION: utils.generate_report] No fileKey found in outputs. Skipping compensation.`);
      return { success: true }; // Nothing to delete
    }

    console.log(`[ACTION: utils.generate_report] ROLLING BACK: Deleting file ${fileKey} from UploadThing...`);

    // 2. Destroy the orphaned artifact
    const deleteResult = await utapi.deleteFiles(fileKey);

    if (!deleteResult.success) {
      // If UploadThing fails to delete it, we trigger a DEAD LETTER so a human can clean it up
      return {
        success: false,
        error: "UploadThing failed to delete the artifact during rollback",
        isRetriable: true
      };
    }

    return { success: true };

  } catch (error) {
    return {
      success: false,
      error: errorMessage(error, "Fatal error during compensation"),
      isRetriable: true
    };
  }
};

// Export the fully formed action object
export const generateReportAction: WorkflowAction = {
  id: "utils.generate_report",
  execute,
  compensate,
};