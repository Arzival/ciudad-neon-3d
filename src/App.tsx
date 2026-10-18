import { useEffect, useMemo, useState } from "react";
import CityWorld, { type CityWorldNode } from "./city/CityWorld";
import { hasWebGL } from "./city/three-helpers";

/**
 * Página de demostración. Los datos son de ejemplo: en tu proyecto, cambia DEMO_NODES por los tuyos
 * (por ejemplo, lo que regrese tu API) y la ciudad se actualiza sola, sin volver a armar la escena.
 */
const DEMO_NODES: CityWorldNode[] = [
  // Repartidos en un anillo alrededor de la torre central para que las etiquetas no se encimen.
  // Apps: torres. La altura sale de `height` (más alto = torre más alta).
  { id: "tienda", name: "Tienda", type: "app", color: "#37e5ec", value: "1.2K", unit: "pedidos", hasData: true, x: -73, y: -175, height: 110 },
  { id: "blog", name: "Blog", type: "app", color: "#b8ff38", value: "8.4K", unit: "visitas", hasData: true, x: 175, y: -73, height: 70 },
  { id: "notas", name: "Notas", type: "app", color: "#8a6bff", value: "312", unit: "notas", hasData: true, x: -175, y: 73, height: 55 },
  { id: "finanzas", name: "Finanzas", type: "app", color: "#ffb36b", value: "$4.8K", unit: "MXN", hasData: true, x: 73, y: 175, height: 90 },
  // Redes: antenas.
  { id: "tiktok", name: "TikTok", type: "social", color: "#f186df", value: "12.3K", unit: "seguidores", hasData: true, x: -175, y: -73, height: 40 },
  { id: "instagram", name: "Instagram", type: "social", color: "#ed74ff", value: "3.4K", unit: "seguidores", hasData: true, x: 175, y: 73, height: 40 },
  { id: "youtube", name: "YouTube", type: "social", color: "#ff5a5a", value: "890", unit: "suscriptores", hasData: true, x: 73, y: -175, height: 40 },
  { id: "x", name: "X", type: "social", color: "#6b9fff", value: "", unit: "", hasData: false, x: -73, y: 175, height: 40 },
];

type Filter = "all" | "app" | "social";
const FILTERS: [Filter, string][] = [["all", "Todo"], ["app", "Apps"], ["social", "Redes"]];

/** "12.3K" → 12300 y de vuelta, para simular datos que cambian en vivo. */
const parse = (v: string) => { const n = parseFloat(v.replace(/[^0-9.]/g, "")); return /K/i.test(v) ? n * 1000 : n; };
const format = (n: number, like: string) => {
  const prefix = like.startsWith("$") ? "$" : "";
  return prefix + (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n)));
};

export default function App() {
  const [nodes, setNodes] = useState(DEMO_NODES);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [zoom, setZoom] = useState(1);
  const [motion, setMotion] = useState(true);
  const [gpuEpoch, setGpuEpoch] = useState(0);
  const [glReady] = useState(hasWebGL);
  const selected = useMemo(() => nodes.find((n) => n.id === selectedId) ?? null, [nodes, selectedId]);

  // Datos "en vivo": cada 3 s algún número sube un poco. La escena no se rearma; solo cambian etiquetas.
  useEffect(() => {
    const t = window.setInterval(() => {
      setNodes((all) => all.map((n) => (n.hasData && Math.random() < 0.35 ? { ...n, value: format(parse(n.value) * (1 + Math.random() * 0.01) + 1, n.value) } : n)));
    }, 3000);
    return () => window.clearInterval(t);
  }, []);

  // Escape cierra el panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSelectedId(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <main className="app">
      {glReady ? (
        <CityWorld
          key={gpuEpoch}
          nodes={nodes}
          selectedId={selectedId}
          filter={filter}
          zoom={zoom}
          motion={motion}
          onSelect={(id) => setSelectedId((cur) => (cur === id ? null : id))}
          onGpuLost={() => setGpuEpoch((x) => x + 1)}
        />
      ) : (
        <div className="no-webgl">Tu navegador no tiene WebGL activado; la ciudad 3D lo necesita.</div>
      )}

      <header className="topbar">
        <h1>CIUDAD <span>NEÓN</span> 3D</h1>
        <nav className="chips" aria-label="Filtro">
          {FILTERS.map(([id, label]) => (
            <button key={id} className={filter === id ? "on" : ""} onClick={() => setFilter(id)}>{label}</button>
          ))}
        </nav>
        <label className="zoom">
          Zoom
          <input type="range" min={0.6} max={2} step={0.05} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
        </label>
        <button className={`toggle ${motion ? "on" : ""}`} onClick={() => setMotion((m) => !m)}>{motion ? "Movimiento: sí" : "Movimiento: no"}</button>
      </header>

      {selected && (
        <aside className="panel" style={{ ["--node" as string]: selected.color }}>
          <button className="close" onClick={() => setSelectedId(null)} aria-label="Cerrar">✕</button>
          <small>{selected.type === "app" ? "TORRE · APP" : "ANTENA · RED"}</small>
          <h2>{selected.name}</h2>
          <p className="big">{selected.hasData ? selected.value : "—"}</p>
          <p className="unit">{selected.hasData ? selected.unit : "sin datos"}</p>
          <p className="hint">La cámara sigue a este nodo. Arrástralo para moverlo: regresa a su lugar como resorte.</p>
        </aside>
      )}

      <footer className="credit">
        three.js · React · shaders GLSL — <a href="https://github.com/Arzival/ciudad-neon-3d" target="_blank" rel="noreferrer">código en GitHub</a>
      </footer>
    </main>
  );
}
