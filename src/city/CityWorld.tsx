import { useEffect, useLayoutEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import "./CityWorld.css";
import { PALETTE, explodeCurve, glowTexture, ringTexture, rng } from "./three-helpers";

/**
 * Un nodo de la ciudad: "app" se dibuja como torre (su altura sale de `height`) y "social" como antena.
 * `x` y `y` van en un plano de ±250 (se escalan a la escena con SCALE). `value` y `unit` salen en su etiqueta.
 */
export type CityWorldNode = { id: string; name: string; type: "app" | "social"; color: string; value: string; unit: string; hasData: boolean; x: number; y: number; height: number };
type Props = {
  nodes: CityWorldNode[];
  /** Texto de la torre central. */
  centerLabel?: string;
  selectedId: string | null;
  filter: string;
  zoom: number;
  motion: boolean;
  onSelect: (id: string) => void;
  /** La GPU se reinició (contexto WebGL perdido): el padre vuelve a montar el mundo. */
  onGpuLost?: () => void;
  /** No se pudo crear el contexto WebGL. */
  onGpuFail?: () => void;
};

const SCALE = 1 / 20; // plano original → mundo 3D
const BG = "#05070d";
const FOG = "#1a1530";
const FOG_DENSITY = 0.0105;
const AVENUES = [-12, 0, 12];

// Niebla exponencial calculada a mano (los ShaderMaterial no la reciben solos).
const fogVertex = `float fogOf(vec3 w) { float d = length(w - cameraPosition) * ${FOG_DENSITY}; return 1.0 - exp(-d * d); }`;

// Edificios: fachada de acero oscuro con miles de ventanas encendidas (cálidas y frías, algunas parpadean).
// Crecen con el mouse, saltan con las ondas y vuelan en la explosión.
const buildingVertex = `
  attribute vec3 aTint; attribute float aSeed;
  uniform float uClock; uniform vec3 uMouse; uniform float uMouseForce; uniform vec4 uWaves[4]; uniform float uExplode; uniform float uMovable;
  uniform vec3 uColor; uniform float uUseColor;
  varying vec2 vUv; varying vec3 vNormal; varying vec3 vTint; varying float vGlow; varying vec3 vSize; varying float vSeed; varying float vFog; varying float vY;
  ${fogVertex}
  void main() {
    mat4 im = mat4(1.0);
    #ifdef USE_INSTANCING
      im = instanceMatrix;
    #endif
    mat4 M = modelMatrix * im;
    vec3 base = (M * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    vSize = vec3(length(M[0].xyz), length(M[1].xyz), length(M[2].xyz));
    vec3 local = position;
    float dm = length(base.xz - uMouse.xz);
    float f = uMouseForce * exp(-dm * dm / 16.0);
    local.y *= 1.0 + f * 0.55 * uMovable;
    float glow = abs(f) * 0.9;
    float lift = 0.0;
    for (int i = 0; i < 4; i++) {
      vec4 w = uWaves[i];
      if (w.w < 0.0) continue;
      float age = uClock - w.w;
      if (age < 0.0 || age > 3.0) continue;
      float dist = length(base.xz - w.xz);
      float ring = exp(-pow(dist - age * 13.0, 2.0) / 4.0) * (1.0 - age / 3.0);
      lift += ring * 2.2;
      glow += ring * 1.4;
    }
    float k = 0.6 + fract(aSeed * 7.31) * 1.6;
    float e = uExplode * uMovable;
    float ang = e * k * 3.0;
    vec3 c = vec3(0.0, 0.5, 0.0);
    vec3 p = local - c;
    p.xy = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * p.xy;
    p.yz = mat2(cos(ang * 0.7), -sin(ang * 0.7), sin(ang * 0.7), cos(ang * 0.7)) * p.yz;
    local = mix(local, p + c, step(0.001, e));
    vec4 world = M * vec4(local, 1.0);
    vec2 out2 = normalize(base.xz + vec2(0.001)) * e * k * 9.0;
    world.xyz += vec3(out2.x, e * k * 16.0 + lift * uMovable, out2.y);
    vUv = uv; vNormal = normal; vTint = mix(aTint, uColor, uUseColor); vGlow = glow * uMovable + glow * uUseColor; vSeed = aSeed; vY = position.y;
    vFog = fogOf(world.xyz);
    gl_Position = projectionMatrix * viewMatrix * world;
  }`;
const buildingFragment = `
  uniform float uDim; uniform float uSel; uniform float uClock; uniform float uNeon; uniform vec3 uFogColor;
  varying vec2 vUv; varying vec3 vNormal; varying vec3 vTint; varying float vGlow; varying vec3 vSize; varying float vSeed; varying float vFog; varying float vY;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    vec3 steel = vec3(0.0055, 0.0075, 0.013);
    float edge = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
    vec3 col;
    vec3 light = vec3(0.0);
    if (abs(vNormal.y) < 0.5) {
      float shade = abs(vNormal.x) > 0.5 ? 0.6 : 1.0;
      float span = abs(vNormal.x) > 0.5 ? vSize.z : vSize.x;
      // panel de fachada: franjas verticales sutiles y un poco más claro abajo
      col = steel * shade * (0.85 + 0.3 * step(0.92, fract(vUv.x * max(2.0, floor(span * 1.2)))));
      float cols = max(2.0, floor(span * 2.6));
      float rows = max(3.0, floor(vSize.y * 3.2));
      vec2 cell = vec2(vUv.x * cols, vUv.y * rows);
      vec2 f = fract(cell);
      float win = step(0.2, f.x) * step(f.x, 0.8) * step(0.25, f.y) * step(f.y, 0.78);
      vec2 id = floor(cell) + vec2(vSeed * 91.0, floor(vNormal.x * 3.0 + vNormal.z * 7.0));
      float h1 = hash(id), h2 = hash(id + 17.3), h3 = hash(id + 41.9);
      // pisos completos apagados o encendidos, como oficinas reales
      float floorOn = step(0.28, hash(vec2(floor(cell.y), vSeed * 37.0)));
      float lit = step(0.55, h1) * floorOn;
      float flick = h3 > 0.97 ? step(0.5, fract(sin(uClock * (2.0 + h3 * 9.0) + h1 * 40.0) * 3.0)) : 1.0;
      vec3 warm = mix(vec3(1.0, 0.72, 0.38), vec3(1.0, 0.88, 0.64), h2);
      vec3 cool = mix(vec3(0.55, 0.78, 1.0), vec3(0.85, 0.95, 1.0), h2);
      vec3 wc = h2 > 0.72 ? cool : warm;
      light += wc * win * lit * flick * (0.25 + 0.45 * h3 * h3) * (0.7 + 0.3 * shade);
      // cristal apagado con reflejo frío
      col += vec3(0.008, 0.012, 0.022) * win * (1.0 - lit);
    } else {
      col = steel * 1.3;
    }
    // filo superior con luz de borde (neón fuerte solo en torres del hub)
    float rim = smoothstep(0.03, 0.0, edge);
    float topEdge = smoothstep(0.985, 1.0, vY) * (1.0 - step(0.5, abs(vNormal.y)));
    light += vTint * rim * uNeon * (0.7 + uSel * 0.8 * (0.6 + 0.4 * sin(uClock * 5.0)));
    light += vTint * topEdge * (0.35 + uNeon * 0.6);
    light += vTint * vGlow * 0.6;
    // la niebla se traga la fachada, pero las ventanas siguen titilando a lo lejos
    gl_FragColor = vec4(mix(col * uDim, uFogColor, vFog) + light * uDim * (1.0 - vFog * 0.72), 1.0);
  }`;

// Puntos de luz genéricos: faroles, balizas rojas y estrellas (parpadeo opcional).
const lampVertex = `
  attribute vec3 aColor; attribute float aSize; attribute float aPhase; attribute float aBlink;
  uniform float uClock; uniform float uScale; uniform float uExplode;
  varying vec3 vColor; varying float vA; varying float vFog;
  ${fogVertex}
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    float on = aBlink > 0.5 ? step(0.55, fract(uClock * 0.7 + aPhase)) * 0.9 + 0.1 : 0.75 + 0.25 * sin(uClock * 2.0 + aPhase * 20.0);
    vColor = aColor; vA = on * (1.0 - uExplode); vFog = fogOf(wp.xyz);
    vec4 mv = viewMatrix * wp;
    gl_PointSize = min(aSize * uScale / -mv.z, 6.0);
    gl_Position = projectionMatrix * mv;
  }`;
const lampFragment = `uniform vec3 uFogColor; varying vec3 vColor; varying float vA; varying float vFog;
  void main() { float d = length(gl_PointCoord - 0.5); gl_FragColor = vec4(vColor * (1.0 - vFog * 0.85), smoothstep(0.5, 0.0, d) * vA); }`;

export default function CityWorld({ nodes, centerLabel = "HUB", selectedId, filter, zoom, motion, onSelect, onGpuLost, onGpuFail }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({ selectedId, filter, zoom, motion, nodes });
  const callbacks = useRef({ onSelect, onGpuLost, onGpuFail });
  const actionsRef = useRef<{ explode?: () => void; resetView?: () => void; labelDown?: (id: string, ev: PointerEvent) => void; suppressClick?: boolean }>({});
  const initialNodes = useRef(nodes);

  // Datos y callbacks más recientes para el bucle de animación (sin rearmar la escena).
  useLayoutEffect(() => {
    stateRef.current = { selectedId, filter, zoom, motion, nodes };
    callbacks.current = { onSelect, onGpuLost, onGpuFail };
  });

  useEffect(() => {
    const mount = mountRef.current!;
    const labels = labelsRef.current!;
    const width = () => mount.clientWidth || 800;
    const height = () => mount.clientHeight || 600;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    } catch {
      callbacks.current.onGpuFail?.();
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(width(), height());
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    mount.appendChild(renderer.domElement);
    // Si Chrome reinicia su GPU, avisamos al padre para volver a montar el mundo en vez de quedarnos en blanco.
    const onLost = (ev: Event) => { ev.preventDefault(); callbacks.current.onGpuLost?.(); };
    renderer.domElement.addEventListener("webglcontextlost", onLost);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BG);

    // Cámara en perspectiva: vista aérea de la megaciudad con horizonte hasta el infinito.
    const camera = new THREE.PerspectiveCamera(40, width() / height(), 0.1, 1400);
    camera.position.set(56, 23, 56);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.enablePan = false;
    controls.enableZoom = false;
    controls.minPolarAngle = 0.55;
    controls.maxPolarAngle = 1.36;
    controls.rotateSpeed = 0.5;
    controls.autoRotateSpeed = 0.22;

    const rand = rng(1200800);
    const glowTex = glowTexture();
    const ringTex = ringTexture();
    const disposables: { dispose: () => void }[] = [glowTex, ringTex];
    const track = <T extends { dispose: () => void }>(x: T) => { disposables.push(x); return x; };
    const fogColor = new THREE.Color(FOG);
    const pxScale = () => renderer.getPixelRatio() * height() * 0.5;

    // Uniformes compartidos por todos los materiales que reaccionan.
    const shared = {
      uClock: { value: 0 },
      uMouse: { value: new THREE.Vector3(999, 0, 999) },
      uMouseForce: { value: 0 },
      uWaves: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0, 0, 0, -1)) },
      uExplode: { value: 0 },
    };
    const lampUniforms = { uClock: shared.uClock, uExplode: { value: 0 }, uScale: { value: pxScale() }, uFogColor: { value: fogColor } };
    const lampMat = track(new THREE.ShaderMaterial({ uniforms: lampUniforms, vertexShader: lampVertex, fragmentShader: lampFragment, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    const skyLampMat = track(new THREE.ShaderMaterial({ uniforms: { ...lampUniforms, uExplode: { value: 0 } }, vertexShader: lampVertex, fragmentShader: lampFragment, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    const lamps = (pts: { p: THREE.Vector3; c: THREE.Color; s: number; blink?: boolean }[], mat = lampMat) => {
      const n = pts.length;
      const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n), phase = new Float32Array(n), blink = new Float32Array(n);
      pts.forEach((x, i) => { pos.set([x.p.x, x.p.y, x.p.z], i * 3); col.set([x.c.r, x.c.g, x.c.b], i * 3); size[i] = x.s; phase[i] = rand(); blink[i] = x.blink ? 1 : 0; });
      const geo = track(new THREE.BufferGeometry());
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
      geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
      geo.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
      geo.setAttribute("aBlink", new THREE.BufferAttribute(blink, 1));
      const points = new THREE.Points(geo, mat);
      points.frustumCulled = false;
      scene.add(points);
      return points;
    };

    // ---------- Cielo: degradado con contaminación lumínica, estrellas, luna enorme y nebulosa ----------
    const skyMat = track(new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      vertexShader: `varying vec3 vD; void main() { vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying vec3 vD;
        void main() {
          float h = clamp(vD.y, -0.2, 1.0);
          vec3 top = vec3(0.002, 0.003, 0.008), mid = vec3(0.01, 0.011, 0.03), glow = vec3(0.07, 0.03, 0.06);
          vec3 col = mix(mid, top, smoothstep(0.0, 0.55, h));
          col += glow * exp(-max(h, 0.0) * 9.0) * 0.55; // resplandor de la ciudad en el horizonte
          col = mix(col, vec3(${fogColor.r.toFixed(3)}, ${fogColor.g.toFixed(3)}, ${fogColor.b.toFixed(3)}), smoothstep(0.02, -0.08, h));
          gl_FragColor = vec4(col, 1.0);
        }`,
    }));
    scene.add(new THREE.Mesh(track(new THREE.SphereGeometry(900, 32, 16)), skyMat));
    const starPts: { p: THREE.Vector3; c: THREE.Color; s: number }[] = [];
    const starCols = ["#ffffff", "#cfdcff", "#ffe2c0"].map((c) => new THREE.Color(c));
    for (let i = 0; i < 2600; i++) {
      const th = rand() * Math.PI * 2, u = 0.12 + rand() * 0.88, s = Math.sqrt(1 - u * u);
      starPts.push({ p: new THREE.Vector3(Math.cos(th) * s * 800, u * 800, Math.sin(th) * s * 800), c: starCols[i % 3].clone().multiplyScalar(0.5 + rand() * 0.5), s: 1.2 + Math.pow(rand(), 4) * 3 });
    }
    lamps(starPts, skyLampMat);
    // luna/planeta gigante con cráteres y halo
    const moonCanvas = document.createElement("canvas");
    moonCanvas.width = 512; moonCanvas.height = 256;
    const mg = moonCanvas.getContext("2d")!;
    mg.fillStyle = "#a7b1c6"; mg.fillRect(0, 0, 512, 256);
    for (let i = 0; i < 260; i++) {
      mg.fillStyle = rand() < 0.6 ? `rgba(70,80,100,${0.15 + rand() * 0.3})` : `rgba(220,228,240,${0.1 + rand() * 0.2})`;
      mg.beginPath(); mg.arc(rand() * 512, rand() * 256, 2 + Math.pow(rand(), 2) * 30, 0, Math.PI * 2); mg.fill();
    }
    const moonTex = track(new THREE.CanvasTexture(moonCanvas));
    moonTex.colorSpace = THREE.SRGBColorSpace;
    const moon = new THREE.Mesh(track(new THREE.SphereGeometry(70, 64, 32)), track(new THREE.MeshBasicMaterial({ map: moonTex, color: "#c9d2e6", fog: false })));
    moon.position.set(-330, 230, -520);
    scene.add(moon);
    const moonGlow = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: glowTex, color: "#7f9dff", transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })));
    moonGlow.position.copy(moon.position);
    moonGlow.scale.setScalar(360);
    scene.add(moonGlow);
    ([["#6a3fb8", 260, 300, -600, 520, 0.22], ["#2f5fc4", 120, 360, -640, 420, 0.16], ["#c2479c", 380, 220, -560, 300, 0.12]] as const).forEach(([c, x, y, z, sc, op]) => {
      const neb = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: glowTex, color: c, transparent: true, opacity: op, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })));
      neb.position.set(x, y, z);
      neb.scale.setScalar(sc);
      scene.add(neb);
    });

    // ---------- Suelo mojado: asfalto, calles con reflejos, estelas de autos y ondas ----------
    const groundMat = track(new THREE.ShaderMaterial({
      uniforms: { ...shared, uFogColor: { value: fogColor } },
      extensions: { derivatives: true } as never,
      vertexShader: `varying vec3 vW; varying float vFog; ${fogVertex} void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vFog = fogOf(w.xyz); gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `
        uniform float uClock; uniform vec3 uMouse; uniform float uMouseForce; uniform vec4 uWaves[4]; uniform vec3 uFogColor;
        varying vec3 vW; varying float vFog;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float street(float c, float period, float w) { float d = abs(fract(c / period + 0.5) - 0.5) * period; return smoothstep(w, w * 0.6, d); }
        void main() {
          vec3 pink = vec3(0.945, 0.525, 0.875), cyan = vec3(0.216, 0.898, 0.925);
          vec3 warm = vec3(1.0, 0.7, 0.4), red = vec3(1.0, 0.16, 0.12), white = vec3(0.9, 0.95, 1.0);
          // asfalto húmedo con charcos
          float puddle = smoothstep(0.55, 0.75, hash(floor(vW.xz * 0.6)) * 0.6 + hash(floor(vW.xz * 2.3)) * 0.4);
          vec3 col = vec3(0.003, 0.004, 0.006) + vec3(0.004, 0.006, 0.011) * puddle;
          // calles: avenidas grandes cada 12 y calles chicas cada 3
          float av = max(street(vW.x, 12.0, 1.5), street(vW.z, 12.0, 1.5));
          float st = max(street(vW.x, 3.0, 0.45), street(vW.z, 3.0, 0.45)) * 0.45;
          float road = max(av, st);
          col += vec3(0.004, 0.005, 0.007) * road;
          // reflejo de faroles: manchas cálidas alargadas sobre lo mojado
          vec2 lampCell = vec2(fract(vW.x / 3.0), fract(vW.z / 3.0));
          col += warm * 0.05 * road * (0.4 + puddle) * exp(-pow(length(lampCell - 0.5), 2.0) * 9.0);
          col += vec3(0.012, 0.01, 0.02) * av;
          // estelas de autos sobre las avenidas: blancas en un sentido, rojas en el otro
          float onX = street(vW.z, 12.0, 1.5), onZ = street(vW.x, 12.0, 1.5);
          float sideX = sign(fract(vW.z / 12.0 + 0.5) - 0.5), sideZ = sign(fract(vW.x / 12.0 + 0.5) - 0.5);
          float tx = smoothstep(0.85, 1.0, fract(vW.x * 0.08 - uClock * 0.35 * sideX + hash(vec2(floor(vW.z * 2.0), 3.0))));
          float tz = smoothstep(0.85, 1.0, fract(vW.z * 0.08 - uClock * 0.35 * sideZ + hash(vec2(floor(vW.x * 2.0), 5.0))));
          col += mix(white, red, step(0.0, sideX)) * tx * onX * 0.25 * (0.5 + puddle);
          col += mix(white, red, step(0.0, sideZ)) * tz * onZ * 0.25 * (0.5 + puddle);
          // brillo del distrito central y foco del mouse
          col += pink * 0.06 * exp(-dot(vW.xz, vW.xz) / 90.0);
          col += cyan * 0.35 * abs(uMouseForce) * exp(-dot(vW.xz - uMouse.xz, vW.xz - uMouse.xz) / 10.0);
          for (int i = 0; i < 4; i++) {
            vec4 w = uWaves[i];
            if (w.w < 0.0) continue;
            float age = uClock - w.w;
            if (age < 0.0 || age > 3.0) continue;
            float d = length(vW.xz - w.xz);
            col += mix(pink, cyan, 0.4) * 1.1 * exp(-pow(d - age * 13.0, 2.0) / 0.6) * (1.0 - age / 3.0);
          }
          gl_FragColor = vec4(mix(col, uFogColor, vFog), 1.0);
        }`,
    }));
    const ground = new THREE.Mesh(track(new THREE.PlaneGeometry(1200, 1200)), groundMat);
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    // ---------- Nodos (los datos que recibe el componente) ----------
    const nodeList = initialNodes.current;
    const homes = new Map(nodeList.map((n) => [n.id, new THREE.Vector3(n.x * SCALE, 0, n.y * SCALE)]));
    const occupied = [new THREE.Vector2(0, 0), ...[...homes.values()].map((v) => new THREE.Vector2(v.x, v.z))];

    // ---------- Edificios: núcleo jugable + skyline que se pierde en el horizonte ----------
    type Spot = { x: number; z: number; w: number; d: number; h: number; tint: THREE.Color };
    const accentTints = [PALETTE.pink, PALETTE.cyan, PALETTE.violet, "#6b9fff", PALETTE.magenta, "#ffb36b"].map((c) => new THREE.Color(c));
    const onAvenue = (x: number, z: number, m: number) => AVENUES.some((r) => Math.abs(x - r) < m || Math.abs(z - r) < m) || [-24, 24].some((r) => Math.abs(x - r) < m || Math.abs(z - r) < m);
    const core: Spot[] = [];
    for (let gx = -22.5; gx <= 22.5; gx += 2.5) {
      for (let gz = -22.5; gz <= 22.5; gz += 2.5) {
        const x = gx + (rand() - 0.5) * 0.5, z = gz + (rand() - 0.5) * 0.5;
        if (onAvenue(x, z, 1.7)) continue;
        if (occupied.some((o) => Math.hypot(o.x - x, o.y - z) < 3.3)) continue;
        if (rand() < 0.12) continue;
        const centerBias = 1 - Math.min(1, Math.hypot(x, z) / 32);
        core.push({ x, z, w: 1.2 + rand() * 0.9, d: 1.2 + rand() * 0.9, h: 1 + Math.pow(rand(), 2.2) * 13 * (0.35 + centerBias), tint: accentTints[Math.floor(rand() * accentTints.length)].clone().multiplyScalar(0.6) });
      }
    }
    const far: Spot[] = [];
    for (let i = 0; i < 4200; i++) {
      // anillos de ciudad hacia el horizonte, con distritos de rascacielos
      const r = 34 + Math.pow(rand(), 1.15) * 330, a = rand() * Math.PI * 2;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (onAvenue(x, z, 2.2)) continue;
      const district = Math.pow(Math.max(0, Math.sin(a * 5 + r * 0.03) * Math.cos(r * 0.045)), 2);
      const s = 1.6 + rand() * 2.6;
      const reach = THREE.MathUtils.smoothstep(r, 45, 120); // cerca de la cámara bajitos, los rascacielos hacia el horizonte
      far.push({ x, z, w: s, d: s * (0.7 + rand() * 0.6), h: 1 + rand() * 2.5 + reach * (Math.pow(rand(), 2.5) * 20 + district * 30 * rand()), tint: accentTints[Math.floor(rand() * accentTints.length)].clone().multiplyScalar(0.4) });
    }
    const boxGeo = track(new THREE.BoxGeometry(1, 1, 1));
    boxGeo.translate(0, 0.5, 0); // base en el suelo
    const makeBuildingMat = (extra: Record<string, THREE.IUniform>) =>
      track(new THREE.ShaderMaterial({ uniforms: { ...shared, uMovable: { value: 1 }, uDim: { value: 1 }, uSel: { value: 0 }, uNeon: { value: 0 }, uColor: { value: new THREE.Color() }, uUseColor: { value: 0 }, uFogColor: { value: fogColor }, ...extra }, vertexShader: buildingVertex, fragmentShader: buildingFragment }));
    const m4 = new THREE.Matrix4();
    const instanced = (spots: Spot[], mat: THREE.ShaderMaterial) => {
      const geo = track(boxGeo.clone());
      geo.setAttribute("aTint", new THREE.InstancedBufferAttribute(new Float32Array(spots.flatMap((s) => [s.tint.r, s.tint.g, s.tint.b])), 3));
      geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(new Float32Array(spots.map(() => rand())), 1));
      const mesh = new THREE.InstancedMesh(geo, mat, spots.length);
      spots.forEach((s, i) => mesh.setMatrixAt(i, m4.compose(new THREE.Vector3(s.x, 0, s.z), new THREE.Quaternion(), new THREE.Vector3(s.w, s.h, s.d))));
      mesh.frustumCulled = false;
      scene.add(mesh);
      return mesh;
    };
    instanced(core, makeBuildingMat({}));
    instanced(far, makeBuildingMat({ uMovable: { value: 0 } }));

    // antenas con baliza roja en los rascacielos y faroles a lo largo de las calles
    const red = new THREE.Color("#ff3b30"), warmLamp = new THREE.Color("#ffb46a"), coolLamp = new THREE.Color("#a8d4ff");
    const beaconPts = [...core, ...far].filter((s) => s.h > 9).map((s) => ({ p: new THREE.Vector3(s.x, s.h + 0.35, s.z), c: red, s: 0.5, blink: true }));
    lamps(beaconPts);
    const masts: THREE.Vector3[] = core.filter((s) => s.h > 9).map((s) => new THREE.Vector3(s.x, s.h, s.z));
    if (masts.length) {
      const mastGeo = track(new THREE.CylinderGeometry(0.03, 0.05, 0.7, 5));
      mastGeo.translate(0, 0.35, 0);
      const mastMesh = new THREE.InstancedMesh(mastGeo, track(new THREE.MeshBasicMaterial({ color: "#3a4256" })), masts.length);
      masts.forEach((p, i) => mastMesh.setMatrixAt(i, m4.makeTranslation(p.x, p.y, p.z)));
      scene.add(mastMesh);
    }
    const streetPts: { p: THREE.Vector3; c: THREE.Color; s: number }[] = [];
    for (let v = -120; v <= 120; v += 12) {
      for (let k = -150; k <= 150; k += 1.6) {
        const c = Math.abs(k) % 9 < 1.6 ? coolLamp : warmLamp;
        streetPts.push({ p: new THREE.Vector3(k, 0.35, v + 1.7), c, s: 0.32 }, { p: new THREE.Vector3(k, 0.35, v - 1.7), c, s: 0.32 });
        streetPts.push({ p: new THREE.Vector3(v + 1.7, 0.35, k), c, s: 0.32 }, { p: new THREE.Vector3(v - 1.7, 0.35, k), c, s: 0.32 });
      }
    }
    lamps(streetPts);

    // ---------- Tráfico aéreo: carriles de autos voladores (faros blancos de ida, calaveras rojas de vuelta) ----------
    const CARS: { a: THREE.Vector3; b: THREE.Vector3; off: number; speed: number; c: THREE.Color; size: number }[] = [];
    const head = new THREE.Color("#fff3df"), tail = new THREE.Color("#ff2a1e"), blue = new THREE.Color("#7fc8ff");
    [...AVENUES, -36, 36].forEach((v) => {
      [3.2, 5.4, 8.2, 12].forEach((y, li) => {
        [1, -1].forEach((dir) => {
          const lateral = dir * (0.55 + li * 0.18);
          const n = 70 - li * 8;
          for (let k = 0; k < n; k++) {
            const off = rand(), speed = (0.012 + rand() * 0.01) * (li > 2 ? 1.5 : 1);
            const c = dir > 0 ? (rand() < 0.15 ? blue : head) : tail;
            const ax = new THREE.Vector3(-170 * dir, y, v + lateral), bx = new THREE.Vector3(170 * dir, y, v + lateral);
            const az = new THREE.Vector3(v + lateral, y, -170 * dir), bz = new THREE.Vector3(v + lateral, y, 170 * dir);
            // dos puntos por auto: luz principal y una estela más tenue detrás
            CARS.push({ a: ax, b: bx, off, speed, c: c.clone().multiplyScalar(1.6), size: 0.42 }, { a: ax, b: bx, off: off - 0.0012, speed, c: c.clone().multiplyScalar(0.5), size: 0.22 }, { a: ax, b: bx, off: off - 0.0024, speed, c: c.clone().multiplyScalar(0.25), size: 0.16 });
            CARS.push({ a: az, b: bz, off: off + 0.37, speed, c: c.clone().multiplyScalar(1.6), size: 0.42 }, { a: az, b: bz, off: off + 0.3688, speed, c: c.clone().multiplyScalar(0.5), size: 0.22 }, { a: az, b: bz, off: off + 0.3676, speed, c: c.clone().multiplyScalar(0.25), size: 0.16 });
          }
        });
      });
    });
    const carGeo = track(new THREE.BufferGeometry());
    const cA = new Float32Array(CARS.length * 3), cB = new Float32Array(CARS.length * 3), cOff = new Float32Array(CARS.length), cSpd = new Float32Array(CARS.length), cCol = new Float32Array(CARS.length * 3), cSize = new Float32Array(CARS.length);
    CARS.forEach((car, i) => { cA.set([car.a.x, car.a.y, car.a.z], i * 3); cB.set([car.b.x, car.b.y, car.b.z], i * 3); cOff[i] = car.off; cSpd[i] = car.speed; cCol.set([car.c.r, car.c.g, car.c.b], i * 3); cSize[i] = car.size; });
    carGeo.setAttribute("position", new THREE.BufferAttribute(cA, 3));
    carGeo.setAttribute("aB", new THREE.BufferAttribute(cB, 3));
    carGeo.setAttribute("aOff", new THREE.BufferAttribute(cOff, 1));
    carGeo.setAttribute("aSpeed", new THREE.BufferAttribute(cSpd, 1));
    carGeo.setAttribute("aColor", new THREE.BufferAttribute(cCol, 3));
    carGeo.setAttribute("aSize", new THREE.BufferAttribute(cSize, 1));
    const carMat = track(new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uScale: lampUniforms.uScale, uFogColor: { value: fogColor }, uWaves: shared.uWaves, uClock: shared.uClock, uExplode: shared.uExplode },
      vertexShader: `
        attribute vec3 aB; attribute float aOff; attribute float aSpeed; attribute vec3 aColor; attribute float aSize;
        uniform float uTime; uniform float uScale; uniform vec4 uWaves[4]; uniform float uClock; uniform float uExplode;
        varying vec3 vColor; varying float vFog;
        ${fogVertex}
        void main() {
          vec3 p = mix(position, aB, fract(aOff + uTime * aSpeed));
          float boost = 0.0;
          for (int i = 0; i < 4; i++) {
            vec4 w = uWaves[i];
            if (w.w < 0.0) continue;
            float age = uClock - w.w;
            if (age < 0.0 || age > 3.0) continue;
            float ring = exp(-pow(length(p.xz - w.xz) - age * 13.0, 2.0) / 4.0) * (1.0 - age / 3.0);
            p.y += ring * 2.5; boost += ring;
          }
          p.y += uExplode * 10.0 * fract(aOff * 13.0);
          vColor = aColor * (1.0 + boost * 2.0); vFog = fogOf(p);
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_PointSize = min(aSize * (1.0 + boost) * uScale / -mv.z, 7.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `varying vec3 vColor; varying float vFog; void main() { float d = length(gl_PointCoord - 0.5); gl_FragColor = vec4(vColor * (1.0 - vFog * 0.9), smoothstep(0.5, 0.0, d)); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    const traffic = new THREE.Points(carGeo, carMat);
    traffic.frustumCulled = false;
    scene.add(traffic);

    // ---------- Maglev elevado alrededor del centro ----------
    const steel = track(new THREE.MeshStandardMaterial({ color: "#8e97ab", metalness: 0.85, roughness: 0.32 }));
    const darkSteel = track(new THREE.MeshStandardMaterial({ color: "#2b3142", metalness: 0.8, roughness: 0.45 }));
    scene.add(new THREE.AmbientLight("#4a5878", 0.6));
    const moonLight = new THREE.DirectionalLight("#b8c8ff", 1.6);
    moonLight.position.set(-60, 80, -40);
    scene.add(moonLight);
    const railCurve = new THREE.CatmullRomCurve3(Array.from({ length: 40 }, (_, i) => {
      const a = (i / 40) * Math.PI * 2;
      return new THREE.Vector3(Math.cos(a) * 27, 6 + Math.sin(a * 3) * 0.8, Math.sin(a) * 24);
    }), true);
    scene.add(new THREE.Mesh(track(new THREE.TubeGeometry(railCurve, 300, 0.32, 6, true)), darkSteel));
    const railStrip = new THREE.Mesh(track(new THREE.TubeGeometry(railCurve, 300, 0.07, 4, true)), track(new THREE.MeshBasicMaterial({ color: "#7fd0ff" })));
    railStrip.position.y = 0.3;
    scene.add(railStrip);
    const pillarGeo = track(new THREE.BoxGeometry(0.35, 1, 0.35));
    pillarGeo.translate(0, 0.5, 0);
    for (let k = 0; k < 28; k++) {
      const p = railCurve.getPointAt(k / 28);
      const pillar = new THREE.Mesh(pillarGeo, steel);
      pillar.position.set(p.x, 0, p.z);
      pillar.scale.y = p.y;
      scene.add(pillar);
    }
    const trainCarGeo = track(new THREE.CapsuleGeometry(0.42, 2.2, 6, 14));
    const trainWin = track(new THREE.MeshBasicMaterial({ color: "#bfe6ff" }));
    const trainWinGeo = track(new THREE.BoxGeometry(0.06, 1.9, 0.2));
    const up = new THREE.Vector3(0, 1, 0);
    const railLen = railCurve.getLength();
    const trains = [0, 0.5].map((u0) => {
      const cars = Array.from({ length: 6 }, () => {
        const car = new THREE.Group();
        const w1 = new THREE.Mesh(trainWinGeo, trainWin);
        w1.position.x = 0.4;
        const w2 = w1.clone();
        w2.position.x = -0.4;
        car.add(new THREE.Mesh(trainCarGeo, steel), w1, w2);
        scene.add(car);
        return car;
      });
      const lamp = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: glowTex, color: "#6fc0ff", transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));
      lamp.scale.setScalar(3);
      scene.add(lamp);
      return { cars, lamp, u: u0 };
    });

    // ---------- Torre central (hub): aguja de acero con anillo y baliza ----------
    const hubMat = makeBuildingMat({ uMovable: { value: 0 }, uColor: { value: new THREE.Color(PALETTE.pink) }, uUseColor: { value: 1 }, uNeon: { value: 1 } });
    const hubGeo = track(boxGeo.clone());
    hubGeo.setAttribute("aTint", new THREE.Float32BufferAttribute(new Array(hubGeo.attributes.position.count * 3).fill(0), 3));
    hubGeo.setAttribute("aSeed", new THREE.Float32BufferAttribute(new Array(hubGeo.attributes.position.count).fill(0.37), 1));
    const hubTower = new THREE.Mesh(hubGeo, hubMat);
    hubTower.scale.set(2.6, 15, 2.6);
    scene.add(hubTower);
    const spire = new THREE.Mesh(track(new THREE.CylinderGeometry(0.05, 0.4, 5, 8)), steel);
    spire.position.y = 17.5;
    scene.add(spire);
    const hubRing = new THREE.Mesh(track(new THREE.TorusGeometry(3.4, 0.06, 8, 80)), track(new THREE.MeshBasicMaterial({ color: PALETTE.pink, transparent: true, opacity: 0.9 })));
    hubRing.rotation.x = Math.PI / 2;
    hubRing.position.y = 0.15;
    scene.add(hubRing);
    const hubRing2 = new THREE.Mesh(track(new THREE.TorusGeometry(2.2, 0.05, 8, 60)), track(new THREE.MeshBasicMaterial({ color: PALETTE.pink, transparent: true, opacity: 0.8 })));
    hubRing2.rotation.x = Math.PI / 2;
    hubRing2.position.y = 15.6;
    scene.add(hubRing2);
    const hubBeacon = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: glowTex, color: PALETTE.pink, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));
    hubBeacon.position.y = 20.2;
    hubBeacon.scale.setScalar(4);
    scene.add(hubBeacon);

    // Holograma: anuncio de luz en el color del nodo, con líneas de escaneo y parpadeo.
    const holoMat = (color: string) => track(new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color) }, uClock: shared.uClock, uDim: { value: 1 } },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform vec3 uColor; uniform float uClock; uniform float uDim; varying vec2 vUv;
        void main() {
          float scan = 0.65 + 0.35 * sin(vUv.y * 90.0 - uClock * 6.0);
          float frame = step(min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y)), 0.05);
          float bars = step(0.35, fract(vUv.x * 5.0 + floor(vUv.y * 4.0) * 0.37)) * step(0.2, vUv.y) * step(vUv.y, 0.8) * 0.35;
          float flick = 0.85 + 0.15 * step(0.92, fract(sin(uClock * 3.1) * 43.7));
          float a = (0.28 * scan + frame * 0.9 + bars) * flick * uDim;
          gl_FragColor = vec4(uColor * 1.6, a);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));

    // ---------- Torres (apps) y antenas (redes) ----------
    type NodeObj = { group: THREE.Group; mat: THREE.ShaderMaterial; pick: THREE.Mesh; top: number; extra: THREE.Material[]; holos: THREE.ShaderMaterial[] };
    const nodeObjs = new Map<string, NodeObj>();
    const picks: THREE.Mesh[] = [];
    const anchors = new Map<string, THREE.Vector3>([["hub", new THREE.Vector3(0, 22, 0)]]);
    const phys = new Map<string, { home: THREE.Vector3; pos: THREE.Vector3; vel: THREE.Vector3 }>();
    nodeList.forEach((n) => {
      const home = homes.get(n.id)!;
      const group = new THREE.Group();
      group.position.copy(home);
      const geo = track(boxGeo.clone());
      geo.setAttribute("aTint", new THREE.Float32BufferAttribute(new Array(geo.attributes.position.count * 3).fill(0), 3));
      geo.setAttribute("aSeed", new THREE.Float32BufferAttribute(new Array(geo.attributes.position.count).fill(rand()), 1));
      const mat = makeBuildingMat({ uMovable: { value: 0 }, uColor: { value: new THREE.Color(n.color) }, uUseColor: { value: 1 }, uNeon: { value: 1 } });
      const isApp = n.type === "app";
      const bh = isApp ? Math.max(4, n.height / 7) : 3;
      const body = new THREE.Mesh(geo, mat);
      body.scale.set(2.3, bh, 2.3);
      group.add(body);
      const extra: THREE.Material[] = [];
      const holos: THREE.ShaderMaterial[] = [];
      let top = bh;
      // anuncios holográficos en dos caras del edificio
      [[0, 1.17, 0], [Math.PI / 2, 0, 1.17]].forEach(([rot, dz, dx], i) => {
        const hm = holoMat(n.color);
        const holo = new THREE.Mesh(track(new THREE.PlaneGeometry(1.9, Math.min(bh * 0.4, 3.2))), hm);
        holo.position.set(dx as number, bh * (i ? 0.45 : 0.65), dz as number);
        holo.rotation.y = rot as number;
        group.add(holo);
        holos.push(hm);
      });
      if (!isApp) {
        // antena: mástil, anillos que laten y esfera brillante
        const poleMat = track(new THREE.MeshBasicMaterial({ color: n.color }));
        const pole = new THREE.Mesh(track(new THREE.CylinderGeometry(0.06, 0.06, 3.6, 8)), poleMat);
        pole.position.y = bh + 1.8;
        group.add(pole);
        [0.9, 1.5].forEach((r, i) => {
          const ringMat = track(new THREE.MeshBasicMaterial({ color: n.color, transparent: true, opacity: 0.8 }));
          const ring = new THREE.Mesh(track(new THREE.TorusGeometry(r, 0.035, 6, 48)), ringMat);
          ring.rotation.x = Math.PI / 2;
          ring.position.y = bh + 2.6 + i * 0.5;
          ring.userData.pulse = i;
          group.add(ring);
          extra.push(ringMat);
        });
        top = bh + 3.6;
        extra.push(poleMat);
      }
      const beacon = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: glowTex, color: n.color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));
      beacon.position.y = top + 0.3;
      beacon.scale.setScalar(isApp ? 2.4 : 2);
      group.add(beacon);
      extra.push(beacon.material);
      const halo = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: ringTex, color: n.color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.6 })));
      halo.position.y = 0.05;
      halo.scale.setScalar(5);
      group.add(halo);
      extra.push(halo.material);
      // caja invisible para tocar/arrastrar
      const pick = new THREE.Mesh(track(new THREE.BoxGeometry(3, top + 1, 3)), track(new THREE.MeshBasicMaterial({ visible: false })));
      pick.position.y = (top + 1) / 2;
      pick.userData.id = n.id;
      group.add(pick);
      picks.push(pick);
      scene.add(group);
      nodeObjs.set(n.id, { group, mat, pick, top, extra, holos });
      anchors.set(n.id, new THREE.Vector3(home.x, top + 1.4, home.z));
      phys.set(n.id, { home: home.clone(), pos: home.clone(), vel: new THREE.Vector3() });
    });

    // ---------- Líneas de datos del hub a cada nodo (siguen a los nodos) ----------
    const linkPos = new Float32Array(nodeList.length * 6);
    const linkCol = new Float32Array(nodeList.length * 6);
    nodeList.forEach((n, i) => {
      const c = new THREE.Color(n.color);
      linkCol.set([1, 0.53, 0.87, c.r, c.g, c.b], i * 6);
    });
    const linkGeo = track(new THREE.BufferGeometry());
    const linkAttr = new THREE.BufferAttribute(linkPos, 3);
    linkAttr.setUsage(THREE.DynamicDrawUsage);
    linkGeo.setAttribute("position", linkAttr);
    linkGeo.setAttribute("color", new THREE.BufferAttribute(linkCol, 3));
    scene.add(new THREE.LineSegments(linkGeo, track(new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }))));
    const updateLinks = () => {
      nodeList.forEach((n, i) => {
        const p = phys.get(n.id)!.pos;
        linkPos.set([0, 0.08, 0, p.x, 0.08, p.z], i * 6);
      });
      linkAttr.needsUpdate = true;
      linkGeo.computeBoundingSphere();
    };

    // ---------- Polvo y llovizna en el aire (reaccionan al mouse, ondas y explosión) ----------
    const SPARKS = 1400;
    const sp = new Float32Array(SPARKS * 3), sc = new Float32Array(SPARKS * 3), ss = new Float32Array(SPARKS);
    const sparkPalette = ["#ffd9a8", "#a8c8ff", "#ffffff", PALETTE.pink].map((c) => new THREE.Color(c));
    for (let i = 0; i < SPARKS; i++) {
      sp.set([(rand() - 0.5) * 60, rand() * 22, (rand() - 0.5) * 60], i * 3);
      const c = sparkPalette[i % 11 === 0 ? 3 : Math.floor(rand() * 3)];
      sc.set([c.r, c.g, c.b], i * 3);
      ss[i] = rand();
    }
    const sparkGeo = track(new THREE.BufferGeometry());
    sparkGeo.setAttribute("position", new THREE.BufferAttribute(sp, 3));
    sparkGeo.setAttribute("aColor", new THREE.BufferAttribute(sc, 3));
    sparkGeo.setAttribute("aSeed", new THREE.BufferAttribute(ss, 1));
    const sparkMat = track(new THREE.ShaderMaterial({
      uniforms: { ...shared, uTime: { value: 0 }, uPx: { value: renderer.getPixelRatio() } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `
        attribute vec3 aColor; attribute float aSeed;
        uniform float uTime; uniform float uClock; uniform vec3 uMouse; uniform float uMouseForce; uniform vec4 uWaves[4]; uniform float uExplode; uniform float uPx;
        varying vec3 vC; varying float vA;
        void main() {
          vec3 p = position;
          p.y = mod(p.y + uTime * (0.2 + aSeed * 0.5), 22.0);
          vec3 dm = p - vec3(uMouse.x, p.y, uMouse.z);
          float dl = length(dm);
          p += (dl > 0.001 ? dm / dl : vec3(0.0)) * uMouseForce * exp(-dl * dl / 10.0) * 2.5;
          float boost = 0.0;
          for (int i = 0; i < 4; i++) {
            vec4 w = uWaves[i];
            if (w.w < 0.0) continue;
            float age = uClock - w.w;
            if (age < 0.0 || age > 3.0) continue;
            float d = length(p.xz - w.xz);
            float ring = exp(-pow(d - age * 13.0, 2.0) / 3.0) * (1.0 - age / 3.0);
            p.y += ring * 3.0; boost += ring;
          }
          vec2 o = normalize(p.xz + vec2(0.001)) * uExplode * (4.0 + aSeed * 10.0);
          p += vec3(o.x, uExplode * (6.0 + aSeed * 14.0), o.y);
          vC = aColor; vA = (0.12 + 0.3 * fract(aSeed * 13.7)) * (1.0 - smoothstep(18.0, 22.0, position.y)) + boost;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = (1.0 + aSeed * 2.0) * uPx * (1.0 + boost);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `varying vec3 vC; varying float vA; void main() { float d = length(gl_PointCoord - 0.5); gl_FragColor = vec4(vC, smoothstep(0.5, 0.0, d) * vA); }`,
    }));
    scene.add(new THREE.Points(sparkGeo, sparkMat));

    // ---------- Brillo ----------
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(width(), height()), 0.75, 0.5, 0.42);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    // ---------- Interacción ----------
    const clock = new THREE.Clock();
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    let downAt = { x: 0, y: 0 };
    let moved = false;
    let dragging: string | null = null;
    const mouseTarget = new THREE.Vector3(999, 0, 999);
    let mouseForceTarget = 0;
    let wheelZoom = 1;
    let waveIndex = 0;
    let explodeAt = -1;
    const setRay = (ev: { clientX: number; clientY: number }) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
    };
    const pickAt = (ev: PointerEvent) => {
      setRay(ev);
      const h = raycaster.intersectObjects(picks, false)[0];
      return h ? (h.object.userData.id as string) : null;
    };
    const startDrag = (id: string) => {
      dragging = id;
      controls.enabled = false;
    };
    const endDrag = (ev: PointerEvent) => {
      const id = dragging;
      dragging = null;
      controls.enabled = true;
      const wasDrag = moved || Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) > 5;
      return { id, wasDrag };
    };
    const onDown = (ev: PointerEvent) => {
      downAt = { x: ev.clientX, y: ev.clientY };
      moved = false;
      const id = pickAt(ev);
      if (id) {
        startDrag(id);
        renderer.domElement.setPointerCapture(ev.pointerId);
      }
    };
    const onUp = (ev: PointerEvent) => {
      if (dragging) {
        if (renderer.domElement.hasPointerCapture(ev.pointerId)) renderer.domElement.releasePointerCapture(ev.pointerId);
        const { id, wasDrag } = endDrag(ev);
        if (!wasDrag && id) callbacks.current.onSelect(id);
        return;
      }
      if (moved || Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) > 5) return;
      // clic en el vacío: onda por el suelo
      setRay(ev);
      if (!raycaster.ray.intersectPlane(groundPlane, hit)) return;
      (shared.uWaves.value[waveIndex % 4] as THREE.Vector4).set(hit.x, 0, hit.z, clock.getElapsedTime());
      waveIndex++;
    };
    const onMove = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) > 5) moved = true;
      setRay(ev);
      const onGround = raycaster.ray.intersectPlane(groundPlane, hit);
      if (dragging) {
        if (onGround) {
          const ph = phys.get(dragging)!;
          ph.pos.set(THREE.MathUtils.clamp(hit.x, -22, 22), 0, THREE.MathUtils.clamp(hit.z, -22, 22));
          ph.vel.set(0, 0, 0);
        }
        return;
      }
      if (onGround) mouseTarget.copy(hit);
      mouseForceTarget = ev.shiftKey ? -1 : 1;
      renderer.domElement.style.cursor = pickAt(ev) ? "grab" : "crosshair";
    };
    const onLeave = () => { mouseForceTarget = 0; };
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      wheelZoom = THREE.MathUtils.clamp(wheelZoom * Math.exp(-ev.deltaY * 0.0012), 0.55, 3);
    };
    const onWinMove = (ev: PointerEvent) => onMove(ev);
    const onWinUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onWinMove);
      actionsRef.current.suppressClick = endDrag(ev).wasDrag;
    };
    actionsRef.current.labelDown = (id, ev) => {
      downAt = { x: ev.clientX, y: ev.clientY };
      moved = false;
      startDrag(id);
      window.addEventListener("pointermove", onWinMove);
      window.addEventListener("pointerup", onWinUp, { once: true });
    };
    actionsRef.current.explode = () => { explodeAt = clock.getElapsedTime(); };
    actionsRef.current.resetView = () => { wheelZoom = 1; };
    const el = renderer.domElement;
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("wheel", onWheel, { passive: false });

    const resize = () => {
      camera.aspect = width() / height();
      camera.updateProjectionMatrix();
      renderer.setSize(width(), height());
      composer.setSize(width(), height());
      lampUniforms.uScale.value = pxScale();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    // ---------- Bucle ----------
    const target = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    const look = new THREE.Vector3();
    const HOME = new THREE.Vector3(0, 7, 0);
    let lastT = 0;
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const t = clock.getElapsedTime();
      const dt = Math.min(t - lastT, 0.05);
      lastT = t;
      const s = stateRef.current;
      shared.uClock.value = t;
      if (s.motion) {
        sparkMat.uniforms.uTime.value = t;
        carMat.uniforms.uTime.value += dt;
      }
      shared.uMouseForce.value = THREE.MathUtils.lerp(shared.uMouseForce.value, mouseForceTarget, 0.12);
      (shared.uMouse.value as THREE.Vector3).lerp(mouseTarget, 0.35);
      let e = 0;
      if (explodeAt >= 0) {
        e = explodeCurve(t - explodeAt);
        if (e < 0) { e = 0; explodeAt = -1; }
      }
      shared.uExplode.value = e;
      lampUniforms.uExplode.value = e;
      bloom.strength = 0.75 + e * 0.5;
      controls.autoRotate = s.motion && !s.selectedId && !dragging;
      // foco y zoom: la cámara se acerca al nodo elegido
      const focus = s.selectedId ? phys.get(s.selectedId)?.pos : null;
      target.copy(focus ? tmp.copy(focus).setY(4) : HOME);
      controls.target.lerp(target, 0.07);
      const desired = (focus ? 34 : 74) / Math.max(0.3, s.zoom * wheelZoom);
      tmp.copy(camera.position).sub(controls.target);
      tmp.setLength(THREE.MathUtils.lerp(tmp.length(), desired, 0.06));
      camera.position.copy(controls.target).add(tmp);
      controls.update();
      // anillos del hub y maglev
      if (s.motion) {
        hubRing.rotation.z = t * 0.4;
        hubRing2.rotation.z = -t * 0.6;
        (hubBeacon.material as THREE.SpriteMaterial).opacity = 0.75 + Math.sin(t * 2) * 0.25;
        trains.forEach((tr) => { tr.u = (tr.u + (dt * 9) / railLen) % 1; });
      }
      trains.forEach((tr) => {
        tr.cars.forEach((car, k) => {
          const u = (tr.u - (k * 2.9) / railLen + 1) % 1;
          car.position.copy(railCurve.getPointAt(u)).addScaledVector(up, 0.75 + e * 6);
          look.copy(railCurve.getTangentAt(u));
          car.quaternion.setFromUnitVectors(up, look);
          if (k === 0) tr.lamp.position.copy(car.position).addScaledVector(look, 1.9);
        });
      });
      // nodos: resorte, atenuado por filtro y selección
      nodeObjs.forEach((o, id) => {
        const ph = phys.get(id)!;
        if (dragging !== id) {
          ph.vel.add(tmp.copy(ph.home).sub(ph.pos).multiplyScalar(0.07)).multiplyScalar(0.84);
          ph.pos.add(ph.vel);
        }
        o.group.position.copy(ph.pos);
        anchors.get(id)!.set(ph.pos.x, o.top + 1.4, ph.pos.z);
        const node = s.nodes.find((n) => n.id === id);
        const faded = node ? s.filter !== "all" && node.type !== s.filter : false;
        const dim = faded ? 0.25 : node && !node.hasData ? 0.6 : 1;
        o.mat.uniforms.uDim.value = dim;
        o.mat.uniforms.uSel.value = s.selectedId === id ? 1 : 0;
        o.holos.forEach((h) => { h.uniforms.uDim.value = dim * (s.selectedId === id ? 1.5 : 1); });
        o.extra.forEach((m) => { (m as THREE.MeshBasicMaterial).opacity = dim * 0.9; m.transparent = true; });
        o.group.children.forEach((c) => {
          if (c.userData.pulse !== undefined && s.motion) c.scale.setScalar(1 + Math.sin(t * 3 + c.userData.pulse * 1.4) * 0.12);
        });
      });
      updateLinks();
      composer.render();
      // etiquetas HTML proyectadas
      const w = width(), h = height();
      labels.querySelectorAll<HTMLElement>("[data-anchor]").forEach((lab) => {
        const a = anchors.get(lab.dataset.anchor!);
        if (!a) return;
        const v = a.clone().project(camera);
        lab.style.transform = `translate(-50%, -100%) translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px)`;
        lab.style.opacity = v.z > 1 ? "0" : e > 0.05 ? String(1 - e) : "1";
        lab.style.zIndex = String(1000 + Math.round(-v.z * 500) + (lab.classList.contains("node") ? 2000 : 0));
      });
    };
    updateLinks();
    loop();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("wheel", onWheel);
      window.removeEventListener("pointermove", onWinMove);
      controls.dispose();
      bloom.dispose();
      composer.dispose();
      disposables.forEach((d) => d.dispose());
      renderer.domElement.removeEventListener("webglcontextlost", onLost);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div className="city-world city3d-world">
      <div className="city-canvas" ref={mountRef} />
      <div className="city3d-vignette" />
      <div className="city-labels" ref={labelsRef}>
        <div className="city3d-hub" data-anchor="hub"><b>{centerLabel}</b><span>/ 01</span></div>
        {nodes.map((n) => {
          const faded = filter !== "all" && n.type !== filter;
          return (
            <button
              key={n.id}
              className={`city-label node city3d-node ${selectedId === n.id ? "selected" : ""} ${faded ? "faded" : ""} ${n.hasData ? "" : "nodata"}`}
              data-anchor={n.id}
              style={{ ["--node" as string]: n.color }}
              onPointerDown={(e) => { if (e.button === 0) actionsRef.current.labelDown?.(n.id, e.nativeEvent); }}
              onClick={() => {
                if (actionsRef.current.suppressClick) { actionsRef.current.suppressClick = false; return; }
                onSelect(n.id);
              }}
            >
              <i />
              <span>{n.name}</span>
              <em>{n.hasData ? `${n.value} ${n.unit}` : "sin datos"}</em>
            </button>
          );
        })}
      </div>
      <div className="city-tools">
        <button className="city-boom" onClick={() => actionsRef.current.explode?.()} title="Los edificios salen volando y vuelven a su lugar">
          <span>✸</span> Explosión
        </button>
        <button className="city-reset" onClick={() => actionsRef.current.resetView?.()} title="Regresa el zoom de la rueda">Zoom 1:1</button>
        <ul className="city-help">
          <li><b>Arrastrar</b> gira la ciudad</li>
          <li><b>Rueda</b> acerca y aleja</li>
          <li><b>Clic en el suelo</b> lanza una onda</li>
          <li><b>Cursor</b> hace crecer edificios · <b>Shift</b> los hunde</li>
          <li><b>Arrastrar una torre</b> la mueve como resorte</li>
        </ul>
      </div>
    </div>
  );
}
