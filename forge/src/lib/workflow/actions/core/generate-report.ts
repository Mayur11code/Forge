// src/lib/workflow/actions/utils/generate-report.ts
import { ExecuteFunction, CompensateFunction, WorkflowAction } from "../../../workflow-types/type";
import { utapi } from "@/lib/uploadThing/uploadthing-server";

const execute: ExecuteFunction = async (ctx) => {
  try {
    // 1. Inputs are perfectly resolved by the engine
    const { userName, templateId } = ctx.inputs;

    if (!userName) {
      return { 
        success: false, 
        error: "Missing required field: userName", 
        isRetriable: false // Bad user config
      };
    }

    console.log(`[ACTION: utils.generate_report] Generating heavy payload for user "${userName}"...`);

    // 2. GENERATE THE HEAVY DATA (The Coat)
    // Simulating a heavy text/CSV/PDF generation
    const reportContent = `CONFIDENTIAL REPORT\nGenerated for: ${userName}\nTemplate: ${templateId || 'default'}\n\n` + "DATA... ".repeat(5000);
    
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

  } catch (error: any) {
    return {
      success: false,
      error: error.message || "Failed to generate or upload report",
      isRetriable: true 
    };
  }
};

const compensate: CompensateFunction = async (ctx) => {
  try {
    // 1. Pull the exact historical output from the forward execution
    const { fileKey, documentUrl } = ctx.outputs;

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

  } catch (error: any) {
    return {
      success: false,
      error: error.message || "Fatal error during compensation",
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