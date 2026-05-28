import React from "react";
import { motion } from "motion/react";

interface TunerGaugeProps {
  centsOff: number; // -50 to +50
  confidence: number; // 0 to 1
  noteName: string;
  octave: number;
  frequency: number;
}

export default function TunerGauge({
  centsOff,
  confidence,
  noteName,
  octave,
  frequency,
}: TunerGaugeProps) {
  const isTooQuiet = frequency < 0;

  // Clamp cents between -50 and 50
  const clampedCents = Math.max(-50, Math.min(50, centsOff));

  // Determine indicator colors / states
  const absCents = Math.abs(clampedCents);
  let colorClass = "text-zinc-650";
  let textColor = "text-white/40";
  let glowColor = "rgba(255, 255, 255, 0)";
  let accentColorHex = "rgba(161, 161, 170, 0.45)"; // zinc-400 equivalent

  if (!isTooQuiet && confidence > 0) {
    if (absCents <= 3) {
      colorClass = "text-emerald-400";
      textColor = "text-emerald-400 font-bold drop-shadow-[0_0_15px_rgba(52,211,153,0.4)]";
      glowColor = "rgba(16, 185, 129, 0.12)";
      accentColorHex = "#10b981";
    } else if (absCents <= 12) {
      colorClass = "text-amber-400";
      textColor = "text-amber-400 font-medium drop-shadow-[0_0_15px_rgba(245,158,11,0.25)]";
      glowColor = "rgba(245, 158, 11, 0.08)";
      accentColorHex = "#f59e0b";
    } else {
      colorClass = "text-rose-400";
      textColor = "text-rose-400 font-medium drop-shadow-[0_0_15px_rgba(239,68,68,0.25)]";
      glowColor = "rgba(239, 68, 68, 0.08)";
      accentColorHex = "#ef4444";
    }
  }

  // Cents rotation range: -60deg to +60deg
  const rotationAngle = isTooQuiet ? 0 : (clampedCents / 50) * 60;

  return (
    <div className="flex flex-col items-center justify-center bg-[#12141A] rounded-3xl p-8 border border-white/10 shadow-2xl w-full max-w-md mx-auto relative overflow-hidden">
      {/* Subtle background visual grid */}
      <div 
        className="absolute inset-0 opacity-[0.02] pointer-events-none" 
        style={{ 
          backgroundImage: "radial-gradient(#fff 1px, transparent 1px)", 
          backgroundSize: "24px 24px" 
        }}
      />
      
      {/* Dynamic ambient halo */}
      <div
        className="absolute inset-0 transition-all duration-700 pointer-events-none"
        style={{
          background: `radial-gradient(circle at center, ${glowColor} 0%, rgba(10, 11, 14, 0) 75%)`
        }}
      />

      {/* Top Tag */}
      <div className="w-full flex items-center justify-between mb-4 z-10">
        <span className="text-[10px] font-mono tracking-[0.2em] text-white/40 uppercase">
          Tuning Indicator
        </span>
        <span className="text-[10px] font-mono tracking-[0.2em] text-white/50 uppercase flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${isTooQuiet ? "bg-white/10" : "bg-emerald-400 animate-pulse"}`} />
          {isTooQuiet ? "Standby" : "Lock"}
        </span>
      </div>

      {/* Semicircle Ticks Gauge */}
      <div className="w-full relative h-28 flex items-end justify-center z-10">
        {/* Track */}
        <svg className="absolute top-2 w-72 h-36 text-white/5" viewBox="0 0 200 100" fill="none">
          <path
            d="M20 90 A80 80 0 0 1 180 90"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
          />
          {/* Central target notch */}
          <path
            d="M93 11 A80 80 0 0 1 107 11"
            stroke="#10b981"
            strokeWidth="5"
            strokeLinecap="round"
          />

          {/* Symmetrical scale ticks */}
          {[-50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50].map((tick) => {
            const angleDeg = (tick / 50) * 60 - 90;
            const angleRad = (angleDeg * Math.PI) / 180;
            const rStart = 78;
            const rEnd = 86;
            const isCenter = tick === 0;

            const xSn = 100 + rStart * Math.cos(angleRad);
            const ySn = 90 + rStart * Math.sin(angleRad);
            const xEn = 100 + rEnd * Math.cos(angleRad);
            const yEn = 90 + rEnd * Math.sin(angleRad);

            return (
              <line
                key={tick}
                x1={xSn}
                y1={ySn}
                x2={xEn}
                y2={yEn}
                stroke={isCenter ? "#10b981" : Math.abs(tick) === 50 ? "#ef4444" : "rgba(255,255,255,0.15)"}
                strokeWidth={isCenter ? "2.5" : "1"}
              />
            );
          })}
        </svg>

        {/* Needle */}
        <motion.div
          className="absolute origin-bottom bottom-[10px] left-1/2 -ml-[1px] h-20 w-[2px]"
          animate={{ rotate: rotationAngle }}
          transition={{ type: "spring", stiffness: 100, damping: 15 }}
          style={{
            transformOrigin: "bottom center",
            background: isTooQuiet ? "rgba(255,255,255,0.15)" : accentColorHex,
            boxShadow: !isTooQuiet ? `0 0 10px ${accentColorHex}` : "none"
          }}
        />

        {/* Needle Pin */}
        <div className="absolute bottom-1 left-1/2 -ml-2.5 w-5 h-5 rounded-full bg-[#0C0E12] border border-white/10 flex items-center justify-center z-10">
          <div 
            className="w-1.5 h-1.5 rounded-full transition-colors duration-300" 
            style={{ backgroundColor: isTooQuiet ? "#3f3f46" : accentColorHex }}
          />
        </div>

        {/* Labels */}
        <div className="absolute bottom-2 left-6 text-[9px] font-mono tracking-widest text-white/30 uppercase">
          ♭ Flat
        </div>
        <div className="absolute bottom-2 right-6 text-[9px] font-mono tracking-widest text-white/30 uppercase">
          ♯ Sharp
        </div>
      </div>

      {/* Large Numerical & Note Letter Box */}
      <div className="mt-6 flex flex-col items-center justify-center select-none z-10 w-full min-h-[120px] bg-black/20 border border-white/5 rounded-2xl p-4">
        {isTooQuiet ? (
          <div className="flex flex-col items-center justify-center text-center py-2">
            <span className="text-xs font-mono tracking-[0.25em] text-white/30 animate-pulse uppercase">
              PLUCK BASS STRING
            </span>
            <span className="text-[10px] font-mono tracking-widest text-white/20 uppercase mt-1">
              LOW-FREQUENCY OPTIMIZED
            </span>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center w-full">
            <div className="flex items-baseline justify-center">
              <span className={`text-6xl font-black tracking-tighter transition-all duration-300 ${textColor}`}>
                {noteName}
              </span>
              <span className="text-2xl font-semibold text-white/30 ml-1.5 font-mono">
                {octave}
              </span>
            </div>

            {/* Micro Details and Cents */}
            <div className="flex items-center gap-3 mt-3">
              <span className="font-mono text-xs text-white/70 bg-white/5 border border-white/10 px-2.5 py-1 rounded-md">
                {frequency.toFixed(2)} Hz
              </span>

              <span className={`font-mono text-xs px-2.5 py-1 rounded-md border transition-all ${
                absCents <= 3 
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20 font-bold" 
                  : absCents <= 12
                  ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                  : "bg-rose-500/10 text-rose-400 border-rose-500/20"
              }`}>
                {centsOff === 0 ? "PERFECT" : centsOff > 0 ? `+${centsOff}¢` : `${centsOff}¢`}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Centered precision sub-bar indicator */}
      <div className="w-full mt-5 relative flex items-center justify-center">
        <div className="h-[2px] w-full bg-white/5 rounded-full overflow-hidden relative">
          <div
            className="absolute left-1/2 w-0.5 h-full bg-white/10 -translate-x-1/2"
            title="Ideal center"
          />
          <div
            className="h-full transition-all duration-150 absolute"
            style={{
              left: "50%",
              width: isTooQuiet ? "0%" : `${Math.abs(clampedCents) / 50 * 50}%`,
              transform: clampedCents < 0 ? "translateX(-110%)" : "none",
              backgroundColor: isTooQuiet 
                ? "transparent" 
                : absCents <= 3 
                ? "#10b981" 
                : absCents <= 12 
                ? "#f59e0b" 
                : "#ef4444"
            }}
          />
        </div>
      </div>
    </div>
  );
}

