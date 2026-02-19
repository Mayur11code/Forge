export function extractKeyFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);

    // Expected format: https://utfs.io/f/<key>
    const segments = parsed.pathname.split("/");

    const fIndex = segments.indexOf("f");

    if (fIndex === -1 || !segments[fIndex + 1]) {
      return null;
    }

    return segments[fIndex + 1];
  } catch {
    return null;
  }
}
