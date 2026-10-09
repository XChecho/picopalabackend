import { Platform } from "@prisma/client";

export const MOBILE_PLATFORMS = [
  "IOS",
  "ANDROID",
] as const satisfies readonly Platform[];
export type MobilePlatform = (typeof MOBILE_PLATFORMS)[number];
