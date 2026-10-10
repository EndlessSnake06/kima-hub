/** Headless Chromium has no WebGL and the vibe map needs it; these flags turn on software rendering. */
export const softwareWebGL = {
    launchOptions: {
        args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
};
