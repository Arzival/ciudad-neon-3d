import * as THREE from "three";

/** Utilidades de la escena: paleta, texturas generadas en canvas, aleatorio con semilla y curva de la explosión. */

/** Paleta neón de la ciudad. */
export const PALETTE = { bg: "#070912", pink: "#f186df", magenta: "#ed74ff", cyan: "#37e5ec", violet: "#8a6bff", neon: "#b8ff38" };

export function radialTexture(stops: [number, string][]) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  stops.forEach(([o, col]) => grad.addColorStop(o, col));
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Halo blanco que se tiñe con el color del material. */
export const glowTexture = () => radialTexture([[0, "rgba(255,255,255,1)"], [0.18, "rgba(255,255,255,0.85)"], [0.45, "rgba(255,255,255,0.3)"], [1, "rgba(255,255,255,0)"]]);

export function ringTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.strokeStyle = "rgba(255,255,255,1)";
  g.lineWidth = 7;
  g.shadowColor = "rgba(255,255,255,0.9)";
  g.shadowBlur = 14;
  g.beginPath();
  g.arc(64, 64, 46, 0, Math.PI * 2);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Generador pseudoaleatorio con semilla: el mundo sale igual en cada carga. */
export function rng(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

/** Curva de la explosión: sale (1.1 s), se queda (1 s) y vuelve (1.9 s). Devuelve 0..1 o -1 al terminar. */
export function explodeCurve(age: number) {
  if (age < 0) return 0;
  if (age < 1.1) return 1 - Math.pow(1 - age / 1.1, 3);
  if (age < 2.1) return 1;
  if (age < 4.0) {
    const b = (age - 2.1) / 1.9;
    return 1 - (b < 0.5 ? 4 * b * b * b : 1 - Math.pow(-2 * b + 2, 3) / 2);
  }
  return -1;
}

/** ¿Hay WebGL en este navegador? */
export function hasWebGL() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}
