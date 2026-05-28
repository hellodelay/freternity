import React, { useState, useEffect, useRef } from "react";
import { TUNING_PRESETS, TuningPreset, TunedNoteState } from "./types";
import { detectPitch, frequencyToNote } from "./utils/pitch";
import TunerGauge from "./components/TunerGauge";
import AudioVisualizer from "./components/AudioVisualizer";
import FretboardTrainer from "./components/FretboardTrainer";
import {
  Activity,
  Mic,
  Sliders,
  AlertCircle,
  Play,
  RotateCw,
  Info,
  ChevronDown,
  HelpCircle,
  ChevronUp,
  Settings,
  Waves
} from "lucide-react";

export default function App() {
  // Audio state
  const [isActive, setIsActive] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  
  // Audio nodes refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const splitterNodeRef = useRef<ChannelSplitterNode | null>(null);
  const lowpassFilterNodeRef = useRef<BiquadFilterNode | null>(null);
  const analyserNodeRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Playback monitor states
  const [playbackEnabled, setPlaybackEnabled] = useState(false);
  const [playbackVolume, setPlaybackVolume] = useState(0.20); // safe default feedback level
  const playbackGainNodeRef = useRef<GainNode | null>(null);

  // Configuration state
  const [selectedPreset, setSelectedPreset] = useState<TuningPreset>(TUNING_PRESETS[0]);
  const [noiseThreshold, setNoiseThreshold] = useState<number>(0.008); // volume gate
  const [inputChannel, setInputChannel] = useState<"sum" | "left" | "right">("sum");
  const [lowpassFilterEnabled, setLowpassFilterEnabled] = useState(true);
  const [lowpassFrequency, setLowpassFrequency] = useState(180); // 180Hz cuts higher harmonics
  const [showTroubleshooting, setShowTroubleshooting] = useState(false);
  const [showSetupPanel, setShowSetupPanel] = useState(false); // Collapsed by default

  // Detection output state
  const [pitchState, setPitchState] = useState<TunedNoteState>({
    noteName: "-",
    octave: 0,
    frequency: -1,
    centsOff: 0,
    targetFreq: 0,
    confidence: 0,
    nearestStringIndex: -1,
  });

  // Automatically update low-pass filter cutoff on instrument change
  useEffect(() => {
    if (selectedPreset.id === "6s_guitar") {
      setLowpassFrequency(450); // Cutoff 450Hz for standard guitar tracking range
    } else {
      setLowpassFrequency(180); // Default 180Hz for low bass fundamentals
    }
  }, [selectedPreset]);

  // Keep latest config in ref for the real-time loop to avoid closures issues
  const configRef = useRef({
    noiseThreshold,
    selectedPreset,
  });

  useEffect(() => {
    configRef.current = {
      noiseThreshold,
      selectedPreset,
    };
  }, [noiseThreshold, selectedPreset]);

  // Handle changing routing on-the-fly when input channel or filter changes
  const updateRouting = () => {
    if (!isActive || !audioContextRef.current || !sourceNodeRef.current) return;

    try {
      const ctx = audioContextRef.current;
      const source = sourceNodeRef.current;
      const filter = lowpassFilterNodeRef.current;
      const analyser = analyserNodeRef.current;

      if (!analyser) return;

      // Disconnect everything first to avoid duplicate routings
      source.disconnect();
      if (splitterNodeRef.current) {
        splitterNodeRef.current.disconnect();
      }
      if (filter) {
        filter.disconnect();
      }
      if (playbackGainNodeRef.current) {
        playbackGainNodeRef.current.disconnect();
      }

      // Establish Routing Node
      let inputSourceNode: AudioNode = source;

      if (inputChannel !== "sum") {
        // Create splitter if it doesn't exist
        if (!splitterNodeRef.current) {
          splitterNodeRef.current = ctx.createChannelSplitter(2);
        }
        
        const splitter = splitterNodeRef.current;
        source.connect(splitter);

        // Select Left (Channel 1) or Right (Channel 2)
        const channelIndex = inputChannel === "left" ? 0 : 1;
        
        // Use a temp gain node to route a single channel into our mono filter/analyser chain
        const monoGain = ctx.createGain();
        monoGain.gain.value = 1.0;
        
        splitter.connect(monoGain, channelIndex, 0);
        inputSourceNode = monoGain;
      }

      // Filter Routing
      if (lowpassFilterEnabled && filter) {
        filter.frequency.setValueAtTime(lowpassFrequency, ctx.currentTime);
        inputSourceNode.connect(filter);
        filter.connect(analyser);
      } else {
        inputSourceNode.connect(analyser);
      }

      // Playback Monitor routing
      playbackGainNodeRef.current = ctx.createGain();
      playbackGainNodeRef.current.gain.setValueAtTime(playbackEnabled ? playbackVolume : 0, ctx.currentTime);
      source.connect(playbackGainNodeRef.current);
      playbackGainNodeRef.current.connect(ctx.destination);
    } catch (e) {
      console.error("Failed to update audio routing:", e);
    }
  };

  // Re-run routing when user updates channel, filter, or playback options
  useEffect(() => {
    updateRouting();
  }, [inputChannel, lowpassFilterEnabled, lowpassFrequency, isActive, playbackEnabled, playbackVolume]);

  // Start Pitch Listening Stream
  const startTuner = async () => {
    try {
      setAudioError(null);

      // 1. Create AudioContext synchronously BEFORE any async await boundary
      // This is a crucial fix for iOS Safari/iPadOS where AudioContext must be initiated directly in the user click event handler
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioCtx();
      
      // Request raw, untouched mic/instrument feed with ideal stereo channel configurations
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 2 }
        },
      });

      streamRef.current = stream;
      audioContextRef.current = ctx;

      // 2. Setup Nodes
      const source = ctx.createMediaStreamSource(stream);
      sourceNodeRef.current = source;

      // Lowpass filter (blocks finger scrapes, upper buzzes)
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.value = lowpassFrequency;
      lowpassFilterNodeRef.current = lowpass;

      // High-precision Analyser
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 4096; // 4096 is optimal for low frequencies below 100Hz
      analyserNodeRef.current = analyser;

      setIsActive(true);

      // Trigger automatic connection logic
      setTimeout(() => {
        updateRouting();
        startDetectionLoop(ctx, analyser);
      }, 50);

    } catch (err: any) {
      console.error("Error accessing microphone/audio interface:", err);
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        setAudioError(
          "Microphone permission denied. Please allow camera/microphone access in your browser settings to tune your bass."
        );
      } else {
        setAudioError(
          `Unable to connect audio device: ${err.message || "Please check USB-C audio interface connections."}`
        );
      }
      setIsActive(false);
    }
  };

  const stopTuner = () => {
    setIsActive(false);
    
    // Stop mic stream tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    // Stop detection animation frame
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    // Close AudioContext
    if (audioContextRef.current) {
      audioContextRef.current.close().catch((e) => console.log(e));
      audioContextRef.current = null;
    }

    if (playbackGainNodeRef.current) {
      playbackGainNodeRef.current.disconnect();
      playbackGainNodeRef.current = null;
    }

    // Reset notes state
    setPitchState({
      noteName: "-",
      octave: 0,
      frequency: -1,
      centsOff: 0,
      targetFreq: 0,
      confidence: 0,
      nearestStringIndex: -1,
    });
  };

  // Autocorrelation pitch detection loop
  const startDetectionLoop = (ctx: AudioContext, analyser: AnalyserNode) => {
    const bufferLength = analyser.fftSize;
    const dataArray = new Float32Array(bufferLength);
    
    // Pitch state smoothing variables
    let lastStableFreq = -1;
    let frequencyHoldCounter = 0; // Number of quiet frames to hold last note before clearing

    const updatePitch = () => {
      if (ctx.state === "suspended") {
        ctx.resume();
      }

      analyser.getFloatTimeDomainData(dataArray);

      // Run optimized Pitch DSP
      const { frequency, confidence } = detectPitch(
        dataArray,
        ctx.sampleRate,
        configRef.current.noiseThreshold
      );

      if (frequency > 0 && confidence > 0.65) {
        // Reset hold counter since we have a solid peak
        frequencyHoldCounter = 12; // Hold for ~200ms of silence to avoid immediate flickering

        // Calculate pitch note parameters
        const noteDetails = frequencyToNote(frequency);

        // Find which string in our Active tuning preset is nearest
        const presetStrings = configRef.current.selectedPreset.strings;
        let nearestIdx = -1;
        let minDiff = Infinity;

        presetStrings.forEach((str, idx) => {
          // Check pitch difference
          const diff = Math.abs(frequency - str.frequency);
          if (diff < minDiff) {
            minDiff = diff;
            nearestIdx = idx;
          }
        });

        lastStableFreq = frequency;

        setPitchState({
          noteName: noteDetails.noteName,
          octave: noteDetails.octave,
          frequency: frequency,
          centsOff: noteDetails.centsOff,
          targetFreq: noteDetails.targetFreq,
          confidence: confidence,
          nearestStringIndex: nearestIdx,
        });
      } else {
        // No stable pitch. Evaluate holding note to prevent UI flickers during standard picking gaps
        if (frequencyHoldCounter > 0) {
          frequencyHoldCounter--;
        } else {
          lastStableFreq = -1;
          setPitchState({
            noteName: "-",
            octave: 0,
            frequency: -1,
            centsOff: 0,
            targetFreq: 0,
            confidence: 0,
            nearestStringIndex: -1,
          });
        }
      }

      animationFrameRef.current = requestAnimationFrame(updatePitch);
    };

    animationFrameRef.current = requestAnimationFrame(updatePitch);
  };

  // Clean on unmount
  useEffect(() => {
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  return (
    <div className="min-h-screen bg-[#0A0B0E] text-[#E0E2E5] flex flex-col font-sans select-none pb-12 relative overflow-x-hidden">
      {/* Background radial matrix grid */}
      <div 
        className="absolute inset-0 opacity-[0.03] pointer-events-none" 
        style={{ 
          backgroundImage: "radial-gradient(#fff 1px, transparent 1px)", 
          backgroundSize: "40px 40px" 
        }}
      />

      {/* Balanced, Full-Width Responsive Layout Container */}
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 md:px-6 py-2 md:py-4 flex flex-col gap-3 md:gap-4 relative z-10">
        
        {/* Audio interface diagnostic / setup instruction panels */}
        {audioError && (
          <div className="bg-rose-500/5 border border-rose-500/20 p-4 rounded-2xl flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
            <div>
              <h4 className="text-xs font-bold text-rose-400 font-mono uppercase tracking-[0.2em]">
                Audio Connection Access Warning
              </h4>
              <p className="text-xs text-rose-400/80 mt-1.5 leading-relaxed">
                {audioError}
              </p>
            </div>
          </div>
        )}

        {/* Core Interactive Fretboard Trainer Game */}
        <FretboardTrainer
          currentPreset={selectedPreset}
          pitchState={pitchState}
          isActive={isActive}
          analyser={analyserNodeRef.current}
          onToggleConnect={isActive ? stopTuner : startTuner}
          onPresetChange={setSelectedPreset}
        />

        {/* Collapsible Setup, Tuning & Signal processing Tools Panel wrapper */}
        <div className="bg-[#12141A] border border-[#ffffff0c] rounded-3xl p-6 shadow-xl">
          <button
            onClick={() => setShowSetupPanel(!showSetupPanel)}
            className="w-full flex items-center justify-between text-xs font-bold font-mono text-white/60 hover:text-white uppercase tracking-[0.2em] transition-colors cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <Settings className="w-4 h-4 text-emerald-400" />
              Calibration & Calibration Reference Tools
            </span>
            {showSetupPanel ? (
              <ChevronUp className="w-4 h-4 text-emerald-400 animate-pulse" />
            ) : (
              <ChevronDown className="w-4 h-4" />
            )}
          </button>

          {showSetupPanel && (
            <div className="mt-5 pt-5 border-t border-white/5 flex flex-col gap-6">
              <p className="text-[10px] text-white/40 leading-relaxed font-mono">
                Traditional dial gauge and reference frequencies. Tune your model strings and calibrate signal filters using this tools utility segment before trainer run.
              </p>
              
              <div className="flex items-center justify-center">
                <TunerGauge
                  centsOff={pitchState.centsOff}
                  confidence={pitchState.confidence}
                  noteName={pitchState.noteName}
                  octave={pitchState.octave}
                  frequency={pitchState.frequency}
                />
              </div>

              {/* Interface / Signal DSP Settings Area - Moved directly inside the tools segment! */}
              <div className="border-t border-white/5 pt-5 mt-2 flex flex-col lg:flex-row gap-6">
                
                <div className="flex-1 flex flex-col gap-5">
                  <div className="flex items-center gap-2">
                    <Sliders className="w-4 h-4 text-emerald-400" />
                    <h3 className="text-xs font-bold text-white/80 uppercase tracking-[0.15em] font-mono">
                      Signal Processing (DSP)
                    </h3>
                  </div>

                  {/* Input Port select */}
                  <div className="flex flex-col gap-2">
                    <span className="text-[10px] font-bold text-white/40 uppercase tracking-[0.2em] font-mono">
                      Input Routing
                    </span>
                    <p className="text-[10px] text-white/30">
                      Route multi-channel USB iOS audio interfaces appropriately
                    </p>
                    <div className="grid grid-cols-3 gap-1 bg-[#0C0E12] p-1 rounded-xl border border-white/5 max-w-md">
                      {[
                        { id: "sum", label: "MONO SUM" },
                        { id: "left", label: "CH 1 (L)" },
                        { id: "right", label: "CH 2 (R)" },
                      ].map((ch) => (
                        <button
                          key={ch.id}
                          onClick={() => setInputChannel(ch.id as any)}
                          className={`py-2 text-[10px] font-mono font-bold rounded-lg transition-all cursor-pointer ${
                            inputChannel === ch.id
                              ? "bg-white/5 text-emerald-400 border border-white/10"
                              : "text-white/40 hover:text-white/60"
                          }`}
                        >
                          {ch.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Noise Gate adjustment Slider */}
                  <div className="flex flex-col gap-2">
                    <div className="flex justify-between text-[10px] font-bold font-mono text-white/40">
                      <span className="uppercase tracking-[0.2em]">Gate Threshold</span>
                      <span className="text-emerald-400 font-semibold text-xs">
                        {(noiseThreshold * 1000).toFixed(0)} mVRMS
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0.001"
                      max="0.05"
                      step="0.001"
                      value={noiseThreshold}
                      onChange={(e) => setNoiseThreshold(parseFloat(e.target.value))}
                      className="w-full h-1 bg-[#0C0E12] rounded-lg appearance-none cursor-pointer accent-emerald-500 max-w-md"
                    />
                  </div>

                  {/* Instrument Playback Feedback */}
                  <div className="flex flex-col gap-2.5 border-t border-white/5 pt-3.5 mt-1">
                    <div className="flex items-center justify-between">
                      <div className="flex flex-col">
                        <span className="text-[10px] font-bold text-white/50 font-mono uppercase tracking-[0.2em]">
                          Instrument Monitoring
                        </span>
                        <p className="text-[10px] text-white/30 mt-0.5 leading-normal">
                          Play back pure instrument input through your speakers
                        </p>
                      </div>
                      <button
                        onClick={() => setPlaybackEnabled(!playbackEnabled)}
                        className={`text-[9px] font-mono font-bold px-2 py-1 rounded-md border transition-all cursor-pointer ${
                          playbackEnabled
                            ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                            : "bg-[#0C0E12] text-white/30 border-white/5"
                        }`}
                      >
                        {playbackEnabled ? "MONITORING" : "MUTED"}
                      </button>
                    </div>

                    {playbackEnabled && (
                      <div className="flex flex-col gap-1.5 max-w-md">
                        <div className="flex justify-between text-[8px] font-bold font-mono text-white/30">
                          <span className="uppercase tracking-widest">Feedback Volume</span>
                          <span>{Math.round(playbackVolume * 100)}%</span>
                        </div>
                        <input
                          type="range"
                          min="0.0"
                          max="1.0"
                          step="0.05"
                          value={playbackVolume}
                          onChange={(e) => setPlaybackVolume(parseFloat(e.target.value))}
                          className="w-full h-1 bg-[#0C0E12] rounded-lg appearance-none cursor-pointer accent-emerald-500"
                        />
                        <p className="text-[9px] text-amber-400/80 leading-normal bg-amber-400/5 border border-amber-400/10 p-2 rounded-lg font-mono">
                          ⚠️ Warning: Use headphones when turning up monitoring to prevent acoustic feedback loops.
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex-1 flex flex-col gap-4 border-l border-white/5 pl-0 lg:pl-6">
                  {/* Lowpass fundamental filter toggler */}
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <div className="flex flex-col">
                        <span className="text-[10px] font-bold text-white/50 font-mono uppercase tracking-[0.2em]">
                          DSP Tuning Filter
                        </span>
                        <p className="text-[10px] text-white/30 mt-0.5 leading-normal">
                          Attenuates finger buzzes and higher frequency noise
                        </p>
                      </div>
                      <button
                        onClick={() => setLowpassFilterEnabled(!lowpassFilterEnabled)}
                        className={`text-[9px] font-mono font-bold px-2 py-1 rounded-md border transition-all cursor-pointer ${
                          lowpassFilterEnabled
                            ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                            : "bg-[#0C0E12] text-white/30 border-white/5"
                        }`}
                      >
                        {lowpassFilterEnabled ? "ACTIVE" : "BYPASS"}
                      </button>
                    </div>

                    {lowpassFilterEnabled && (
                      <div className="flex items-start gap-2.5 bg-white/5 rounded-xl p-3 border border-white/5">
                        <Info className="w-3.5 h-3.5 text-white/40 shrink-0 mt-0.5" />
                        <p className="text-[10px] text-white/40 leading-relaxed">
                          Attenuation active above {lowpassFrequency}Hz. Auto-tuned for {selectedPreset.id === "6s_guitar" ? "6s guitar" : "bass"} frequency capture.
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Troubleshoot Input Panel to diagnose iPad USB-C interfaces */}
                  <div className="pt-2">
                    <button
                      onClick={() => setShowTroubleshooting(!showTroubleshooting)}
                      className="w-full flex items-center justify-between text-[10px] font-bold text-white/50 hover:text-white font-mono uppercase tracking-[0.2em] transition-colors cursor-pointer"
                    >
                      <span>No Input Detected? Troubleshooting Guidance</span>
                      {showTroubleshooting ? (
                        <ChevronUp className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <ChevronDown className="w-3.5 h-3.5" />
                      )}
                    </button>

                    {showTroubleshooting && (
                      <div className="mt-3 flex flex-col gap-3 bg-white/5 border border-white/5 p-4 rounded-2xl text-[10px] text-white/50 leading-relaxed">
                        <p>
                          <strong className="text-white/80">1. Open in a New Tab:</strong> Browser sandboxes restrict microphone access in iframes. Click the <strong className="text-emerald-400">arrow icon</strong> in the top-right corner of Google AI Studio to launch the tuner directly.
                        </p>
                        <p>
                          <strong className="text-white/80">2. Toggle Routing:</strong> USB interfaces send instrument lines on separate audio channels. Try changing <strong className="text-white">Input Routing</strong> to <strong className="text-emerald-400">CH 1 (L)</strong> or <strong className="text-emerald-400">CH 2 (R)</strong>.
                        </p>
                        <p>
                          <strong className="text-white/80">3. Physical Gain:</strong> Boost the physical preamp input knob on your interface until the signal registers in the Real-Time scope.
                        </p>
                        <p>
                          <strong className="text-white/80">4. Device Settings:</strong> Check settings to allow browser Microphone access.
                        </p>
                      </div>
                    )}
                  </div>

                </div>

              </div>

            </div>
          )}
        </div>

      </main>
    </div>
  );
}

