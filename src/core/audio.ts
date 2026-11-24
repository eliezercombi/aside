/** Wrap raw 16-bit little-endian mono PCM (what the glasses send) in a WAV header. */
export function wavFromPcm(chunks: Uint8Array[], sampleRate = 16_000): Uint8Array {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(44 + size)
  const view = new DataView(out.buffer)
  const ascii = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) out[offset + i] = value.charCodeAt(i) }
  ascii(0, 'RIFF'); view.setUint32(4, 36 + size, true); ascii(8, 'WAVE')
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  ascii(36, 'data'); view.setUint32(40, size, true)
  let offset = 44
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length }
  return out
}
