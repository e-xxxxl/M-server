import { z } from "zod";

/**
 * The two kinds of phone token the server delivers to:
 * - an Expo push token, `ExponentPushToken[...]`, which the Expo push service delivers (the app's usual choice);
 * - a raw Firebase Cloud Messaging device token, which the server delivers itself with its Firebase key.
 */
export const expoTokenPattern = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,180}\]$/;
export const fcmTokenPattern = /^[A-Za-z0-9_:-]{100,4096}$/;

export const isExpoToken = (token) => expoTokenPattern.test(String(token));
export const isPushToken = (token) => isExpoToken(token) || fcmTokenPattern.test(String(token));

export const pushTokenMessage = "This is not a valid push token. Send the Expo push token (ExponentPushToken[...]) or the Firebase device token the app gets.";

/** A push token that must be valid. */
export const pushTokenSchema = z.string().trim().refine(isPushToken, pushTokenMessage);

/** The optional token on sign-in and sign-up: missing or empty means none. Anything else is checked where it is used. */
export const optionalDevicePushToken = z.string().max(4096).optional();
