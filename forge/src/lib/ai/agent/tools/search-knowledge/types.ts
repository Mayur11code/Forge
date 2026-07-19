import { z } from "zod";

import { searchKnowledgeSchema } from "./schema";

export type SearchKnowledgeInput =
  z.infer<typeof searchKnowledgeSchema>;

export interface SearchKnowledgeResult {
  documents: {
    id: string;
    title: string;
    content: string;
    score: number;
  }[];
}