import { Router } from "express";
import { invalidateUserCache } from "../../middleware/auth";
import bcrypt from "bcrypt";
import { prisma } from "../../utils/db";
import { defaultUserSettingsFor } from "../../utils/userSettingsDefaults";
import { subsonicError, subsonicOk, SubsonicError } from "../../utils/subsonicResponse";
import { wrap } from "./mappers";
import { decodeSubsonicPassword, mapSubsonicUser, requireSubsonicAdmin } from "./userHelpers";

export const userManagementRouter = Router();

userManagementRouter.all("/getUsers.view", wrap(async (req, res) => {
    if (!requireSubsonicAdmin(req, res)) return;

    const users = await prisma.user.findMany({
        select: {
            username: true,
            role: true,
        },
        orderBy: { username: "asc" },
    });

    return subsonicOk(req, res, {
        users: {
            user: users.map(mapSubsonicUser),
        },
    });
}));

userManagementRouter.all("/changePassword.view", wrap(async (req, res) => {
    const username = req.query.username as string | undefined;
    const passwordRaw = req.query.password as string | undefined;
    if (!username) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: username");
    }
    if (!passwordRaw) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: password");
    }

    if (username !== req.user!.username && !requireSubsonicAdmin(req, res)) {
        return;
    }

    // A user changing their own password with an API key is refused: a leaked
    // key must not be able to take over the login, which is what 2FA protects.
    // Password sessions, and admins changing another user's password, are unaffected.
    if (username === req.user!.username && req.subsonicAuthMethod === "apiKey") {
        return subsonicError(
            req,
            res,
            SubsonicError.NOT_AUTHORIZED,
            "Change your password on the web, not with an app key.",
        );
    }

    const user = await prisma.user.findUnique({
        where: { username },
        select: { id: true },
    });
    if (!user) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "User not found");
    }

    const password = decodeSubsonicPassword(passwordRaw);
    const passwordHash = await bcrypt.hash(password, 10);

    await prisma.user.update({
        where: { id: user.id },
        data: {
            passwordHash,
            tokenVersion: { increment: 1 },
        },
    });
    // tokenVersion revokes issued tokens; drop the cached row so it takes
    // effect immediately rather than after the auth cache TTL.
    invalidateUserCache(user.id);

    return subsonicOk(req, res);
}));

userManagementRouter.all("/createUser.view", wrap(async (req, res) => {
    if (!requireSubsonicAdmin(req, res)) return;

    const username = req.query.username as string | undefined;
    const passwordRaw = req.query.password as string | undefined;
    if (!username) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: username");
    }
    if (!passwordRaw) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: password");
    }

    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) {
        return subsonicError(req, res, SubsonicError.GENERIC, "Username already exists");
    }

    const adminRoleRaw = req.query.adminRole as string | undefined;
    const adminRole = adminRoleRaw === "true" || adminRoleRaw === "1";
    const password = decodeSubsonicPassword(passwordRaw);
    const passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
        data: {
            username,
            passwordHash,
            role: adminRole ? "admin" : "user",
            onboardingComplete: true,
        },
        select: { id: true },
    });

    await prisma.userSettings.upsert({
        where: { userId: user.id },
        update: {},
        create: defaultUserSettingsFor(user.id),
    });

    return subsonicOk(req, res);
}));

userManagementRouter.all("/updateUser.view", wrap(async (req, res) => {
    if (!requireSubsonicAdmin(req, res)) return;

    const username = req.query.username as string | undefined;
    if (!username) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: username");
    }

    const target = await prisma.user.findUnique({
        where: { username },
        select: { id: true, username: true },
    });
    if (!target) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "User not found");
    }

    const roleData: { role?: "admin" | "user" } = {};
    const adminRoleRaw = req.query.adminRole as string | undefined;
    if (adminRoleRaw !== undefined) {
        roleData.role = adminRoleRaw === "true" || adminRoleRaw === "1" ? "admin" : "user";
    }

    const passwordRaw = req.query.password as string | undefined;
    const passwordData: { passwordHash?: string; tokenVersion?: { increment: number } } = {};
    if (passwordRaw) {
        const password = decodeSubsonicPassword(passwordRaw);
        passwordData.passwordHash = await bcrypt.hash(password, 10);
        passwordData.tokenVersion = { increment: 1 };
    }

    if (target.id === req.user!.id && roleData.role === "user") {
        return subsonicError(req, res, SubsonicError.NOT_AUTHORIZED, "Cannot remove your own admin role");
    }

    await prisma.user.update({
        where: { id: target.id },
        data: {
            ...roleData,
            ...passwordData,
        },
    });
    // The auth layer caches this row, and it carries both `role` and
    // `tokenVersion` -- a stale entry would keep an old role (or a revoked
    // token) working until the TTL elapsed.
    invalidateUserCache(target.id);

    return subsonicOk(req, res);
}));

userManagementRouter.all("/deleteUser.view", wrap(async (req, res) => {
    if (!requireSubsonicAdmin(req, res)) return;

    const username = req.query.username as string | undefined;
    if (!username) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: username");
    }

    const target = await prisma.user.findUnique({
        where: { username },
        select: { id: true },
    });
    if (!target) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "User not found");
    }

    if (target.id === req.user!.id) {
        return subsonicError(req, res, SubsonicError.NOT_AUTHORIZED, "Cannot delete your own account");
    }

    await prisma.user.delete({ where: { id: target.id } });
    invalidateUserCache(target.id);
    return subsonicOk(req, res);
}));