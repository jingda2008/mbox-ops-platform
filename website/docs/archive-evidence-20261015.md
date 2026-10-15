# Public archive evidence and release boundary — 2026-10-15

Scope: seven language `/archive/` pages and three editorial links on each homepage. No changes to reservation code, gateway, staff/backend, menus or shared styles.

## Evidence allowed

- 2017 author-published historical promotional article: https://k.sina.cn/article_5860568496_15d512db0019002x3i.html (2017-10-19). Supports an attributed 1999 brand origin and historical singer-recruitment announcement. Does not establish competition completion or current recruitment.
- 2021 author-published venue introduction: https://www.sohu.com/a/481017465_121124405 (2021-08-02). Supports attributed brand origin and mention of Lujiazui Center and Huaihai Road locations. Not a platform endorsement or evidence that the current venue opened in 1999.
- Read-only production performer catalog checked 2026-10-15 20:51 CST: 17 active records, but one is the combined schedule label 小双／小九. Publish 16 independent stage-name entries, with check date; no assertion that all appear tonight. Biography/style/highlight fields are empty. No awards, work histories or identity matches inferred.
- Reuse the user-supplied performance clip already on the homepage. No artist identification, filming date or promise of a particular performance added.
- Private hire availability before 20:00 and in the evening, for team gatherings, salons/discussion groups and small meetings, comes from the owner's direct instruction. Capacity, equipment, quiet conditions, fees and exclusive rooms require confirmation.

## Evidence excluded / still needed

- Production activity table contains test and cancelled records. A published 2026-08-30 Mayday fan-gathering invitation is insufficient to establish a real public event; omitted entirely. No completed customer cases are claimed.
- Historical celebrity timelines are not reproduced. The 2006 Mayday album-event date in retrospective promotion conflicts with contemporaneous release reporting and needs further primary evidence.
- Artist biographies need performer/manager confirmation and approved materials. A completed case needs date, location, actual activity and authorized photos or records. These gaps remain open.

## Validation

- Independent content reviewer reviewed evidence and final seven-language output; initial title/combined-name issues fixed, final content review passed.
- 38 website checks passed (run from website directory). 10 runtime checks passed, covering booking access control, video byte ranges, SSR menu, seven archive routes and sitemap.
- Seven language mobile views checked at 390px; no horizontal overflow. Chinese desktop/mobile and German mobile visually reviewed; language switch keeps archive route.
- Aliyun output uses www.shmbox.com canonical and 29 sitemap entries. Existing Google/Baidu verification files preserved.
- Reservation pages, booking.js, gateway.js, server.mjs and shared style.css are byte-identical to production v18 in the release artifact. Menu data/templates unchanged in meaning (line-ending normalization only).

Release status and post-release checks are recorded separately in the commercial checklist and release evidence, not inferred from these local checks.

## Production readback — 2026-10-15 21:15 CST

- Deployed content commit: `e421380c`, public container `mbox-public-site-www-v19`, release `/opt/mbox-public-site/releases/20261015-archive-v19`.
- Caddy change is exclusively the www public upstream from v18 to v19. Old v18 retained; backup `/opt/mbox-public-site/Caddyfile.before-archive-v19`.
- 17 anonymous public checks returned 200, including all seven archive pages, homepage entry points, menu, reservation page, live performances, `/api/website/menu`, sitemap, robots and existing Google/Baidu verification files. An initial checker used the backend-only menu path on the website and got 404; the actual documented public route passed.
- Real browser playback reached 29 seconds with readyState 4 and no media error.
- Backend image `sha256:9b854bc10bbc80dbfd243a821855772f9495e27afa38eeab3d682888810fcf80`, StartedAt `2026-10-13T17:58:18.380129469Z`, health healthy: unchanged before/after. The unrelated guessed `/api/health` path did not return success; Docker health and actual public performance/menu endpoints are the health evidence.
- Reviewer independently checked final readback, business-file hashes and unchanged backend identity. No booking creation/cancellation or employee notification tests performed on production. No database writes.
- Evidence directory: `/Users/jingda/mbox/outputs/website-content-20261013/content-evidence-20261015/`. Public availability and indexing permission do not establish new-page indexing or AI recommendations.
