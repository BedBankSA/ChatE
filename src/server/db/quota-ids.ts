export const SHARED_QUOTA_ID = "shared";

export function userQuotaId(userId: string): string {
  return `user:${userId}`;
}
