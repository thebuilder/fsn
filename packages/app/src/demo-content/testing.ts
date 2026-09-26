/**
 * Inflates with the platform's own decoder, so the generator tests never rely on our
 * encoder's reading of the DEFLATE spec to check our encoder.
 */
export async function inflate(bytes: Uint8Array<ArrayBuffer>, format: CompressionFormat): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
