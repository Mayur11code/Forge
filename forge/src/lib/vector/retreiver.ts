// src/lib/vector/retriever.ts
import { embed } from 'ai';
import { googleProvider } from '@/lib/ai/provider';
import { getTenantVectorStore } from './client';

/**
 * Converts a raw user query string into a vector embedding using the global provider,
 * queries the isolated tenant vector space, and formats the hits into a semantic context block.
 */
export async function retrieveRelevantContext(
    userQuery: string,
    orgId: string
): Promise<string> {
    try {
        if (!userQuery || !userQuery.trim()) return "";
        if (!orgId) throw new Error("CRITICAL: Tenant isolation key (orgId) missing during retrieval.");

        // 1. Generate Query Vector Embedding via the Global Singleton Provider
        // We use the 'embed' function from the Vercel AI SDK passed into our singleton instance
        // 1. Generate query vector embedding
        const { embedding } = await embed({
            model: googleProvider.embeddingModel("gemini-embedding-001"),
            value: userQuery,
            providerOptions: {
                google: {
                    outputDimensionality: 768,
                } 
            },
        });

        if (!embedding || embedding.length === 0) {
            console.error("❌ [RETRIEVER] Failed to extract vector values from the global provider.");
            return "";
        }

        // 2. Fetch Isolated Tenant Vector Store Instance
        const vectorStore = getTenantVectorStore(orgId);

        // 3. Query the Namespace
        // Pull the top 5 most semantically relevant chunks from Pinecone
        const searchHits = await vectorStore.query(embedding, 5);

        if (!searchHits.matches || searchHits.matches.length === 0) {
            console.log(`[RETRIEVER] Zero semantic hits located for Org: ${orgId}`);
            return "";
        }

        console.log(`🎯 [RETRIEVER] Successfully located ${searchHits.matches.length} matching vector fragments.`);

        // 4. Assemble and Format the Context Block
        const compiledContextBlocks = searchHits.matches
            .map((hit, index) => {
                const textPayload = hit.metadata?.text;
                if (!textPayload) return null;

                // Extract relational variables if they exist on metadata
                const taskId = hit.metadata?.taskId || "Unknown ID";
                const scorePercentage = Math.round(hit.score ? hit.score * 100 : 0);

                return `[Context Chunk #${index + 1} | Source Task ID: ${taskId} | Semantic Match: ${scorePercentage}%]\n${textPayload}`;
            })
            .filter(Boolean)
            .join("\n\n---\n\n");

        return compiledContextBlocks;

    } catch (error: any) {
        console.error("❌ [RETRIEVER_ERROR]: Execution failed during context generation ->", error);
        // Return empty string gracefully so the Chat API can fall back to general assistant instructions
        return "";
    }
}