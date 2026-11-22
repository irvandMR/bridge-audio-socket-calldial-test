// src/utils/audioResampler.ts

/**
 * AudioResampler: Linear PCM 16-bit Mono Resampler
 * 
 * - Inbound (Nasabah -> AI): 8000 Hz -> 16000 Hz (Interpolasi Linier 1:2)
 * - Outbound (AI -> Nasabah): 24000 Hz -> 8000 Hz (Averaging Decimation Filter 3:1)
 */
export class AudioResampler {
  /**
   * Mengubah audio 8000 Hz menjadi 16000 Hz untuk input server AI
   * Rasio: 1 input sample -> 2 output sample
   */
  public static resample8kTo16k(input: Buffer): Buffer {
    const numSamples = Math.floor(input.length / 2);
    if (numSamples === 0) return Buffer.alloc(0);

    const output = Buffer.allocUnsafe(numSamples * 4); // 2 samples * 2 bytes = 4 bytes per input sample

    for (let i = 0; i < numSamples; i++) {
      const s0 = input.readInt16LE(i * 2);
      const s1 = i + 1 < numSamples ? input.readInt16LE((i + 1) * 2) : s0;

      // Sample 1: sample titik asli
      output.writeInt16LE(s0, i * 4);

      // Sample 2: interpolasi rata-rata linier antara s0 dan s1
      const interpolated = Math.round((s0 + s1) / 2);
      output.writeInt16LE(interpolated, i * 4 + 2);
    }

    return output;
  }

  /**
   * Mengubah audio 24000 Hz dari AI menjadi 8000 Hz untuk speaker Asterisk nasabah
   * Rasio: 3 input sample -> 1 output sample (Rata-rata 3 sample sebagai anti-aliasing filter)
   */
  public static resample24kTo8k(input: Buffer): Buffer {
    const numSamples = Math.floor(input.length / 2);
    const numTriplets = Math.floor(numSamples / 3);
    if (numTriplets === 0) return Buffer.alloc(0);

    const output = Buffer.allocUnsafe(numTriplets * 2);

    for (let i = 0; i < numTriplets; i++) {
      const idx = i * 3 * 2;
      const s0 = input.readInt16LE(idx);
      const s1 = input.readInt16LE(idx + 2);
      const s2 = input.readInt16LE(idx + 4);

      // Rata-rata 3 sample berurutan untuk menjaga kejelasan suara tanpa aliasing
      const avg = Math.round((s0 + s1 + s2) / 3);
      output.writeInt16LE(avg, i * 2);
    }

    return output;
  }
}
