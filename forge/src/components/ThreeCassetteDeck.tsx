"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";

interface ThreeCassetteDeckProps {
  ambientAudioActive: boolean;
  scrambleTrigger: number;
  onMechanicalClick?: () => void;
}

interface CassettePhysicsData {
  meshGroup: THREE.Group;
  spoolLeft: THREE.Object3D;
  spoolRight: THREE.Object3D;
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

// Generate high-resolution canvas texture for the cassette label plate
function createLabelTexture(tape: {
  name: string;
  type: string;
  side: string;
  serial: string;
  accent: string;
}): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 360;
  const ctx = canvas.getContext("2d")!;

  // Background dark brushed graphite
  const bgGrad = ctx.createLinearGradient(0, 0, 1024, 360);
  bgGrad.addColorStop(0, "#22222e");
  bgGrad.addColorStop(0.5, "#181824");
  bgGrad.addColorStop(1, "#12121c");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, 1024, 360);

  // Silver foil accent stripe across the middle
  const foilGrad = ctx.createLinearGradient(0, 0, 1024, 0);
  foilGrad.addColorStop(0, "#888899");
  foilGrad.addColorStop(0.3, "#e4e4ed");
  foilGrad.addColorStop(0.7, "#a0a0b2");
  foilGrad.addColorStop(1, "#ffffff");
  ctx.fillStyle = foilGrad;
  ctx.fillRect(0, 220, 1024, 12);

  // Hairline perimeter border
  ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
  ctx.lineWidth = 4;
  ctx.strokeRect(12, 12, 1000, 336);

  // Top header typography
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 56px sans-serif";
  ctx.fillText(tape.name, 48, 95);

  ctx.fillStyle = "#a1a1b0";
  ctx.font = "32px monospace";
  ctx.fillText(tape.type, 48, 160);

  // Side indicator (A or B)
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 78px sans-serif";
  ctx.fillText(tape.side, 920, 105);

  // Micro details
  ctx.fillStyle = "#717182";
  ctx.font = "24px monospace";
  ctx.fillText(tape.serial, 780, 160);
  ctx.fillText("FORGE SYSTEM ARCHITECTURE · HIGH BIAS 70µs EQ · NR OFF", 48, 290);
  ctx.fillText("JAPAN CrO2", 840, 290);

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 8;
  return texture;
}

