import { useCallback, useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

type WorkersConfig = Awaited<ReturnType<typeof api.getAnalysisWorkers>>;

/** One analyzer's worker count: the stored value, and a slider setter that saves once dragging stops. */
export function useWorkerSetting(
    queryKey: string,
    load: () => Promise<WorkersConfig>,
    save: (workers: number) => Promise<WorkersConfig>,
    fallbackRecommended: number,
) {
    const queryClient = useQueryClient();
    const key = useMemo(() => [queryKey], [queryKey]);

    const { data: config, isLoading } = useQuery({
        queryKey: key,
        queryFn: load,
        staleTime: 0,
    });

    const withWorkers = useCallback(
        (workers: number): WorkersConfig => {
            const cpuCores = config?.cpuCores || 4;
            return {
                workers,
                cpuCores,
                recommended: config?.recommended || fallbackRecommended,
                description: `Using ${workers} of ${cpuCores} available CPU cores`,
            };
        },
        [config, fallbackRecommended],
    );

    const mutation = useMutation({
        mutationFn: save,
        onMutate: async (workers) => {
            await queryClient.cancelQueries({ queryKey: key });
            const previous = queryClient.getQueryData<WorkersConfig>(key);
            queryClient.setQueryData(key, withWorkers(workers));
            return { previous };
        },
        onError: (_err, _workers, context) => {
            queryClient.setQueryData(key, context?.previous);
        },
    });

    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const setWorkers = useCallback(
        (workers: number) => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
            queryClient.setQueryData(key, withWorkers(workers));
            debounceRef.current = setTimeout(() => mutation.mutate(workers), 500);
        },
        [queryClient, key, withWorkers, mutation],
    );

    useEffect(() => {
        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
        };
    }, []);

    return { config, isLoading, setWorkers };
}
