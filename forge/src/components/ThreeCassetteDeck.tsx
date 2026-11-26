"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";

interface ThreeCassetteDeckProps {
  ambientAudioActive: boolean;
  scrambleTrigger: number;
  onMechanicalClick?: () => void;
}

interface ComputeBladePhysicsData {
  meshGroup: THREE.Group;
  turbineLeft: THREE.Object3D;
  turbineRight: THREE.Object3D;
  statusLed: THREE.Mesh;
  txLed: THREE.Mesh;
  vx: number;
  vy: number;
  vz: number;
  vRotX: number;
  vRotY: number;
  vRotZ: number;
  isDragging: boolean;
  name: string;
  serial: string;
  initialX: number;
  initialY: number;
  initialZ: number;
}

// Generate high-resolution canvas texture for the compute blade faceplate
function createBladeFaceplateTexture(node: {
  name: string;
  spec: string;
  slot: string;
  serial: string;
  accent: string;
  metric: string;
}): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 360;
  const ctx = canvas.getContext("2d")!;

  // 1. Dark brushed titanium / carbon substrate background
  const bgGrad = ctx.createLinearGradient(0, 0, 1024, 360);
  bgGrad.addColorStop(0, "#16181f");
  bgGrad.addColorStop(0.5, "#0e1017");
  bgGrad.addColorStop(1, "#090a0f");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, 1024, 360);

  // Subtle carbon grid weave
  ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
  ctx.lineWidth = 1;
  for (let x = 0; x < 1024; x += 32) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 360);
    ctx.stroke();
  }
  for (let y = 0; y < 360; y += 32) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(1024, y);
    ctx.stroke();
  }

  // 2. High-speed bus accent line (Cyan / Emerald / Amber)
  const busGrad = ctx.createLinearGradient(0, 0, 1024, 0);
  busGrad.addColorStop(0, node.accent);
  busGrad.addColorStop(0.3, "#ffffff");
  busGrad.addColorStop(0.7, node.accent);
  busGrad.addColorStop(1, "rgba(255,255,255,0.2)");
  ctx.fillStyle = busGrad;
  ctx.fillRect(0, 208, 1024, 6);

  // 3. Laser-milled perimeter border
  ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
  ctx.lineWidth = 3;
  ctx.strokeRect(14, 14, 996, 332);

  // 4. Primary node title & specification
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 52px monospace";
  ctx.fillText(node.name, 48, 88);

  ctx.fillStyle = "#818cf8";
  ctx.font = "26px monospace";
  ctx.fillText(node.spec, 48, 148);

  // Slot designation (SLOT-01, SLOT-02)
  ctx.fillStyle = node.accent;
  ctx.font = "bold 72px monospace";
  ctx.fillText(node.slot, 880, 95);

  // 5. Lower telemetry readouts
  ctx.fillStyle = "#94a3b8";
  ctx.font = "20px monospace";
  ctx.fillText(node.serial, 780, 150);
  ctx.fillText(`FORGE DISTRIBUTED MESH · ${node.metric} · LOCK: MUTEX_L0`, 48, 290);
  ctx.fillText("ECC DDR5 100GbE", 780, 290);

  // 6. Micro printed circuit traces
  ctx.strokeStyle = "rgba(129, 140, 248, 0.35)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(48, 320);
  ctx.lineTo(240, 320);
  ctx.lineTo(280, 340);
  ctx.lineTo(600, 340);
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 8;
  return texture;
}

