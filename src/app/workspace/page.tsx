import { redirect } from "next/navigation";
import { Workspace } from "@/components/workspace";
import { readGoogleSession } from "@/server/google-session";

export default async function WorkspacePage() {
  const session = await readGoogleSession();
  if (!session) redirect("/");
  return <Workspace />;
}
