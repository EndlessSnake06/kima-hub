"use client";

/**
 * Keyboard shortcuts: digits jump to sections in page order, ? shows them. A
 * corner panel rather than a dialog, so it neither covers the page nor steals
 * focus.
 */

import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";

export interface Jump {
    /** The id on the section, or "top". */
    anchor: string;
    label: string;
}

/** Typing somewhere? Then a bare letter is text, not a command. */
function isTyping(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export function Shortcuts({ jumps }: { jumps: Jump[] }) {
    const [open, setOpen] = useState(false);

    const go = useCallback((anchor: string) => {
        if (anchor === "top") {
            const main = document.querySelector("main");
            (main ?? window).scrollTo({ top: 0, behavior: "smooth" });
            return;
        }
        document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, []);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
            if (e.key === "?") { e.preventDefault(); setOpen((v) => !v); return; }
            if (e.key === "Escape" && open) { setOpen(false); return; }
            const n = Number(e.key);
            if (Number.isInteger(n) && n >= 1 && n <= jumps.length) {
                e.preventDefault();
                go(jumps[n - 1].anchor);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [jumps, go, open]);

    if (!open) {
        return (
            <p className="t-meta hidden sm:block fixed bottom-24 right-6 z-(--z-raised) pointer-events-none">
                press <kbd className="t-data px-1 py-0.5 rounded bg-white/[0.08] text-[var(--text-secondary)]">?</kbd> for shortcuts
            </p>
        );
    }

    return (
        <div
            role="dialog"
            aria-label="Keyboard shortcuts"
            className="hidden sm:flex fixed bottom-24 right-6 z-(--z-dropdown) w-[19rem] flex-col gap-4 rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-5 animate-rise"
        >
            <div className="flex items-baseline justify-between gap-4">
                <h2 className="t-label text-[var(--text-secondary)]">Keyboard</h2>
                <button
                    onClick={() => setOpen(false)}
                    aria-label="Close shortcuts"
                    className="-mr-1 -mt-1 w-8 h-8 flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-white hover:bg-white/5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                >
                    <X className="w-4 h-4" />
                </button>
            </div>

            <dl className="flex flex-col gap-2">
                {jumps.map((j, i) => (
                    <div key={j.anchor} className="flex items-baseline justify-between gap-4">
                        <dt className="t-meta text-[var(--text-secondary)]">{j.label}</dt>
                        <dd><Key>{i + 1}</Key></dd>
                    </div>
                ))}
            </dl>

            <div className="flex flex-col gap-2 border-t border-white/[0.08] pt-4">
                <div className="flex items-baseline justify-between gap-4">
                    <span className="t-meta text-[var(--text-secondary)]">Move in the week grid</span>
                    <span className="flex gap-1"><Key>←</Key><Key>→</Key><Key>↑</Key><Key>↓</Key></span>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                    <span className="t-meta text-[var(--text-secondary)]">See what was playing</span>
                    <Key>Enter</Key>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                    <span className="t-meta text-[var(--text-secondary)]">Close anything open</span>
                    <Key>Esc</Key>
                </div>
            </div>
        </div>
    );
}

function Key({ children }: { children: React.ReactNode }) {
    return (
        <kbd className="t-data px-1.5 py-0.5 rounded bg-white/[0.08] text-[var(--text-secondary)] leading-none">
            {children}
        </kbd>
    );
}
