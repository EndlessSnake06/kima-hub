"use client";

/**
 * What changed, and what we're asking.
 *
 * This is the one surface in Kima that is allowed to block: it exists to be read
 * before the thing it describes can be used, which is the point when a release
 * introduces something that needs permission. Everything else should get out of
 * the way.
 *
 * ## Three kinds of item, one window
 *
 * A `note` says something happened. An `action` offers something runnable. A
 * `choice` asks permission and carries a default, and that default is always
 * off.
 *
 * ## Closing is an answer
 *
 * The X and the Escape key do the same thing as answering no to everything
 * untouched — the server records a real decision for each one. That is stated on
 * the window rather than buried, because a consent dialogue that quietly banks
 * silence as agreement is the thing this design exists not to be.
 *
 * When there is nothing to consent to, the window says so and the close button
 * is just a close button. Don't put a scary sentence on a changelog.
 */

import { useCallback, useEffect, useState } from "react";
import { X, Check, Loader2 } from "lucide-react";
import { api } from "@/lib/api";

type ReleaseItem =
    | { kind: "note"; key: string; title: string; body: string; label?: string }
    | {
          kind: "action";
          key: string;
          title: string;
          body: string;
          cta: string;
          settingsPath?: string;
          runsFromWindow?: boolean;
          confirmTitle?: string;
          confirmMessage?: string;
          confirmLabel?: string;
      }
    | {
          kind: "choice";
          key: string;
          title: string;
          body: string;
          defaultValue: false;
          benefit?: string;
          discloses?: string;
      };

interface Release {
    version: string;
    title: string;
    summary: string;
    date: string;
    items: ReleaseItem[];
}

