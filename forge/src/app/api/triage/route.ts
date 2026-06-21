// src/app/api/triage/route.ts
import { generateObject } from 'ai';
import { googleProvider } from '@/lib/ai/provider';
import { triageSchema } from '@/lib/ai/schemas';
import { prisma } from '@/lib/prisma/extended';

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const rawBugReport =
      typeof body.rawBugReport === 'string' ? body.rawBugReport.trim() : '';

const projectId =
  typeof body.projectId === 'string' ? body.projectId.trim() : '';

if (!projectId) {
  return Response.json(
    { error: 'projectId is required.' },
    { status: 400 }
  );
}

    // Validate incoming request data before calling the model.
    if (!rawBugReport) {
      return Response.json(
        { error: 'rawBugReport is required.' },
        { status: 400 }
      );
    }

    const result = await generateObject({
      model: googleProvider('gemini-2.5-flash'),
      schema: triageSchema,
      system:
        'You are an automated issue-triage service. Extract metadata only from the submitted bug report. Do not invent details that are unsupported by the report.',
      prompt: rawBugReport,
      temperature: 0,
    });

    const structuredIssue = result.object;

const priorityMap = {
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
  critical: 'HIGH',
} as const;

const savedTask = await prisma.task.create({
  data: {
    title: `Automated Triage: ${structuredIssue.affectedComponent}`,
    description: rawBugReport,
    priority: priorityMap[structuredIssue.severity],
    projectId,
  },
});

    return Response.json(
      {
        success: true,
        data: savedTask,
        extracted: structuredIssue,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('Triage extraction failed:', error);

    return Response.json(
      { error: 'Failed to parse and save issue.' },
      { status: 500 }
    );
  }
}