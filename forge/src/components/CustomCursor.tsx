"use client";

import { useEffect, useRef, useState } from "react";

export function CustomCursor() {
  const dotRef = useRef<HTMLDivElement | null>(null);
  const ringRef = useRef<HTMLDivElement | null>(null);
  const coordsRef = useRef<HTMLDivElement | null>(null);

  const [isPointerDevice, setIsPointerDevice] = useState(false);
  const [isHovering, setIsHovering] = useState(false);
  const [isClicking, setIsClicking] = useState(false);
  const [coords, setCoords] = useState({ x: 0, y: 0 });

  const mousePos = useRef({ x: -100, y: -100 });
  const ringPos = useRef({ x: -100, y: -100 });

  useEffect(() => {
    // Only engage custom cursor if device has a fine pointer (mouse/trackpad)
    if (window.matchMedia("(pointer: fine)").matches) {
      setIsPointerDevice(true);
      document.body.classList.add("custom-cursor-hide");
    }

    const handleMouseMove = (e: MouseEvent) => {
      mousePos.current = { x: e.clientX, y: e.clientY };

      // Update dot immediately
      if (dotRef.current) {
        dotRef.current.style.transform = `translate3d(${e.clientX}px, ${e.clientY}px, 0)`;
      }

      // Check if hovering interactive element
      const target = e.target as HTMLElement | null;
      if (target) {
        const interactive = Boolean(
          target.closest("button") ||
            target.closest("a") ||
            target.closest("[role='button']") ||
            target.closest("input") ||
            target.closest("canvas")
        );
        setIsHovering(interactive);
      }
    };

    const handleMouseDown = () => setIsClicking(true);
    const handleMouseUp = () => setIsClicking(false);

    window.addEventListener("mousemove", handleMouseMove, { passive: true });
    window.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("mouseup", handleMouseUp);

    // Smooth lerp loop for the outer reticle ring & technical HUD
    let animId: number;
    let frameCount = 0;

    const render = () => {
      animId = requestAnimationFrame(render);

      // Lerp ring position towards mouse position (0.22 damping)
      ringPos.current.x += (mousePos.current.x - ringPos.current.x) * 0.22;
      ringPos.current.y += (mousePos.current.y - ringPos.current.y) * 0.22;

      if (ringRef.current) {
        ringRef.current.style.transform = `translate3d(${ringPos.current.x}px, ${ringPos.current.y}px, 0)`;
      }

      if (coordsRef.current) {
        coordsRef.current.style.transform = `translate3d(${ringPos.current.x + 18}px, ${ringPos.current.y + 18}px, 0)`;
      }

      // Throttle coordinate text updates to 15fps to avoid excessive React renders
      frameCount++;
      if (frameCount % 4 === 0) {
        setCoords({
          x: Math.round(mousePos.current.x),
          y: Math.round(mousePos.current.y),
        });
      }
    };

    animId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animId);
      document.body.classList.remove("custom-cursor-hide");
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  if (!isPointerDevice) return null;

  const pad = (n: number) => String(n).padStart(4, "0");

  return (
    <div className="pointer-events-none fixed inset-0 z-[9999] overflow-hidden select-none">
      {/* 1. Precision Center Dot */}
      <div
        ref={dotRef}
        className={`fixed top-0 left-0 w-1.5 h-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-200 ${
          isHovering ? "bg-white scale-125 shadow-[0_0_8px_rgba(255,255,255,0.8)]" : "bg-white"
        }`}
      />

      {/* 2. Precision Outer Follower Ring / Reticle */}
      <div
        ref={ringRef}
        className={`fixed top-0 left-0 -translate-x-1/2 -translate-y-1/2 rounded-full border transition-all duration-200 ease-out flex items-center justify-center ${
          isHovering
            ? "w-14 h-14 border-white/80 bg-white/[0.04] backdrop-blur-[1px] shadow-[0_0_16px_rgba(255,255,255,0.15)]"
            : isClicking
            ? "w-6 h-6 border-white/90 scale-90"
            : "w-8 h-8 border-white/35"
        }`}
      >
        {/* Subtle crosshair tick marks when hovering (SLX technical style) */}
        {isHovering && (
          <>
            <span className="absolute top-0 w-1.5 h-[1px] bg-white/70" />
            <span className="absolute bottom-0 w-1.5 h-[1px] bg-white/70" />
            <span className="absolute left-0 h-1.5 w-[1px] bg-white/70" />
            <span className="absolute right-0 h-1.5 w-[1px] bg-white/70" />
          </>
        )}
      </div>

      {/* 3. SLX Management-Style Technical Coordinate HUD */}
      <div
        ref={coordsRef}
        className="fixed top-0 left-0 font-mono text-[9px] text-zinc-500 tracking-wider transition-opacity duration-300 pointer-events-none hidden sm:block"
      >
        <span className="text-zinc-400 font-semibold">+</span> X {pad(coords.x)} · Y {pad(coords.y)}
      </div>
    </div>
  );
}

export default CustomCursor;
