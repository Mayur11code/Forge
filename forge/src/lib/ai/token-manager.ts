// src/lib/ai/token-manager.ts
import { getEncoding } from "js-tiktoken";

const encoder = getEncoding("cl100k_base");

// Helper function to safely extract text from the new AI SDK payload
const extractText = (msg: any): string => {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.parts)) {
    return msg.parts.map((p: any) => p.text || '').join('');
  }
  return "";
};

export function countArrayTokens(messages: any[]): number {
  let totalTokens = 3; 
  for (const msg of messages) {
    totalTokens += 3; 
    
    const role = msg.role || 'user';
    const content = extractText(msg); // Safely extract

    totalTokens += encoder.encode(role).length;
    totalTokens += encoder.encode(content).length;
  }
  return totalTokens;
}

export function enforceTokenBudget(messages: any[], maxAllowedTokens: number): any[] {
  let currentTokens = countArrayTokens(messages);
  let prunedMessages = [...messages]; 

  while (currentTokens > maxAllowedTokens && prunedMessages.length >= 4) {
    const systemPrompt = prunedMessages[0];
    const preservedHistory = prunedMessages.slice(3);
    prunedMessages = [systemPrompt, ...preservedHistory];
    currentTokens = countArrayTokens(prunedMessages);
  }

  // The Guillotine Fallback
  if (currentTokens > maxAllowedTokens) {
    const lastMsg = prunedMessages[prunedMessages.length - 1];
    const rawContent = extractText(lastMsg); // Safely extract
    
    const safeText = encoder.decode(encoder.encode(rawContent).slice(0, maxAllowedTokens - 500));
    
    // Normalize the message to ensure Gemini gets a standard string content back
    prunedMessages[prunedMessages.length - 1] = {
      ...lastMsg,
      content: safeText + "\n\n[SYSTEM: TRUNCATED FOR LENGTH]",
      parts: undefined // Strip parts so it doesn't conflict
    };
  }

  return prunedMessages;
}