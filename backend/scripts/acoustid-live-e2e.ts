/* Live E2E: fpcalc -> acoustidService.lookup against the real API. */
import { fpcalcService } from "../src/services/fpcalc";
import { acoustidService } from "../src/services/acoustidService";

async function main() {
    const file =
        "~/Music/kima-library/Carpenter Brut/Leather Teeth (2018)/Carpenter Brut - Leather Teeth - 02 - Cheerleader Effect.mp3";

    const avail = await fpcalcService.isAvailable();
    console.log("fpcalc available:", avail);

    const fp = await fpcalcService.fingerprintFile(file);
    console.log("fingerprint duration:", fp?.duration, "fp len:", fp?.fingerprint.length);

    if (!fp) throw new Error("fpcalc returned null");
    const result = await acoustidService.lookup(fp.duration, fp.fingerprint);
    console.log("lookup result:", JSON.stringify(result, null, 2));
    if (!result || !result.recordingMbid || !result.releaseGroupMbid) {
        throw new Error("lookup did not produce a full identity");
    }
    console.log("E2E OK");
}

main().catch((e) => {
    console.error("E2E FAILED:", e);
    process.exit(1);
});
