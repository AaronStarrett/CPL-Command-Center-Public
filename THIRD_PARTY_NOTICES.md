# Third-party dependencies and assets

Application source remains `UNLICENSED`. This document records dependency attribution; it does not relicense the application or CPL product mark.

`PUBLIC_DEPENDENCIES.json` records the installed dependency names, versions, package-declared licenses, and supplied license/notice filenames reviewed when this snapshot was exported. `pnpm-lock.yaml` retains the exact dependency resolution. This source repository does not include dependency vendor trees, native dependency binaries, generated bundles, or copies of third-party fonts. Installation fetches those dependencies from their upstream package distributions with their own license and notice files.

The reviewed Windows installation includes the following dependencies with terms requiring particular attention before any later redistribution of their code, data, native binaries, or application bundles:

| Package                     | Version      | Declared license                 | Upstream source                                                |
| --------------------------- | ------------ | -------------------------------- | -------------------------------------------------------------- |
| @img/sharp-win32-x64        | 0.35.3       | Apache-2.0 AND LGPL-3.0-or-later | [sharp](https://github.com/lovell/sharp)                       |
| axe-core                    | 4.13.0       | MPL-2.0                          | [axe-core](https://github.com/dequelabs/axe-core)              |
| caniuse-lite                | 1.0.30001809 | CC-BY-4.0                        | [caniuse-lite](https://github.com/browserslist/caniuse-lite)   |
| lightningcss                | 1.33.0       | MPL-2.0                          | [lightningcss](https://github.com/parcel-bundler/lightningcss) |
| lightningcss-win32-x64-msvc | 1.33.0       | MPL-2.0                          | [lightningcss](https://github.com/parcel-bundler/lightningcss) |

Other reviewed dependencies declare MIT, Apache-2.0, BSD, ISC, Python-2.0, MIT-0, 0BSD, CC0, BlueOak-1.0.0, or combined MIT/Zlib terms as recorded in the inventory. Preserve the original notices in every installed dependency. Native deployment artifacts and application bundles are not cleared for redistribution by this source-only review; review their actual included code and notices at that stage.

The hosted build separately generates `/THIRD_PARTY_NOTICES.txt` and `/THIRD_PARTY_NOTICES.json` from emitted webpack resources, OpenNext and Wrangler bundle metadata, and identified copied adapter runtime. It preserves upstream notice bytes and hashes. Because Next's prebundled server runtime conceals its internal module graph, the artifact also includes the complete installed Next embedded-notice set as a conservative supplement; that does not mean every supplemented library ships. Missing notices block the build. Version-pinned upstream notice supplements retain their source and digest under `scripts/publication/licenses`. The exact empty `client-only@0.0.1/index.js` and `server-only@0.0.1/empty.js` markers preserve their own package license declarations only and block if authored or unreviewed source appears, including within embedded packages. This technical inventory does not replace review of the actual deployment artifact or create a general legal clearance.

The CPL product mark is owner-provided branding. Customer-supplied original logos, source documents, and historical branded assets are excluded from this publication. No trademark license is granted.