// Build a real 3D Cassette Mesh in Three.js
function buildCassette3D(tape: {
  name: string;
  type: string;
  side: string;
  serial: string;
  accent: string;
}): {
  group: THREE.Group;
  spoolLeft: THREE.Object3D;
  spoolRight: THREE.Object3D;
} {
  const group = new THREE.Group();

  const width = 3.8;
  const height = 2.4;
  const depth = 0.32;

  // 1. Main Plastic Body (Extruded Box with real thickness)
  const bodyGeo = new THREE.BoxGeometry(width, height, depth);
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x14141e,
    roughness: 0.35,
    metalness: 0.2,
  });
  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  group.add(bodyMesh);

  // 2. Beveled Face Frame (Chamfer Inset)
  const faceFrameGeo = new THREE.BoxGeometry(width - 0.2, height - 0.2, 0.02);
  const faceFrameMat = new THREE.MeshStandardMaterial({
    color: 0x0c0c12,
    roughness: 0.5,
  });
  const faceFrame = new THREE.Mesh(faceFrameGeo, faceFrameMat);
  faceFrame.position.z = depth / 2 + 0.01;
  group.add(faceFrame);

  // 3. Foil Label Plate (Printed Front Face)
  const labelTex = createLabelTexture(tape);
  const labelGeo = new THREE.PlaneGeometry(3.4, 1.0);
  const labelMat = new THREE.MeshStandardMaterial({
    map: labelTex,
    roughness: 0.3,
    metalness: 0.4,
  });
  const labelMesh = new THREE.Mesh(labelGeo, labelMat);
  labelMesh.position.set(0, 0.45, depth / 2 + 0.022);
  group.add(labelMesh);

  // 4. Recessed Center Window & Acrylic Glare
  const windowGeo = new THREE.BoxGeometry(2.0, 0.68, 0.04);
  const windowMat = new THREE.MeshPhysicalMaterial({
    color: 0x06060a,
    transparent: true,
    opacity: 0.4,
    roughness: 0.1,
    transmission: 0.85,
    ior: 1.45,
  });
  const windowMesh = new THREE.Mesh(windowGeo, windowMat);
  windowMesh.position.set(0, -0.25, depth / 2 + 0.02);
  group.add(windowMesh);

  // 5. 3D Spools with 6-Tooth Nylon Sprockets
  const createSpool = (tapeRadius: number) => {
    const spoolGroup = new THREE.Group();

    // Wound magnetic tape cylinder (dark brown)
    const tapeGeo = new THREE.CylinderGeometry(tapeRadius, tapeRadius, 0.12, 32);
    tapeGeo.rotateX(Math.PI / 2);
    const tapeMat = new THREE.MeshStandardMaterial({
      color: 0x2b1810,
      roughness: 0.8,
    });
    const tapeMesh = new THREE.Mesh(tapeGeo, tapeMat);
    spoolGroup.add(tapeMesh);

    // White nylon central drive hub
    const hubGeo = new THREE.CylinderGeometry(0.18, 0.18, 0.14, 24);
    hubGeo.rotateX(Math.PI / 2);
    const hubMat = new THREE.MeshStandardMaterial({
      color: 0xededf2,
      roughness: 0.2,
    });
    const hubMesh = new THREE.Mesh(hubGeo, hubMat);
    spoolGroup.add(hubMesh);

    // 6 Sprocket Teeth
    const toothMat = new THREE.MeshStandardMaterial({
      color: 0x111116,
      roughness: 0.4,
    });
    for (let i = 0; i < 6; i++) {
      const toothGeo = new THREE.BoxGeometry(0.04, 0.1, 0.15);
      const tooth = new THREE.Mesh(toothGeo, toothMat);
      const angle = (i * Math.PI) / 3;
      tooth.position.set(Math.cos(angle) * 0.11, Math.sin(angle) * 0.11, 0);
      tooth.rotation.z = angle;
      spoolGroup.add(tooth);
    }

    // Red core center hub
    const redHubGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.16, 16);
    redHubGeo.rotateX(Math.PI / 2);
    const redHubMat = new THREE.MeshStandardMaterial({
      color: 0x991b1b,
      roughness: 0.3,
    });
    const redHub = new THREE.Mesh(redHubGeo, redHubMat);
    spoolGroup.add(redHub);

    return spoolGroup;
  };

  const spoolLeft = createSpool(0.38);
  spoolLeft.position.set(-0.58, -0.25, 0.04);
  group.add(spoolLeft);

  const spoolRight = createSpool(0.24);
  spoolRight.position.set(0.58, -0.25, 0.04);
  group.add(spoolRight);

  // 6. Bottom Trapezoid Notch & Magnetic Tape Path
  const notchGeo = new THREE.BoxGeometry(2.4, 0.3, 0.2);
  const notchMat = new THREE.MeshStandardMaterial({
    color: 0x08080c,
    roughness: 0.6,
  });
  const notch = new THREE.Mesh(notchGeo, notchMat);
  notch.position.set(0, -height / 2 + 0.12, 0);
  group.add(notch);

  // Exposed tape path ribbon across the notch
  const tapeRibbonGeo = new THREE.BoxGeometry(1.8, 0.12, 0.06);
  const tapeRibbonMat = new THREE.MeshStandardMaterial({
    color: 0x331c12,
    roughness: 0.8,
  });
  const tapeRibbon = new THREE.Mesh(tapeRibbonGeo, tapeRibbonMat);
  tapeRibbon.position.set(0, -height / 2 + 0.12, depth / 2 + 0.01);
  group.add(tapeRibbon);

  // Brass guide rollers in the notch
  const rollerMat = new THREE.MeshStandardMaterial({
    color: 0xb59a60,
    metalness: 0.8,
    roughness: 0.2,
  });
  const rollerGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.22, 16);
  rollerGeo.rotateX(Math.PI / 2);

  const rollerLeft = new THREE.Mesh(rollerGeo, rollerMat);
  rollerLeft.position.set(-0.85, -height / 2 + 0.12, 0.02);
  group.add(rollerLeft);

  const rollerRight = new THREE.Mesh(rollerGeo, rollerMat);
  rollerRight.position.set(0.85, -height / 2 + 0.12, 0.02);
  group.add(rollerRight);

  // 7. Metallic Corner Screws (Real 3D Chrome Cylinders)
  const screwMat = new THREE.MeshStandardMaterial({
    color: 0xd0d0dc,
    metalness: 0.95,
    roughness: 0.15,
  });
  const screwGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.04, 16);
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
  addScrew(0, height / 2 - 0.14);

  return { group, spoolLeft, spoolRight };
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

  const bodiesRef = useRef<CassettePhysicsData[]>([]);
  const isDraggingRef = useRef(false);
  const draggedBodyRef = useRef<CassettePhysicsData | null>(null);
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

      // Check intersections with all cassette bodies
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
    scene.background = new THREE.Color(0x07070a);

    const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100);
    camera.position.set(0, 0, 6.2);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    // 2. Lights
    const ambientLight = new THREE.AmbientLight(0x282835, 1.4);
    scene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight(0xffffff, 2.8);
    dirLight1.position.set(5, 7, 6);
    dirLight1.castShadow = true;
    dirLight1.shadow.mapSize.width = 1024;
    dirLight1.shadow.mapSize.height = 1024;
    scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(0x7080a0, 1.4);
    dirLight2.position.set(-5, -4, 4);
    scene.add(dirLight2);

    const pointLight = new THREE.PointLight(0xffffff, 1.5, 8);
    pointLight.position.set(0, 0, 4);
    scene.add(pointLight);

    // 3. Construct 3 Real 3D Cassettes
    const tapeConfigs = [
      {
        name: "FORGE UX-PRO 90",
        type: "SUPER CHROME CLASS · BIAS 70µs",
        side: "A",
        serial: "CR-90-A882",
        accent: "#ffffff",
        x: -1.2,
        y: -0.2,
        z: 0.1,
        rotZ: -0.15,
        rotX: 0.12,
        rotY: -0.2,
      },
      {
        name: "TRANSACTION OUTBOX",
        type: "ATOMIC CDC LOG · 50ms LEASE",
        side: "B",
        serial: "TX-50-K104",
        accent: "#d4d4d8",
        x: 1.1,
        y: 0.35,
        z: -0.1,
        rotZ: 0.22,
        rotX: -0.15,
        rotY: 0.25,
      },
      {
        name: "SAGA ROLLBACK FLIGHT",
        type: "REVERSE DAG RECORDER · 24-HR",
        side: "A",
        serial: "SG-04-R991",
        accent: "#e4e4e7",
        x: 0.1,
        y: -0.9,
        z: 0.2,
        rotZ: -0.28,
        rotX: 0.2,
        rotY: 0.1,
      },
    ];

    const bodies: CassettePhysicsData[] = tapeConfigs.map((cfg) => {
      const { group, spoolLeft, spoolRight } = buildCassette3D(cfg);
      group.position.set(cfg.x, cfg.y, cfg.z);
      group.rotation.set(cfg.rotX, cfg.rotY, cfg.rotZ);
      scene.add(group);

      return {
        meshGroup: group,
        spoolLeft,
        spoolRight,
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

    // Event listeners attached to DOM container
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
        // Spin tape spools in real 3D
        const spinSpeed = ambientAudioActive ? 2.5 : 0.6;
        b.spoolLeft.rotation.z += spinSpeed * delta;
        b.spoolRight.rotation.z += spinSpeed * 0.94 * delta;

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

    // Resize handler
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
    <div className="relative w-full h-[480px] border border-white/[0.08] bg-[#07070a] overflow-hidden shadow-2xl cursor-grab active:cursor-grabbing">
      <div ref={mountRef} className="w-full h-full" />

      {/* Bizarro Technical Colophon HUD Over Canvas */}
      <div className="pointer-events-none absolute top-4 left-4 font-mono text-[10px] text-zinc-400 space-y-1">
        <div>[ REAL 3D WEBGL CASSETTE RIG ]</div>
        <div>MESH: EXTRUDED_CHROME_TYPE_II · THREE.JS</div>
      </div>

      <div className="pointer-events-none absolute bottom-4 right-4 font-mono text-[10px] text-zinc-400 text-right">
        <div>CLICK & TOSS ANY CASSETTE IN 3D</div>
        <div>INERTIA DAMPING: 0.988 · BOUNCE: 0.75</div>
      </div>

      {/* Dynamic targeting HUD indicator when dragging */}
      {activeHUD && (
        <div className="pointer-events-none absolute top-4 right-4 border border-white/[0.2] bg-zinc-950/80 p-2 font-mono text-[10px] text-zinc-300 backdrop-blur-md shadow-xl">
          <div className="text-white font-bold">{activeHUD.name}</div>
          <div className="text-zinc-400">
            pos: [{activeHUD.x}, {activeHUD.y}] · rot: {activeHUD.rot}° · v: {activeHUD.vel} px/s
          </div>
        </div>
      )}
    </div>
  );
}
