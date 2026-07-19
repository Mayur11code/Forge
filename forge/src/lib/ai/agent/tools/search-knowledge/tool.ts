import { tool } from "ai";

import { searchKnowledgeSchema } from "./schema";

export const searchKnowledgeTool = tool({
  description:
    "Search the organization's knowledge base for information relevant to the user's request.",

  inputSchema: searchKnowledgeSchema,
});