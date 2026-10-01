import { ButtonHTMLAttributes, forwardRef, memo } from "react";
import { cn } from "@/lib/cn";
import { GradientSpinner } from "./GradientSpinner";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: "primary" | "secondary" | "ghost" | "danger" | "ai" | "icon";
    isLoading?: boolean;
}

const Button = memo(forwardRef<HTMLButtonElement, ButtonProps>(
    (
        {
            className,
            variant = "secondary",
            isLoading,
            children,
            disabled,
            ...props
        },
        ref
    ) => {
        const baseStyles =
        "inline-flex items-center justify-center min-h-[44px] rounded-lg font-medium transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed";

        const variantStyles = {
            primary:
            "bg-brand hover:bg-brand-hover text-black px-4 py-2 ",
            secondary:
            "bg-[var(--bg-hover)] hover:bg-[#222] text-white px-4 py-2 border border-[var(--border-interactive)]",
            ghost: "text-[var(--text-secondary)] hover:text-white hover:bg-[var(--bg-hover)] px-4 py-2",
            danger: "text-danger hover:bg-danger/10 border border-danger/20 hover:border-danger/40 px-4 py-2",
            ai: "bg-[var(--bg-hover)] hover:bg-brand/10 text-brand border border-[var(--border-subtle)] hover:border-brand/30 px-4 py-2",
            icon: "w-11 h-11 text-[var(--text-secondary)] hover:text-white hover:bg-[var(--bg-hover)]",
        };

        return (
            <button
                ref={ref}
                className={cn(baseStyles, variantStyles[variant], className)}
                disabled={disabled || isLoading}
                {...props}
            >
                {isLoading ? (
                    <>
                        <GradientSpinner size="sm" className="mr-2" />
                        {children}
                    </>
                ) : (
                    children
                )}
            </button>
        );
    }
));

Button.displayName = "Button";

export { Button };
