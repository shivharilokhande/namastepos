// NamastePOS dashboard — drag-and-drop floor plan editor.
//
// Renders tables as absolutely-positioned chips on a canvas. In "edit"
// mode the cashier can drag any table to a new spot to match their cafe's
// real seating layout; on pointer-up we persist x_pos / y_pos to the
// backend via updateOpsTable. In "view" mode tables sit at their saved
// positions but can't be moved (tap = seat / open session).
//
// Grid: snaps to a 20px grid for tidy alignment. Canvas is 1200×750 in
// "design" units, scaled responsively to its container.

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Users, Pencil, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';
import { formatINR } from '@/lib/utils';

const STATUS_COLORS: Record<string, string> = {
  available: 'bg-emerald-100 border-emerald-300 text-emerald-700',
  occupied:  'bg-amber-100 border-amber-300 text-amber-800',
  reserved:  'bg-blue-100 border-blue-300 text-blue-700',
  cleaning:  'bg-slate-100 border-slate-300 text-slate-700',
  blocked:   'bg-red-100 border-red-300 text-red-700',
};

const CANVAS_W = 1200;
const CANVAS_H = 750;
const GRID = 20;
const TABLE_SIZE = 96; // base chip size (square / round)

type TableRow = {
  id: string;
  label: string;
  seats: number;
  shape: 'round' | 'square' | 'rectangle' | 'booth';
  status: string;
  xPos: number;
  yPos: number;
  currentSessionId?: string | null;
  sessionTotalInr?: number | null;
  sessionOpenedAt?: string | null;
};

type Props = {
  tables: TableRow[];
  editMode: boolean;
  onTableTap: (t: TableRow) => void;
  /** Open the create/edit dialog seeded with this table. */
  onEdit?: (t: TableRow) => void;
  /** Hard-delete the table (caller should confirm + check status === available). */
  onDelete?: (t: TableRow) => void;
};

