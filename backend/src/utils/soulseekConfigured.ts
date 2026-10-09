/**
 * Whether Soulseek can be used: slskd holds its own Soulseek account and needs
 * only its address; Kima's own client needs the account itself.
 */
export function soulseekConfigured(settings: {
    soulseekMode?: string | null;
    slskdUrl?: string | null;
    soulseekUsername?: string | null;
    soulseekPassword?: string | null;
} | null | undefined): boolean {
    if (!settings) return false;
    if (settings.soulseekMode === "slskd") return !!settings.slskdUrl?.trim();
    return !!(settings.soulseekUsername?.trim() && settings.soulseekPassword?.trim());
}
