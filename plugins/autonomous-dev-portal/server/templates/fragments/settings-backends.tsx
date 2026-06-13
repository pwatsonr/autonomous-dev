// Settings › Backends tab — honest empty state.
//
// Crawl p10 rewrite: this panel previously rendered kit FIXTURES as if
// they were the operator's infrastructure — "Fly.io (prod) $0.012/run",
// "Kubernetes (staging)", "Render (canary) · Install plugin" — with
// dead Configure / Set default buttons. The daemon does not track
// deploy backends (the Ops page says so honestly); until it does, this
// tab says so too. No fabricated infrastructure, no button costumes.

import type { FC } from "hono/jsx";

import type { SettingsData } from "../../types/render";

export const BackendsPanel: FC<{ data: SettingsData }> = (_props) => (
    <section class="sec" aria-labelledby="backends-heading">
        <div class="sec-head">
            <h2 id="backends-heading">Deploy backends</h2>
        </div>
        <p class="empty dim">
            Deploy backends are not tracked by this daemon version —
            nothing is configured here. Deploy execution runs through the
            pipeline's deploy phase; backend selection will appear here
            when the daemon exposes it.
        </p>
    </section>
);
