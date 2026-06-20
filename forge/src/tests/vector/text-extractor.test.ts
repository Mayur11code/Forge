// src/tests/vector/text-extractor.test.ts
import { buildSemanticPayload, extractPureText } from '@/lib/vector/text-extractor';

describe('Text Extraction & Sanitization Pipeline', () => {

  it('should safely strip HTML without word smashing', () => {
    const rawHtml = `
      <h1>System Failure</h1>
      <p>The database went down.</p>
      <a href="https://example.com/logs">View Logs</a>
      <img src="error.png" alt="Error Graph" />
    `;

    const cleaned = extractPureText(rawHtml);

    // FIX: Expect the uppercased header from html-to-text
    expect(cleaned).toContain('SYSTEM FAILURE\n\nThe database went down.');
    
    expect(cleaned).toContain('View Logs');
    expect(cleaned).not.toContain('https://example.com/logs');
    expect(cleaned).not.toContain('Error Graph');
    expect(cleaned).not.toContain('error.png');
  });

  it('should strip Markdown syntax', () => {
    const rawMarkdown = `
      ## **Urgent Request**
      - Fix the button
      - Deploy to prod
    `;

    const cleaned = extractPureText(rawMarkdown);

    expect(cleaned).not.toContain('##');
    expect(cleaned).not.toContain('**');
    expect(cleaned).toContain('Urgent Request');
    expect(cleaned).toContain('Fix the button');
  });

  it('should crush token-stealing whitespace and invisible characters', () => {
    // FIX: Wrap in <p> tags so the parser respects block-level spacing
    const dirtyWhitespace = `<p>Start\u200Bhere\u00A0with    excessive spaces.</p>\n\n\n\n\n<p>End here.</p>`;
    
    const cleaned = extractPureText(dirtyWhitespace);

    // Assert zero-width is completely gone (Starthere is one word)
    expect(cleaned).toContain('Starthere with excessive spaces.');
    
    // Assert 5 newlines between paragraphs were crushed to 2
    expect(cleaned).toContain('spaces.\n\nEnd here.');
  });

  it('should return an empty string for null or undefined input', () => {
    expect(extractPureText(null)).toBe('');
    expect(extractPureText(undefined)).toBe('');
    expect(extractPureText('')).toBe('');
  });

});

// src/tests/vector/text-extractor.test.ts (Append this to the file)
import { Task, TaskStatus, TaskPriority } from '@prisma/client';
// Make sure to update your import at the top to include buildSemanticPayload:
// import { extractPureText, buildSemanticPayload } from '@/lib/vector/text-extractor';

describe('Contextual Hydration (Stringification)', () => {
  it('should correctly hydrate a fully populated task and clean its HTML', () => {
    const mockTask: Task = {
      id: 'task_123',
      title: 'Fix <h1>Login</h1>',
      description: '<p>The button is broken</p>',
      status: TaskStatus.IN_PROGRESS,
      priority: TaskPriority.HIGH,
      projectId: 'proj_456',
      assigneeId: 'user_789',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const payload = buildSemanticPayload(mockTask);

    // Assert it ran the HTML cleaner on the title and description
expect(payload).toContain('Title: Fix\n\nLOGIN');
    expect(payload).toContain('Description:\nThe button is broken');

    // Assert all context is present
    expect(payload).toContain('Entity Type: Task');
    expect(payload).toContain('Status: IN_PROGRESS');
    expect(payload).toContain('Priority: HIGH');
    expect(payload).toContain('Assignee ID: user_789');
  });

  it('should gracefully handle tasks with missing optional fields', () => {
    const mockTask: Task = {
      id: 'task_123',
      title: 'Simple Task',
      description: null,
      status: TaskStatus.TODO,
      priority: TaskPriority.LOW,
      projectId: 'proj_456',
      assigneeId: null, // Missing assignee
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const payload = buildSemanticPayload(mockTask);

    // Assert Assignee ID is completely omitted, not just printed as "null"
    expect(payload).not.toContain('Assignee ID');
    expect(payload).not.toContain('null');
    
    // Assert fallback for missing description
    expect(payload).toContain('No description provided.');
  });
});