// Measure label-string widths ONCE per string, in canvas device px.
//
// The GalaxyLabel pills lay out in screen space during the greedy collision
// pass in labelPlacement.ts. We can't cheaply trust CSS box sizing from inside
// a Canvas component, so we measure with the same font face the pill uses
// (Montserrat, falling back to system-ui) in a single lazily-created 2D
// context. `document` is absent on the server, but this module only runs on
// the client (GalaxyScene is ssr:false), so the guard is defensive.
//
// The returned width is just the glyph advance; callers add the chip's own
// horizontal padding (padX) + the accent dot width + its gap when laying a
// full pill out. Keep padX in sync with chipBase's padding (`3px 8px`).
const FONT = "600 9.5px 'Montserrat', system-ui, sans-serif";

/** Left+right padding inside the GalaxyLabel pill. See chipBase (`3px 8px`). */
export const LABEL_PAD_X = 16;

let measureCtx: CanvasRenderingContext2D | null = null;
function ctx(): CanvasRenderingContext2D | null {
    if (measureCtx) return measureCtx;
    if (typeof document === "undefined") return null;
    const cv = document.createElement("canvas");
    cv.width = 1;
    cv.height = 1;
    measureCtx = cv.getContext("2d")!;
    return measureCtx;
}

/** Advance width of `name` in the pill font. */
export function measureLabelWidth(name: string): number {
    const c = ctx();
    if (!c) return name.length * 6; // unreachable client-side; SSR-safe fallback
    c.font = FONT;
    return c.measureText(name).width;
}
