
import { z } from 'zod';

export const VectorMetadataSchema = z.object({
  // The actual semantic chunk representation
  text: z.string().min(1, "Text chunk cannot be empty"),
  
  // Logical partitioning (Namespaces handle strict isolation, 
  // but we retain these for granular, intra-namespace filtering)
  orgId: z.string().min(1), 
  projectId: z.string().min(1),
  
  // Categorical identification
  type: z.enum(['task', 'note', 'document', 'comment']),
  
  // Optional relations (Must remain flat strings, NEVER nested objects)
  taskId: z.string().optional(),
  status: z.enum(['TODO', 'IN_PROGRESS', 'DONE']).optional(),
})
// THE SANITIZER: Pinecone crashes on null/undefined. 
// This transformation scrubs the object before it hits the network.
.transform((data) => {
  return Object.fromEntries(
    Object.entries(data).filter(([_, value]) => value != null)
  );
});

export const PineconeRecordSchema = z.object({
  id: z.string().min(1, "Record ID is required"), // Must map exactly to the Prisma Primary Key
  values: z.array(z.number()).length(1536, "Embedding must be exactly 1536 dimensions"), 
  metadata: VectorMetadataSchema
});

// Single Source of Truth for TypeScript Types
export type VectorMetadata = z.infer<typeof VectorMetadataSchema>;
export type PineconeRecord = z.infer<typeof PineconeRecordSchema>;