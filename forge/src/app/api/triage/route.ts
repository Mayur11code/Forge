// src/app/api/triage/route.ts
import { generateObject } from 'ai';
import { googleProvider } from '@/lib/ai/provider';
import { triageSchema } from '@/lib/ai/schemas';
import { prisma } from '@/lib/prisma/extended';
import { auth } from '@/lib/auth/auth';
import { getOrgAccess } from '@/features/organizations/getOrgAccess';
import { createTaskInOrg } from '@/lib/tasks/create-task';

export async function POST(req: Request) {
  try {
    // 1. Trusted identity. The task write is authorized, so the caller must be
    //    an authenticated user.
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
      return Response.json(
        { error: 'Unauthorized.' },
        { status: 401 }
      );
    }

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

    // 2. projectId is UNTRUSTED (it came off the request body). Resolve the
    //    owning organization from it, then confirm this user may act there.
    const project = await prisma.project.findFirst({
      where: { id: projectId },
      select: { id: true, orgId: true, organization: { select: { slug: true } } },
    });

    if (!project) {
      return Response.json(
        { error: 'Project not found.' },
        { status: 404 }
      );
    }

    const access = await getOrgAccess(project.organization.slug);

    if (!access) {
      return Response.json(
        { error: 'You do not have access to this organization.' },
        { status: 403 }
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

    // 3. Canonical task creation. The org comes from the project we just
    //    authorized against, never from the request body. The canonical
    //    operation re-verifies project ownership and fires the TASK_CREATED CDC.
    const created = await createTaskInOrg(
      {
        title: `Automated Triage: ${structuredIssue.affectedComponent}`.slice(0, 100),
        description: rawBugReport,
        priority: priorityMap[structuredIssue.severity],
        projectId,
      },
      {
        orgId: project.orgId,
        userId,
      }
    );

    if (!created.success) {
      return Response.json(
        { error: created.error, code: created.code },
        { status: 400 }
      );
    }

    return Response.json(
      {
        success: true,
        data: created.task,
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
