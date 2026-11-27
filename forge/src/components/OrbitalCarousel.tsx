"use client";

import React, { useState, useEffect, useRef } from "react";
import { ChevronRight } from "lucide-react";

export interface OrbitalCard {
  id: string;
  index: string;
  tag: string;
  title: string;
  subtitle: string;
  metric: string;
  codeSnippet: string;
}

interface OrbitalCarouselProps {
  cards: OrbitalCard[];
  onMechanicalClick?: () => void;
}

export function OrbitalCarousel({ cards, onMechanicalClick }: OrbitalCarouselProps) {
  const [wheelAngle, setWheelAngle] = useState(0);
  const [isDraggingWheel, setIsDraggingWheel] = useState(false);
  const [activeHoverIndex, setActiveHoverIndex] = useState<number | null>(null);

  const wheelAngleRef = useRef(0);
  const wheelVelocityRef = useRef(0.0016);
  const isDraggingWheelRef = useRef(false);
  const wheelStartPointerX = useRef(0);
  const lastWheelPointerX = useRef(0);
  const lastWheelTimestamp = useRef(0);

  useEffect(() => {
    let animId: number;

    const updateOrbitalWheel = () => {
      if (!isDraggingWheelRef.current) {
        if (Math.abs(wheelVelocityRef.current) > 0.0008) {
          wheelVelocityRef.current *= 0.94;
        } else {
          wheelVelocityRef.current = activeHoverIndex !== null ? 0 : 0.0016;
        }
        wheelAngleRef.current += wheelVelocityRef.current;
        setWheelAngle(wheelAngleRef.current);
      }
      animId = requestAnimationFrame(updateOrbitalWheel);
    };

    animId = requestAnimationFrame(updateOrbitalWheel);
    return () => cancelAnimationFrame(animId);
  }, [activeHoverIndex]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    isDraggingWheelRef.current = true;
    setIsDraggingWheel(true);
    wheelStartPointerX.current = e.clientX;
    lastWheelPointerX.current = e.clientX;
    lastWheelTimestamp.current = performance.now();
    wheelVelocityRef.current = 0;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingWheelRef.current) return;
    const now = performance.now();
    const dt = Math.max(1, now - lastWheelTimestamp.current);
    const dx = e.clientX - lastWheelPointerX.current;

    const dTheta = (dx / 460) * 1.4;
    wheelAngleRef.current += dTheta;
    setWheelAngle(wheelAngleRef.current);

    wheelVelocityRef.current = dTheta / (dt / 16.6);
    lastWheelPointerX.current = e.clientX;
    lastWheelTimestamp.current = now;
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingWheelRef.current) return;
    isDraggingWheelRef.current = false;
    setIsDraggingWheel(false);
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    onMechanicalClick?.();
  };

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      className="absolute inset-0 flex items-center justify-center pointer-events-auto cursor-grab active:cursor-grabbing select-none"
    >
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        {cards.map((card, idx) => {
          const total = cards.length;
          const angle = wheelAngle + (idx / total) * (Math.PI * 2);
          const radiusX = 480;
          const radiusY = 265;

          const posX = Math.cos(angle) * radiusX;
          const posY = Math.sin(angle) * radiusY;

          // 3D Depth Scale & Perspective
          const depthFactor = (Math.sin(angle) + 1) / 2; // 0 (far) to 1 (near)
          const scale = 0.82 + depthFactor * 0.32;
          const opacity = 0.65 + depthFactor * 0.35;
          const zIndex = Math.round(depthFactor * 30);
          const isHovered = activeHoverIndex === idx;

          return (
            <div
              key={card.id}
              onPointerEnter={() => setActiveHoverIndex(idx)}
              onPointerLeave={() => setActiveHoverIndex(null)}
              style={{
                transform: `translate3d(${posX}px, ${posY}px, 0) scale(${isHovered ? scale * 1.08 : scale}) rotate(${posX * 0.008}deg)`,
                opacity,
                zIndex: isHovered ? 50 : zIndex,
                transition: isDraggingWheel ? "none" : "transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.25s ease",
              }}
              className={`pointer-events-auto absolute w-60 sm:w-64 p-4 rounded-2xl border bg-gradient-to-b from-[#1c1c2b]/95 to-[#101018]/95 backdrop-blur-md shadow-[0_22px_50px_rgba(0,0,0,0.92)] transition-all duration-300 ${
                isHovered
                  ? "border-white text-white shadow-[0_22px_55px_rgba(255,255,255,0.22),inset_0_1px_0_rgba(255,255,255,0.4)]"
                  : "border-white/[0.24] text-zinc-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]"
              }`}
            >
              <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400 pb-2 border-b border-white/[0.1] mb-2.5">
                <span className="text-zinc-100 font-bold">[ {card.index} ]</span>
                <span className="text-zinc-300 font-medium">{card.tag}</span>
              </div>

              <h3 className="font-mono text-xs font-semibold text-zinc-100 tracking-tight leading-snug">
                {card.title}
              </h3>
              <p className="text-[11px] text-zinc-400 mt-1 font-light leading-snug">
                {card.subtitle}
              </p>

              <div className="mt-3 pt-2.5 border-t border-white/[0.08] flex items-center justify-between text-[10px] font-mono text-zinc-400">
                <span className="text-zinc-200 font-medium">{card.metric}</span>
                <ChevronRight className="w-3 h-3 text-zinc-400" />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default OrbitalCarousel;
