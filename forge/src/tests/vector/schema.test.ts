// src/tests/vector/schema.test.ts
import { VectorMetadataSchema, PineconeRecordSchema } from '@/lib/vector/schema';

describe('Vector Infrastructure Guardrails', () => {
  
  it('should successfully scrub null and undefined fields from metadata', () => {
    const rawPayload = {
      text: 'Production grade system engineering payload',
      orgId: 'org_test_123',
      projectId: 'proj_abc',
      type: 'task' as const,
      taskId: undefined, // The trap field
      status: undefined,  // The trap field
    };

    const parsedData = VectorMetadataSchema.parse(rawPayload);

    // Assert that the transformation completely removed the keys from the object
    expect(parsedData).not.toHaveProperty('taskId');
    expect(parsedData).not.toHaveProperty('status');
    expect(parsedData.orgId).toBe('org_test_123');
  });

  it('should fatal-error if vector array dimensions do not equal exactly 1536', () => {
    const invalidPayload = {
      id: 'rec_malformed_1',
      values: new Array(1535).fill(0.1), // Intentionally short vector array
      metadata: {
        text: 'Invalid dimension test',
        orgId: 'org_test_123',
        projectId: 'proj_abc',
        type: 'task' as const,
      },
    };

    // Assert that the Zod validation schema throws a runtime error
    expect(() => PineconeRecordSchema.parse(invalidPayload)).toThrow();
  });
});