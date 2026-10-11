-- Kima has no OpenAI feature: the key, model and base-url columns were never read by anything.
ALTER TABLE "SystemSettings" DROP COLUMN "openaiEnabled";
ALTER TABLE "SystemSettings" DROP COLUMN "openaiApiKey";
ALTER TABLE "SystemSettings" DROP COLUMN "openaiModel";
ALTER TABLE "SystemSettings" DROP COLUMN "openaiBaseUrl";
