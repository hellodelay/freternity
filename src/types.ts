export interface TuningString {
  note: string;
  octave: number;
  frequency: number;
}

export interface TuningPreset {
  id: string;
  name: string;
  strings: TuningString[]; // from lowest to highest
}

export const TUNING_PRESETS: TuningPreset[] = [
  {
    id: "4s_std",
    name: "4-String Bass Standard (E-A-D-G)",
    strings: [
      { note: "E", octave: 1, frequency: 41.20 },
      { note: "A", octave: 1, frequency: 55.00 },
      { note: "D", octave: 2, frequency: 73.42 },
      { note: "G", octave: 2, frequency: 98.00 },
    ],
  },
  {
    id: "5s_low_b",
    name: "5-String Bass Standard Low B (B-E-A-D-G)",
    strings: [
      { note: "B", octave: 0, frequency: 30.87 },
      { note: "E", octave: 1, frequency: 41.20 },
      { note: "A", octave: 1, frequency: 55.00 },
      { note: "D", octave: 2, frequency: 73.42 },
      { note: "G", octave: 2, frequency: 98.00 },
    ],
  },
  {
    id: "6s_guitar",
    name: "6-String Guitar Standard (E-A-D-G-B-E)",
    strings: [
      { note: "E", octave: 2, frequency: 82.41 },
      { note: "A", octave: 2, frequency: 110.00 },
      { note: "D", octave: 3, frequency: 146.83 },
      { note: "G", octave: 3, frequency: 196.00 },
      { note: "B", octave: 3, frequency: 246.94 },
      { note: "E", octave: 4, frequency: 329.63 },
    ],
  }
];

export interface TunedNoteState {
  noteName: string;
  octave: number;
  frequency: number;
  centsOff: number;
  targetFreq: number;
  confidence: number;
  nearestStringIndex: number;
}
