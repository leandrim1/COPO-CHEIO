import { useEffect, useId, useRef, useState } from 'react';

// Gráficos simples do Dashboard (SVG próprio, sem biblioteca). Uma série por gráfico, barras finas
// azuis com topo arredondado, grade discreta, valor no tooltip (mouse e teclado) e tabela opcional.

const BAR = '#2563FF';
const BAR_HOVER = '#5B8CFF';
const GRID = 'rgba(255,255,255,0.07)';

export type Point = { label: string; tick: string; value: number };

function niceStep(max: number, ticks = 4) {
  if (max <= 0) return 1;
  const raw = max / ticks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

// Coluna com topo arredondado (4px) e base reta.
function columnPath(x: number, y: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function ColumnChart({
  data,
  format,
  axisFormat = format,
  height = 210,
  title,
  integer = false,
}: {
  data: Point[];
  format: (v: number) => string;
  axisFormat?: (v: number) => string;
  height?: number;
  title: string;
  // Contagens: marcas do eixo só em números inteiros.
  integer?: boolean;
}) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const tableId = useId();
  const left = 52;
  const bottom = 26;
  const top = 10;
  const plotW = Math.max(0, width - left - 4);
  const plotH = height - top - bottom;
  const max = Math.max(0, ...data.map((d) => d.value));
  const step = integer ? Math.max(1, Math.ceil(niceStep(max))) : niceStep(max);
  const yMax = Math.max(step, Math.ceil(max / step) * step);
  const ticks = Array.from({ length: Math.round(yMax / step) + 1 }, (_, i) => i * step);
  const band = data.length ? plotW / data.length : 0;
  const barW = Math.max(2, Math.min(24, band - 2, band * 0.62));
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(plotW / 44))));
  const y = (v: number) => top + plotH - (v / yMax) * plotH;
  const active = hover !== null ? data[hover] : null;

  return (
    <div>
      <div ref={wrapRef} className="relative w-full" style={{ height }}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={`${title}. Valores na tabela abaixo.`} className="block">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={left} x2={width} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
                <text x={left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-white/40 text-[10px] tabular-nums">
                  {axisFormat(t)}
                </text>
              </g>
            ))}
            {data.map((d, i) => {
              const x = left + i * band + (band - barW) / 2;
              const h = Math.max(0, y(0) - y(d.value));
              return (
                <g key={d.label}>
                  {h > 0 && <path d={columnPath(x, y(d.value), barW, h)} fill={hover === i ? BAR_HOVER : BAR} />}
                  {i % labelEvery === 0 && (
                    <text x={left + i * band + band / 2} y={height - 8} textAnchor="middle" className="fill-white/40 text-[10px]">
                      {d.tick}
                    </text>
                  )}
                  <rect
                    x={left + i * band}
                    y={top}
                    width={band}
                    height={plotH}
                    fill="transparent"
                    tabIndex={0}
                    aria-label={`${d.label}: ${format(d.value)}`}
                    onPointerEnter={() => setHover(i)}
                    onPointerLeave={() => setHover(null)}
                    onFocus={() => setHover(i)}
                    onBlur={() => setHover(null)}
                    className="cursor-default outline-none focus-visible:fill-white/[0.04]"
                  />
                </g>
              );
            })}
          </svg>
        )}
        {active && hover !== null && (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-white/10 bg-[#0A0D14] px-2.5 py-1.5 shadow-xl"
            style={{ left: Math.min(Math.max(left + hover * band + band / 2, 60), width - 60), top: Math.max(y(active.value) - 6, 34) }}
          >
            <p className="text-sm font-bold text-white">{format(active.value)}</p>
            <p className="text-[11px] text-white/55">{active.label}</p>
          </div>
        )}
      </div>
      <details className="mt-2 text-xs text-white/50">
        <summary className="cursor-pointer select-none hover:text-white/80">Ver tabela</summary>
        <div className="mt-2 max-h-56 overflow-auto rounded-lg border border-white/[0.06]">
          <table id={tableId} className="w-full text-left">
            <caption className="sr-only">{title}</caption>
            <tbody>
              {data.map((d) => (
                <tr key={d.label} className="border-b border-white/[0.04] last:border-0">
                  <th scope="row" className="px-3 py-1.5 font-medium text-white/60">
                    {d.label}
                  </th>
                  <td className="px-3 py-1.5 text-right tabular-nums text-white/85">{format(d.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

// Barras horizontais (produtos mais vendidos): valor na ponta de cada barra.
export function BarList({ rows }: { rows: { label: string; value: number; valueText: string; detail?: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ol className="space-y-3.5">
      {rows.map((row, i) => (
        <li key={row.label} title={row.detail ? `${row.label}: ${row.valueText} · ${row.detail}` : undefined}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate font-medium text-white/85">
              <span className="mr-2 text-white/35 tabular-nums">{i + 1}.</span>
              {row.label}
            </span>
            <span className="shrink-0 text-xs text-white/50">{row.detail}</span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <div className="h-3 flex-1">
              <div className="h-3 rounded-r-[4px]" style={{ width: `${Math.max(2, (row.value / max) * 100)}%`, background: BAR }} />
            </div>
            <span className="w-12 shrink-0 text-right text-xs font-bold tabular-nums text-white">{row.valueText}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}
