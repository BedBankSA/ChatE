import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

export type Profile = {
  name: string | null;
  email: string | null;
  phoneE164: string | null;
  phoneVerifiedAt: string | null;
  age: number | null;
  city: string | null;
  status: "active" | "suspended";
};

export function normalizePhone(country: string, nationalNumber: string): { ok: true; e164: string } | { ok: false } {
  if (!/^[A-Za-z]{2}$/.test(country)) return { ok: false };
  try {
    const parsed = parsePhoneNumberFromString(nationalNumber, country.toUpperCase() as CountryCode);
    if (!parsed?.isValid()) return { ok: false };
    return { ok: true, e164: parsed.number };
  } catch {
    // An unknown region code or malformed input must not throw into the route.
    return { ok: false };
  }
}

export function withUnverifiedPhone(profile: Profile, e164: string): Profile {
  return { ...profile, phoneE164: e164, phoneVerifiedAt: null };
}

export function withVerifiedPhone(profile: Profile, e164: string, verifiedAt: string): Profile {
  return { ...profile, phoneE164: e164, phoneVerifiedAt: verifiedAt };
}

export function withDemographics(profile: Profile, input: { age?: number | null; city?: string | null }): Profile {
  return {
    ...profile,
    age: input.age ?? null,
    city: input.city?.trim() ? input.city.trim() : null,
  };
}

export function profileGate(profile: Profile): { locked: false } | { locked: true; reason: "profile" | "phone" | "suspended" } {
  if (profile.status === "suspended") return { locked: true, reason: "suspended" };
  if (!profile.name || !profile.email) return { locked: true, reason: "profile" };
  if (!profile.phoneE164 || !profile.phoneVerifiedAt) return { locked: true, reason: "phone" };
  return { locked: false };
}
