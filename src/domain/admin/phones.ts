// Pure admin view contract for the phone-history / stuck-customer screen.
// No database access here: the server layer maps these shapes onto bound SQL.

import { PHONE_ACTIONS, isPhoneAction, type PhoneAction } from "@/domain/auth/phone-history";

export const PHONE_STATUS_FILTERS = ["all", "unverified", "verified"] as const;
export type PhoneStatusFilter = (typeof PHONE_STATUS_FILTERS)[number];

export class PhoneQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhoneQueryError";
  }
}

export type PhoneListQuery = {
  q: string;
  status: PhoneStatusFilter;
  action: PhoneAction | null;
  userId: string | null;
  page: number;
  pageSize: number;
};

export type AdminPhoneCustomer = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  phoneVerifiedAt: string | null;
  accountStatus: string;
  registeredAt: string;
  lastActivityAt: string;
};

export type AdminPhoneEvent = {
  id: string;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  oldPhone: string | null;
  newPhone: string;
  action: string;
  phoneVerified: boolean;
  actorType: string;
  actorUserId: string | null;
  ip: string | null;
  createdAt: string;
};

export type AdminPhonesView = {
  email: string;
  actorId: string;
  counts: { total: number; verified: number; unverified: number; duplicatePhones: number };
  customers: AdminPhoneCustomer[];
  customerTotal: number;
  events: AdminPhoneEvent[];
  page: number;
  pageSize: number;
  q: string;
  status: PhoneStatusFilter;
  action: PhoneAction | null;
  userId: string | null;
  notice: string | null;
  loadError: string | null;
};

const STATUSES = new Set<string>(PHONE_STATUS_FILTERS);
const USER_ID = /^[\w.:-]{1,200}$/;

export function parsePhoneListQuery(params: URLSearchParams): PhoneListQuery {
  const status = params.get("status") || "all";
  if (!STATUSES.has(status)) throw new PhoneQueryError("مرشح حالة التوثيق غير مسموح.");
  const action = params.get("event") || "";
  if (action && !isPhoneAction(action)) throw new PhoneQueryError("نوع الحركة غير مسموح.");
  const userId = (params.get("userId") ?? "").trim();
  if (userId && !USER_ID.test(userId)) throw new PhoneQueryError("معرّف العميل غير صالح.");
  return {
    q: (params.get("q") ?? "").trim().slice(0, 200),
    status: status as PhoneStatusFilter,
    action: action ? (action as PhoneAction) : null,
    userId: userId || null,
    page: boundedInt(params.get("page"), 1),
    pageSize: boundedInt(params.get("pageSize"), 20, 5, 100),
  };
}

export function phonesHref(input: {
  q?: string;
  status?: PhoneStatusFilter;
  action?: PhoneAction | null;
  userId?: string | null;
  page?: number;
}): string {
  const params = new URLSearchParams();
  if (input.q) params.set("q", input.q);
  if (input.status && input.status !== "all") params.set("status", input.status);
  if (input.action) params.set("event", input.action);
  if (input.userId) params.set("userId", input.userId);
  if (input.page && input.page > 1) params.set("page", String(input.page));
  const query = params.toString();
  return query ? `/admin/phones?${query}` : "/admin/phones";
}

/** Rendered when the store read fails; the page still explains the state honestly. */
export function emptyAdminPhones(input: {
  email: string;
  actorId: string;
  notice: string | null;
  loadError: string;
}): AdminPhonesView {
  return {
    email: input.email,
    actorId: input.actorId,
    counts: { total: 0, verified: 0, unverified: 0, duplicatePhones: 0 },
    customers: [],
    customerTotal: 0,
    events: [],
    page: 1,
    pageSize: 20,
    q: "",
    status: "all",
    action: null,
    userId: null,
    notice: input.notice,
    loadError: input.loadError,
  };
}

export const PHONE_ACTION_OPTIONS = PHONE_ACTIONS;

function boundedInt(value: string | null, fallback: number, min = 1, max = 100_000): number {
  if (value == null || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value)) throw new PhoneQueryError("رقم الصفحة غير صالح.");
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new PhoneQueryError("رقم الصفحة غير صالح.");
  return parsed;
}