export function FloorCanvas({ tables, editMode, onTableTap, onEdit, onDelete }: Props) {
  const qc = useQueryClient();
  const canvasRef = useRef<HTMLDivElement>(null);
  // Local optimistic positions so dragging feels instant; reconciled with
  // server data on every refetch.
  const [overrides, setOverrides] = useState<Record<string, { x: number; y: number }>>({});
  // Active drag state
  const dragRef = useRef<{
    id: string; startX: number; startY: number; tableStartX: number; tableStartY: number;
  } | null>(null);

  // Auto-arrange tables that have never been positioned (xPos=0, yPos=0).
  // We only auto-arrange the ones at the origin so user-placed tables stay
  // where they were dragged.
  const positioned = tables.map((t, idx) => {
    if (overrides[t.id]) return { ...t, xPos: overrides[t.id].x, yPos: overrides[t.id].y };
    const isOrigin = (t.xPos === 0 || t.xPos == null) && (t.yPos === 0 || t.yPos == null);
    if (isOrigin) {
      const cols = 6;
      const cellW = 140;
      const cellH = 130;
      const margin = 30;
      return {
        ...t,
        xPos: margin + (idx % cols) * cellW,
        yPos: margin + Math.floor(idx / cols) * cellH,
      };
    }
    return t;
  });

  const save = useMutation({
    mutationFn: ({ id, xPos, yPos }: { id: string; xPos: number; yPos: number }) =>
      ffApi.updateOpsTable(id, { xPos, yPos }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ops-tables'] }); },
    onError: (e) => toast.error(apiError(e)),
  });

  // Translate a pointer event into canvas coordinates, accounting for
  // the responsive scale factor the canvas is rendered at.
  function toCanvasCoords(clientX: number, clientY: number) {
    const el = canvasRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    const scale = rect.width / CANVAS_W;
    return {
      x: (clientX - rect.left) / scale,
      y: (clientY - rect.top) / scale,
    };
  }

  function onPointerDown(e: React.PointerEvent, t: TableRow) {
    if (!editMode) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const { x, y } = toCanvasCoords(e.clientX, e.clientY);
    const cur = overrides[t.id] || { x: t.xPos, y: t.yPos };
    dragRef.current = {
      id: t.id, startX: x, startY: y,
      tableStartX: cur.x, tableStartY: cur.y,
    };
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!dragRef.current) return;
    const { x, y } = toCanvasCoords(e.clientX, e.clientY);
    const dx = x - dragRef.current.startX;
    const dy = y - dragRef.current.startY;
    const nextX = Math.max(0, Math.min(CANVAS_W - TABLE_SIZE,
      Math.round((dragRef.current.tableStartX + dx) / GRID) * GRID));
    const nextY = Math.max(0, Math.min(CANVAS_H - TABLE_SIZE,
      Math.round((dragRef.current.tableStartY + dy) / GRID) * GRID));
    setOverrides((prev) => ({ ...prev, [dragRef.current!.id]: { x: nextX, y: nextY } }));
  }

  function onPointerUp(e: React.PointerEvent) {
    if (!dragRef.current) return;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch (_) {}
    const drag = dragRef.current;
    dragRef.current = null;
    const pos = overrides[drag.id];
    if (!pos) return;
    // Only save if it actually moved
    if (pos.x !== drag.tableStartX || pos.y !== drag.tableStartY) {
      save.mutate({ id: drag.id, xPos: pos.x, yPos: pos.y });
    }
  }

  // Drop overrides for tables that no longer exist (deleted while editing)
  useEffect(() => {
    setOverrides((prev) => {
      const next: typeof prev = {};
      for (const t of tables) if (prev[t.id]) next[t.id] = prev[t.id];
      return next;
    });
  }, [tables]);

  return (
    <div className="w-full overflow-auto rounded-lg border bg-card">
      <div
        ref={canvasRef}
        onPointerMove={editMode ? onPointerMove : undefined}
        onPointerUp={editMode ? onPointerUp : undefined}
        onPointerLeave={editMode ? onPointerUp : undefined}
        className="relative"
        style={{
          width: CANVAS_W,
          height: CANVAS_H,
          backgroundImage: editMode
            ? `radial-gradient(circle, rgba(0,0,0,0.12) 1px, transparent 1px)`
            : 'none',
          backgroundSize: editMode ? `${GRID}px ${GRID}px` : 'auto',
          touchAction: editMode ? 'none' : 'auto',
        }}
      >
        {/* Tables positioned in canvas pixel coordinates. The outer
            overflow-auto handles small viewports. */}
        <div className="absolute inset-0">
          {positioned.map((t) => {
            const sizeStyle =
              t.shape === 'booth'     ? { width: TABLE_SIZE * 1.6, height: TABLE_SIZE * 0.95 } :
              t.shape === 'rectangle' ? { width: TABLE_SIZE * 1.5, height: TABLE_SIZE } :
                                        { width: TABLE_SIZE,       height: TABLE_SIZE };
            const radiusCls =
              t.shape === 'round'     ? 'rounded-full' :
              t.shape === 'booth'     ? 'rounded-2xl' :
                                        'rounded-xl';
            const occupied = t.status === 'occupied';
            const since = t.sessionOpenedAt
              ? Math.round((Date.now() - new Date(t.sessionOpenedAt).getTime()) / 60000)
              : null;

            return (
              <div
                key={t.id}
                onPointerDown={(e) => {
                  // Don't initiate a drag from the edit/delete icon hit boxes.
                  if ((e.target as HTMLElement).closest('[data-table-action]')) return;
                  onPointerDown(e, t);
                }}
                onClick={(e) => {
                  // Edit-mode click = no-op (drag handled by pointer events).
                  if (editMode) return;
                  e.preventDefault();
                  onTableTap(t);
                }}
                style={{
                  position: 'absolute',
                  left: t.xPos,
                  top: t.yPos,
                  ...sizeStyle,
                  cursor: editMode ? 'grab' : 'pointer',
                }}
                className={`group ${radiusCls} border-2 ${STATUS_COLORS[t.status]} ${
                  editMode ? 'shadow-md hover:shadow-lg active:cursor-grabbing' : 'hover:scale-[1.03]'
                } relative flex flex-col items-center justify-center gap-0.5 transition-all select-none`}
              >
                <div className="text-2xl font-extrabold leading-none">{t.label}</div>
                <div className="text-[10px] flex items-center gap-0.5 mt-0.5">
                  <Users className="h-3 w-3" /> {t.seats}
                </div>
                {occupied && (
                  <>
                    <div className="text-[11px] font-semibold mt-1">
                      {t.sessionTotalInr != null ? formatINR(t.sessionTotalInr) : '—'}
                    </div>
                    {since != null && (
                      <div className="text-[9px] opacity-80">
                        {since < 60 ? `${since}m` : `${Math.floor(since/60)}h ${since%60}m`}
                      </div>
                    )}
                  </>
                )}
                {!occupied && !editMode && (
                  <Badge variant="muted" className="text-[9px] capitalize mt-0.5">{t.status}</Badge>
                )}

                {/* Edit + delete actions — only in layout-edit mode. */}
                {editMode && (
                  <>
                    {onEdit && (
                      <button
                        data-table-action="edit"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); onEdit(t); }}
                        className="absolute -top-2 -left-2 h-7 w-7 rounded-full bg-white border-2 border-slate-300 shadow grid place-items-center hover:bg-blue-50 hover:border-blue-400 transition-colors"
                        title="Edit table"
                      >
                        <Pencil className="h-3.5 w-3.5 text-slate-700" />
                      </button>
                    )}
                    {onDelete && (
                      <button
                        data-table-action="delete"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); onDelete(t); }}
                        className="absolute -top-2 -right-2 h-7 w-7 rounded-full bg-white border-2 border-slate-300 shadow grid place-items-center hover:bg-red-50 hover:border-red-400 transition-colors"
                        title="Delete table"
                      >
                        <Trash2 className="h-3.5 w-3.5 text-red-600" />
                      </button>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
