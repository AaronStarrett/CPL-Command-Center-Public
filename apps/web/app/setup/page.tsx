import Image from "next/image";
import styles from "./setup.module.css";
export const dynamic = "force-dynamic";
export const metadata = { title: "Workspace setup" };
export default function SetupPage() {
  return (
    <div className={styles.page}>
      <a className={styles.skip} href="#setup">
        Skip to workspace setup
      </a>
      <header className={styles.header}>
        <span className={styles.monogram}>CPL</span>
        <div>
          <strong>Command Center</strong>
          <span>Cyber Pirate Labs</span>
        </div>
        <span className={styles.badge}>Setup required</span>
      </header>
      <main id="setup" className={styles.main}>
        <section className={styles.intro} aria-labelledby="setup-title">
          <p className={styles.eyebrow}>YOUR OPERATIONS, IN ONE PLACE</p>
          <h1 id="setup-title">
            A clear start for
            <br />
            your workspace.
          </h1>
          <p className={styles.lead}>
            CPL Command Center brings your intake, proposals, and service work together. Secure
            workspace setup must be completed before customer records can be added.
          </p>
          <div className={styles.notice}>
            <span aria-hidden="true">◈</span>
            <p>
              <strong>Your workspace starts empty.</strong>
              <br />
              No customer records, sample activity, or connected accounts have been created.
            </p>
          </div>
          <form action="/setup" method="get">
            <button className={styles.refresh} type="submit">
              Refresh setup status <span aria-hidden="true">↻</span>
            </button>
          </form>
        </section>
        <aside className={styles.panel} aria-label="Workspace activation requirements">
          <Image
            src="/brand/cpl-logo.png"
            alt="Cyber Pirate Labs pirate skull and tricorn logo"
            width={134}
            height={134}
            unoptimized
            priority
          />
          <h2>Before you begin</h2>
          <p className={styles.panelLead}>
            This development checkpoint is awaiting secure activation.
          </p>
          <ol className={styles.steps}>
            <li>
              <span>01</span>
              <div>
                <h3>Secure sign-in</h3>
                <p>Hosted sign-in and administrator verification are not yet available.</p>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <h3>Company workspace</h3>
                <p>Organization access must be verified throughout the application.</p>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <h3>Workflow configuration</h3>
                <p>
                  Your service catalog, templates, and enabled modules will be configured for your
                  company.
                </p>
              </div>
            </li>
            <li>
              <span>04</span>
              <div>
                <h3>Authorized connections</h3>
                <p>Email, documents, and AI remain disconnected until separately approved.</p>
              </div>
            </li>
          </ol>
          <p className={styles.status}>Customer operations are currently unavailable.</p>
        </aside>
      </main>
      <footer className={styles.footer}>
        <span>CPL Command Center</span>
        <span>Development checkpoint · No live connections</span>
      </footer>
    </div>
  );
}