// Build a real 3D Modular Server Blade Mesh in Three.js
function buildComputeBlade3D(node: {
  name: string;
  spec: string;
  slot: string;
  serial: string;
  accent: string;
  metric: string;
}): {
  group: THREE.Group;
  turbineLeft: THREE.Object3D;
  turbineRight: THREE.Object3D;
  statusLed: THREE.Mesh;
  txLed: THREE.Mesh;
} {
  const group = new THREE.Group();

  const width = 3.8;
  const height = 2.4;
  const depth = 0.34;

  // 1. Main Obsidian Titanium Chassis
  const bodyGeo = new THREE.BoxGeometry(width, height, depth);
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x11131a,
    roughness: 0.28,
    metalness: 0.8,
  });
  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  group.add(bodyMesh);

  // 2. Chamfered Face Inset Housing
  const faceInsetGeo = new THREE.BoxGeometry(width - 0.16, height - 0.16, 0.02);
  const faceInsetMat = new THREE.MeshStandardMaterial({
    color: 0x08090d,
    roughness: 0.5,
    metalness: 0.6,
  });
  const faceInset = new THREE.Mesh(faceInsetGeo, faceInsetMat);
  faceInset.position.z = depth / 2 + 0.01;
  group.add(faceInset);

  // 3. Side Aluminum Heatsink Cooling Fins
  const finMat = new THREE.MeshStandardMaterial({
    color: 0x222633,
    roughness: 0.2,
    metalness: 0.9,
  });
  const finGeo = new THREE.BoxGeometry(0.04, 0.18, depth + 0.04);
  for (let i = 0; i < 9; i++) {
    const finX = -width / 2 + 0.4 + i * 0.36;
    // Top heatsink fin
    const finTop = new THREE.Mesh(finGeo, finMat);
    finTop.position.set(finX, height / 2 - 0.06, 0);
    group.add(finTop);

    // Bottom heatsink fin
    const finBottom = new THREE.Mesh(finGeo, finMat);
    finBottom.position.set(finX, -height / 2 + 0.06, 0);
    group.add(finBottom);
  }

  // 4. Gold Backplane Connector Edge (Enterprise Hot-Swap Pins)
  const connectorHousingGeo = new THREE.BoxGeometry(2.4, 0.22, 0.18);
  const connectorHousingMat = new THREE.MeshStandardMaterial({
    color: 0x07080b,
    roughness: 0.4,
  });
  const connectorHousing = new THREE.Mesh(connectorHousingGeo, connectorHousingMat);
  connectorHousing.position.set(0, -height / 2 + 0.08, 0);
  group.add(connectorHousing);

  const goldPinMat = new THREE.MeshStandardMaterial({
    color: 0xdfb141,
    metalness: 0.98,
    roughness: 0.1,
  });
  const pinGeo = new THREE.BoxGeometry(0.04, 0.12, 0.015);
  for (let i = -14; i <= 14; i++) {
    const pin = new THREE.Mesh(pinGeo, goldPinMat);
    pin.position.set(i * 0.07, -height / 2 + 0.08, depth / 2 + 0.01);
    group.add(pin);
  }

  // 5. Printed Faceplate Plate
  const labelTex = createBladeFaceplateTexture(node);
  const labelGeo = new THREE.PlaneGeometry(3.4, 1.0);
  const labelMat = new THREE.MeshStandardMaterial({
    map: labelTex,
    roughness: 0.25,
    metalness: 0.5,
  });
  const labelMesh = new THREE.Mesh(labelGeo, labelMat);
  labelMesh.position.set(0, 0.45, depth / 2 + 0.022);
  group.add(labelMesh);

  // 6. Recessed Micro-Turbine Viewing Window
  const windowGeo = new THREE.BoxGeometry(2.2, 0.68, 0.04);
  const windowMat = new THREE.MeshPhysicalMaterial({
    color: 0x05070d,
    transparent: true,
    opacity: 0.35,
    roughness: 0.08,
    transmission: 0.88,
    ior: 1.5,
  });
  const windowMesh = new THREE.Mesh(windowGeo, windowMat);
  windowMesh.position.set(0, -0.28, depth / 2 + 0.02);
  group.add(windowMesh);

  // 7. Rotating High-Speed Cooling Turbines
  const createTurbine = () => {
    const turbineGroup = new THREE.Group();

    // Outer turbine shroud ring
    const shroudGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.08, 32);
    shroudGeo.rotateX(Math.PI / 2);
    const shroudMat = new THREE.MeshStandardMaterial({
      color: 0x1e2230,
      roughness: 0.3,
      metalness: 0.85,
    });
    const shroud = new THREE.Mesh(shroudGeo, shroudMat);
    turbineGroup.add(shroud);

    // Copper inductor magnetic core
    const coreGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.12, 24);
    coreGeo.rotateX(Math.PI / 2);
    const coreMat = new THREE.MeshStandardMaterial({
      color: 0xb45309,
      roughness: 0.3,
      metalness: 0.9,
    });
    const core = new THREE.Mesh(coreGeo, coreMat);
    turbineGroup.add(core);

    // 8 Angled aerodynamic turbine blades
    const bladeMat = new THREE.MeshStandardMaterial({
      color: 0x94a3b8,
      metalness: 0.95,
      roughness: 0.15,
    });
    for (let i = 0; i < 8; i++) {
      const bladeGeo = new THREE.BoxGeometry(0.035, 0.16, 0.1);
      const blade = new THREE.Mesh(bladeGeo, bladeMat);
      const angle = (i * Math.PI) / 4;
      blade.position.set(Math.cos(angle) * 0.22, Math.sin(angle) * 0.22, 0);
      blade.rotation.z = angle + 0.35;
      turbineGroup.add(blade);
    }

    return turbineGroup;
  };

  const turbineLeft = createTurbine();
  turbineLeft.position.set(-0.6, -0.28, 0.03);
  group.add(turbineLeft);

  const turbineRight = createTurbine();
  turbineRight.position.set(0.6, -0.28, 0.03);
  group.add(turbineRight);

  // 8. Live LED Status Cluster
  // Primary Heartbeat Status LED (Emerald Green)
  const statusLedGeo = new THREE.SphereGeometry(0.05, 16, 16);
  const statusLedMat = new THREE.MeshStandardMaterial({
    color: 0x10b981,
    emissive: 0x10b981,
    emissiveIntensity: 2.2,
    roughness: 0.1,
  });
  const statusLed = new THREE.Mesh(statusLedGeo, statusLedMat);
  statusLed.position.set(-1.45, -0.28, depth / 2 + 0.025);
  group.add(statusLed);

  // High-Speed TX/RX Optical Link LED (Cyan)
  const txLedGeo = new THREE.SphereGeometry(0.04, 16, 16);
  const txLedMat = new THREE.MeshStandardMaterial({
    color: 0x06b6d4,
    emissive: 0x06b6d4,
    emissiveIntensity: 2.0,
    roughness: 0.1,
  });
  const txLed = new THREE.Mesh(txLedGeo, txLedMat);
  txLed.position.set(-1.32, -0.28, depth / 2 + 0.025);
  group.add(txLed);

  // Amber Fault/Sync Bus LED
  const busLedGeo = new THREE.SphereGeometry(0.035, 16, 16);
  const busLedMat = new THREE.MeshStandardMaterial({
    color: 0xf59e0b,
    emissive: 0xf59e0b,
    emissiveIntensity: 1.5,
  });
  const busLed = new THREE.Mesh(busLedGeo, busLedMat);
  busLed.position.set(1.4, -0.28, depth / 2 + 0.025);
  group.add(busLed);

  // 9. Precision Hex Torx Fasteners (4 corners)
  const screwMat = new THREE.MeshStandardMaterial({
    color: 0xd1d5db,
    metalness: 0.95,
    roughness: 0.15,
  });
  const screwGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.03, 6);
  screwGeo.rotateX(Math.PI / 2);

  const addScrew = (sx: number, sy: number) => {
    const screw = new THREE.Mesh(screwGeo, screwMat);
    screw.position.set(sx, sy, depth / 2 + 0.02);
    group.add(screw);
  };

  addScrew(-width / 2 + 0.18, height / 2 - 0.18);
  addScrew(width / 2 - 0.18, height / 2 - 0.18);
  addScrew(-width / 2 + 0.18, -height / 2 + 0.18);
  addScrew(width / 2 - 0.18, -height / 2 + 0.18);

  return { group, turbineLeft, turbineRight, statusLed, txLed };
}

