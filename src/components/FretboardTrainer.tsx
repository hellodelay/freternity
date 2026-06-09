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
  const [rightPanelExpanded, setRightPanelExpanded] = useState(false);
  const [roundHistory, setRoundHistory] = useState<RoundResult[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("freternity_history") || "[]");
    } catch (e) {
      return [];
    }
  });
  const roundLoggedRef = useRef(false);
  
  const [targetNotesQueue, setTargetNotesQueue] = useState<FretboardNote[]>([]);
  const targetNote = targetNotesQueue[0] || null;

  // Metronome states
  const [metronomeEnabled, setMetronomeEnabled] = useState(false);
  const [metronomeBpm, setMetronomeBpm] = useState(120);
  const [metronomeDivision, setMetronomeDivision] = useState<"quarter" | "half" | "whole">("quarter");
  const [currentBeat, setCurrentBeat] = useState(0); // 0, 1, 2, 3 visualization beats
  
  // Dual Timer states (Default Note Countdown Time derives from BPM!)
  const noteDuration = +(240 / metronomeBpm).toFixed(2);
  const [roundDuration, setRoundDuration] = useState(60); // total round configured
  
  const [noteTimeLeft, setNoteTimeLeft] = useState(2.0);
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

  // Refs for correct match hold time and ringing note detection
  const correctMatchStartTimeRef = useRef<number | null>(null);
  const previousTargetNoteRef = useRef<FretboardNote | null>(null);
  const targetNoteSetTimeRef = useRef<number>(0);

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

  const generateNotesQueue = (count: number, previousNote: FretboardNote | null = null): FretboardNote[] => {
    const pool = getFretboardNotePool();
    if (pool.length === 0) return [];
    const queue: FretboardNote[] = [];
    let lastNote = previousNote;
    for (let i = 0; i < count; i++) {
      const prev = lastNote;
      let filteredPool = pool.filter(n => 
        !prev || n.note !== prev.note || n.octave !== prev.octave
      );
      if (filteredPool.length === 0) filteredPool = pool;
      const randomNote = filteredPool[Math.floor(Math.random() * filteredPool.length)];
      queue.push(randomNote);
      lastNote = randomNote;
    }
    return queue;
  };

  // Setup/Fetch a new random target note
  const pickNewTargetNote = (previousNote: FretboardNote | null = null) => {
    const pool = getFretboardNotePool();
    if (pool.length === 0) return;

    if (previousNote) {
      previousTargetNoteRef.current = previousNote;
    }
    targetNoteSetTimeRef.current = Date.now();

    setTargetNotesQueue((prevQueue) => {
      const nextQueue = prevQueue.slice(1);
      const lastNote = nextQueue[nextQueue.length - 1] || previousNote;
      let filteredPool = pool.filter(n => 
        !lastNote || n.note !== lastNote.note || n.octave !== lastNote.octave
      );
      if (filteredPool.length === 0) filteredPool = pool;
      const randomNote = filteredPool[Math.floor(Math.random() * filteredPool.length)];
      return [...nextQueue, randomNote];
    });

    // Scale timer precisely to integer multiples of the beat duration based on streak
    // At streak <= 2: 4 beats. At streak 3 to 5: 3 beats. At streak >= 6: 2 beats.
    const beatDuration = 60 / metronomeBpm;
    const targetBeatsForStreak = streak >= 6 ? 2 : streak >= 3 ? 3 : 4;
    const newTime = targetBeatsForStreak * beatDuration;
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

    // Reset current beat tracker to 0 on new target note entry
    setCurrentBeat(0);

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
  }, [metronomeEnabled, metronomeBpm, metronomeDivision, gameState, targetNote]);

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
      const initialQueue = generateNotesQueue(12, null);
      setTargetNotesQueue(initialQueue);
      previousTargetNoteRef.current = null;
      targetNoteSetTimeRef.current = Date.now();
      correctMatchStartTimeRef.current = null;
    }
  };

  const stopGame = () => {
    setGameState("idle");
    setTargetNotesQueue([]);
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
        const updated = [newRound, ...prev].slice(0, 3);
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
        setNotesPlayedThisGame((prev) => prev + 1);
        
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
      if (correctMatchStartTimeRef.current === null) {
        correctMatchStartTimeRef.current = Date.now();
      }

      const elapsed = Date.now() - correctMatchStartTimeRef.current;
      if (elapsed < 750) {
        // Not held long enough (0.75s). Let subsequent updates check.
        return;
      }

      // Success! Held for >= 0.75s
      correctMatchStartTimeRef.current = null;
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
    } else {
      // If we are not matching the correct note, reset the hold start time
      correctMatchStartTimeRef.current = null;

      if (missOnWrongNote && isConfidenceHigh && detectedNoteName !== "-") {
        // Wrong note detected when parameter is active
        const now = Date.now();

        // Check if this detected wrong note is actually the previous note still ringing!
        const isPreviousRingingNote = previousTargetNoteRef.current && 
          (detectedNoteName === previousTargetNoteRef.current.note) &&
          (!matchExactOctave || detectedOctave === previousTargetNoteRef.current.octave);
        
        const timeSinceTargetChange = now - targetNoteSetTimeRef.current;
        const isGraceActive = timeSinceTargetChange < 1500;

        if (isGraceActive && isPreviousRingingNote) {
          // Ignore it while it is ringing out in the grace period!
          return;
        }

        const isCooldownOver = (now - lastWrongNoteTimeRef.current) > 900;
        const isDifferentNote = lastWrongNoteRef.current !== detectedNoteName;

        if (isCooldownOver || isDifferentNote) {
          lastWrongNoteRef.current = detectedNoteName;
          lastWrongNoteTimeRef.current = now;

          setMissCount((prev) => prev + 1);
          setStreak(0);
          setNotesPlayedThisGame((prev) => prev + 1);

          // Play brief buzz tone
          playSineTone(140, "sawtooth", 0.04, 0.25);

          // Pick next target note
          pickNewTargetNote(targetNote);
        }
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

  const isBass = currentPreset.id !== "6s_guitar";

  return (
    <div className="bg-[#12141A] border border-white/10 rounded-3xl p-3.5 md:p-5 shadow-2xl relative overflow-hidden flex flex-col gap-3 md:gap-4">
      {/* Decorative Matrix Header Dot */}
      <div className="absolute top-0 inset-x-0 h-[2px] bg-gradient-to-r from-emerald-500/0 via-emerald-400/30 to-emerald-500/0 animate-pulse" />

      {/* TOP PORTION: Full Horizontal Width (Top 2/3rds of space) */}
      <div className="w-full">
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

            {/* HUD / Score bar */}
            <div className="flex flex-col sm:flex-row items-center justify-between w-full border-b border-white/5 pb-3 mb-3 gap-2 z-10 relative">
              <div className="flex items-center gap-1.5 self-start">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span className="font-mono text-[9px] font-bold text-white/45 uppercase tracking-widest">
                  {successAnimation ? "Success Match!" : "Active Practice Note"}
                </span>
              </div>
              
              <div className="flex flex-wrap items-center gap-3 self-end justify-end">
                {/* Metronome HUD Toggle Button */}
                <button
                  type="button"
                  onClick={() => setMetronomeEnabled(!metronomeEnabled)}
                  className={`py-1 px-3 rounded-xl flex items-center gap-1.5 text-[10px] font-mono border transition-all cursor-pointer active:scale-95 duration-100 ${
                    metronomeEnabled
                      ? "bg-emerald-500/15 border-emerald-500/25 text-emerald-400"
                      : "bg-black/40 border-white/5 text-white/45 hover:bg-white/5"
                  }`}
                >
                  <Music className={`w-3.5 h-3.5 ${metronomeEnabled ? "animate-pulse text-emerald-400" : "text-white/30"}`} />
                  <span className="text-white/25 text-[8px] uppercase">CLICK:</span>
                  <span className="font-extrabold">{metronomeEnabled ? "ON" : "OFF"}</span>
                </button>

                <div className="bg-black/40 border border-white/5 py-1 px-3 rounded-xl flex items-center gap-2 text-[10px] font-mono">
                  <span className="text-white/25 text-[8px] uppercase">ROUND TIME:</span>
                  <span className="text-emerald-400 font-extrabold">{Math.max(0, Math.ceil(roundTimeLeft))}s</span>
                </div>
                <div className="bg-black/40 border border-white/5 py-1 px-3 rounded-xl flex items-center gap-2 text-[10px] font-mono">
                  <span className="text-white/25 text-[8px] uppercase">STREAK:</span>
                  <span className="text-rose-455 font-black">{streak}</span>
                </div>
                <div className="bg-black/40 border border-[#ffffff10] py-1 px-3 rounded-xl flex items-center gap-2 text-[10px] font-mono">
                  <span className="text-white/25 text-[8px] uppercase">OK/MISS:</span>
                  <span className="text-emerald-400 font-bold">{correctCount}/{missCount}</span>
                </div>
                
                {/* Audio visualizer */}
                <div className="hidden sm:flex items-center gap-1.5 border-l border-white/10 pl-3 h-5">
                  <AudioVisualizer analyser={analyser} isActive={isActive} variant="compact" />
                </div>

                <button
                  onClick={endRoundEarly}
                  className="px-3 py-1 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 text-[9px] uppercase font-mono tracking-wider font-bold rounded-lg transition-all cursor-pointer active:scale-95 duration-100 flex items-center gap-1"
                >
                  <span className="w-1 h-1 rounded-full bg-rose-400 animate-pulse" />
                  Stop
                </button>
              </div>
            </div>

            {/* Target Note Panel + Sheet Music Horizontal Container */}
            <div className="w-full flex flex-col md:flex-row gap-4 items-stretch select-none z-10">
              {/* Left Panel: Target Note Display + Draining Timer Circle */}
              <div className="flex-shrink-0 w-full md:w-[180px] bg-black/25 border border-white/5 rounded-2xl p-4 flex flex-col items-center justify-center relative overflow-hidden min-h-[180px]">
                <div className="relative w-36 h-36 flex items-center justify-center">
                  <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 100 100">
                    <circle
                      cx="50"
                      cy="50"
                      r="40"
                      className="stroke-white/5 fill-none"
                      strokeWidth="6"
                    />
                    <circle
                      cx="50"
                      cy="50"
                      r="40"
                      className={`fill-none ${
                        noteTimeLeft < 2.5 ? "stroke-rose-500 drop-shadow-[0_0_6px_rgba(244,63,94,0.4)]" : "stroke-emerald-400 drop-shadow-[0_0_6px_rgba(52,211,153,0.4)]"
                      }`}
                      style={{
                        transition: noteTimeLeft >= ((streak >= 6 ? 2 : streak >= 3 ? 3 : 4) * (60 / metronomeBpm)) - 0.05 ? "none" : "stroke-dashoffset 0.05s linear, stroke 0.15s ease"
                      }}
                      strokeWidth="6"
                      strokeDasharray="251.3"
                      strokeDashoffset={251.3 * (1 - (noteTimeLeft / ((streak >= 6 ? 2 : streak >= 3 ? 3 : 4) * (60 / metronomeBpm))))}
                      strokeLinecap="round"
                    />
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span className={`text-5xl font-black tracking-tight select-none pointer-events-none transition-colors duration-155 ${
                      noteTimeLeft < 2.5 ? "text-rose-400 animate-pulse" : "text-emerald-400"
                    }`}>
                      {targetNote.note}
                    </span>
                    <span className="text-[9px] font-mono text-white/30 uppercase font-semibold mt-1">
                      OCTAVE {targetNote.octave}
                    </span>
                  </div>
                </div>
              </div>

              {/* Right Panel: Main Sheet Music content */}
              <div className="flex-1 bg-black/15 border border-white/5 rounded-2xl p-4 min-h-[180px] overflow-hidden flex flex-col justify-center items-center relative">
                <div className="w-full h-full flex flex-col justify-between relative overflow-hidden select-none">
                  {/* SVG Canvas for Sheet Music */}
                  <svg className="w-full h-[180px]" viewBox="0 0 700 180" xmlns="http://www.w3.org/2000/svg">
                    <defs>
                      <radialGradient id="playheadGlow" cx="50%" cy="50%" r="50%">
                        <stop offset="0%" stopColor="#10b981" stopOpacity="0.4" />
                        <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
                      </radialGradient>
                    </defs>

                    {/* Five horizontal musical staff lines representing E4, G4, B4, D5, F5 */}
                    {[70, 80, 90, 100, 110].map((yLine, index) => (
                      <line
                        key={index}
                        x1="20"
                        y1={yLine}
                        x2="680"
                        y2={yLine}
                        stroke="rgba(255, 255, 255, 0.15)"
                        strokeWidth="1.2"
                      />
                    ))}

                    {/* Clef Symbol (Bass for bass, Treble for guitar) */}
                    <text
                      x="35"
                      y={isBass ? "102" : "112"}
                      className="fill-emerald-400 text-5xl font-serif select-none pointer-events-none opacity-85"
                    >
                      {isBass ? "𝄢" : "𝄞"}
                    </text>

                    {/* Target Intersect Playback Zone (Vertical Bar) */}
                    <rect
                      x="80"
                      y="20"
                      width="20"
                      height="140"
                      fill="url(#playheadGlow)"
                      className="pointer-events-none"
                    />
                    
                    <line
                      x1="90"
                      y1="25"
                      x2="90"
                      y2="155"
                      stroke="#10b981"
                      strokeWidth="5"
                      strokeLinecap="round"
                      opacity={successAnimation ? 0.6 : 0.2}
                      className={successAnimation ? "animate-pulse" : ""}
                    />
                    
                    <line
                      x1="90"
                      y1="25"
                      x2="90"
                      y2="155"
                      stroke={successAnimation ? "#34d399" : "#10b981"}
                      strokeWidth="2"
                      strokeLinecap="round"
                      opacity="0.95"
                    />

                    {/* Display the next 8 notes in the target notes queue */}
                    {targetNotesQueue.slice(0, 8).map((note, i) => {
                      const NOTE_ORDER = ["C", "D", "E", "F", "G", "A", "B"];
                      const baseNote = note.note.replace("#", "");
                      const hasSharp = note.note.includes("#");
                      const noteIndex = NOTE_ORDER.indexOf(baseNote);
                      
                      let Y;
                      if (isBass) {
                        // Bass Clef: middle line is D3
                        const stepsFromC3 = noteIndex + (note.octave - 3) * 7;
                        Y = 90 - (stepsFromC3 - 1) * 5;
                      } else {
                        // Treble Clef: middle line is B4
                        const stepsFromC4 = noteIndex + (note.octave - 4) * 7;
                        Y = 90 - (stepsFromC4 - 6) * 5;
                      }

                      // Calculate scrolling horizontally
                      const noteSpacing = 74;
                      const x = 90 + i * noteSpacing + (noteTimeLeft / noteDuration) * noteSpacing;

                      if (x < 15 || x > 690) return null;

                      const isCurrentlyActive = i === 0;
                      const isSuccess = isCurrentlyActive && successAnimation;

                      // Ledger lines detection
                      const ledgerLines: number[] = [];
                      if (Y >= 120) {
                        for (let ly = 120; ly <= Y; ly += 10) {
                          ledgerLines.push(ly);
                        }
                      } else if (Y <= 60) {
                        for (let ly = 60; ly >= Y; ly -= 10) {
                          ledgerLines.push(ly);
                        }
                      }

                      const stemDir = Y <= 90 ? "down" : "up";
                      const absoluteIndex = notesPlayedThisGame + i;

                      return (
                        <g key={note.midi + "-" + i} className="transition-all duration-75">
                          {/* Draw a barline separator before this note if it starts a new measure / group of 4 notes */}
                          {absoluteIndex % 4 === 0 && absoluteIndex > 0 && (x - 37) >= 60 && (x - 37) <= 675 && (
                            <g>
                              {/* Vertical bar line crossing staff lines: Y=70 to Y=110. Slightly taller (Y=62 to Y=118) for elegant view */}
                              <line
                                x1={x - 37}
                                y1="62"
                                x2={x - 37}
                                y2="118"
                                stroke="rgba(255, 255, 255, 0.45)"
                                strokeWidth="2.5"
                                strokeLinecap="square"
                              />
                              {/* Label indicating the measure number */}
                              <text
                                x={x - 37}
                                y="52"
                                className="fill-white/45 font-mono text-[8px] font-bold text-center select-none"
                                textAnchor="middle"
                              >
                                M{Math.floor(absoluteIndex / 4) + 1}
                              </text>
                            </g>
                          )}

                          {/* Render ledger lines under/over the notehead */}
                          {ledgerLines.map((ly) => (
                            <line
                              key={ly}
                              x1={x - 14}
                              y1={ly}
                              x2={x + 14}
                              y2={ly}
                              stroke="rgba(255, 255, 255, 0.45)"
                              strokeWidth="1.2"
                            />
                          ))}

                          {/* Stem line */}
                          <line
                            x1={stemDir === "up" ? x + 7.2 : x - 7.2}
                            y1={Y}
                            x2={stemDir === "up" ? x + 7.2 : x - 7.2}
                            y2={stemDir === "up" ? Y - 26 : Y + 26}
                            stroke={isSuccess ? "#34d399" : isCurrentlyActive ? "rgba(255, 255, 255, 0.9)" : "rgba(255, 255, 255, 0.45)"}
                            strokeWidth="1.2"
                          />

                          {/* Sharp Accidental Sign */}
                          {hasSharp && (
                            <text
                              x={x - 18}
                              y={Y + 4}
                              className={`text-[12px] font-sans font-black select-none pointer-events-none ${
                                isSuccess ? "fill-emerald-400 animate-pulse" : isCurrentlyActive ? "fill-white" : "fill-white/60"
                              }`}
                            >
                              ♯
                            </text>
                          )}

                          {/* Note Head (Tilted Ellipse) */}
                          <ellipse
                            cx={x}
                            cy={Y}
                            rx="7.5"
                            ry="5.2"
                            transform={`rotate(-20 ${x} ${Y})`}
                            className={`transition-colors duration-200 outline-none ${
                              isSuccess 
                                ? "fill-emerald-400 stroke-emerald-300 stroke-2 drop-shadow-[0_0_8px_#34d399]" 
                                : isCurrentlyActive 
                                  ? noteTimeLeft < 2.5 
                                    ? "fill-rose-500 stroke-rose-300 font-bold" 
                                    : "fill-emerald-500 stroke-emerald-300"
                                  : "fill-white/70 stroke-white/20"
                            }`}
                          />

                          {/* Active pulse aura for Note 0 */}
                          {isCurrentlyActive && !isSuccess && (
                            <ellipse
                              cx={x}
                              cy={Y}
                              rx="11"
                              ry="8.8"
                              transform={`rotate(-20 ${x} ${Y})`}
                              fill="none"
                              className={`stroke-2 animate-ping opacity-60 ${
                                noteTimeLeft < 2.5 ? "stroke-rose-500" : "stroke-emerald-400"
                              }`}
                              style={{ animationDuration: "1.5s" }}
                            />
                          )}

                          {/* Letter name of note displayed directly above the note */}
                          <text
                            x={x}
                            y={Y - 14}
                            className={`text-[9px] font-black font-mono select-none pointer-events-none text-center ${
                              isSuccess 
                                ? "fill-emerald-300 text-[10px]" 
                                : isCurrentlyActive 
                                  ? "fill-white" 
                                  : "fill-white/45"
                            }`}
                            textAnchor="middle"
                          >
                            {note.note}
                          </text>
                          
                          {/* Octave number drawn smaller beside the letter */}
                          <text
                            x={x + 10}
                            y={Y - 14}
                            className={`text-[6.5px] font-semibold font-mono select-none pointer-events-none text-center ${
                              isSuccess ? "fill-emerald-400" : isCurrentlyActive ? "fill-white/60" : "fill-white/35"
                            }`}
                            textAnchor="start"
                          >
                            {note.octave}
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                </div>
              </div>

            </div>
          </div>
        )}

        {/* Idle screen config */}
        {gameState === "idle" && isParamsCollapsed && (
          <div className="p-6 md:p-8 rounded-3xl border border-white/5 bg-[#0C0E12]/85 flex flex-col md:flex-row items-center justify-between gap-6 min-h-[170px] md:min-h-[220px]">
            <div className="flex flex-col items-start text-left max-w-lg">
              <div className="w-10 h-10 rounded-full bg-emerald-500/10 border border-emerald-500/25 flex items-center justify-center mb-3 text-emerald-400">
                <Music className="w-4 h-4 animate-pulse" />
              </div>
              <h2 className="text-base md:text-xl font-black tracking-wider text-white mb-1 font-mono uppercase">
                FRETERNITY NOTE TRAINER
              </h2>
              <h3 className="text-xs font-semibold text-white/40 uppercase tracking-widest font-mono mb-2">
                Train your Fretboard Awareness
              </h3>
              <p className="text-xs text-white/40 leading-relaxed">
                Connect your microphone/USB interface, pluck the requested fret notes, and match pitches. Hit as many notes as you can before time runs out.
              </p>
            </div>

            <div className="flex flex-col items-center gap-3 min-w-[220px] bg-black/30 p-4 rounded-2xl border border-white/5 w-full md:w-auto">
              {/* Real-time Oscilloscope/Waveform preview in idle mode */}
              <div className="w-full flex flex-col items-center gap-1 border-b border-white/5 pb-3">
                <span className="text-[8px] font-mono text-white/30 uppercase tracking-wide">Live Audio Signal</span>
                <div className="w-full h-8 flex items-center">
                  <AudioVisualizer analyser={analyser} isActive={isActive} variant="compact" />
                </div>
              </div>

              <div className="flex flex-col gap-2 w-full font-mono">
                <button
                  onClick={startGame}
                  disabled={getFretboardNotePool().length === 0}
                  className="w-full py-2.5 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-30 disabled:hover:bg-emerald-500 text-black font-semibold text-xs uppercase tracking-wider rounded-xl transition-all cursor-pointer shadow-lg shadow-emerald-500/10 active:scale-95 duration-100"
                >
                  START TRAINING
                </button>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={onToggleConnect}
                    className={`flex items-center justify-center gap-1 w-full py-2 rounded-xl text-[9px] font-bold leading-none uppercase tracking-wider border transition-all cursor-pointer active:scale-95 duration-150 ${
                      isActive
                        ? "bg-rose-500/15 hover:bg-rose-500/25 text-rose-450 border-rose-500/20"
                        : "bg-[#090A0D] hover:bg-[#12141a]/80 text-white/75 border-white/5"
                    }`}
                  >
                    {!isActive && <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0" />}
                    {isActive ? "Disconnect" : "Connect"}
                  </button>
                  <button
                    onClick={() => setIsParamsCollapsed(false)}
                    className="flex items-center justify-center gap-1.5 w-full py-2 rounded-xl text-[9px] font-bold leading-none uppercase tracking-wider border border-emerald-500/25 bg-emerald-500/5 text-emerald-400 transition-all cursor-pointer active:scale-95 text-center font-mono"
                  >
                    <Sliders className="w-3 h-3" />
                    Configure
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Game Over screen - only visible when parameters are collapsed */}
        {gameState === "gameOver" && isParamsCollapsed && (
          <div className="p-6 md:p-8 rounded-3xl border border-rose-500/10 bg-[#0C0E12]/80 grid grid-cols-1 lg:grid-cols-12 gap-6 items-center justify-between min-h-[220px]">
            
            {/* Left Column: Final Round Report */}
            <div className="lg:col-span-7 flex flex-col justify-center items-start text-left">
              <span className="text-[9px] font-mono tracking-[0.3em] text-rose-500 uppercase font-black mb-1">
                ROUND COMPLETE
              </span>
              <h3 className="text-xl md:text-2xl font-black text-white uppercase tracking-tight font-mono">
                GAME OVER
              </h3>
              <p className="text-xs text-white/40 mt-1 max-w-sm mb-4">
                Excellent effort! Practice regularly to improve speed, muscle memory, and note visual recall.
              </p>
              
              <div className="grid grid-cols-3 gap-2.5 w-full max-w-sm font-mono">
                <div className="bg-emerald-500/5 p-2 rounded-xl border border-emerald-500/10 flex flex-col justify-center items-center">
                  <span className="text-[7.5px] text-emerald-400/50 block font-bold">CORRECT</span>
                  <span className="text-sm font-black text-emerald-400">{correctCount}</span>
                </div>
                <div className="bg-rose-500/5 p-2 rounded-xl border border-rose-500/10 flex flex-col justify-center items-center">
                  <span className="text-[7.5px] text-rose-400/50 block font-bold">MISSED</span>
                  <span className="text-sm font-black text-rose-400/80">{missCount}</span>
                </div>
                <div className="bg-white/5 p-2 rounded-xl border border-white/5 flex flex-col justify-center items-center">
                  <span className="text-[7.5px] text-white/30 block font-bold">ACCURACY</span>
                  <span className="text-sm font-black text-amber-500">
                    {correctCount + missCount > 0 
                      ? Math.round((correctCount / (correctCount + missCount)) * 100) 
                      : 0}%
                  </span>
                </div>
              </div>

              {/* Action Controls */}
              <div className="flex flex-wrap items-center gap-3 mt-6 font-mono">
                <button
                  onClick={startGame}
                  className="px-5 py-2.5 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-30 disabled:hover:bg-emerald-500 text-black font-semibold text-xs uppercase tracking-widest rounded-xl transition-all cursor-pointer shadow-lg shadow-emerald-500/10 active:scale-95 duration-100"
                >
                  PLAY AGAIN
                </button>
                <button
                  onClick={stopGame}
                  className="px-4 py-2.5 bg-white/5 hover:bg-white/10 text-white/80 text-xs uppercase tracking-widest rounded-xl transition-all cursor-pointer border border-white/10 active:scale-95 duration-100"
                >
                  EXIT TO LOBBY
                </button>
                <button
                  onClick={() => setIsParamsCollapsed(false)}
                  className="px-4 py-2.5 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 text-xs uppercase tracking-widest rounded-xl transition-all cursor-pointer border border-emerald-500/20 active:scale-95 duration-100"
                >
                  SETTINGS
                </button>
              </div>
            </div>

            {/* Right Column: Round History Log */}
            <div className="lg:col-span-5 flex flex-col lg:border-l border-t lg:border-t-0 border-white/5 pt-5 lg:pt-0 lg:pl-6 text-left h-full justify-start">
              <div className="flex items-center justify-between pb-2 border-b border-white/5 mb-3 font-mono">
                <span className="text-[10px] font-bold text-amber-400 uppercase tracking-[0.2em] flex items-center gap-1.5">
                  <Trophy className="w-3.5 h-3.5 text-amber-400" />
                  ROUND HISTORY (LAST 3)
                </span>
                {roundHistory.length > 0 && (
                  <button 
                    onClick={() => {
                      setRoundHistory([]);
                      localStorage.removeItem("freternity_history");
                    }}
                    className="text-[8px] text-rose-400 hover:text-rose-300 transition-colors uppercase font-bold cursor-pointer"
                  >
                    Clear Log
                  </button>
                )}
              </div>

              <div className="flex flex-col gap-2.5">
                {roundHistory.length === 0 ? (
                  <div className="py-8 text-center text-[10px] text-white/35 leading-relaxed font-mono">
                    No rounds logged yet. Complete a practice session to save your progress!
                  </div>
                ) : (
                  roundHistory.slice(0, 3).map((round, idx) => (
                    <div 
                      key={round.id || idx}
                      className="bg-black/20 border border-white/5 rounded-xl p-2 md:p-2.5 flex items-center justify-between gap-1 text-[9.5px] font-mono text-white/70 hover:bg-white/5 transition-all"
                    >
                      {/* Round Index & Score */}
                      <div className="flex flex-col items-start font-mono">
                        <span className="text-[7.5px] text-white/30 uppercase font-bold leading-none font-sans">ROUND {roundHistory.length - idx}</span>
                        <span className="text-xs font-bold text-emerald-400 mt-1 leading-none">
                          {round.score <= 100 ? `${round.score}%` : "100%"}
                        </span>
                      </div>

                      {/* Accuracy details */}
                      <div className="flex flex-col items-center">
                        <span className="text-[7.5px] text-white/30 uppercase leading-none font-sans">HITS/MAX</span>
                        <span className="font-bold text-emerald-400 mt-1 leading-none">
                          {round.correct} <span className="text-white/30">/</span> <span className="text-rose-400">{round.streak}</span>
                        </span>
                      </div>

                      {/* Parameters */}
                      <div className="flex flex-col items-end">
                        <span className="text-[7.5px] text-white/30 uppercase leading-none font-sans font-bold2">SPAN | TEMPO</span>
                        <span className="font-semibold text-white/60 mt-1 leading-none">
                          {round.fretSpan} <span className="text-white/20">|</span> {round.timeout}s
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

          </div>
        )}

        {/* Expanded Trainer Parameters Panel - Shown in full main panel space when config is open and not playing */}
        {gameState !== "playing" && !isParamsCollapsed && (
          <div className="p-5 md:p-6 rounded-3xl border border-emerald-500/10 bg-[#0C0E12]/90 flex flex-col gap-4 min-h-[300px] animate-fade-in text-left">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-white/5 pb-3 gap-2">
              <div className="flex flex-col">
                <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-widest font-mono flex items-center gap-1.5 mb-0.5 animate-pulse">
                  <Sliders className="w-4 h-4 text-emerald-400" />
                  CONFIGURE PRACTICE PARAMETERS
                </span>
                <span className="text-[9px] text-white/40 font-mono">Adjust tuning standard, boundaries, click tempo, and accuracy guides</span>
              </div>
              <button
                type="button"
                onClick={() => setIsParamsCollapsed(true)}
                className="px-4 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-black font-extrabold font-mono text-[10px] uppercase rounded-xl transition-all cursor-pointer shadow-lg shadow-emerald-500/10 active:scale-95 duration-100"
              >
                APPLY & CLOSE
              </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
              {/* Left Column: Instrument & Range settings */}
              <div className="flex flex-col gap-4">
                {/* Instrument Setup & Preset selection */}
                <div className="flex flex-col gap-2 font-mono">
                  <label className="text-[10px] font-mono text-white/40 font-bold uppercase tracking-wider">
                    Instrument Tuning Preset
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
                    {TUNING_PRESETS.map((p) => {
                      const isSel = currentPreset.id === p.id;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => onPresetChange(p)}
                          className={`py-2 rounded-xl font-mono text-[9px] font-extrabold uppercase transition-all border cursor-pointer border-white/5 hover:bg-white/5 ${
                            isSel
                              ? "bg-emerald-500/15 text-emerald-400 border-emerald-400/30 font-black shadow-[0_0_10px_rgba(16,185,129,0.05)]"
                              : "bg-black/25 text-white/45"
                          }`}
                        >
                          {p.name.split(" (")[0]}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Target Fretboard boundaries */}
                <div className="flex flex-col gap-2 font-mono">
                  <div className="flex justify-between items-center text-[10px] font-mono text-white/40 font-bold uppercase tracking-wider">
                    <span>ACTIVE FRET BOUNDARY</span>
                    <span className="font-extrabold text-white font-mono shrink-0 bg-white/5 px-2 py-0.5 rounded border border-white/5 text-[9px]">
                      FRET {minFret} TO {maxFret} ({maxFret - minFret + 1} FRETS)
                    </span>
                  </div>
                  <div className="bg-black/25 border border-white/5 rounded-2xl p-3.5 flex flex-col gap-3">
                    {/* Min fret adjustment range */}
                    <div className="flex items-center gap-3 w-full">
                      <span className="text-[8.5px] text-white/40 font-mono w-14 uppercase">Min Fret:</span>
                      <input
                        type="range"
                        min="0"
                        max="11"
                        value={minFret}
                        onChange={(e) => setMinFret(Math.min(maxFret, Number(e.target.value)))}
                        className="flex-1 h-1 bg-[#12141A] rounded-lg appearance-none cursor-pointer accent-emerald-500 outline-none"
                      />
                      <span className="text-[10px] font-extrabold font-mono text-emerald-400 w-4 text-right">
                        F{minFret}
                      </span>
                    </div>
                    {/* Max fret adjustment range */}
                    <div className="flex items-center gap-3 w-full">
                      <span className="text-[8.5px] text-white/40 font-mono w-14 uppercase">Max Fret:</span>
                      <input
                        type="range"
                        min="3"
                        max="15"
                        value={maxFret}
                        onChange={(e) => setMaxFret(Math.max(minFret, Number(e.target.value)))}
                        className="flex-1 h-1 bg-[#12141A] rounded-lg appearance-none cursor-pointer accent-emerald-500 outline-none"
                      />
                      <span className="text-[10px] font-extrabold font-mono text-emerald-400 w-4 text-right">
                        F{maxFret}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Total Practice Session Limits */}
                <div className="flex flex-col gap-2 font-mono">
                  <div className="flex justify-between items-center text-[10px] font-mono text-white/45 font-bold uppercase tracking-wider">
                    <span>ROUND PRACTICE DURATION</span>
                    <span className="text-emerald-400 text-[9px] font-bold bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-md">
                      {roundDuration}s ({Math.floor(roundDuration / 60)}m {roundDuration % 60}s)
                    </span>
                  </div>
                  <div className="bg-black/25 border border-white/5 rounded-2xl p-3">
                    <input
                      type="range"
                      min="15"
                      max="180"
                      step="15"
                      value={roundDuration}
                      onChange={(e) => setRoundDuration(Number(e.target.value))}
                      className="w-full h-1 bg-[#12141A] rounded-lg appearance-none cursor-pointer accent-emerald-500 outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* Right Column: Metronome / Click & Toggles */}
              <div className="flex flex-col gap-4 font-mono">
                {/* Tempo & Metronome Controls */}
                <div className="bg-black/25 border border-white/5 p-4 rounded-xl flex flex-col gap-3 font-mono">
                  <div className="flex justify-between items-center text-[9px] font-mono text-white/45 font-bold uppercase tracking-wider">
                    <span>CLICK SPEED & METRONOME</span>
                    <span className="text-emerald-400 font-bold bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-0.5 rounded-md flex items-center gap-1 shrink-0 animate-pulse">
                      <Music className="w-3.5 h-3.5 text-emerald-400" />
                      {metronomeBpm} BPM
                    </span>
                  </div>

                  {/* Beats Pulse visual helper */}
                  <div className="flex items-center justify-between text-[8px] font-mono text-white/35">
                    <span>BEATS GUIDE</span>
                    <div className="flex gap-1.5 font-mono">
                      {[0, 1, 2, 3].map((b) => (
                        <span
                          key={b}
                          className="w-1.5 h-1.5 rounded-full bg-white/10"
                        />
                      ))}
                    </div>
                  </div>

                  {/* Steppers & Slider */}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setMetronomeBpm((prev) => Math.max(45, prev - 5))}
                      className="w-8 h-8 rounded-xl bg-[#090A0D] hover:bg-white/5 border border-white/5 text-xs text-white/70 font-mono font-bold flex items-center justify-center cursor-pointer select-none active:scale-90 transition-all text-center"
                    >
                      -
                    </button>
                    <div className="flex-1">
                      <input
                        type="range"
                        min="45"
                        max="220"
                        step="5"
                        value={metronomeBpm}
                        onChange={(e) => setMetronomeBpm(Number(e.target.value))}
                        className="w-full h-1 bg-[#090A0D] rounded-lg appearance-none cursor-pointer accent-emerald-500 outline-none"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => setMetronomeBpm((prev) => Math.min(220, prev + 5))}
                      className="w-8 h-8 rounded-xl bg-[#090A0D] hover:bg-white/5 border border-white/5 text-xs text-white/70 font-mono font-bold flex items-center justify-center cursor-pointer select-none active:scale-90 transition-all text-center"
                    >
                      +
                    </button>
                  </div>

                  {/* Toggle and click divisions */}
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setMetronomeEnabled(!metronomeEnabled)}
                      className={`py-2 px-2.5 text-[9px] font-black font-mono rounded-xl border transition-all flex items-center justify-center gap-1.5 cursor-pointer select-none active:scale-95 duration-100 ${
                        metronomeEnabled
                          ? "bg-emerald-500/15 text-emerald-400 border-emerald-400/30"
                          : "bg-[#090A0D] text-white/35 border-white/5 hover:bg-white/5"
                      }`}
                    >
                      <div className={`w-1.5 h-1.5 rounded-full ${metronomeEnabled ? "bg-emerald-400 animate-ping" : "bg-white/30"}`} />
                      CLICK: {metronomeEnabled ? "ON" : "OFF"}
                    </button>

                    <button
                      type="button"
                      onClick={() => setMetronomeDivision((prev) => prev === "quarter" ? "half" : prev === "half" ? "whole" : "quarter")}
                      className="py-2 px-2.5 bg-[#090A0D] hover:bg-white/5 border border-white/5 rounded-xl font-mono text-[9px] font-bold text-white/60 cursor-pointer select-none transition-all active:scale-95 text-center"
                    >
                      RATE: {metronomeDivision === "quarter" ? "Quarters" : metronomeDivision === "half" ? "Halves" : "Wholes"}
                    </button>
                  </div>

                  <div className="text-[8.5px] text-white/35 font-mono text-center border-t border-white/5 pt-2">
                    <span>Speed limits whole notes to: </span>
                    <span className="text-emerald-400 font-bold">{noteDuration}s</span>
                  </div>
                </div>

                {/* Precision & Guidelines Toggles */}
                <div className="flex flex-col gap-2.5 border-t border-white/5 pt-3">
                  {/* Show Board Guides */}
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex flex-col">
                      <span className="font-mono text-[10px] text-white/55 uppercase tracking-wider">
                        Fretboard Guides
                      </span>
                      <span className="text-[9px] text-white/30 leading-normal font-mono">
                        Fret notes and positions light up during practice
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowFretboardGuide(!showFretboardGuide)}
                      className={`text-[9px] font-bold font-mono px-2.5 py-1 rounded-md border transition-all cursor-pointer ${
                        showFretboardGuide
                          ? "bg-emerald-500/10 text-emerald-400 border-emerald-400/20"
                          : "bg-[#0C0E12]"
                      }`}
                    >
                      {showFretboardGuide ? "ACTIVE" : "HIDDEN"}
                    </button>
                  </div>

                  {/* Exact Octave Match */}
                  <div className="flex items-center justify-between text-xs border-t border-white/5 pt-2.5">
                    <div className="flex flex-col">
                      <span className="font-mono text-[10px] text-white/55 uppercase tracking-wider">
                        Octaves Pairing
                      </span>
                      <span className="text-[9px] text-white/30 leading-normal font-mono">
                        Requires exact pitch octave match (strict) or allow any octave
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setMatchExactOctave(!matchExactOctave)}
                      className={`text-[9px] font-bold font-mono px-2.5 py-1 rounded-md border transition-all cursor-pointer ${
                        matchExactOctave
                          ? "bg-emerald-500/10 text-emerald-400 border-emerald-400/20"
                          : "bg-[#0C0E12] text-white/30 border-white/5"
                      }`}
                    >
                      {matchExactOctave ? "EXACT MATCH" : "ANY OCTAVE"}
                    </button>
                  </div>

                  {/* Strict Mode Match */}
                  <div className="flex items-center justify-between text-xs border-t border-white/5 pt-2.5">
                    <div className="flex flex-col font-mono">
                      <span className="font-mono text-[10px] text-white/55 uppercase tracking-wider">
                        STRICT MODE
                      </span>
                      <span className="text-[9px] text-white/30 leading-normal font-mono">
                        Plucking incorrect notes triggers instant failure for the target
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setMissOnWrongNote(!missOnWrongNote)}
                      className={`text-[9px] font-bold font-mono px-2.5 py-1 rounded-md border transition-all cursor-pointer ${
                        missOnWrongNote
                          ? "bg-rose-500/10 text-rose-400 border-rose-500/20"
                          : "bg-[#0C0E12] text-white/30 border-white/5"
                      }`}
                    >
                      {missOnWrongNote ? "STRICT" : "NORMAL"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* BOTTOM SECTION: Shared Row (Bottom 1/3 of space) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 md:gap-6 items-stretch w-full">
        {/* Left: Interactive Fretboard Visualizer (Column Span 8) */}
        <div className="col-span-1 lg:col-span-8 flex flex-col justify-start">
          {renderFretboardVisual(false)}
        </div>

        {/* Right: Trainer Parameters (Column Span 4) */}
        <div className="col-span-1 lg:col-span-4 flex flex-col">
          {!rightPanelExpanded ? (
            <div className="bg-[#0C0E12]/80 border border-white/5 rounded-3xl p-4 md:p-5 flex flex-col justify-between select-none h-full min-h-[220px] text-left">
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between border-b border-white/5 pb-2">
                  <span className="text-[10px] font-bold text-white/55 uppercase tracking-widest font-mono flex items-center gap-1.5">
                    <Sliders className="w-3.5 h-3.5 text-emerald-400" />
                    TRAINER SETTINGS
                  </span>
                  <button
                    type="button"
                    onClick={() => setRightPanelExpanded(true)}
                    className="text-[8px] font-bold text-emerald-400 hover:text-emerald-300 bg-emerald-500/10 px-1.5 py-0.5 rounded font-mono uppercase tracking-wider cursor-pointer"
                  >
                    EXPAND
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-x-4 gap-y-3.5 text-[9px] font-mono leading-tight pt-1">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-white/30 uppercase text-[8px]">Tuning</span>
                    <span className="text-white/85 font-bold truncate">{currentPreset.name.split(" (")[0]}</span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-white/30 uppercase text-[8px]">Active Range</span>
                    <span className="text-white/85 font-bold">Frets {minFret} - {maxFret}</span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-white/30 uppercase text-[8px]">Tempo & Click</span>
                    <span className="text-white/85 font-bold truncate">{metronomeBpm} BPM {metronomeEnabled ? "(On)" : "(Off)"}</span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-white/30 uppercase text-[8px]">Practice mode</span>
                    <span className="text-white/85 font-bold">{missOnWrongNote ? "Strict Match" : "Normal Match"}</span>
                  </div>
                </div>

                <div className="border-t border-white/5 pt-2 mt-1.5 flex justify-between text-white/40 text-[8px] font-mono">
                  <span>GUIDES: <strong className={showFretboardGuide ? "text-emerald-400" : "text-white/40"}>{showFretboardGuide ? "ON" : "OFF"}</strong></span>
                  <span>OCTAVE: <strong className={matchExactOctave ? "text-emerald-400" : "text-white/40"}>{matchExactOctave ? "EXACT" : "ANY"}</strong></span>
                </div>
              </div>

              {/* Configure Parameters Button */}
              <button
                type="button"
                onClick={() => setIsParamsCollapsed(false)}
                className="w-full mt-3 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/25 rounded-xl font-mono text-[9px] font-bold uppercase transition-all duration-150 active:scale-95 cursor-pointer text-center flex items-center justify-center gap-1"
              >
                <Sliders className="w-3 h-3" />
                Configure Parameters
              </button>
            </div>
          ) : (
            <div className="bg-[#0C0E12]/85 border border-white/5 rounded-3xl p-4 md:p-5 flex flex-col gap-3.5 select-none h-full justify-start text-left">
              <div className="flex items-center justify-between border-b border-white/5 pb-2">
                <span className="text-[10px] font-bold text-white/55 uppercase tracking-widest font-mono flex items-center gap-1.5">
                  <Sliders className="w-3.5 h-3.5 text-emerald-400" />
                  TRAINER PARAMETERS
                </span>
                <button
                  type="button"
                  onClick={() => setRightPanelExpanded(false)}
                  className="text-[8px] text-emerald-400 hover:text-emerald-300 transition-colors uppercase font-bold cursor-pointer"
                >
                  Collapse Panel
                </button>
              </div>

              {/* Instrument Setup & Preset selection */}
              <div className="flex flex-col gap-2">
                <label className="text-[10px] font-mono text-white/40 font-bold uppercase tracking-wider">
                  Instrument Tuning
                </label>
                <div className="grid grid-cols-3 gap-1.5">
                  {TUNING_PRESETS.map((p) => {
                    const isSel = currentPreset.name === p.name;
                    return (
                      <button
                        key={p.name}
                        onClick={() => onPresetChange(p)}
                        className={`py-1.5 rounded-xl font-mono text-[9px] font-extrabold uppercase transition-all border cursor-pointer border-white/5 hover:bg-white/5 ${
                          isSel
                            ? "bg-emerald-500/15 text-emerald-400 border-emerald-400/30"
                            : "bg-black/25 text-white/45"
                        }`}
                      >
                        {p.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Target Fretboard boundaries */}
              <div className="flex flex-col gap-2">
                <div className="flex justify-between items-center text-[10px] font-mono text-white/40 font-bold uppercase tracking-wider">
                  <span>ACTIVE FRET BOUNDARY</span>
                  <span className="font-extrabold text-white font-mono shrink-0 bg-white/5 px-2 py-0.5 rounded border border-white/5">
                    FRET {minFret} TO {maxFret} ({maxFret - minFret + 1} FRETS)
                  </span>
                </div>
                <div className="bg-black/25 border border-white/5 rounded-2xl p-3 flex flex-col gap-3">
                  {/* Min fret adjustment range */}
                  <div className="flex items-center gap-3 w-full">
                    <span className="text-[8.5px] text-white/40 font-mono w-14 uppercase">Min Fret:</span>
                    <input
                      type="range"
                      min="0"
                      max="11"
                      value={minFret}
                      onChange={(e) => setMinFret(Math.min(maxFret, Number(e.target.value)))}
                      className="flex-1 h-1 bg-[#12141A] rounded-lg appearance-none cursor-pointer accent-emerald-500 outline-none"
                    />
                    <span className="text-[10px] font-extrabold font-mono text-emerald-400 w-4 text-right">
                      F{minFret}
                    </span>
                  </div>
                  {/* Max fret adjustment range */}
                  <div className="flex items-center gap-3 w-full">
                    <span className="text-[8.5px] text-white/40 font-mono w-14 uppercase">Max Fret:</span>
                    <input
                      type="range"
                      min="3"
                      max="15"
                      value={maxFret}
                      onChange={(e) => setMaxFret(Math.max(minFret, Number(e.target.value)))}
                      className="flex-1 h-1 bg-[#12141A] rounded-lg appearance-none cursor-pointer accent-emerald-500 outline-none"
                    />
                    <span className="text-[10px] font-extrabold font-mono text-emerald-400 w-4 text-right">
                      F{maxFret}
                    </span>
                  </div>
                </div>
              </div>

              {/* Tempo & Metronome Controls */}
              <div className="bg-black/25 border border-white/5 p-3.5 rounded-2xl flex flex-col gap-3">
                <div className="flex justify-between items-center text-[9px] font-mono text-white/45 font-bold uppercase tracking-wider">
                  <span>CLICK SPEED & METRONOME</span>
                  <span className="text-emerald-400 font-bold bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-0.5 rounded-md flex items-center gap-1 shrink-0">
                    <Music className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
                    {metronomeBpm} BPM
                  </span>
                </div>

                {/* Beats Pulse visual helper */}
                <div className="flex items-center justify-between text-[8px] font-mono text-white/35">
                  <span>BEATS GUIDE</span>
                  <div className="flex gap-1.5">
                    {[0, 1, 2, 3].map((b) => (
                      <span
                        key={b}
                        className={`w-1.5 h-1.5 rounded-full transition-all duration-100 ${
                          metronomeEnabled && gameState === "playing" && currentBeat === b
                            ? b === 0
                              ? "bg-emerald-400 scale-125 shadow-[0_0_8px_#10b981]"
                              : "bg-emerald-500/70 scale-110"
                            : "bg-white/10"
                        }`}
                      />
                    ))}
                  </div>
                </div>

                {/* Steppers & Slider */}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setMetronomeBpm((prev) => Math.max(45, prev - 5))}
                    className="w-8 h-8 rounded-xl bg-[#090A0D] hover:bg-white/5 border border-white/5 text-xs text-white/70 font-mono font-bold flex items-center justify-center cursor-pointer select-none active:scale-90 transition-all text-center"
                  >
                    -
                  </button>
                  <div className="flex-1">
                    <input
                      type="range"
                      min="45"
                      max="220"
                      step="5"
                      value={metronomeBpm}
                      onChange={(e) => setMetronomeBpm(Number(e.target.value))}
                      className="w-full h-1 bg-[#090A0D] rounded-lg appearance-none cursor-pointer accent-emerald-500 outline-none"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setMetronomeBpm((prev) => Math.min(220, prev + 5))}
                    className="w-8 h-8 rounded-xl bg-[#090A0D] hover:bg-white/5 border border-white/5 text-xs text-white/70 font-mono font-bold flex items-center justify-center cursor-pointer select-none active:scale-90 transition-all text-center"
                  >
                    +
                  </button>
                </div>

                {/* Toggle and click divisions */}
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setMetronomeEnabled(!metronomeEnabled)}
                    className={`py-2 px-2.5 text-[9px] font-black font-mono rounded-xl border transition-all flex items-center justify-center gap-1.5 cursor-pointer select-none active:scale-95 duration-100 ${
                      metronomeEnabled
                        ? "bg-emerald-500/15 text-emerald-400 border-emerald-400/30"
                        : "bg-[#090A0D] text-white/35 border-white/5 hover:bg-white/5"
                    }`}
                  >
                    <div className={`w-1.5 h-1.5 rounded-full ${metronomeEnabled ? "bg-emerald-400 animate-ping" : "bg-white/30"}`} />
                    CLICK: {metronomeEnabled ? "ON" : "OFF"}
                  </button>

                  <button
                    type="button"
                    onClick={() => setMetronomeDivision((prev) => prev === "quarter" ? "half" : prev === "half" ? "whole" : "quarter")}
                    className="py-2 px-2.5 bg-[#090A0D] hover:bg-white/5 border border-white/5 rounded-xl font-mono text-[9px] font-bold text-white/60 cursor-pointer select-none transition-all active:scale-95 text-center"
                  >
                    RATE: {metronomeDivision === "quarter" ? "Quarters" : metronomeDivision === "half" ? "Halves" : "Wholes"}
                  </button>
                </div>

                <div className="text-[8.5px] text-white/35 font-mono text-center border-t border-white/5 pt-2">
                  <span>Speed limits whole notes to: </span>
                  <span className="text-emerald-400 font-bold">{noteDuration}s</span>
                </div>
              </div>

              {/* Total Practice Session Limits */}
              <div className="flex flex-col gap-2">
                <div className="flex justify-between items-center text-[10px] font-mono text-white/40 font-bold uppercase tracking-wider">
                  <span>ROUND duration</span>
                  <span className="text-emerald-400 font-bold bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-md">
                    {roundDuration}s ({Math.floor(roundDuration / 60)}m {roundDuration % 60}s)
                  </span>
                </div>
                <div className="bg-black/25 border border-white/5 rounded-2xl p-3">
                  <input
                    type="range"
                    min="15"
                    max="180"
                    step="15"
                    value={roundDuration}
                    onChange={(e) => setRoundDuration(Number(e.target.value))}
                    className="w-full h-1 bg-[#12141A] rounded-lg appearance-none cursor-pointer accent-emerald-500 outline-none"
                  />
                </div>
              </div>

              {/* Precision & Guidelines Toggles */}
              <div className="flex flex-col gap-2.5 border-t border-white/5 pt-3">
                {/* Show Board Guides */}
                <div className="flex items-center justify-between text-xs">
                  <div className="flex flex-col">
                    <span className="font-mono text-[10px] text-white/55 uppercase tracking-wider">
                      Fretboard Guides
                    </span>
                    <span className="text-[9px] text-white/30 leading-normal">
                      Fret hints light up during play
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowFretboardGuide(!showFretboardGuide)}
                    className={`text-[9px] font-bold font-mono px-2.5 py-1 rounded-md border transition-all cursor-pointer ${
                      showFretboardGuide
                        ? "bg-emerald-500/10 text-emerald-400 border-emerald-400/20"
                        : "bg-[#0C0E12] text-white/30 border-white/5"
                    }`}
                  >
                    {showFretboardGuide ? "ACTIVE" : "HIDDEN"}
                  </button>
                </div>

                {/* Exact Octave Match */}
                <div className="flex items-center justify-between text-xs border-t border-white/5 pt-2.5">
                  <div className="flex flex-col">
                    <span className="font-mono text-[10px] text-white/55 uppercase tracking-wider">
                      Octaves Tuning
                    </span>
                    <span className="text-[9px] text-white/30 leading-normal">
                      Requires exact pitch octave matching
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setMatchExactOctave(!matchExactOctave)}
                    className={`text-[9px] font-bold font-mono px-2.5 py-1 rounded-md border transition-all cursor-pointer ${
                      matchExactOctave
                        ? "bg-emerald-500/10 text-emerald-400 border-emerald-400/20"
                        : "bg-[#0C0E12] text-white/30 border-white/5"
                    }`}
                  >
                    {matchExactOctave ? "EXACT MATCH" : "ANY MATCH"}
                  </button>
                </div>

                {/* Strict Mode Match */}
                <div className="flex items-center justify-between text-xs border-t border-white/5 pt-2.5">
                  <div className="flex flex-col">
                    <span className="font-mono text-[10px] text-white/55 uppercase tracking-wider">
                      STRICT PRACTICE
                    </span>
                    <span className="text-[9px] text-white/30 leading-normal">
                      Wrong plucks trigger instant misses
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setMissOnWrongNote(!missOnWrongNote)}
                    className={`text-[9px] font-bold font-mono px-2.5 py-1 rounded-md border transition-all cursor-pointer ${
                      missOnWrongNote
                        ? "bg-rose-500/10 text-rose-400 border-rose-500/20"
                        : "bg-[#0C0E12] text-white/30 border-white/5"
                    }`}
                  >
                    {missOnWrongNote ? "STRICT" : "NORMAL"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
