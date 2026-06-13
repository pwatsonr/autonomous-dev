// Settings › Variants tab — REAL request types.
//
// Crawl p10 rewrite: this panel previously rendered kit fixtures
// ("Fast-track (4-phase)", "8-phase canonical") from server/stubs with
// dead Edit / Set default buttons. The daemon's actual variant concept
// is config/request-types.json (default / hotfix / exploration /
// refactor — each with a cost cap, trust threshold, and default
// reviewers). Display-only: there are no edit endpoints yet, so per the
// dead-control precedent (#420) there are no button costumes either.

import type { FC } from "hono/jsx";

import type { SettingsData } from "../../types/render";
import { Chip } from "../../components/primitives";

export const VariantsPanel: FC<{ data: SettingsData }> = ({ data }) => {
    const types = data.requestTypes ?? [];
    return (
        <section class="sec" aria-labelledby="variants-heading">
            <div class="sec-head">
                <h2 id="variants-heading">Request types</h2>
                <span class="meta-mono dim">
                    config/request-types.json · read-only
                </span>
            </div>
            <p class="dim">
                The pipeline variants the daemon accepts on request intake.
                Each sets the default cost cap, trust threshold, and
                reviewer chain for requests of that type.
            </p>
            {types.length === 0 ? (
                <p class="empty dim">
                    No request types found — the daemon plugin's
                    config/request-types.json was not readable.
                </p>
            ) : (
                <div class="rt-grid">
                    {types.map((t) => (
                        <div class="card rt-card" key={t.id}>
                            <div class="rt-head">
                                <span class="rt-name mono">{t.id}</span>
                                {t.id === "default" ? (
                                    <Chip variant="status" tone="ok">
                                        DEFAULT
                                    </Chip>
                                ) : null}
                            </div>
                            <p class="rt-desc dim">{t.description}</p>
                            <dl class="kv rt-kv">
                                <dt>Cost cap</dt>
                                <dd class="mono">
                                    {t.defaultCostCapUsd !== null
                                        ? `$${t.defaultCostCapUsd}`
                                        : "—"}
                                </dd>
                                <dt>Trust threshold</dt>
                                <dd class="mono">
                                    {t.defaultTrustThreshold !== null
                                        ? String(t.defaultTrustThreshold)
                                        : "—"}
                                </dd>
                                <dt>Reviewers</dt>
                                <dd class="mono">
                                    {t.defaultReviewers.length > 0
                                        ? t.defaultReviewers.join(" · ")
                                        : "none"}
                                </dd>
                            </dl>
                        </div>
                    ))}
                </div>
            )}
        </section>
    );
};
