// src/lib/ai/schemas.ts
import { z } from 'zod';

// ==========================================
// SCHEMA 1: THE BUG TRIAGE CONTRACT
// ==========================================
export const triageSchema = z.object({
  // 1. The Token-Layer Constraint
  severity: z.enum(['low', 'medium', 'high', 'critical'])
    .describe('The priority level of the issue based on system impact. If a database is down, it is critical.'),
  
  category: z.enum(['ui_bug', 'database_error', 'auth_issue', 'feature_request']),
  
  // 2. The Micro-Prompt
  affectedComponent: z.string()
    .describe('Guess the exact React component name or backend file path causing the issue based on the text.'),
  
  requiresImmediateAction: z.boolean()
    .describe('True if this blocks users from logging in or paying.'),
});

// ==========================================
// SCHEMA 2: THE ARCHITECTURE AUDIT CONTRACT
// ==========================================
export const architectureReportSchema = z.object({
  summary: z.string().describe('A high-level, 2-sentence architectural overview.'),
  
  // 3. Nested Array Constraints
  vulnerabilities: z.array(
    z.object({
      path: z.string().describe('The file path containing the issue.'),
      riskLevel: z.enum(['low', 'medium', 'high', 'critical']),
      fixAction: z.string().describe('A clear, 1-sentence programmatic remediation step.')
    })
  )
});

// ==========================================
// 4. END-TO-END TYPE EXPORTS
// ==========================================
// We use z.infer to automatically generate TypeScript interfaces from our schemas.
// If you add a key to the Zod schema above, these types automatically update everywhere in your app.
export type TriageIssue = z.infer<typeof triageSchema>;
export type ArchitectureReport = z.infer<typeof architectureReportSchema>;