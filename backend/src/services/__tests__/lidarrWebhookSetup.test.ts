/**
 * The Lidarr webhook gets Kima's secret as a header, and Kima saves the
 * secret only when Lidarr kept that header.
 */

const lidarr = { get: jest.fn(), put: jest.fn(), post: jest.fn() };
jest.mock("axios", () => ({ __esModule: true, default: { create: () => lidarr } }));
jest.mock("../../utils/db", () => ({ prisma: { systemSettings: { update: jest.fn() } } }));
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
    invalidateSystemSettingsCache: jest.fn(),
}));
jest.mock("../../utils/encryptedFields", () => ({
    encryptSettings: (s: Record<string, string>) => ({ lidarrWebhookSecret: `enc:${s.lidarrWebhookSecret}` }),
}));

import { prisma } from "../../utils/db";
import { getSystemSettings } from "../../utils/systemSettings";
import { configureLidarrWebhook, WEBHOOK_SECRET_HEADER } from "../lidarrWebhookSetup";

const update = prisma.systemSettings.update as jest.Mock;
const sentHeaders = (call: any[]) => call[1].fields.find((f: any) => f.name === "headers").value;
const echo = (_url: string, body: any) => Promise.resolve({ data: body });

beforeEach(() => {
    jest.clearAllMocks();
    lidarr.get.mockResolvedValue({ data: [] });
});

it("creates the webhook with a new secret and saves it once Lidarr keeps it", async () => {
    (getSystemSettings as jest.Mock).mockResolvedValue({ lidarrWebhookSecret: null });
    lidarr.post.mockImplementation(echo);

    await configureLidarrWebhook("http://lidarr", "key");

    const [header] = sentHeaders(lidarr.post.mock.calls[0]);
    expect(header.key).toBe(WEBHOOK_SECRET_HEADER);
    expect(header.value).toMatch(/^[0-9a-f]{64}$/);
    expect(update).toHaveBeenCalledWith({
        where: { id: "default" },
        data: { lidarrWebhookSecret: `enc:${header.value}` },
    });
});

it("reuses the stored secret on the existing webhook without saving again", async () => {
    (getSystemSettings as jest.Mock).mockResolvedValue({ lidarrWebhookSecret: "kept" });
    lidarr.get.mockResolvedValue({ data: [{ id: 3, name: "Kima", implementation: "Webhook", fields: [] }] });
    lidarr.put.mockImplementation(echo);

    await configureLidarrWebhook("http://lidarr", "key");

    expect(lidarr.put.mock.calls[0][0]).toBe("/api/v1/notification/3?forceSave=true");
    expect(sentHeaders(lidarr.put.mock.calls[0])).toEqual([{ key: WEBHOOK_SECRET_HEADER, value: "kept" }]);
    expect(update).not.toHaveBeenCalled();
});

it("does not save a secret Lidarr dropped", async () => {
    (getSystemSettings as jest.Mock).mockResolvedValue({ lidarrWebhookSecret: null });
    lidarr.post.mockImplementation((_url: string, body: any) =>
        Promise.resolve({ data: { ...body, fields: body.fields.filter((f: any) => f.name !== "headers") } })
    );

    await configureLidarrWebhook("http://lidarr", "key");

    expect(update).not.toHaveBeenCalled();
});
