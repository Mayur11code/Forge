import { ExecuteFunction, WorkflowAction } from "../../../workflow-types/type";
import { executeSendEmail } from "@/lib/emails/core-service";

const execute: ExecuteFunction = async (ctx) => {
  try {
    const { toEmail, subject, bodyText, attachmentUrl, attachmentName } = ctx.inputs;

    if (!toEmail || !subject) {
      return { success: false, error: "Missing required fields", isRetriable: false };
    }

    const htmlTemplate = `
      <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #f9f9f9;">
        <h2 style="color: #333;">${subject}</h2>
        <p style="color: #555; font-size: 16px;">${bodyText}</p>
      </div>
    `;

    // CALL THE SHARED CORE
    const result = await executeSendEmail({
      to: toEmail,
      subject,
      html: htmlTemplate,
      attachmentUrl,
      attachmentName
    });

    return { success: true, data: { resendId: result.id, deliveredTo: result.deliveredTo } };

  } catch (error: any) {
    return {
      success: false,
      error: error.message,
      isRetriable: error.name !== 'validation_error', 
    };
  }
};

export const sendEmailAction: WorkflowAction = {
  id: "communication.send_email",
  execute,
};