export function WhatsNewWindow({
    release,
    onClose,
    renderAction,
}: {
    release: Release;
    onClose: () => void;
    /** An `action` item supplies its own body; the window only frames it. */
    renderAction?: (item: Extract<ReleaseItem, { kind: "action" }>) => React.ReactNode;
}) {
    const [choices, setChoices] = useState<Record<string, boolean>>({});
    const [closing, setClosing] = useState(false);

    const asks = release.items.filter((i) => i.kind === "choice");
    const unanswered = asks.filter((i) => choices[i.key] === undefined).length;

    const close = useCallback(async () => {
        setClosing(true);
        try {
            await api.post(`/whats-new/${release.version}/dismiss`, {});
        } finally {
            onClose();
        }
    }, [release.version, onClose]);

    // Escape closes, and closing is a real answer -- same path as the button, so
    // the two can never diverge. While a nested confirm is open (the
    // run-from-window action), Escape belongs to it alone; the gate tells the
    // window to hold off by setting data-confirming on the scrim.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            if (document.querySelector("[data-nested-confirm='true']")) return;
            void close();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [close]);

    const answer = async (key: string, enabled: boolean) => {
        setChoices((c) => ({ ...c, [key]: enabled }));
        try {
            await api.post(`/whats-new/${release.version}/choice`, { key, enabled });
        } catch {
            setChoices((c) => { const n = { ...c }; delete n[key]; return n; });
        }
    };

    return (
        <div
            className="fixed inset-0 z-(--z-modal) flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-6"
            role="dialog"
            aria-modal="true"
            aria-labelledby="whats-new-title"
        >
            <div className="w-full sm:max-w-2xl max-h-[92vh] sm:max-h-[85vh] flex flex-col bg-[var(--bg-secondary)] border border-white/10 rounded-t-2xl sm:rounded-2xl overflow-hidden">
                <header className="shrink-0 px-6 pt-6 pb-5 border-b border-white/10">
                    <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                            <p className="text-[0.6875rem] uppercase tracking-[0.12em] text-brand">
                                Kima {release.version}
                            </p>
                            <h2
                                id="whats-new-title"
                                className="mt-2 text-2xl font-bold tracking-tight text-white text-balance"
                            >
                                {release.title}
                            </h2>
                            <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)] max-w-prose">
                                {release.summary}
                            </p>
                        </div>
                        <button
                            onClick={close}
                            disabled={closing}
                            aria-label="Close"
                            className="shrink-0 w-11 h-11 -mr-2 -mt-2 flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-white hover:bg-white/5 transition-colors"
                        >
                            {closing ? <Loader2 className="w-5 h-5 animate-spin" /> : <X className="w-5 h-5" />}
                        </button>
                    </div>
                </header>

                <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-7">
                    {release.items.map((item) => {
                        if (item.kind === "note") {
                            return (
                                <section key={item.key} className="flex flex-col gap-1.5">
                                    {item.label && (
                                        <p className="text-[0.625rem] uppercase tracking-[0.12em] text-[var(--text-muted)]">
                                            {item.label}
                                        </p>
                                    )}
                                    <h3 className="text-base font-semibold text-white text-balance">{item.title}</h3>
                                    <Body text={item.body} />
                                </section>
                            );
                        }

                        if (item.kind === "action") {
                            return (
                                <section key={item.key} className="flex flex-col gap-3">
                                    <div className="flex flex-col gap-1.5">
                                        <h3 className="text-base font-semibold text-white text-balance">{item.title}</h3>
                                        <Body text={item.body} />
                                    </div>
                                    {renderAction?.(item)}
                                    {item.settingsPath && (
                                        <p className="text-xs text-[var(--text-muted)]">
                                            This lives in Settings too, if you&rsquo;d rather do it later.
                                        </p>
                                    )}
                                </section>
                            );
                        }

                        const answered = choices[item.key];
                        return (
                            <section key={item.key} className="flex flex-col gap-3 rounded-xl border border-white/10 bg-[var(--bg-tertiary)] p-4">
                                <div className="flex flex-col gap-1.5">
                                    <h3 className="text-base font-semibold text-white text-balance">{item.title}</h3>
                                    <Body text={item.body} />
                                    {item.discloses && (
                                        <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
                                            <span className="text-white/70">What actually leaves your server:</span> {item.discloses}
                                        </p>
                                    )}
                                </div>
                                <div className="flex gap-2">
                                    <ChoiceButton
                                        selected={answered === true}
                                        onClick={() => answer(item.key, true)}
                                        label="Turn it on"
                                    />
                                    <ChoiceButton
                                        selected={answered === false}
                                        onClick={() => answer(item.key, false)}
                                        label="No thanks"
                                    />
                                </div>
                            </section>
                        );
                    })}
                </div>

                <footer className="shrink-0 px-6 py-4 border-t border-white/10 flex items-center justify-between gap-4">
                    <p className="text-xs leading-relaxed text-[var(--text-muted)]">
                        {asks.length === 0
                            ? "Nothing to decide here."
                            : unanswered > 0
                              ? `If you close now, ${unanswered === asks.length ? "these stay" : "the rest stay"} off. You can change your mind in Settings whenever.`
                              : "You can change your mind in Settings whenever."}
                    </p>
                    <button
                        onClick={close}
                        disabled={closing}
                        className="shrink-0 h-11 px-5 rounded-lg bg-brand hover:bg-[#e69200] text-black text-sm font-semibold transition-colors disabled:opacity-60"
                    >
                        {unanswered > 0 && asks.length > 0 ? "Close" : "Done"}
                    </button>
                </footer>
            </div>
        </div>
    );
}

/** Copy can carry blank lines; render them as the paragraphs they are. */
function Body({ text }: { text: string }) {
    return (
        <>
            {text.split("\n\n").map((para, i) => (
                <p key={i} className="text-sm leading-relaxed text-[var(--text-secondary)] max-w-prose">
                    {para}
                </p>
            ))}
        </>
    );
}

function ChoiceButton({
    selected,
    onClick,
    label,
}: {
    selected: boolean;
    onClick: () => void;
    label: string;
}) {
    return (
        <button
            onClick={onClick}
            aria-pressed={selected}
            className={[
                "h-11 px-4 rounded-lg text-sm font-medium transition-colors flex items-center gap-2",
                selected
                    ? "bg-brand text-black"
                    : "bg-white/[0.04] text-[var(--text-secondary)] hover:text-white hover:bg-white/[0.08]",
            ].join(" ")}
        >
            {selected && <Check className="w-4 h-4" />}
            {label}
        </button>
    );
}
