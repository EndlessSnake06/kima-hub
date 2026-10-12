// The GPU runtime's pinned CUDA wheels exist only for linux/x86_64 CPython
// 3.11; the installer (services/audio-analyzer-clap/gpu_runtime.py) enforces
// the same rule before downloading anything. Separated into its own module so
// tests can pin the answer regardless of the host they run on.
export function gpuSupported(): boolean {
    return process.platform === "linux" && process.arch === "x64";
}
