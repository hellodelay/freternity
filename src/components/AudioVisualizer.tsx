import React, { useEffect, useRef } from "react";

interface AudioVisualizerProps {
  analyser: AnalyserNode | null;
  isActive: boolean;
  variant?: "default" | "compact";
}

export default function AudioVisualizer({ analyser, isActive, variant = "default" }: AudioVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Set correct canvas hardware resolution
    const resizeCanvas = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
    };

    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);

    // Render loop
    const render = () => {
      if (!analyser || !isActive) {
        // Just draw a flat centered line when not active
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        animationRef.current = requestAnimationFrame(render);
        return;
      }

      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Float32Array(bufferLength);
      
      analyser.getFloatTimeDomainData(dataArray);

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Draw subtle background grid lines (Studio oscilloscope style)
      ctx.strokeStyle = "rgba(255, 255, 255, 0.03)";
      ctx.lineWidth = 1;
      
      // Horizontal grid lines
      for (let yOffset = 0.1; yOffset < 1.0; yOffset += 0.2) {
        ctx.beginPath();
        ctx.moveTo(0, height * yOffset);
        ctx.lineTo(width, height * yOffset);
        ctx.stroke();
      }

      // Vertical grid lines
      for (let xOffset = 0.1; xOffset < 1.0; xOffset += 0.1) {
        ctx.beginPath();
        ctx.moveTo(width * xOffset, 0);
        ctx.lineTo(width * xOffset, height);
        ctx.stroke();
      }

      // Center reference lines
      ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.stroke();

      // Draw Waveform with beautiful neon styling
      ctx.beginPath();
      ctx.lineWidth = 2.5;
      
      // Professional neon green/emerald gradient
      const gradient = ctx.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, "rgba(52, 211, 153, 0.4)"); // emerald-400
      gradient.addColorStop(0.5, "rgba(16, 185, 129, 0.95)"); // emerald-500
      gradient.addColorStop(1, "rgba(52, 211, 153, 0.4)");
      ctx.strokeStyle = gradient;

      // Glow effect shadow for professional CRT/hardware styling
      ctx.shadowBlur = 10;
      ctx.shadowColor = "rgba(16, 185, 129, 0.6)";

      const sliceWidth = width / bufferLength;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        // Amplifying somewhat safely
        const v = dataArray[i] * 1.6;
        const y = (v + 1) * (height / 2);

        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }

        x += sliceWidth;
      }

      ctx.lineTo(width, height / 2);
      ctx.stroke();

      // Reset shadows
      ctx.shadowBlur = 0;

      animationRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      window.removeEventListener("resize", resizeCanvas);
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [analyser, isActive]);

  if (variant === "compact") {
    return (
      <div className="w-full relative h-14 bg-black/25 rounded-xl border border-white/5 overflow-hidden flex items-center">
        <canvas
          ref={canvasRef}
          className="w-full h-full block"
        />
        {/* Subtle status overlay */}
        <div className="absolute top-1.5 right-2 font-mono text-[8px] uppercase tracking-widest text-white/35 pointer-events-none select-none">
          {isActive ? "LIVE SOURCE" : "STANDBY"}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-[#12141A] p-5 rounded-3xl border border-white/10 shadow-lg flex flex-col gap-3 w-full relative overflow-hidden">
      {/* Background design dots */}
      <div 
        className="absolute inset-0 opacity-[0.01] pointer-events-none" 
        style={{ 
          backgroundImage: "radial-gradient(#fff 1px, transparent 1px)", 
          backgroundSize: "24px 24px" 
        }}
      />

      <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.2em] text-white/50 px-1 z-10">
        <span>Real-Time FFT Waveform</span>
        <span className="flex items-center gap-1.5 font-semibold text-white/60">
          <span className={`w-1.5 h-1.5 rounded-full ${isActive ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)] animate-pulse" : "bg-white/10"}`} />
          {isActive ? "LIVE STREAM" : "STANDBY"}
        </span>
      </div>

      <canvas
        ref={canvasRef}
        className="w-full h-28 rounded-xl bg-black/20 border border-white/5 block z-10"
      />
    </div>
  );
}

