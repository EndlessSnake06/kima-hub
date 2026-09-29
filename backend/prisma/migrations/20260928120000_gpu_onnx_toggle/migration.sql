-- The NVIDIA GPU toggle for CLAP embedding.
-- Truth of the toggle; the runtime itself is downloaded into the data
-- volume, never into the image.
ALTER TABLE "SystemSettings" ADD COLUMN IF NOT EXISTS "gpuOnnxEnabled" BOOLEAN NOT NULL DEFAULT false;
