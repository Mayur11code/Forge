// src/app/api/stream-audit/route.ts
import { streamText, Output } from 'ai';
import { resolveOrganizationLanguageModel, AiResolverError } from '@/lib/ai/resolver';
import { architectureReportSchema } from '@/lib/ai/schemas';
import { auth } from '@/lib/auth/auth';
import { db } from '@/lib/prisma/db';

export const runtime = 'nodejs';

// S3 (security) — AUTHENTICATE and TENANT-AUTHORIZE.
// This endpoint drives a paid model. Requires an authenticated session,
// validates tenant membership before accessing organization credentials,
// and enforces entitlement policy via resolveOrganizationLanguageModel.
export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return Response.json({ error: 'Unauthorized.' }, { status: 401 });
    }

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

    const rawOrgId =
      typeof body.orgId === 'string' && body.orgId.trim()
        ? body.orgId.trim()
        : null;

    let targetOrgId = rawOrgId;

    if (targetOrgId) {
      const membership = await db.membership.findUnique({
        where: {
          userId_orgId: {
            userId: session.user.id,
            orgId: targetOrgId,
          },
        },
      });

      if (!membership) {
        return Response.json(
          { error: 'Forbidden: You do not have access to this organization.' },
          { status: 403 }
        );
      }
    } else {
      const userMembership = await db.membership.findFirst({
        where: { userId: session.user.id },
        select: { orgId: true },
      });

      if (!userMembership) {
        return Response.json(
          { error: 'Forbidden: User does not belong to any organization.' },
          { status: 403 }
        );
      }
      targetOrgId = userMembership.orgId;
    }

    const model = await resolveOrganizationLanguageModel({ orgId: targetOrgId });

    const result = streamText({
      model,
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
    if (error instanceof AiResolverError) {
      return Response.json(
        { error: error.message, code: error.code },
        { status: error.code === 'ORGANIZATION_KEY_REQUIRED' ? 402 : 400 }
      );
    }

    console.error('Stream audit failed:', error);

    return Response.json(
      { error: 'Audit failed.' },
      { status: 500 }
    );
  }
}
