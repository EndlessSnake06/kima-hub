import fs from "fs";
import { logger } from "./logger";
import path from "path";

/**
 * Writes key-value pairs to .env file
 * Preserves existing variables not in the provided map
 */
export async function writeEnvFile(
    variables: Record<string, string | null | undefined>
): Promise<void> {
    // Write to project root .env (parent of backend dir) for docker-compose
    const envPath = path.resolve(process.cwd(), "..", ".env");

    let existingContent = "";
    const existingVars = new Map<string, string>();

    try {
        existingContent = fs.readFileSync(envPath, "utf-8");

        existingContent.split("\n").forEach((line) => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith("#")) {
                const [key, ...valueParts] = trimmed.split("=");
                if (key) {
                    existingVars.set(key.trim(), valueParts.join("="));
                }
            }
        });
    } catch (error) {
        logger.debug("No existing .env file, creating new one");
    }

    Object.entries(variables).forEach(([key, value]) => {
        if (value !== null && value !== undefined) {
            existingVars.set(key, value);
        }
    });

    const lines: string[] = [
        "# Kima Environment Variables",
        `# Auto-generated on ${new Date().toISOString()}`,
        "",
    ];

    const categories = {
        "Database & Redis": ["DATABASE_URL", "REDIS_URL"],
        Server: ["PORT", "NODE_ENV", "SESSION_SECRET", "ALLOWED_ORIGINS"],
        Lidarr: ["LIDARR_ENABLED", "LIDARR_URL", "LIDARR_API_KEY"],
        "Fanart.tv": ["FANART_API_KEY"],
        Audiobookshelf: ["AUDIOBOOKSHELF_URL", "AUDIOBOOKSHELF_API_KEY"],
        Soulseek: ["SOULSEEK_USERNAME", "SOULSEEK_PASSWORD"],
        "Docker Paths": ["MUSIC_PATH", "DOWNLOAD_PATH"],
        Security: ["SETTINGS_ENCRYPTION_KEY"],
    };

    const writtenKeys = new Set<string>();

    Object.entries(categories).forEach(([category, keys]) => {
        const categoryVars: string[] = [];

        keys.forEach((key) => {
            if (existingVars.has(key)) {
                const value = existingVars.get(key);
                categoryVars.push(`${key}=${value}`);
                writtenKeys.add(key);
            }
        });

        if (categoryVars.length > 0) {
            lines.push("", `# ${category}`, ...categoryVars);
        }
    });

    const uncategorized: string[] = [];
    existingVars.forEach((value, key) => {
        if (!writtenKeys.has(key)) {
            uncategorized.push(`${key}=${value}`);
        }
    });

    if (uncategorized.length > 0) {
        lines.push("", "# Other Variables", ...uncategorized);
    }

    lines.push("");

    fs.writeFileSync(envPath, lines.join("\n"), "utf-8");
    logger.debug(`.env file updated with ${existingVars.size} variables`);
}
