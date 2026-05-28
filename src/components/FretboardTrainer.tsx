import React, { useState, useEffect, useRef } from "react";
import { TuningPreset, TuningString, TunedNoteState, TUNING_PRESETS } from "../types";
import { getNoteAtFret } from "../utils/fretboard";
import AudioVisualizer from "./AudioVisualizer";
import {
  Flame,
  Trophy,
  Timer,
  Play,
  Square,
  Eye,
  EyeOff,
  Zap,
  Music,
  CheckCircle2,
  Sliders,
  Sparkles,
  ChevronDown,
  AlertTriangle
} from "lucide-react";

interface FretboardTrainerProps {
  currentPreset: TuningPreset;
  pitchState: TunedNoteState;
  isActive: boolean; // Is the microphone tuner session active?
  analyser: AnalyserNode | null;
  onToggleConnect: () => void;
  onPresetChange: (preset: TuningPreset) => void;
}

export interface FretboardNote {
  note: string;
  octave: number;
  midi: number;
  frequency: number;
  stringIndex: number;
  fret: number;
}

interface RoundResult {
  id: string;
  timestamp: number;
  correct: number;
  streak: number;
  fretSpan: string;
  duration: number;
  timeout: number;
  score: number;
  missOnWrongNote?: boolean;
}

export default function FretboardTrainer({
  currentPreset,
  pitchState,
  isActive,
  analyser,
  onToggleConnect,
  onPresetChange
}: FretboardTrainerProps) {
  // Game state
  const [gameState, setGameState] = useState<"idle" | "playing" | "gameOver">("idle");
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [maxStreakOfRound, setMaxStreakOfRound] = useState(0);
  const [highScore, setHighScore] = useState<number>(() => {
    return Number(localStorage.getItem("freternity_highscore") || "0");
  });
  const [isParamsCollapsed, setIsParamsCollapsed] = useState(true);
  const [roundHistory, setRoundHistory] = useState<RoundResult[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("freternity_history") || "[]");
    } catch (e) {
      return [];
    }
  });
  const roundLoggedRef = useRef(false);
  
  const [targetNote, setTargetNote] = useState<FretboardNote | null>(null);
  
  // Dual Timer states (Default Note Countdown Time changed to 5s!)
  const [noteDuration, setNoteDuration] = useState(5); // countdown per note configured
  const [roundDuration, setRoundDuration] = useState(60); // total round configured
  
  const [noteTimeLeft, setNoteTimeLeft] = useState(5.0);
  const [roundTimeLeft, setRoundTimeLeft] = useState(60.0);
  
  const [correctCount, setCorrectCount] = useState(0);
  const [missCount, setMissCount] = useState(0);
  const [notesPlayedThisGame, setNotesPlayedThisGame] = useState(0);
  
  // Custom Settings
  const [minFret, setMinFret] = useState(0);
  const [maxFret, setMaxFret] = useState(5);
  const [showFretboardGuide, setShowFretboardGuide] = useState(true);
  const [matchExactOctave, setMatchExactOctave] = useState(true);
  const [successAnimation, setSuccessAnimation] = useState(false);
  const [missOnWrongNote, setMissOnWrongNote] = useState(false);

  // Refs for tracking non-cascading wrong notes
  const lastWrongNoteRef = useRef<string | null>(null);
  const lastWrongNoteTimeRef = useRef<number>(0);

  // Refs for timer loops
  const successAnimationRef = useRef(false);
  const noteDurationRef = useRef(5);
  const roundDurationRef = useRef(60);

  useEffect(() => {
    successAnimationRef.current = successAnimation;
  }, [successAnimation]);

  useEffect(() => {
    noteDurationRef.current = noteDuration;
  }, [noteDuration]);

  useEffect(() => {
    roundDurationRef.current = roundDuration;
  }, [roundDuration]);

  // Metronome states
  const [metronomeEnabled, setMetronomeEnabled] = useState(false);
  const [metronomeBpm, setMetronomeBpm] = useState(120);
  const [metronomeDivision, setMetronomeDivision] = useState<"quarter" | "half" | "whole">("whole");
  const [currentBeat, setCurrentBeat] = useState(0); // 0, 1, 2, 3 visualization beats

  // Timer Ref
  const timerIntervalRef = useRef<number | null>(null);

  // Generate note options inside configured bounds
  const getFretboardNotePool = (): FretboardNote[] => {
    const pool: FretboardNote[] = [];
    currentPreset.strings.forEach((str, stringIndex) => {
      for (let fret = minFret; fret <= maxFret; fret++) {
        const noteInfo = getNoteAtFret(str.note, str.octave, fret);
        // Standard Equal Temperament formula: f = 440 * 2^((midi-69)/12)
        const frequency = 440 * Math.pow(2, (noteInfo.midi - 69) / 12);
        pool.push({
          note: noteInfo.note,
          octave: noteInfo.octave,
          midi: noteInfo.midi,
          frequency,
          stringIndex,
          fret,
        });
      }
    });
    return pool;
  };

  // Helper to determine MIDI note to frequency
  const midiToFreq = (midi: number): number => {
    return 440 * Math.pow(2, (midi - 69) / 12);
  };

  // Setup/Fetch a new random target note
  const pickNewTargetNote = (previousNote: FretboardNote | null = null) => {
    const pool = getFretboardNotePool();
    if (pool.length === 0) return;

    // Filter out previous target to ensure we don't pick the identical note twice back-to-back
    let filteredPool = pool.filter(n => 
      !previousNote || n.note !== previousNote.note || n.octave !== previousNote.octave
    );
    if (filteredPool.length === 0) filteredPool = pool;

    const randomNote = filteredPool[Math.floor(Math.random() * filteredPool.length)];
    setTargetNote(randomNote);
    
    // Scale timer slightly with streak, starting from the configured noteDuration
    const newTime = Math.max(2.0, noteDuration - Math.min(noteDuration * 0.4, streak * 0.3));
    setNoteTimeLeft(newTime);
  };

  // Persistent Audio Context for Trainer sounds
  const audioContextRef = useRef<AudioContext | null>(null);

  const getOrCreateAudioContext = (): AudioContext | null => {
    try {
      if (!audioContextRef.current) {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        audioContextRef.current = new AudioCtx();
      }
      if (audioContextRef.current.state === "suspended") {
        audioContextRef.current.resume().catch(() => {});
      }
      return audioContextRef.current;
    } catch (e) {
      console.warn("Failed to create shared AudioContext:", e);
      return null;
    }
  };

  const playSineTone = (frequency: number, type: OscillatorType, gainVal: number, duration: number) => {
    const ctx = getOrCreateAudioContext();
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = type;
      osc.frequency.setValueAtTime(frequency, ctx.currentTime);

      gain.gain.setValueAtTime(gainVal, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration - 0.02);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start();
      osc.stop(ctx.currentTime + duration);
    } catch (e) {
      console.warn("Tone playback failure:", e);
    }
  };

  const playTargetNote = (note: FretboardNote) => {
    const ctx = getOrCreateAudioContext();
    if (!ctx) return;
    try {
      const oscRoot = ctx.createOscillator();
      const oscOctave = ctx.createOscillator();
      const gainNode = ctx.createGain();

      oscRoot.type = "triangle";
      oscRoot.frequency.setValueAtTime(note.frequency, ctx.currentTime);

      // Add a higher pitch octave-up harmonic so it's fully audible on small speakers
      oscOctave.type = "sine";
      oscOctave.frequency.setValueAtTime(note.frequency * 2, ctx.currentTime);

      gainNode.gain.setValueAtTime(0.12, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.2 - 0.05);

      oscRoot.connect(gainNode);
      oscOctave.connect(gainNode);
      gainNode.connect(ctx.destination);

      oscRoot.start();
      oscOctave.start();
      oscRoot.stop(ctx.currentTime + 1.2);
      oscOctave.stop(ctx.currentTime + 1.2);
    } catch (e) {
      console.warn("Failed to play target note tone:", e);
    }
  };

  // Play target note audio when it changes
  useEffect(() => {
    if (gameState === "playing" && targetNote) {
      // Small 150ms timeout to allow user to register visual change before audio
      const timer = setTimeout(() => {
        playTargetNote(targetNote);
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [targetNote, gameState]);

  // Clean persistent Audio Context on unmount
  useEffect(() => {
    return () => {
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => {});
        audioContextRef.current = null;
      }
    };
  }, []);

  // Helper function to sound a crisp, high-quality metronome click using the shared AudioContext
  const playMetronomeTick = (isFirstBeat: boolean) => {
    const freq = isFirstBeat ? 1000 : 700;
    playSineTone(freq, "sine", 0.08, 0.06);
  };

  // Metronome ticking loop
  useEffect(() => {
    if (!metronomeEnabled || gameState !== "playing") {
      setCurrentBeat(0);
      return;
    }

    const beatMs = 60000 / metronomeBpm;

    // Tick the first beat immediately
    playMetronomeTick(true);

    const interval = window.setInterval(() => {
      setCurrentBeat((prev) => {
        const nextBeat = (prev + 1) % 4;

        // Check if we should click with selected notes division
        let shouldSound = false;
        if (metronomeDivision === "quarter") {
          shouldSound = true;
        } else if (metronomeDivision === "half") {
          shouldSound = nextBeat === 0 || nextBeat === 2;
        } else if (metronomeDivision === "whole") {
          shouldSound = nextBeat === 0;
        }

        if (shouldSound) {
          playMetronomeTick(nextBeat === 0);
        }

        return nextBeat;
      });
    }, beatMs);

    return () => {
      clearInterval(interval);
    };
  }, [metronomeEnabled, metronomeBpm, metronomeDivision, gameState]);

  // Start the Game
  const startGame = () => {
    setScore(0);
    setStreak(0);
    setMaxStreakOfRound(0);
    setCorrectCount(0);
    setMissCount(0);
    setNotesPlayedThisGame(0);
    setGameState("playing");
    setSuccessAnimation(false);
    successAnimationRef.current = false;
    roundLoggedRef.current = false;
    
    setRoundTimeLeft(roundDuration);
    setNoteTimeLeft(noteDuration);
    
    // Force pick target
    const pool = getFretboardNotePool();
    if (pool.length > 0) {
      const randomNote = pool[Math.floor(Math.random() * pool.length)];
      setTargetNote(randomNote);
    }
  };

  const stopGame = () => {
    setGameState("idle");
    setTargetNote(null);
    setStreak(0);
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
  };

  const endRoundEarly = () => {
    setGameState("gameOver");
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
  };

  // Timer interval ticking down
  useEffect(() => {
    if (gameState === "playing") {
      timerIntervalRef.current = window.setInterval(() => {
        // Overall Game Timer
        setRoundTimeLeft((prevRound) => {
          if (prevRound <= 0.05) {
            setGameState("gameOver");
            if (timerIntervalRef.current) {
              clearInterval(timerIntervalRef.current);
            }
            return 0;
          }
          return prevRound - 0.05;
        });

        // Note Timer
        setNoteTimeLeft((prevNote) => {
          if (successAnimationRef.current) return prevNote; // freeze timer during success flash
          if (prevNote <= 0.05) {
            return -1; // special flag for note expiration
          }
          return prevNote - 0.05;
        });
      }, 50);
    } else {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
    }

    return () => {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
      }
    };
  }, [gameState]);

  // High score tracking when round ends
  useEffect(() => {
    if (gameState === "gameOver" && !roundLoggedRef.current) {
      roundLoggedRef.current = true;
      if (score > highScore) {
        setHighScore(score);
        localStorage.setItem("freternity_highscore", score.toString());
      }

      const totalNotes = correctCount + missCount;
      const accuracy = totalNotes > 0 ? Math.round((correctCount / totalNotes) * 100) : 0;

      const newRound: RoundResult = {
        id: Math.random().toString(36).substring(2, 9),
        timestamp: Date.now(),
        correct: correctCount,
        streak: maxStreakOfRound,
        fretSpan: `F${minFret}-F${maxFret}`,
        duration: roundDuration,
        timeout: noteDuration,
        score: accuracy,
        missOnWrongNote: missOnWrongNote
      };

      setRoundHistory((prev) => {
        const updated = [newRound, ...prev].slice(0, 5);
        localStorage.setItem("freternity_history", JSON.stringify(updated));
        return updated;
      });
    }
  }, [gameState, score, highScore, correctCount, missCount, maxStreakOfRound, minFret, maxFret, roundDuration, noteDuration, missOnWrongNote]);

  // Hook listening to note detection events to evaluate game state match
  useEffect(() => {
    if (gameState !== "playing" || !targetNote) return;
    // Guard synchronously and asynchronously against duplicate detections
    if (successAnimation || successAnimationRef.current) return; 

    // Handle note timer timeout (Missed note!)
    if (noteTimeLeft <= 0) {
      if (noteTimeLeft === -1) {
        setMissCount((prev) => prev + 1);
        setStreak(0);
        
        // Play brief buzz tone
        playSineTone(140, "sawtooth", 0.04, 0.25);

        // Pick next target note
        pickNewTargetNote(targetNote);
      }
      return;
    }

    const detectedNoteName = pitchState.noteName;
    const detectedOctave = pitchState.octave;
    const isConfidenceHigh = pitchState.confidence > 0.70;

    // Reset wrong note tracking if silent or no note detected
    if (!isConfidenceHigh || detectedNoteName === "-") {
      lastWrongNoteRef.current = null;
    }

    // Check if the user matched the target note
    const namesMatch = detectedNoteName === targetNote.note;
    const octavesMatch = !matchExactOctave || detectedOctave === targetNote.octave;

    if (namesMatch && octavesMatch && isConfidenceHigh) {
      lastWrongNoteRef.current = null;
      lastWrongNoteTimeRef.current = 0;

      // Block subsequent detections instantly and synchronously!
      successAnimationRef.current = true;
      setSuccessAnimation(true);
      
      // Calculate dynamic score based on time remaining
      const timeBonus = Math.round((noteTimeLeft / noteDuration) * 100);
      const points = 100 + timeBonus + (streak * 15);
      
      setScore((prev) => prev + points);
      setStreak((prev) => {
        const next = prev + 1;
        setMaxStreakOfRound((currentMax) => Math.max(currentMax, next));
        return next;
      });
      setCorrectCount((prev) => prev + 1);
      setNotesPlayedThisGame((prev) => prev + 1);

      // Play matching hum sound subtly
      playSineTone(600, "sine", 0.08, 0.35);

      // Short delay for the next note to keep UI satisfaction high
      const curTarget = targetNote;
      setTimeout(() => {
        setSuccessAnimation(false);
        successAnimationRef.current = false; // Reset the synchronous guard
        pickNewTargetNote(curTarget);
      }, 500);
    } else if (missOnWrongNote && isConfidenceHigh && detectedNoteName !== "-") {
      // Wrong note detected when parameter is active
      const now = Date.now();
      const isCooldownOver = (now - lastWrongNoteTimeRef.current) > 900;
      const isDifferentNote = lastWrongNoteRef.current !== detectedNoteName;

      if (isCooldownOver || isDifferentNote) {
        lastWrongNoteRef.current = detectedNoteName;
        lastWrongNoteTimeRef.current = now;

        setMissCount((prev) => prev + 1);
        setStreak(0);

        // Play brief buzz tone
        playSineTone(140, "sawtooth", 0.04, 0.25);

        // Pick next target note
        pickNewTargetNote(targetNote);
      }
    }
  }, [pitchState, gameState, targetNote, matchExactOctave, noteTimeLeft, streak, noteDuration, missOnWrongNote]);

  // Compute all instances of the current target note on the fretboard
  const getNoteCoordinates = (noteName: string, octave: number | null): { stringIndex: number; fret: number }[] => {
    const coords: { stringIndex: number; fret: number }[] = [];
    currentPreset.strings.forEach((str, strIdx) => {
      for (let fret = minFret; fret <= maxFret; fret++) {
        const noteInfo = getNoteAtFret(str.note, str.octave, fret);
        if (noteInfo.note === noteName && (octave === null || noteInfo.octave === octave)) {
          coords.push({ stringIndex: strIdx, fret });
        }
      }
    });
    return coords;
  };

  const targetCoords = targetNote ? getNoteCoordinates(targetNote.note, matchExactOctave ? targetNote.octave : null) : [];

  const renderFretboardVisual = (isNested: boolean) => {
    return (
      <div className={isNested 
        ? "w-full mt-3.5 pt-3.5 border-t border-white/5 z-10 select-none overflow-x-auto text-left" 
        : "bg-[#0C0E12]/80 border border-white/5 rounded-3xl p-2.5 md:p-3 select-none overflow-x-auto"
      }>
        <div className="flex items-center justify-between mb-2 gap-2 min-w-[420px]">
          <span className="text-[9px] font-bold text-white/40 uppercase tracking-[0.2em] font-mono">
            {isNested ? "FRETBOARD GUIDE" : "FRETBOARD"}
          </span>
          <span className="text-[8.5px] text-white/40 font-mono tracking-widest uppercase text-right">
            {currentPreset.name} (Fret {minFret} to {maxFret})
          </span>
        </div>

        {/* The Neck */}
        <div className="relative border border-white/10 rounded-2xl bg-[#090A0D] p-2 min-w-[460px] overflow-hidden">
          {/* Wood and Frets grid lines */}
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 bg-gradient-to-r from-amber-700/0 via-amber-800/15 to-transparent pointer-events-none" />

          <div className="relative z-10 flex flex-col gap-1.5">
            {/* Draw standard fret indicators */}
            <div className="flex border-b border-white/5 pb-0.5 items-center">
              {/* String label placeholder spacing */}
              <div className="w-10 text-center text-[8.5px] font-mono font-bold text-white/20">STR</div>
              
              <div className="flex-1 flex items-center pl-1 h-full">
                {/* Fret 0 (Open) */}
                {(() => {
                  const f0ConfigInRange = 0 >= minFret && 0 <= maxFret;
                  return (
                    <div className={`w-8 text-center font-mono text-[8.5px] tracking-tighter ${
                      f0ConfigInRange ? "text-white/60 font-black" : "text-white/15"
                    }`}>
                      F0
                    </div>
                  );
                })()}

                {/* Pronounced divider gap line between F0 and F1 indices */}
                <div className="w-[3px] h-3.5 bg-white/35 mx-1.5 rounded-full shrink-0 shadow-sm" />

                {/* F1-15 indices */}
                <div className="flex-1 flex items-center justify-around">
                  {Array.from({ length: 15 }).map((_, i) => {
                    const fIdx = i + 1;
                    const isConfigInRange = fIdx >= minFret && fIdx <= maxFret;
                    return (
                      <div
                        key={fIdx}
                        className={`flex-1 text-center font-mono text-[8.5px] tracking-tighter ${
                          isConfigInRange ? "text-white/60 font-black" : "text-white/15"
                        }`}
                      >
                        F{fIdx}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* List and draw strings */}
            {currentPreset.strings.map((str, sIdx) => {
              // Standard fretboard strings layout: display highest pitched string on the top
              const revIdx = currentPreset.strings.length - 1 - sIdx;
              const stringDef = currentPreset.strings[revIdx];

              const isGaugeTuningClosest = pitchState.nearestStringIndex === revIdx && pitchState.frequency > 0;

              return (
                <div key={revIdx} className="flex items-center relative h-5">
                  {/* String Open Note Badge */}
                  <div className={`w-10 flex items-baseline select-none z-20 ${
                    isGaugeTuningClosest ? "text-emerald-400" : "text-white/50"
                  }`}>
                    <span className="text-[10px] font-black font-mono leading-none">{stringDef.note}</span>
                    <span className="text-[7.5px] font-semibold text-white/30 ml-0.5 leading-none font-mono">
                      {stringDef.octave}
                    </span>
                  </div>

                  {/* Horizontal visual metal string core */}
                  <div 
                    className={`absolute left-9 right-0 h-[1.5px] transition-all -translate-y-0.5 z-10 ${
                      isGaugeTuningClosest 
                        ? "bg-emerald-400 shadow-[0_0_8px_#10b981]" 
                        : "bg-white/15"
                    }`}
                    style={{
                      // Scale metal Thickness based on index to simulate low vs high strings!
                      height: `${1 + revIdx * 0.3}px`,
                      opacity: isGaugeTuningClosest ? 1.0 : 0.4
                    }}
                  />

                  {/* Draw each fret note on this string */}
                  <div className="flex-1 flex z-20 items-center h-full pl-1">
                    {/* F0 Open Note Block */}
                    {(() => {
                      const fIdx = 0;
                      const noteInfo = getNoteAtFret(stringDef.note, stringDef.octave, fIdx);
                      const isFretTarget = targetNote && 
                                           noteInfo.note === targetNote.note && 
                                           (!matchExactOctave || noteInfo.octave === targetNote.octave);
                      
                      const isPlayedRefMatching = pitchState.confidence > 0.70 &&
                                                  pitchState.noteName === noteInfo.note &&
                                                  (!matchExactOctave || pitchState.octave === noteInfo.octave);

                      const inRange = fIdx >= minFret && fIdx <= maxFret;

                      const visible = showFretboardGuide && isFretTarget;

                      return (
                        <div className="w-8 flex items-center justify-center relative group">
                          <div className="absolute right-0 top-0 bottom-0 w-px bg-white/5 pointer-events-none" />
                          <div className={`w-5 h-5 rounded flex items-center justify-center font-mono text-[7px] transition-all duration-300 ${
                            visible && inRange
                              ? "bg-emerald-400 text-black font-bold shadow-[0_0_6px_rgba(52,211,153,0.4)] border border-emerald-300 animate-pulse scale-105"
                              : isPlayedRefMatching && inRange
                              ? "bg-amber-400/20 border border-amber-400/30 text-amber-300 font-bold"
                              : inRange
                              ? "bg-white/5 hover:bg-white/10 text-white/40 group-hover:text-white/85 border border-white/5"
                              : "text-white/10 opacity-30 select-none cursor-default"
                          }`}>
                            {inRange ? (
                              <div className="flex flex-col items-center leading-none scale-90">
                                <span className="font-bold leading-none">{noteInfo.note}</span>
                                <span className="text-[5.5px] opacity-65 font-semibold leading-none mt-0.5">{noteInfo.octave}</span>
                              </div>
                            ) : (
                              "-"
                            )}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Hardwood/Bone Nut divider line between fret 0 and fret 1 */}
                    <div className="w-[3px] bg-amber-500/40 self-stretch my-0.5 rounded-full shadow-[0_0_4px_rgba(245,158,11,0.35)] z-30 mx-1.5" />

                    {/* F1-15 Notes Block */}
                    <div className="flex-1 flex justify-around items-center h-full">
                      {Array.from({ length: 15 }).map((_, i) => {
                        const fIdx = i + 1;
                        const noteInfo = getNoteAtFret(stringDef.note, stringDef.octave, fIdx);
                        const isFretTarget = targetNote && 
                                             noteInfo.note === targetNote.note && 
                                             (!matchExactOctave || noteInfo.octave === targetNote.octave);
                        
                        const isPlayedRefMatching = pitchState.confidence > 0.70 &&
                                                    pitchState.noteName === noteInfo.note &&
                                                    (!matchExactOctave || pitchState.octave === noteInfo.octave);

                        const inRange = fIdx >= minFret && fIdx <= maxFret;

                        // Fretboard guide option controls visibility
                        const visible = showFretboardGuide && isFretTarget;

                        return (
                          <div
                            key={fIdx}
                            className="flex-1 flex items-center justify-center relative group animate-fade-in"
                          >
                            {/* Slabs or Fret Bars spacer */}
                            <div className="absolute right-0 top-0 bottom-0 w-px bg-white/5 pointer-events-none" />

                            {/* Highlight Fret Space container - Sized to w-5 h-5 */}
                            <div className={`w-5 h-5 rounded flex items-center justify-center font-mono text-[7px] transition-all duration-300 ${
                              visible && inRange
                                ? "bg-emerald-400 text-black font-bold shadow-[0_0_6px_rgba(52,211,153,0.4)] border border-emerald-300 animate-pulse scale-105"
                                : isPlayedRefMatching && inRange
                                ? "bg-amber-400/20 border border-amber-400/30 text-amber-300 font-bold"
                                : inRange
                                ? "bg-white/5 hover:bg-white/10 text-white/40 group-hover:text-white/85 border border-white/5"
                                : "text-white/10 opacity-30 select-none cursor-default"
                            }`}>
                              {inRange ? (
                                <div className="flex flex-col items-center leading-none scale-90">
                                  <span className="font-bold leading-none">{noteInfo.note}</span>
                                  <span className="text-[5.5px] opacity-65 font-semibold leading-none mt-0.5">{noteInfo.octave}</span>
                                </div>
                              ) : (
                                "-"
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="bg-[#12141A] border border-white/10 rounded-3xl p-3.5 md:p-5 shadow-2xl relative overflow-hidden flex flex-col gap-3 md:gap-4">
      {/* Decorative Matrix Header Dot */}
      <div className="absolute top-0 inset-x-0 h-[2px] bg-gradient-to-r from-emerald-500/0 via-emerald-400/30 to-emerald-500/0 animate-pulse" />

      {/* Main Mode / Configuration Sidebar & Target Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 md:gap-6 items-start">
        
        {/* Game Dashboard Panel (Columns 1-7) - Holds active target AND virtual fretboard stacking! */}
        <div className="col-span-1 lg:col-span-7 flex flex-col gap-4 md:gap-6">
          
          {/* Active Target Banner */}
          {gameState === "playing" && targetNote && (
            <div className={`p-4 md:p-5 rounded-3xl border transition-all duration-300 flex flex-col items-center justify-center text-center relative overflow-hidden ${
              successAnimation 
                ? "bg-emerald-500/10 border-emerald-400/40 shadow-[0_0_30px_rgba(52,211,153,0.15)]" 
                : "bg-black/20 border-white/5"
            }`}>
              
              {/* Pulse ambient backdrop halo */}
              <div className={`absolute inset-0 pointer-events-none transition-opacity duration-300 opacity-15 bg-radial-gradient ${
                successAnimation ? "bg-emerald-400" : "bg-emerald-950/20"
              }`} />

              <span className="text-[9px] font-mono tracking-[0.3em] text-white/35 uppercase z-10 block mb-3 text-center">
                {successAnimation ? "SUCCESS MATCH!" : "PLAY THIS NOTE"}
              </span>

              {/* Main Active Target layout combining Note display and stacked stats */}
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 w-full items-stretch z-10 relative">
                {/* Left: Taller target note display block with absolute timer and nice centered circular progress */}
                <div className="relative sm:col-span-3 flex flex-col justify-center items-center bg-black/15 border border-white/5 rounded-2xl p-4 min-h-[170px] md:min-h-[200px] overflow-hidden select-none">
                  
                  {/* Circular Progress Countdown Ring */}
                  <div className="relative w-36 h-36 md:w-42 md:h-42 flex items-center justify-center">
                    <svg className="absolute inset-0 w-full h-full -rotate-90 scale-x-[-1]" viewBox="0 0 100 100">
                      {/* Background quiet track */}
                      <circle
                        cx="50"
                        cy="50"
                        r="46"
                        className="stroke-white/5 fill-none"
                        strokeWidth="3.5"
                      />
                      {/* Dynamic active draining countdown ring */}
                      <circle
                        cx="50"
                        cy="50"
                        r="46"
                        className={`fill-none ease-linear ${
                          noteTimeLeft >= noteDuration - 0.15 
                            ? "transition-none" 
                            : "transition-all duration-75"
                        } ${
                          noteTimeLeft < 2.5 
                            ? "stroke-rose-500" 
                            : "stroke-emerald-400"
                        }`}
                        strokeWidth="3.5"
                        strokeDasharray="289.03"
                        strokeDashoffset={(1 - (noteTimeLeft / noteDuration)) * 289.03}
                        strokeLinecap="round"
                      />
                    </svg>

                    {/* Central Target Note Symbol inside Circle */}
                    <div className="flex items-baseline justify-center transition-transform duration-300 relative">
                      <span className={`text-5xl md:text-6xl font-black tracking-tight leading-none ${
                        successAnimation ? "text-emerald-400 scale-105" : "text-white"
                      }`}>
                        {targetNote.note}
                      </span>
                      <span className="text-2xl md:text-3xl font-bold font-mono text-white/40 ml-1 leading-none">
                        {targetNote.octave}
                      </span>
                    </div>
                  </div>

                  {/* Corner Remaining Time Readout */}
                  <div className={`absolute bottom-3 right-4 font-mono text-xs font-semibold select-none flex items-center gap-1.5 ${
                    noteTimeLeft < 2.5 ? "text-rose-450 font-bold animate-pulse" : "text-white/40"
                  }`}>
                    <Timer className={`w-3.5 h-3.5 ${noteTimeLeft < 2.5 ? "text-rose-450 animate-bounce" : "text-white/30"}`} />
                    <span>{noteTimeLeft.toFixed(1)}s</span>
                  </div>
                </div>

                {/* Right: Round, Streak, and OK/Miss stacked vertically */}
                <div className="sm:col-span-1 flex flex-row sm:flex-col gap-2 w-full sm:justify-start sm:py-1">
                  <div className="flex-1 sm:flex-none h-12 bg-black/35 rounded-xl border border-white/5 flex flex-col justify-center items-center text-center">
                    <span className="text-[7.5px] text-white/30 block uppercase tracking-wide font-mono mb-0.5 mt-0.5">ROUND</span>
                    <span className="text-xs font-black text-emerald-400 font-mono leading-none mb-0.5">{Math.max(0, Math.ceil(roundTimeLeft))}s</span>
                  </div>
                  <div className="flex-1 sm:flex-none h-12 bg-black/35 rounded-xl border border-white/5 flex flex-col justify-center items-center text-center">
                    <span className="text-[7.5px] text-white/30 block uppercase tracking-wide font-mono mb-0.5 mt-0.5">STREAK</span>
                    <span className="text-xs font-black text-rose-450 font-mono leading-none mb-0.5">{streak}</span>
                  </div>
                  <div className="flex-1 sm:flex-none h-12 bg-emerald-500/5 rounded-xl border border-emerald-500/10 flex flex-col justify-center items-center text-center">
                    <span className="text-[7.5px] text-emerald-400/50 block uppercase tracking-wide font-mono mb-0.5 mt-0.5">OK/MISS</span>
                    <span className="text-xs font-black text-emerald-400 font-mono leading-none mb-0.5">{correctCount}/{missCount}</span>
                  </div>
                </div>
              </div>

              {/* Fretboard guide nested directly inside the Active Target Card */}
              {renderFretboardVisual(true)}

              {/* Combined Metronome & Waveform Dashboard */}
              <div className="w-full mt-3 pt-3.5 border-t border-white/5 z-10 flex flex-col gap-2 text-left">
                <div className="flex items-center justify-between">
                  <span className="text-[9px] font-mono text-white/35 uppercase tracking-widest flex items-center gap-1.5">
                    <Music className={`w-3 h-3 ${metronomeEnabled ? "text-emerald-450 animate-pulse" : "text-white/40"}`} />
                    METRONOME & SIGNAL WAVEFORM
                  </span>
                  {/* Micro beat visualizer dots */}
                  {metronomeEnabled && (
                    <div className="flex gap-1">
                      {[0, 1, 2, 3].map((b) => (
                        <span
                          key={b}
                          className={`w-1.5 h-1.5 rounded-full transition-all duration-100 ${
                            currentBeat === b
                              ? b === 0
                                ? "bg-emerald-400 scale-125 shadow-[0_0_8px_#10b981]"
                                : "bg-emerald-500/70 scale-110"
                              : "bg-white/10"
                          }`}
                        />
                      ))}
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-center bg-black/40 p-2.5 rounded-2xl border border-white/5">
                  {/* Left: Metronome controls */}
                  <div className="flex items-center justify-between gap-2.5">
                    {/* Toggle Switch Button */}
                    <button
                      onClick={() => setMetronomeEnabled(!metronomeEnabled)}
                      className={`px-3 py-1.5 text-[8.5px] font-bold font-mono rounded-lg border transition-all flex items-center gap-1.5 cursor-pointer select-none active:scale-95 duration-100 ${
                          metronomeEnabled
                            ? "bg-emerald-500/20 text-emerald-300 border-emerald-400/30 shadow-[0_0_10px_rgba(16,185,129,0.1)]"
                            : "bg-[#12141A] text-white/55 border-white/10 hover:bg-white/10"
                        }`}
                    >
                      <div className={`w-1.5 h-1.5 rounded-full ${metronomeEnabled ? "bg-emerald-400 animate-ping" : "bg-white/30"}`} />
                      {metronomeEnabled ? "ON" : "OFF"}
                    </button>

                    {/* Elegant BPM Speed Stepper */}
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setMetronomeBpm((prev) => Math.max(40, prev - 5))}
                        className="w-5.5 h-5.5 rounded-md bg-[#12141A] hover:bg-white/5 border border-white/5 text-[10px] text-white/70 font-mono font-bold flex items-center justify-center cursor-pointer select-none active:scale-90"
                      >
                        -
                      </button>
                      <div className="flex flex-col items-center min-w-[28px]">
                        <span className="text-[10px] font-extrabold text-white font-mono leading-none">{metronomeBpm}</span>
                        <span className="text-[6.5px] text-white/30 font-mono leading-none mt-0.5">BPM</span>
                      </div>
                      <button
                        onClick={() => setMetronomeBpm((prev) => Math.min(240, prev + 5))}
                        className="w-5.5 h-5.5 rounded-md bg-[#12141A] hover:bg-white/5 border border-white/5 text-[10px] text-white/70 font-mono font-bold flex items-center justify-center cursor-pointer select-none active:scale-90"
                      >
                        +
                      </button>
                    </div>

                    {/* Division switches matching Quarter, Half, Whole (Default Whole) */}
                    <div 
                      onClick={() => setMetronomeDivision((prev) => prev === "quarter" ? "half" : prev === "half" ? "whole" : "quarter")}
                      className="flex bg-[#12141A] border border-white/5 p-0.5 rounded-lg font-mono text-[7.5px] font-bold cursor-pointer select-none active:scale-95 transition-transform duration-100"
                    >
                      {(["quarter", "half", "whole"] as const).map((div) => {
                        const isSel = metronomeDivision === div;
                        return (
                          <div
                            key={div}
                            className={`px-1.5 py-0.5 rounded transition-all ${
                              isSel
                                ? "bg-emerald-500 text-black font-extrabold shadow-sm"
                                : "text-white/40"
                            }`}
                          >
                            {div === "quarter" ? "1/4" : div === "half" ? "1/2" : "1/1"}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Right: Real-time Oscilloscope/Waveform sharing same row! */}
                  <div className="w-full flex items-center h-10 border-t md:border-t-0 md:border-l border-white/5 pt-2.5 md:pt-0 md:pl-2.5">
                    <AudioVisualizer analyser={analyser} isActive={isActive} variant="compact" />
                  </div>
                </div>
              </div>

              {/* End Round Action */}
              <button
                onClick={endRoundEarly}
                className="relative z-10 w-full mt-3.5 px-4 py-2 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 text-[10px] uppercase font-mono tracking-widest font-bold rounded-xl transition-all cursor-pointer active:scale-95 duration-100 flex items-center justify-center gap-1.5"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-pulse" />
                End Round
              </button>

            </div>
          )}

          {/* Idle screen config */}
          {gameState === "idle" && (
            <div className="p-6 md:p-8 rounded-3xl border border-white/5 bg-black/20 flex flex-col items-center justify-center text-center min-h-[220px]">
              <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/25 flex items-center justify-center mb-3 text-emerald-400 animate-pulse">
                <Music className="w-5 h-5" />
              </div>
              <h2 className="text-base md:text-lg font-black tracking-wider text-white mb-1 font-mono uppercase">
                FRETERNITY NOTE TRAINER
              </h2>
              <h3 className="text-xs font-semibold text-white/40 uppercase tracking-widest font-mono mb-2">
                Train your Fretboard Awareness
              </h3>
              <p className="text-xs text-white/40 max-w-sm leading-relaxed mb-4">
                Connect your microphone/USB interface, pluck the requested fret notes, and match pitches. Hit as many notes as you can before time runs out.
              </p>
              
              <div className="flex flex-wrap items-center justify-center gap-3 mt-2">
                <button
                  onClick={startGame}
                  disabled={getFretboardNotePool().length === 0}
                  className="px-6 py-2.5 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-30 disabled:hover:bg-emerald-500 text-black font-semibold font-mono text-xs uppercase tracking-wider rounded-xl transition-all cursor-pointer shadow-lg shadow-emerald-500/10 active:scale-95 duration-100 animate-pulse"
                >
                  START GAME
                </button>
                <button
                  onClick={onToggleConnect}
                  className={`flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-xs font-mono font-bold leading-none uppercase tracking-wider border transition-all cursor-pointer active:scale-95 duration-150 ${
                    isActive
                      ? "bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border-rose-500/20 shadow-[0_0_8px_rgba(239,68,68,0.08)]"
                      : "bg-amber-400 hover:bg-amber-300 text-black border-amber-400/20 shadow-md shadow-amber-500/10"
                  }`}
                >
                  {!isActive && <AlertTriangle className="w-3.5 h-3.5 text-black shrink-0 animate-bounce" />}
                  {isActive ? "Disconnect" : "Connect Input"}
                </button>
              </div>
            </div>
          )}

          {/* Game Over screen */}
          {gameState === "gameOver" && (
            <div className="p-8 rounded-3xl border border-rose-500/10 bg-black/25 flex flex-col items-center justify-center text-center min-h-[220px]">
              <span className="text-[9px] font-mono tracking-[0.3em] text-rose-500 uppercase font-black">
                ROUND COMPLETE
              </span>
              <h3 className="text-xl font-black text-white uppercase tracking-tight mt-1.5">
                GAME OVER
              </h3>
              
              <div className="grid grid-cols-3 gap-2.5 mt-5 w-full max-w-sm font-mono">
                <div className="bg-emerald-500/5 p-2 rounded-2xl border border-emerald-500/10">
                  <span className="text-[7px] text-emerald-400/50 block">CORRECT</span>
                  <span className="text-sm font-black text-emerald-400">{correctCount}</span>
                </div>
                <div className="bg-rose-500/5 p-2 rounded-2xl border border-rose-500/10">
                  <span className="text-[7px] text-rose-400/50 block">MISSED</span>
                  <span className="text-sm font-black text-rose-400/80">{missCount}</span>
                </div>
                <div className="bg-white/5 p-2 rounded-2xl border border-white/5">
                  <span className="text-[7px] text-white/30 block">ACCURACY</span>
                  <span className="text-sm font-black text-amber-400">
                    {correctCount + missCount > 0 
                      ? Math.round((correctCount / (correctCount + missCount)) * 100) 
                      : 0}%
                  </span>
                </div>
              </div>

                <div className="bg-[#12141A]/50 border border-white/5 rounded-2xl p-2 md:p-3 flex items-center justify-between gap-1 text-[10px] text-white/70 hover:bg-white/5 transition-all w-full max-w-sm mt-4">
                  <div className="flex flex-col items-start">
                    <span className="text-[7px] text-white/30 uppercase font-bold leading-none">Settings</span>
                    <span className="text-[9px] font-semibold text-white/50 mt-1 font-mono tracking-tight leading-none uppercase">
                      F{minFret}-F{maxFret} <span className="text-white/20">|</span> {matchExactOctave ? "EXACT" : "ANY"} <span className="text-white/20">|</span> {noteDuration}s
                    </span>
                  </div>
                  {missOnWrongNote && (
                    <span className="text-[7px] bg-rose-500/15 text-rose-400 px-1.5 py-0.5 rounded font-bold font-mono tracking-tight">
                      WRONG=MISS
                    </span>
                  )}
                </div>

              <div className="flex items-center gap-3 mt-6">
                <button
                  onClick={startGame}
                  className="px-5 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-black font-semibold font-mono text-xs uppercase tracking-widest rounded-xl transition-all cursor-pointer shadow-lg shadow-emerald-500/10"
                >
                  PLAY AGAIN
                </button>
                <button
                  onClick={stopGame}
                  className="px-4 py-2.5 bg-white/5 hover:bg-white/10 text-white/80 font-mono text-xs uppercase tracking-widest rounded-xl transition-all cursor-pointer border border-white/10"
                >
                  EXIT
                </button>
              </div>
            </div>
          )}

          {/* Interactive Fretboard Visual Guide (Only shown standalone when not playing!) */}
          {gameState !== "playing" && renderFretboardVisual(false)}

        </div>

        {/* Configuration settings panel (Columns 8-12) */}
        <div className="col-span-1 lg:col-span-5 flex flex-col gap-4">
          
          {/* Hi-Score History Panel */}
          <div className="bg-[#0C0E12]/80 border border-white/5 rounded-3xl p-4 flex flex-col gap-3 font-mono">
            <div className="flex items-center justify-between pb-2 border-b border-white/5">
              <span className="text-[10px] font-bold text-amber-400 uppercase tracking-[0.2em] flex items-center gap-1.5">
                <Trophy className="w-3.5 h-3.5 text-amber-400" />
                ROUND HISTORY (LAST 5)
              </span>
              {roundHistory.length > 0 && (
                <button 
                  onClick={() => {
                    setRoundHistory([]);
                    localStorage.removeItem("freternity_history");
                  }}
                  className="text-[8px] text-rose-400 hover:text-rose-300 transition-colors uppercase font-bold cursor-pointer"
                >
                  Clear
                </button>
              )}
            </div>

            {roundHistory.length === 0 ? (
              <div className="py-4 text-center text-[10px] text-white/35 leading-relaxed">
                No rounds logged yet. Complete a practice session to save your progress!
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {roundHistory.map((round, idx) => (
                  <div 
                    key={round.id || idx}
                    className="bg-black/20 border border-white/5 rounded-xl p-2.5 flex items-center justify-between gap-1 text-[10px] text-white/70 hover:bg-white/5 transition-all"
                  >
                    {/* Rank/Date & Accuracy */}
                    <div className="flex flex-col items-start min-w-[55px]">
                      <span className="text-[7.5px] text-white/30 uppercase font-bold leading-none">ROUND {roundHistory.length - idx}</span>
                      <span className="text-xs font-bold text-emerald-400 mt-1 leading-none">
                        {round.score <= 100 ? `${round.score}%` : "100%"}
                      </span>
                    </div>

                    {/* Correct & Streak */}
                    <div className="flex flex-col items-center">
                      <span className="text-[7.5px] text-white/30 uppercase leading-none">CORRECT/STREAK</span>
                      <span className="text-[10px] font-bold text-emerald-400 mt-1 leading-none">
                        {round.correct} hits <span className="text-white/40 font-normal">/</span> <span className="text-rose-400 font-bold">{round.streak} max</span>
                      </span>
                    </div>

                    {/* Fret Span */}
                    <div className="flex flex-col items-center">
                      <span className="text-[7.5px] text-white/30 uppercase leading-none">SPAN</span>
                      <span className="text-[10px] font-bold text-amber-300 mt-1 leading-none">{round.fretSpan}</span>
                    </div>

                    {/* Duration & Timeout Settings */}
                    <div className="flex flex-col items-end min-w-[55px]">
                      <span className="text-[7.5px] text-white/30 uppercase leading-none">PARAMS</span>
                      <span className="text-[9px] font-bold text-white/50 mt-1 leading-none">
                        {round.duration}s <span className="text-white/20">|</span> {round.timeout}s
                      </span>
                      {round.missOnWrongNote && (
                        <span className="text-[6.5px] bg-rose-500/15 text-rose-400 px-1 py-0.5 rounded mt-1 font-bold font-mono">WRONG=MISS</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Game Modifiers and sliders */}
          <div 
            onClick={() => {
              if (isParamsCollapsed) {
                setIsParamsCollapsed(false);
              }
            }}
            className={`bg-[#0C0E12]/80 border border-white/5 rounded-3xl p-4 md:p-5 flex flex-col gap-3 transition-all duration-300 select-none ${
              isParamsCollapsed ? "cursor-pointer hover:bg-[#11141A]/90 hover:border-white/10" : ""
            }`}
          >
            
            {/* Header / Collapse Trigger Button */}
            <button 
              onClick={() => setIsParamsCollapsed(!isParamsCollapsed)}
              className="flex items-center justify-between w-full pb-1 border-b border-white/5 text-left focus:outline-none cursor-pointer group select-none"
            >
              <span className="text-[10px] font-bold text-white/40 uppercase tracking-[0.2em] font-mono flex items-center gap-1.5 group-hover:text-white/75 transition-colors">
                <Sliders className="w-3.5 h-3.5 text-emerald-400" />
                TRAINER PARAMETERS
              </span>
              <div className="flex items-center gap-2">
                <ChevronDown className={`w-4 h-4 text-white/40 group-hover:text-white/70 transition-transform duration-200 ${isParamsCollapsed ? "" : "rotate-180"}`} />
              </div>
            </button>

            {/* Collapsed view summary of current settings */}
            {isParamsCollapsed && (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5 pt-1 text-[9.5px] font-mono select-none">
                <div className="bg-white/5 border border-white/5 p-1.5 rounded-lg flex flex-col justify-between">
                  <span className="text-[7px] text-white/30 uppercase leading-none mb-1">Instrument</span>
                  <span className="text-white/80 font-semibold truncate leading-none">
                    {currentPreset.name.split(' (')[0]}
                  </span>
                </div>
                <div className="bg-white/5 border border-white/5 p-1.5 rounded-lg flex flex-col justify-between">
                  <span className="text-[7px] text-white/30 uppercase leading-none mb-1">Fret Span</span>
                  <span className="text-emerald-400 font-bold leading-none">
                    F{minFret} &rarr; F{maxFret}
                  </span>
                </div>
                <div className="bg-white/5 border border-white/5 p-1.5 rounded-lg flex flex-col justify-between">
                  <span className="text-[7px] text-white/30 uppercase leading-none mb-1">Note Limit</span>
                  <span className="text-amber-400 font-semibold leading-none">
                    {noteDuration}s timeout
                  </span>
                </div>
                <div className="bg-white/5 border border-white/5 p-1.5 rounded-lg flex flex-col justify-between">
                  <span className="text-[7px] text-white/30 uppercase leading-none mb-1">Round Time</span>
                  <span className="text-white/80 font-semibold leading-none">
                    {roundDuration}s
                  </span>
                </div>
                <div className="bg-white/5 border border-white/5 p-1.5 rounded-lg flex flex-col justify-between">
                  <span className="text-[7px] text-white/30 uppercase leading-none mb-1">Visual Guide</span>
                  <span className={`font-semibold leading-none ${showFretboardGuide ? "text-emerald-400/80" : "text-amber-500/80"}`}>
                    {showFretboardGuide ? "GUIDE ON" : "BLIND MODE"}
                  </span>
                </div>
                <div className="bg-white/5 border border-white/5 p-1.5 rounded-lg flex flex-col justify-between">
                  <span className="text-[7px] text-white/30 uppercase leading-none mb-1">Precision</span>
                  <span className="text-white/80 font-semibold leading-none">
                    {matchExactOctave ? "EXACT OCTAVE" : "ANY OCTAVE"}
                  </span>
                </div>
                <div className="bg-white/5 border border-white/5 p-1.5 rounded-lg flex flex-col justify-between">
                  <span className="text-[7px] text-white/30 uppercase leading-none mb-1">Wrong Note</span>
                  <span className={`font-semibold leading-none ${missOnWrongNote ? "text-rose-400" : "text-white/40"}`}>
                    {missOnWrongNote ? "AUTO-MISS ON" : "NO PENALTY"}
                  </span>
                </div>
              </div>
            )}

            {/* Parameter Content (Hidden when collapsed) */}
            {!isParamsCollapsed && (
              <div className="flex flex-col gap-5 pt-2 animate-fade-in">
                {/* Instrument Selection Dropdown */}
                <div>
                  <label className="text-[9px] font-bold text-white/40 uppercase tracking-[0.2em] font-mono block mb-2">
                    ACTIVE INSTRUMENT (TUNING PRESET)
                  </label>
                  <div className="relative">
                    <select
                      value={currentPreset.id}
                      onChange={(e) => {
                        const preset = TUNING_PRESETS.find((p) => p.id === e.target.value);
                        if (preset) onPresetChange(preset);
                      }}
                      className="w-full bg-black/40 border border-[#ffffff15] hover:border-white/25 text-xs font-semibold rounded-xl px-4 py-2.5 outline-none appearance-none cursor-pointer transition-colors text-white/95"
                    >
                      {TUNING_PRESETS.map((preset) => (
                        <option key={preset.id} value={preset.id} className="bg-[#0c0e12] text-white">
                          {preset.name}
                        </option>
                      ))}
                    </select>
                    <div className="absolute inset-y-0 right-3.5 flex items-center pointer-events-none text-white/40">
                      <ChevronDown className="w-4 h-4" />
                    </div>
                  </div>
                </div>

                {/* Fret Range Selectors combined into a single visual dual-thumb slider control! */}
                <div>
                  <div className="flex justify-between items-center text-[10px] font-mono text-white/40 font-bold uppercase tracking-wider mb-2.5">
                    <span>INCLUDED FRETS SPAN</span>
                    <span className="text-emerald-400 font-bold bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-0.5 rounded-md">
                      F{minFret} &rarr; F{maxFret}
                    </span>
                  </div>

                  <div className="bg-black/20 border border-white/5 p-4 rounded-2xl flex flex-col gap-3 relative">
                    {/* Visual Fret Milestones labels */}
                    <div className="flex justify-between text-[8px] font-mono text-white/30 px-0.5 pointer-events-none select-none">
                      <span>F0 (OPEN)</span>
                      <span>F5</span>
                      <span>F10</span>
                      <span>F15 (MAX)</span>
                    </div>

                    <div className="relative w-full h-6 flex items-center">
                      {/* Track background */}
                      <div className="absolute inset-x-0 h-1 bg-black/60 rounded-full border border-white/5 pointer-events-none" />
                      
                      {/* Highlighted segment between min and max */}
                      <div 
                        className="absolute h-1 bg-emerald-500 rounded-full shadow-[0_0_8px_rgba(16,185,129,0.5)] pointer-events-none"
                        style={{
                          left: `${(minFret / 15) * 100}%`,
                          width: `${((maxFret - minFret) / 15) * 100}%`
                        }}
                      />

                      {/* Dual native inputs stacked with CSS helper classes for independent sliding */}
                      <input
                        type="range"
                        min="0"
                        max="15"
                        step="1"
                        value={minFret}
                        onChange={(e) => {
                          const val = Math.min(Number(e.target.value), maxFret);
                          setMinFret(val);
                        }}
                        className="absolute w-full h-1 bg-transparent appearance-none pointer-events-none cursor-pointer z-35 outline-none
                          [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-emerald-400 [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-[#12141A] [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:hover:scale-110 [&::-webkit-slider-thumb]:transition-transform
                          [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-emerald-400 [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-[#12141A] [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:shadow-md [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:hover:scale-110 [&::-moz-range-thumb]:transition-transform"
                      />
                      
                      <input
                        type="range"
                        min="0"
                        max="15"
                        step="1"
                        value={maxFret}
                        onChange={(e) => {
                          const val = Math.max(Number(e.target.value), minFret);
                          setMaxFret(val);
                        }}
                        className="absolute w-full h-1 bg-transparent appearance-none pointer-events-none cursor-pointer z-35 outline-none
                          [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-emerald-400 [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-[#12141A] [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:hover:scale-110 [&::-webkit-slider-thumb]:transition-transform
                          [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-emerald-400 [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-[#12141A] [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:shadow-md [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:hover:scale-110 [&::-moz-range-thumb]:transition-transform"
                      />
                    </div>
                    
                    <p className="text-[9px] text-white/30 font-mono text-center">
                      Drag left thumb for minimum fret, right thumb for maximum fret
                    </p>
                  </div>
                </div>

                {/* Configs for Note Countdown Target and Total Round Duration */}
                <div className="flex flex-col gap-4 pt-1">
                  
                  {/* Note Countdown duration slider */}
                  <div>
                    <div className="flex justify-between items-center text-[10px] font-mono text-white/40 font-bold uppercase tracking-wider mb-2">
                      <span>NOTE TIMEOUT</span>
                      <span className="text-emerald-400 font-bold bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-md">
                        {noteDuration} seconds
                      </span>
                    </div>
                    <div className="bg-black/20 border border-white/5 p-3 rounded-2xl">
                      <input
                        type="range"
                        min="3"
                        max="15"
                        step="1"
                        value={noteDuration}
                        onChange={(e) => setNoteDuration(Number(e.target.value))}
                        className="w-full h-1 bg-[#0C0E12] rounded-lg appearance-none cursor-pointer accent-emerald-500 outline-none"
                      />
                      <p className="text-[8px] text-white/30 font-mono mt-1 w-full text-center">
                        Seconds allowed per target note before registering a miss
                      </p>
                    </div>
                  </div>

                  {/* Total Round duration slider */}
                  <div>
                    <div className="flex justify-between items-center text-[10px] font-mono text-white/40 font-bold uppercase tracking-wider mb-2">
                      <span>TOTAL GAME ROUND DURATION</span>
                      <span className="text-emerald-400 font-bold bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-0.5 rounded-md">
                        {roundDuration}s ({Math.floor(roundDuration / 60)}m {roundDuration % 60}s)
                      </span>
                    </div>
                    <div className="bg-black/20 border border-white/5 p-3 rounded-2xl">
                      <input
                        type="range"
                        min="15"
                        max="180"
                        step="15"
                        value={roundDuration}
                        onChange={(e) => setRoundDuration(Number(e.target.value))}
                        className="w-full h-1 bg-[#0C0E12] rounded-lg appearance-none cursor-pointer accent-emerald-500 outline-none"
                      />
                      <p className="text-[8px] text-white/30 font-mono mt-1 w-full text-center">
                        Total round practice duration before practicing ends
                      </p>
                    </div>
                  </div>

                </div>

                {/* Smart game toggles */}
                <div className="flex flex-col gap-3 pt-2">
                  
                  {/* Toggle Fretboard Guide */}
                  <div className="flex items-center justify-between text-xs border-t border-white/5 pt-3">
                    <span className="font-mono text-[10px] text-white/55 uppercase tracking-wider">
                      Fretboard Highlight Guide
                    </span>
                    <button
                      onClick={() => setShowFretboardGuide(!showFretboardGuide)}
                      className={`flex items-center gap-1 text-[9px] font-bold font-mono px-2.5 py-1 rounded-md border transition-all cursor-pointer ${
                        showFretboardGuide
                          ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                          : "bg-[#0C0E12] text-white/30 border-white/5"
                      }`}
                    >
                      {showFretboardGuide ? (
                        <>
                          <Eye className="w-3.5 h-3.5" /> SHOW GUIDE
                        </>
                      ) : (
                        <>
                          <EyeOff className="w-3.5 h-3.5" /> BLIND MODE
                        </>
                      )}
                    </button>
                  </div>

                  {/* Toggle Octave constraint */}
                  <div className="flex items-center justify-between text-xs border-t border-white/5 pt-3">
                    <div className="flex flex-col">
                      <span className="font-mono text-[10px] text-white/55 uppercase tracking-wider">
                        Match Precision
                      </span>
                      <span className="text-[9px] text-white/30 leading-normal">
                        Requires exact octave match or matching any same note
                      </span>
                    </div>
                    <button
                      onClick={() => setMatchExactOctave(!matchExactOctave)}
                      className={`text-[9px] font-bold font-mono px-2.5 py-1 rounded-md border transition-all cursor-pointer ${
                        matchExactOctave
                          ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                          : "bg-[#0C0E12] text-white/30 border-white/5"
                      }`}
                    >
                      {matchExactOctave ? "EXACT OCTAVE" : "ANY OCTAVE"}
                    </button>
                  </div>

                  {/* Toggle Wrong Note as Miss */}
                  <div className="flex items-center justify-between text-xs border-t border-white/5 pt-3">
                    <div className="flex flex-col">
                      <span className="font-mono text-[10px] text-white/55 uppercase tracking-wider">
                        Wrong Note Penalty
                      </span>
                      <span className="text-[9px] text-white/30 leading-normal">
                        Plucking an incorrect note immediately triggers a miss
                      </span>
                    </div>
                    <button
                      onClick={() => setMissOnWrongNote(!missOnWrongNote)}
                      className={`text-[9px] font-bold font-mono px-2.5 py-1 rounded-md border transition-all cursor-pointer ${
                        missOnWrongNote
                          ? "bg-rose-500/10 text-rose-400 border-rose-500/20"
                          : "bg-[#0C0E12] text-white/30 border-white/5"
                      }`}
                    >
                      {missOnWrongNote ? "IMMEDIATE MISS" : "NO PENALTY"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
