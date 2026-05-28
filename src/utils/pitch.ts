/**
 * Normalized Autocorrelation Pitch Detection Algorithm
 * Optimized for low frequencies such as bass guitar.
 */
export function detectPitch(
  buffer: Float32Array,
  sampleRate: number,
  noiseThreshold: number = 0.01
): { frequency: number; confidence: number } {
  const size = buffer.length;

  // 1. Calculate Root-Mean-Square (RMS) to check signal level
  let rms = 0;
  for (let i = 0; i < size; i++) {
    const val = buffer[i];
    rms += val * val;
  }
  rms = Math.sqrt(rms / size);

  // If the signal is too quiet, do not attempt to detect pitch
  if (rms < noiseThreshold) {
    return { frequency: -1, confidence: 0 };
  }

  // 2. Define the bounds of periods we want to search.
  // We want to support from ~25 Hz up to ~450 Hz for bass guitar.
  // Period = sampleRate / frequency
  // For 48000 Hz:
  // - 25 Hz corresponds to 1920 samples lag.
  // - 450 Hz corresponds to 106 samples lag.
  const minPeriod = Math.floor(sampleRate / 450);
  const maxPeriod = Math.floor(sampleRate / 25);

  // Buffer length must be greater than maxPeriod * 2 for stable autocorrelation
  if (size < maxPeriod * 2) {
    return { frequency: -1, confidence: 0 };
  }

  const correlations = new Float32Array(maxPeriod + 1);

  // 3. Compute Normalized Autocorrelation
  // R(lag) = sum_i (x[i] * x[i+lag]) / sqrt( sum_i (x[i]^2) * sum_i (x[i+lag]^2) )
  for (let lag = minPeriod; lag <= maxPeriod; lag++) {
    let dotProduct = 0;
    let energyBase = 0;
    let energyShift = 0;

    const limit = size - lag;
    for (let i = 0; i < limit; i++) {
      const base = buffer[i];
      const shifted = buffer[i + lag];
      dotProduct += base * shifted;
      energyBase += base * base;
      energyShift += shifted * shifted;
    }

    const norm = Math.sqrt(energyBase * energyShift);
    correlations[lag] = norm > 0 ? dotProduct / norm : 0;
  }

  // 4. Find the local maxima (peaks) above a confidence threshold
  let peakValue = -1;
  let peakLag = -1;
  const confidenceThreshold = 0.65; // At least 65% match to consider a real tone

  for (let lag = minPeriod; lag < maxPeriod - 1; lag++) {
    // Check if it's a local maximum
    if (
      correlations[lag] > correlations[lag - 1] &&
      correlations[lag] > correlations[lag + 1]
    ) {
      if (correlations[lag] > confidenceThreshold && correlations[lag] > peakValue) {
        // Because of sub-harmonics or octaves, we want to favor the highest correlation peak.
        // For bass guitar, picking the absolute highest peak in normalized correlation works very well.
        peakValue = correlations[lag];
        peakLag = lag;
      }
    }
  }

  // 5. Parabolic Interpolation for exact sub-sample peak location
  if (peakLag !== -1 && peakLag > minPeriod && peakLag < maxPeriod) {
    const alpha = correlations[peakLag - 1];
    const beta = correlations[peakLag];
    const gamma = correlations[peakLag + 1];

    // denominator could be 0, guard against division by zero
    const denom = alpha - 2 * beta + gamma;
    if (Math.abs(denom) > 1e-4) {
      const p = 0.5 * (alpha - gamma) / denom;
      const preciseLag = peakLag + p;
      const frequency = sampleRate / preciseLag;
      return { frequency, confidence: peakValue };
    }

    // fallback to discrete lag index if denominator is zero
    return { frequency: sampleRate / peakLag, confidence: peakValue };
  }

  return { frequency: -1, confidence: 0 };
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export interface NoteInfo {
  noteName: string;
  octave: number;
  centsOff: number;
  targetFreq: number;
}

export function frequencyToNote(frequency: number): NoteInfo {
  // MIDI note formula: d = 12 * log2(f / 440) + 69
  const noteNum = 12 * Math.log2(frequency / 440) + 69;
  const midi = Math.round(noteNum);
  
  const noteIdx = ((midi % 12) + 12) % 12;
  const octave = Math.floor((midi - 12) / 12);
  
  // Calculate target frequency for the exact MIDI note
  const targetFreq = 440 * Math.pow(2, (midi - 69) / 12);
  
  // Deviation in cents: cents = 1200 * log2(f / f_target)
  const centsOff = Math.round(1200 * Math.log2(frequency / targetFreq));
  
  return {
    noteName: NOTE_NAMES[noteIdx],
    octave,
    centsOff,
    targetFreq,
  };
}
