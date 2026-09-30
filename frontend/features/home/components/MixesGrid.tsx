"use client";

import { MixCard } from "@/components/MixCard";
import { Mix } from "../types";
import { memo, type CSSProperties } from "react";
import { cn } from "@/lib/cn";
import { cascadeStyle } from "@/lib/motion";

interface MixesGridProps {
    mixes: Mix[];
}

const MixesGrid = memo(function MixesGrid({ mixes }: MixesGridProps) {
    return (
        <div
            className="flex gap-3 overflow-x-auto scrollbar-hide scroll-smooth snap-x snap-mandatory"
            style={cascadeStyle(mixes.length)}
        >
            {mixes.map((mix, index) => {
                return (
                    <div
                        key={mix.id}
                        className={cn(
                            "flex-shrink-0 snap-start w-[140px] sm:w-[160px] md:w-[170px] lg:w-[180px]",
                            "animate-rise [animation-delay:calc(var(--i)*var(--stagger))]",
                        )}
                        style={{ "--i": index } as CSSProperties}
                    >
                        <MixCard mix={mix} index={index} />
                    </div>
                );
            })}
        </div>
    );
});

export { MixesGrid };
