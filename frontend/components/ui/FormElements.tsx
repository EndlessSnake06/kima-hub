import { InputHTMLAttributes, forwardRef } from "react";
import { cn } from "@/lib/cn";

// Input Component
export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, error, ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={cn(
          "bg-[var(--bg-secondary)] border text-white placeholder-gray-600 rounded-sm px-3 py-2 min-h-[44px] text-sm transition-colors",
          "focus:outline-none focus:ring-1",
          error
            ? "border-red-500/50 focus:border-red-500 focus:ring-red-500/20"
            : "border-[var(--border-interactive)] focus:border-[#1db954]/50 focus:ring-purple-500/20",
          className
        )}
        {...props}
      />
    );
  }
);

Input.displayName = "Input";
