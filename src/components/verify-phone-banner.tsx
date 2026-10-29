"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { VERIFY_PHONE_PATH } from "@/domain/auth/phone-history";

/**
 * Persistent, non-dismissible activation banner for signed-in customers whose
 * phone is not verified. It follows them across the app (except on the
 * verification page itself) so an old "stuck" account can never lose the way
 * back to /verify-phone.
 */
export function VerifyPhoneBanner() {
  const pathname = usePathname();
  if (pathname === VERIFY_PHONE_PATH) return null;
  return (
    <div className="verify-banner" role="status">
      <p>حسابك غير مكتمل: وثّق رقم جوالك لفتح النماذج والرفع والمقارنات.</p>
      <Link className="btn" href={VERIFY_PHONE_PATH}>
        تفعيل رقم الجوال
      </Link>
    </div>
  );
}
