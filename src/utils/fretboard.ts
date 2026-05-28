const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/**
 * Calculates note name, octave, and midi number for a given open string tuning and a target fret.
 */
export function getNoteAtFret(
  openNoteName: string,
  openOctave: number,
  fret: number
): { note: string; octave: number; midi: number } {
  // Find normalized base index for the open note name
  const noteIndex = NOTE_NAMES.indexOf(openNoteName);
  
  // Calculate standard midi number for the open note
  // C-1 standard MIDI is 0, C0 is 12, C1 is 24, C2 is 36, etc.
  const openMidi = 12 * (openOctave + 1) + (noteIndex !== -1 ? noteIndex : 0);
  
  // Add fret offsets to determine final midi note
  const targetMidi = openMidi + fret;
  
  const targetNoteIdx = ((targetMidi % 12) + 12) % 12;
  const targetOctave = Math.floor(targetMidi / 12) - 1;
  
  return {
    note: NOTE_NAMES[targetNoteIdx],
    octave: targetOctave,
    midi: targetMidi,
  };
}
