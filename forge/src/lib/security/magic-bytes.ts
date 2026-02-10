const SIGNATURES = {
  pdf: [0x25, 0x50, 0x44, 0x46], // %PDF
  jpg: [0xFF, 0xD8, 0xFF],
  png: [0x89, 0x50, 0x4E, 0x47],
};

export async function validateMagicBytes(
  url: string,
  expected: "pdf" | "jpg" | "png"
) {
  const response = await fetch(url, {
    headers: { Range: "bytes=0-7" },
  });

  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  const signature = SIGNATURES[expected];

  return signature.every((byte, index) => bytes[index] === byte);
}
