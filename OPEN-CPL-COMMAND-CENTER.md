# Open CPL Command Center

Double-click **RUN-CPL-COMMAND-CENTER.cmd** in this folder. Keep its progress window open. The browser opens when the workspace and its local database are ready. A first compilation can take a few minutes; later starts reuse the installed dependencies and cached build.

The app shows **DEVELOPMENT**. Use **Enter development workspace** if prompted. The default identity opens the existing **CPL Development · Synthetic** company. For Phase 5, choose **Synthetic company owner Alpha** for Alder or **Synthetic company owner Beta** for Harbor, then enter or switch identity. The [Phase 5 walkthrough](docs/LOCAL_PHASE5_TESTING.md) identifies the saved fictional records and normal screen paths. These fixed local identities do not simulate production MFA. Google and passkeys remain part of the hosted authentication design.

- **RUN-CPL-COMMAND-CENTER.cmd** opens the existing instance if it is already running.
- **STOP-CPL-COMMAND-CENTER.cmd** stops the web app, local jobs and local database. Your test records are preserved.
- **RESTART-CPL-COMMAND-CENTER.cmd** stops and restarts them, then opens the browser.
- **CPL-Doctor.cmd** shows startup status and dependency checks.

The local address is [CPL development workspace](http://127.0.0.1:3400/workspace). These launchers use the existing Node 24.19.0 and portable PostgreSQL 16.15 under `D:\Cyber Pirate Labs\93_TOOLS_AND_CACHE\CPL-Command-Center`. They never install packages on every launch or fall back to another drive.

Local database files, logs, protected credentials and caches stay on the external SSD. Credentials are encrypted for the current Windows user. Disconnecting the SSD, changing Windows users or an occupied port produces an error that stays visible. Launchers do not terminate unrelated applications, reset data, or contact the hosted database. Close with the stop launcher before unplugging the SSD.

The public source checkout does not contain the owner's database, uploaded photos, generated PDFs or prepared walkthrough records. Its launcher validates the database ownership marker against its own repository identity and checkout path. If the existing SSD database belongs to the canonical checkout, the public checkout refuses to reuse it and preserves its contents. Do not delete the marker, copy credentials or repoint the public checkout at that database. A separately reviewed local setup is required before running another checkout on this machine; publishing source does not authorize changing the active development database.

The current product coverage and next dependencies are in [the feature map](docs/PRODUCT_FEATURE_MAP.md). Hosting acceptance is [deferred](docs/DEFERRED_HOSTING.md); the existing [cloud preview](https://cpl-command-center.astarrett.workers.dev/workspace) is a separate development checkpoint.
