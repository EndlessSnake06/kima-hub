"use client";

import { useEffect, useRef } from "react";
import { AlertTriangle, X } from "lucide-react";

interface ConfirmDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    variant?: "danger" | "warning" | "info";
}

export function ConfirmDialog({
    isOpen,
    onClose,
    onConfirm,
    title,
    message,
    confirmText = "Confirm",
    cancelText = "Cancel",
    variant = "danger",
}: ConfirmDialogProps) {
    const cancelRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);

    // Focus the cancel button when opened
    useEffect(() => {
        if (isOpen) {
            cancelRef.current?.focus();
        }
    }, [isOpen]);

    // Close on Escape; trap focus within the dialog
    useEffect(() => {
        if (!isOpen) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                onClose();
                return;
            }
            if (e.key === "Tab" && dialogRef.current) {
                const focusable = Array.from(
                    dialogRef.current.querySelectorAll<HTMLElement>(
                        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
                    )
                ).filter((el) => !el.hasAttribute("disabled"));
                if (focusable.length === 0) return;
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (e.shiftKey) {
                    if (document.activeElement === first) {
                        e.preventDefault();
                        last.focus();
                    }
                } else {
                    if (document.activeElement === last) {
                        e.preventDefault();
                        first.focus();
                    }
                }
            }
        };

        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    const variantStyles = {
        danger: {
            icon: "text-danger",
            iconBg: "bg-danger/10",
            confirmButton: "bg-danger hover:bg-danger/90 text-white",
        },
        warning: {
            icon: "text-warning",
            iconBg: "bg-warning/10",
            confirmButton: "bg-warning hover:bg-warning/90 text-black",
        },
        info: {
            icon: "text-brand",
            iconBg: "bg-brand/10",
            confirmButton: "bg-brand hover:bg-brand-hover text-black",
        },
    };

    const styles = variantStyles[variant];

    const handleConfirm = () => {
        onConfirm();
        onClose();
    };

    return (
        <div
            className="fixed inset-0 bg-black/75 flex items-center justify-center z-(--z-modal) p-4 transition-opacity duration-200"
            onClick={onClose}
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="confirm-dialog-title"
                aria-describedby="confirm-dialog-message"
                className="bg-[#121212] rounded-xl max-w-md w-full overflow-hidden border border-white/10 animate-pop"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-start gap-4 p-6 border-b border-white/10">
                    <div
                        className={`w-12 h-12 rounded-full ${styles.iconBg} flex items-center justify-center flex-shrink-0`}
                    >
                        <AlertTriangle className={`w-6 h-6 ${styles.icon}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h2 id="confirm-dialog-title" className="text-xl font-bold text-white mb-2">
                            {title}
                        </h2>
                        <p id="confirm-dialog-message" className="text-sm text-[var(--text-secondary)]">{message}</p>
                    </div>
                    <button
                        onClick={onClose}
                        aria-label="Close dialog"
                        className="p-1 hover:bg-white/10 rounded-full transition-colors text-[var(--text-secondary)] hover:text-white flex-shrink-0"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Actions */}
                <div className="flex gap-3 p-6 bg-[var(--bg-primary)]/50">
                    <button
                        ref={cancelRef}
                        onClick={onClose}
                        className="flex-1 px-4 py-3 bg-white/5 hover:bg-white/10 text-white font-semibold rounded-lg transition-colors duration-150 border border-white/10"
                    >
                        {cancelText}
                    </button>
                    <button
                        onClick={handleConfirm}
                        className={`flex-1 px-4 py-3 font-semibold rounded-lg transition-colors duration-150 ${styles.confirmButton}`}
                    >
                        {confirmText}
                    </button>
                </div>
            </div>
        </div>
    );
}
