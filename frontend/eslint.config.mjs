import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
      }],
    },
  },
  {
    // The r3f galaxy rig mutates ref-derived three.js state (materials,
    // camera, OrbitControls, pointer/gesture refs) from inside `useFrame`
    // and DOM gesture callbacks -- both run OUTSIDE React's render phase,
    // so react-hooks/immutability's "no mutating
    // hook-argument-derived values" concern (aimed at render-phase purity)
    // doesn't apply. This is the imperative r3f per-frame update idiom;
    // the unified repo's eslint carries the same carve-out for these files.
    files: [
      "features/vibe/scenes/galaxy/GalaxyScene.tsx",
      "features/vibe/scenes/galaxy/useGalaxyFrame.ts",
      "features/vibe/scenes/galaxy/useGalaxyInteraction.ts",
    ],
    rules: {
      "react-hooks/immutability": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;