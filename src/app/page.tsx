import { redirect } from "next/navigation";

// Root: the middleware already bounces unauthenticated users to /auth/login.
// An authenticated visit lands on the expenses ledger.
export default function Home() {
  redirect("/despesas");
}
