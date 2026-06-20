// src/lib/vector/text-extractor.ts
import { convert } from 'html-to-text';
import removeMd from 'remove-markdown';
import { Task } from '@prisma/client';

export function extractPureText(rawContent: string | null | undefined): string {
  if (!rawContent) return "";

  // 1. PRE-PARSE: Destroy zero-width characters BEFORE the HTML parser turns them into spaces
  let text = rawContent.replace(/[\u200B-\u200D\uFEFF]/g, '');

  // 2. AST HTML Parsing
  text = convert(text, {
    wordwrap: false, 
    selectors: [
      { selector: 'a', options: { ignoreHref: true } }, 
      { selector: 'img', format: 'skip' }, 
      { selector: 'table', options: { uppercaseHeaderCells: true } }
    ]
  });

  // 3. Strip Markdown
  text = removeMd(text, { stripListLeaders: true, gfm: true });

  // 4. POST-PARSE Normalization
  text = text
    .replace(/[\u00A0\t]/g, ' ')           // Convert non-breaking spaces and tabs
    .replace(/\r\n|\r/g, '\n')             // Normalize line endings
    .replace(/ {2,}/g, ' ')                // Crush multiple horizontal spaces
    .replace(/\n{3,}/g, '\n\n')            // Crush 3+ newlines into exactly 2
    .trim();

  return text;
}



/**
 * Injects relational database context into the sanitized text string.
 * This guarantees the AI understands the metadata surrounding the text.
 */
export function buildSemanticPayload(task: Task): string {
  // 1. Clean the user-generated fields using the utility we just built
  const cleanTitle = extractPureText(task.title);
  const cleanDescription = extractPureText(task.description);

  // 2. Build the context header using an array to easily filter empty values
  const contextHeader = [
    `Entity Type: Task`,
    `Task ID: ${task.id}`,
    `Project ID: ${task.projectId}`,
    `Title: ${cleanTitle}`,
    `Status: ${task.status}`,
    `Priority: ${task.priority}`,
    // If assigneeId is null, this line evaluates to null and is stripped out entirely
    task.assigneeId ? `Assignee ID: ${task.assigneeId}` : null, 
  ]
    // Filter out the nulls/falsy values and join with a standard newline
    .filter(Boolean)
    .join('\n');

  // 3. Assemble the final string
  // We use double newlines to mathematically separate the system header from the user body
  return `${contextHeader}\n\nDescription:\n${cleanDescription || "No description provided."}`;
}