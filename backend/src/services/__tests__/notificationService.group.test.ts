/**
 * A grouped alert drops only an identical repeat; a new type or link replaces
 * the row and brings it back unread.
 */

import { prisma } from "../../utils/db";
import { notificationService } from "../notificationService";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const USER = "nsg_user";
const alert = (type: "system" | "error", href: string) =>
    notificationService.create({ userId: USER, type, title: "Lidarr", message: "Check it", metadata: { href }, groupKey: "nsg" });

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

afterEach(async () => {
    await prisma.notification.deleteMany({ where: { userId: USER } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

const markRead = () => prisma.notification.updateMany({ where: { userId: USER }, data: { read: true } });
const only = async () => {
    const rows = await prisma.notification.findMany({ where: { userId: USER } });
    expect(rows).toHaveLength(1);
    return rows[0];
};

it("drops an identical repeat", async () => {
    await alert("error", "/settings#lidarr");
    await markRead();
    await alert("error", "/settings#lidarr");

    expect((await only()).read).toBe(true);
});

it("replaces the row when only the link changes", async () => {
    await alert("error", "/settings#lidarr");
    await markRead();
    await alert("error", "/settings#downloads");

    expect(await only()).toMatchObject({ read: false, metadata: { href: "/settings#downloads" } });
});

it("replaces the row when only the type changes", async () => {
    await alert("error", "/settings#lidarr");
    await markRead();
    await alert("system", "/settings#lidarr");

    expect(await only()).toMatchObject({ read: false, type: "system" });
});
