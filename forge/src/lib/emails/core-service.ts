import { resend } from "@/lib/emails/email";

interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  attachmentUrl?: string;
  attachmentName?: string;
}

type EmailAttachment = {
  filename: string;
  content: Buffer;
};

export async function executeSendEmail({ to, subject, html, attachmentUrl, attachmentName }: SendEmailParams) {
  // `const`, not `let`: the array is only ever mutated in place, so a
  // reassignment could never be intended. Annotated because an unannotated
  // `const x = []` infers `never[]` rather than an array of the shape pushed
  // below, which is how the element type gets quietly lost.
  const emailAttachments: EmailAttachment[] = [];

  // 1. Process Claim Check
  if (attachmentUrl) {
    const response = await fetch(attachmentUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    
    emailAttachments.push({
      filename: attachmentName || "attachment.pdf",
      content: Buffer.from(arrayBuffer),
    });
  }

  // 2. Send via Resend
  const { data, error } = await resend.emails.send({
    from: "onboarding@resend.dev",
    to,
    subject,
    html,
    attachments: emailAttachments.length > 0 ? emailAttachments : undefined,
  });

  if (error) throw error;
  
  return { id: data?.id, deliveredTo: to };
}