import { redirect } from "next/navigation";
import { Workspace } from "@/components/workspace";
import { readGoogleSession } from "@/server/google-session";
import { redirectUnverifiedToVerifyPhone } from "@/server/phone/gate";

export default async function WorkspacePage() {
  const session = await readGoogleSession();
  if (!session) redirect("/");
  // Stuck-customer recovery: a signed-in account without a verified phone is
  // sent straight to the activation gate instead of a workspace that silently
  // refuses every send.
  await redirectUnverifiedToVerifyPhone("/workspace");
  return <Workspace />;
}
