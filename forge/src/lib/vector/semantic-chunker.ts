// src/lib/vector/semantic-chunker.ts
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { getEncoding } from "js-tiktoken";

// 1. Initialize the specific vocabulary for OpenAI's embedding models
const encoder = getEncoding("cl100k_base");

// 2. The Token "Bridge" Function
// LangChain will use this to measure every paragraph and sentence
const tokenLengthFunction = (text: string): number => {
  return encoder.encode(text).length;
};

/**
 * Intelligently splits text by semantic boundaries (\n\n, \n, ., " ")
 * while strictly enforcing the OpenAI token limit.
 */
export async function chunkTextSemantically(text: string): Promise<string[]> {
  // 3. Configure the Recursive Splitter
  const splitter = new RecursiveCharacterTextSplitter({
    // Hard token limits for optimal semantic density
    chunkSize: 800,
    chunkOverlap: 100,
    
    // Inject the OpenAI token counter instead of counting raw characters
    lengthFunction: tokenLengthFunction,
    
    // The prioritized hierarchy of seams (Split Phase)
    separators: [
      "\n\n", // Try paragraphs first
      "\n",   // Then list items/code lines
      ". ",   // Then sentences
      " ",    // Then words
      ""      // Absolute fallback
    ],
  });

  // 4. Execute the Split & Merge Algorithm
  return await splitter.splitText(text);
}