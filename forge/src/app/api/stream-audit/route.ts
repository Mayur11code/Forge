// src/app/api/stream-audit/route.ts
import { streamText, Output } from 'ai';
import { googleProvider } from '@/lib/ai/provider';
import { architectureReportSchema } from '@/lib/ai/schemas';

export const runtime = 'edge';

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const rawCodePayload =
      typeof body.rawCodePayload === 'string'
        ? body.rawCodePayload.trim()
        : '';

    if (!rawCodePayload) {
      return Response.json(
        { error: 'rawCodePayload is required.' },
        { status: 400 }
      );
    }

    const result = streamText({
      model: googleProvider('gemini-2.5-flash'),
      output: Output.object({
        schema: architectureReportSchema,
      }),
      system:
        'You are a senior software architect. Analyze only the supplied code or technical context. Identify concrete architecture, security, scalability, and maintainability risks. Do not invent files or vulnerabilities unsupported by the input.',
      prompt: rawCodePayload,
      temperature: 0.1,
    });

    return result.toTextStreamResponse();
  } catch (error) {
    console.error('Stream audit failed:', error);

    return Response.json(
      { error: 'Audit failed.' },
      { status: 500 }
    );
  }
}