import { Workspace } from "./workspace";
import styles from "./workspace.module.css";

// Only the empty application shell is static. Every user/tenant record is loaded
// from authenticated no-store APIs; no identity or customer data enters this HTML.
export const dynamic = "force-static";
export const metadata = { title: "Company workspace" };

export default function WorkspacePage() {
  return (
    <div className={styles.page}>
      <a className={styles.skip} href="#workspace">
        Skip to workspace
      </a>
      <Workspace />
    </div>
  );
}
