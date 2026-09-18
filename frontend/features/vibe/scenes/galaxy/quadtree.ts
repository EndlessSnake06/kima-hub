// A hand-rolled quadtree over the disc plane (x,z), lifted verbatim from the rig.
// It indexes the REAL people nodes for O(log n) hover-picking + zone-LOD labelling.
// Overkill for ~20 people today, but it is the machinery that lets the same scene
// scale to the cross-instance field (Phase 3 / OurSpace O7) without per-point
// raycasts -- so we port it intact rather than a linear scan we'd have to replace.
export interface QPt {
    x: number;
    z: number;
    i: number;
}

export class QuadTree {
    b: [number, number, number, number];
    cap: number;
    pts: QPt[] = [];
    div = false;
    ch: QuadTree[] | null = null;

    constructor(x0: number, z0: number, x1: number, z1: number, cap = 8) {
        this.b = [x0, z0, x1, z1];
        this.cap = cap;
    }

    insert(p: QPt): boolean {
        const [x0, z0, x1, z1] = this.b;
        if (p.x < x0 || p.x > x1 || p.z < z0 || p.z > z1) return false;
        if (!this.div && this.pts.length < this.cap) {
            this.pts.push(p);
            return true;
        }
        if (!this.div) this.split();
        for (const c of this.ch!) if (c.insert(p)) return true;
        return false;
    }

    private split() {
        const [x0, z0, x1, z1] = this.b;
        const mx = (x0 + x1) / 2;
        const mz = (z0 + z1) / 2;
        this.ch = [
            new QuadTree(x0, z0, mx, mz, this.cap),
            new QuadTree(mx, z0, x1, mz, this.cap),
            new QuadTree(x0, mz, mx, z1, this.cap),
            new QuadTree(mx, mz, x1, z1, this.cap),
        ];
        this.div = true;
        for (const p of this.pts) for (const c of this.ch) if (c.insert(p)) break;
        this.pts = [];
    }

    /** Nearest point to (x,z) within maxR, or null. */
    nearest(x: number, z: number, maxR: number): QPt | null {
        let best: QPt | null = null;
        let bd = maxR * maxR;
        const rec = (node: QuadTree) => {
            const [x0, z0, x1, z1] = node.b;
            const cx = Math.max(x0, Math.min(x, x1));
            const cz = Math.max(z0, Math.min(z, z1));
            if ((cx - x) ** 2 + (cz - z) ** 2 > bd) return;
            if (node.div) {
                for (const c of node.ch!) rec(c);
            } else {
                for (const p of node.pts) {
                    const d2 = (p.x - x) ** 2 + (p.z - z) ** 2;
                    if (d2 < bd) {
                        bd = d2;
                        best = p;
                    }
                }
            }
        };
        rec(this);
        return best;
    }

    /** All point indices within radius r of (x,z) -- for zone-reactive LOD labelling. */
    within(x: number, z: number, r: number, out: number[]): number[] {
        const r2 = r * r;
        const rec = (node: QuadTree) => {
            const [x0, z0, x1, z1] = node.b;
            const cx = Math.max(x0, Math.min(x, x1));
            const cz = Math.max(z0, Math.min(z, z1));
            if ((cx - x) ** 2 + (cz - z) ** 2 > r2) return;
            if (node.div) {
                for (const c of node.ch!) rec(c);
            } else {
                for (const p of node.pts) if ((p.x - x) ** 2 + (p.z - z) ** 2 <= r2) out.push(p.i);
            }
        };
        rec(this);
        return out;
    }
}