export default function ThreeCassetteDeck({
  ambientAudioActive,
  scrambleTrigger,
  onMechanicalClick,
}: ThreeCassetteDeckProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const onMechanicalClickRef = useRef(onMechanicalClick);
  useEffect(() => {
    onMechanicalClickRef.current = onMechanicalClick;
  }, [onMechanicalClick]);

  const scrambleTriggerRef = useRef(scrambleTrigger);
  const lastHandledTriggerRef = useRef(scrambleTrigger);
  useEffect(() => {
    scrambleTriggerRef.current = scrambleTrigger;
  }, [scrambleTrigger]);

  const [activeHUD, setActiveHUD] = useState<{
    name: string;
    serial: string;
    x: number;
    y: number;
    rot: number;
    vel: number;
  } | null>(null);

  const bodiesRef = useRef<ComputeBladePhysicsData[]>([]);
  const isDraggingRef = useRef(false);
  const draggedBodyRef = useRef<ComputeBladePhysicsData | null>(null);
  const dragPlaneRef = useRef(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0));
  const planeIntersectRef = useRef(new THREE.Vector3());
  const dragOffsetRef = useRef(new THREE.Vector3());
  const lastMouseWorldPosRef = useRef(new THREE.Vector3());
  const lastTimeRef = useRef(0);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, camera: THREE.Camera, raycaster: THREE.Raycaster) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const mouseX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const mouseY = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(new THREE.Vector2(mouseX, mouseY), camera);

      // Check intersections with all blade bodies
      const interactiveMeshes = bodiesRef.current.map((b) => b.meshGroup.children[0]);
      const intersects = raycaster.intersectObjects(interactiveMeshes, false);

      if (intersects.length > 0) {
        const hitMesh = intersects[0].object;
        const hitBody = bodiesRef.current.find((b) => b.meshGroup.children[0] === hitMesh);

        if (hitBody) {
          isDraggingRef.current = true;
          draggedBodyRef.current = hitBody;
          hitBody.isDragging = true;

          // Align drag plane to hit body's Z depth
          dragPlaneRef.current.set(new THREE.Vector3(0, 0, 1), -hitBody.meshGroup.position.z);
          raycaster.ray.intersectPlane(dragPlaneRef.current, planeIntersectRef.current);
          dragOffsetRef.current.subVectors(hitBody.meshGroup.position, planeIntersectRef.current);

          lastMouseWorldPosRef.current.copy(planeIntersectRef.current);
          lastTimeRef.current = performance.now();

          e.currentTarget.setPointerCapture?.(e.pointerId);
          onMechanicalClickRef.current?.();
        }
      }
    },
    []
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, camera: THREE.Camera, raycaster: THREE.Raycaster) => {
      if (!isDraggingRef.current || !draggedBodyRef.current) return;
      const b = draggedBodyRef.current;

      const rect = e.currentTarget.getBoundingClientRect();
      const mouseX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const mouseY = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(new THREE.Vector2(mouseX, mouseY), camera);

      if (raycaster.ray.intersectPlane(dragPlaneRef.current, planeIntersectRef.current)) {
        const now = performance.now();
        const dt = Math.max(1, now - lastTimeRef.current);

        const deltaPos = new THREE.Vector3().subVectors(planeIntersectRef.current, lastMouseWorldPosRef.current);

        // Calculate 3D velocity
        b.vx = (deltaPos.x / dt) * 1000 * 0.035;
        b.vy = (deltaPos.y / dt) * 1000 * 0.035;
        b.vRotZ = -b.vx * 0.08;
        b.vRotX = b.vy * 0.06;

        b.meshGroup.position.x = planeIntersectRef.current.x + dragOffsetRef.current.x;
        b.meshGroup.position.y = planeIntersectRef.current.y + dragOffsetRef.current.y;

        // Dynamic 3D tilt while dragging
        b.meshGroup.rotation.y = THREE.MathUtils.clamp(b.vx * 0.35, -0.6, 0.6);
        b.meshGroup.rotation.x = THREE.MathUtils.clamp(-b.vy * 0.35, -0.6, 0.6);

        lastMouseWorldPosRef.current.copy(planeIntersectRef.current);
        lastTimeRef.current = now;

        setActiveHUD({
          name: b.name,
          serial: b.serial,
          x: Math.round(b.meshGroup.position.x * 100),
          y: Math.round(b.meshGroup.position.y * 100),
          rot: Math.round((b.meshGroup.rotation.z * 180) / Math.PI),
          vel: Math.round(Math.hypot(b.vx, b.vy) * 25),
        });
      }
    },
    []
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (draggedBodyRef.current) {
        draggedBodyRef.current.isDragging = false;
        draggedBodyRef.current = null;
        isDraggingRef.current = false;
        setActiveHUD(null);
        e.currentTarget.releasePointerCapture?.(e.pointerId);
        onMechanicalClickRef.current?.();
      }
    },
    []
  );

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const width = container.clientWidth || 700;
    const height = container.clientHeight || 460;

    // 1. Scene, Camera, Renderer
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x06070a);

    const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100);
    camera.position.set(0, 0, 6.2);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    // 2. High-Tech Studio Lighting
    const ambientLight = new THREE.AmbientLight(0x1e2430, 1.6);
    scene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight(0xe0e7ff, 3.2);
    dirLight1.position.set(6, 8, 6);
    dirLight1.castShadow = true;
    dirLight1.shadow.mapSize.width = 1024;
    dirLight1.shadow.mapSize.height = 1024;
    scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(0x38bdf8, 1.8);
    dirLight2.position.set(-6, -5, 4);
    scene.add(dirLight2);

    const pointLight = new THREE.PointLight(0xffffff, 1.5, 8);
    pointLight.position.set(0, 0, 4);
    scene.add(pointLight);

    // 3. Construct 3 Real 3D Compute Blades
    const bladeConfigs = [
      {
        name: "BLADE-01: RAFT CONSENSUS",
        spec: "PRIMARY CORE · DUAL EPYC · 100GbE",
        slot: "01",
        serial: "FD-RAFT-A882",
        accent: "#10b981",
        metric: "LATENCY < 0.8ms",
        x: -1.2,
        y: -0.2,
        z: 0.1,
        rotZ: -0.15,
        rotX: 0.12,
        rotY: -0.2,
      },
      {
        name: "BLADE-02: TRANSACTION OUTBOX",
        spec: "ATOMIC CDC LOG · 50ms LEASED MUTEX",
        slot: "02",
        serial: "TX-CDC-K104",
        accent: "#06b6d4",
        metric: "GUARANTEE: EXACTLY_ONCE",
        x: 1.1,
        y: 0.35,
        z: -0.1,
        rotZ: 0.22,
        rotX: -0.15,
        rotY: 0.25,
      },
      {
        name: "BLADE-03: DETERMINISTIC SAGA",
        spec: "STATE MACHINE · 2-PHASE ROLLBACK",
        slot: "03",
        serial: "SG-DAG-R991",
        accent: "#a855f7",
        metric: "PERSISTENCE: DURABLE WAL",
        x: 0.1,
        y: -0.9,
        z: 0.2,
        rotZ: -0.28,
        rotX: 0.2,
        rotY: 0.1,
      },
    ];

    const bodies: ComputeBladePhysicsData[] = bladeConfigs.map((cfg) => {
      const { group, turbineLeft, turbineRight, statusLed, txLed } = buildComputeBlade3D(cfg);
      group.position.set(cfg.x, cfg.y, cfg.z);
      group.rotation.set(cfg.rotX, cfg.rotY, cfg.rotZ);
      scene.add(group);

      return {
        meshGroup: group,
        turbineLeft,
        turbineRight,
        statusLed,
        txLed,
        vx: (Math.random() - 0.5) * 0.008,
        vy: (Math.random() - 0.5) * 0.008,
        vz: 0,
        vRotX: (Math.random() - 0.5) * 0.003,
        vRotY: (Math.random() - 0.5) * 0.003,
        vRotZ: (Math.random() - 0.5) * 0.002,
        isDragging: false,
        name: cfg.name,
        serial: cfg.serial,
        initialX: cfg.x,
        initialY: cfg.y,
        initialZ: cfg.z,
      };
    });

    bodiesRef.current = bodies;

    const raycaster = new THREE.Raycaster();

    const onDown = (e: PointerEvent) =>
      handlePointerDown(e as unknown as React.PointerEvent<HTMLDivElement>, camera, raycaster);
    const onMove = (e: PointerEvent) =>
      handlePointerMove(e as unknown as React.PointerEvent<HTMLDivElement>, camera, raycaster);
    const onUp = (e: PointerEvent) =>
      handlePointerUp(e as unknown as React.PointerEvent<HTMLDivElement>);

    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("pointerup", onUp);

    // 4. Animation & Physics Simulation Loop
    let animId: number;
    const clock = new THREE.Clock();

    const animate = () => {
      animId = requestAnimationFrame(animate);
      const delta = clock.getDelta();
      const elapsed = clock.getElapsedTime();

      // Check impulse scramble triggers inside animation frame
      if (scrambleTriggerRef.current !== lastHandledTriggerRef.current) {
        lastHandledTriggerRef.current = scrambleTriggerRef.current;
        for (const b of bodiesRef.current) {
          b.vx = (Math.random() - 0.5) * 0.08;
          b.vy = (Math.random() - 0.5) * 0.08;
          b.vRotX = (Math.random() - 0.5) * 0.08;
          b.vRotY = (Math.random() - 0.5) * 0.08;
          b.vRotZ = (Math.random() - 0.5) * 0.06;
        }
        onMechanicalClickRef.current?.();
      }

      // Bounds for 3D physics in camera view
      const boundX = 2.4;
      const boundY = 1.35;

      for (const b of bodiesRef.current) {
        // Spin high-speed cooling turbines
        const spinSpeed = ambientAudioActive ? 7.5 : 2.0;
        b.turbineLeft.rotation.z += spinSpeed * delta;
        b.turbineRight.rotation.z -= spinSpeed * delta;

        // Modulate status LEDs
        const pulse = (Math.sin(elapsed * 4 + b.initialX) + 1) * 0.5;
        (b.statusLed.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.2 + pulse * 1.5;
        (b.txLed.material as THREE.MeshStandardMaterial).emissiveIntensity =
          Math.random() > 0.3 ? 2.5 : 0.5;

        if (!b.isDragging) {
          // Linear motion & rotational tumbling
          b.meshGroup.position.x += b.vx;
          b.meshGroup.position.y += b.vy;
          b.meshGroup.rotation.x += b.vRotX;
          b.meshGroup.rotation.y += b.vRotY;
          b.meshGroup.rotation.z += b.vRotZ;

          // Friction damping
          b.vx *= 0.988;
          b.vy *= 0.988;
          b.vRotX *= 0.99;
          b.vRotY *= 0.99;
          b.vRotZ *= 0.99;

          // Elastic boundary bounce
          if (b.meshGroup.position.x < -boundX) {
            b.meshGroup.position.x = -boundX;
            b.vx = Math.abs(b.vx) * 0.75 + 0.005;
            b.vRotZ += 0.02;
            onMechanicalClickRef.current?.();
          } else if (b.meshGroup.position.x > boundX) {
            b.meshGroup.position.x = boundX;
            b.vx = -Math.abs(b.vx) * 0.75 - 0.005;
            b.vRotZ -= 0.02;
            onMechanicalClickRef.current?.();
          }

          if (b.meshGroup.position.y < -boundY) {
            b.meshGroup.position.y = -boundY;
            b.vy = Math.abs(b.vy) * 0.75 + 0.005;
            b.vRotX += 0.02;
            onMechanicalClickRef.current?.();
          } else if (b.meshGroup.position.y > boundY) {
            b.meshGroup.position.y = boundY;
            b.vy = -Math.abs(b.vy) * 0.75 - 0.005;
            b.vRotX -= 0.02;
            onMechanicalClickRef.current?.();
          }
        }
      }

      renderer.render(scene, camera);
    };

    animate();

    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", handleResize);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", handleResize);
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("pointerup", onUp);
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [ambientAudioActive, handlePointerDown, handlePointerMove, handlePointerUp]);

  return (
    <div className="relative w-full h-[480px] border border-white/[0.08] bg-[#06070a] overflow-hidden shadow-2xl cursor-grab active:cursor-grabbing">
      <div ref={mountRef} className="w-full h-full" />

      {/* Technical Colophon HUD Over Canvas */}
      <div className="pointer-events-none absolute top-4 left-4 font-mono text-[10px] text-zinc-400 space-y-1">
        <div className="flex items-center gap-1.5 text-zinc-200">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span>[ REAL 3D DISTRIBUTED COMPUTE RIG ]</span>
        </div>
        <div>ARCHITECTURE: HOT-SWAP SERVER BLADES · THREE.JS</div>
      </div>

      <div className="pointer-events-none absolute bottom-4 right-4 font-mono text-[10px] text-zinc-400 text-right">
        <div>CLICK & TOSS ANY COMPUTE BLADE IN 3D</div>
        <div>INERTIA DAMPING: 0.988 · BOUNCE: 0.75</div>
      </div>

      {/* Dynamic targeting HUD indicator when dragging */}
      {activeHUD && (
        <div className="pointer-events-none absolute top-4 right-4 border border-indigo-500/40 bg-zinc-950/90 p-2.5 font-mono text-[10px] text-zinc-300 backdrop-blur-md shadow-2xl rounded">
          <div className="text-white font-bold flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
            {activeHUD.name}
          </div>
          <div className="text-zinc-400 mt-1">
            pos: [{activeHUD.x}, {activeHUD.y}] · rot: {activeHUD.rot}° · v: {activeHUD.vel} MHz
          </div>
        </div>
      )}
    </div>
  );
}
