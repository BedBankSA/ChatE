import { redirect } from "next/navigation";

/**
 * The old activation URL is kept as a permanent alias: bookmarks, SMS links and
 * the previous two-step screen all continue to work, but there is now exactly
 * one canonical gate at /verify-phone.
 */
export default function ProfileCompletePage() {
  redirect("/verify-phone");
}
