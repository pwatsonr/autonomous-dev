// SPEC-037-5-04 §Settings Backends Panel — `.backend-grid` of
// `.backend-card`s. Each card shows the backend name, a kind chip
// (`bundled` → `chip ok`, otherwise `chip info`), a cost line, a row of
// `.cap-chip`s, and an action footer that varies by `b.status`:
//   - `available`        → Configure + Set default
//   - other / not-installed → Install plugin (HTMX into `#modal-slot`)
//
// CSS for `.backend-card.not-installed` is in `app.css:585-595`; the
// shared overlay modal helper is `templates/fragments/modal.tsx`
// (SPEC-037-5-06).

import type { FC } from "hono/jsx";

import type { DeployBackend, SettingsData } from "../../types/render";

interface Props {
    data: SettingsData;
}

function backendName(b: DeployBackend): string {
    return b.name ?? b.label;
}

function kindChipClass(kind: string): string {
    return kind === "bundled" ? "chip ok sm" : "chip info sm";
}

interface CardProps {
    backend: DeployBackend;
    isDefault: boolean;
}

const BackendCard: FC<CardProps> = ({ backend, isDefault }) => {
    const status = backend.status ?? "available";
    const isAvailable = status === "available";
    const caps = backend.caps ?? [];
    const cls =
        "backend-card " + status + (isDefault ? " default" : "");
    return (
        <div class={cls} data-backend={backend.id}>
            <div class="backend-top">
                <div class="backend-name">{backendName(backend)}</div>
                <span class={kindChipClass(backend.kind)}>{backend.kind}</span>
            </div>
            {backend.cost !== undefined ? (
                <div class="backend-cost meta-mono">{backend.cost}</div>
            ) : null}
            <div class="backend-caps">
                {caps.map((c) => (
                    <span class="cap-chip">{c}</span>
                ))}
            </div>
            {isAvailable ? (
                <div class="backend-actions">
                    <button type="button" class="btn sm">
                        Configure
                    </button>
                    {isDefault ? (
                        <button
                            type="button"
                            class="btn sm primary"
                            disabled
                        >
                            Set default
                        </button>
                    ) : (
                        <button
                            type="button"
                            class="btn sm primary"
                            hx-post="/api/settings/default-backend"
                            hx-vals={JSON.stringify({ id: backend.id })}
                            hx-target="#settings-root"
                            hx-swap="outerHTML"
                        >
                            Set default
                        </button>
                    )}
                </div>
            ) : (
                <div class="backend-actions">
                    <button
                        type="button"
                        class="btn sm primary"
                        hx-get={`/api/backends/${backend.id}/install`}
                        hx-target="#modal-slot"
                        hx-swap="innerHTML"
                    >
                        Install plugin
                    </button>
                </div>
            )}
        </div>
    );
};

export const BackendsPanel: FC<Props> = ({ data }) => (
    <section class="sec">
        <div class="sec-head">
            <h2>Deploy backends</h2>
            <span class="meta-mono dim">PRD-014</span>
        </div>
        <p class="dim">
            Bundled backends ship with the portal. Plugin backends are
            installed on demand.
        </p>
        <div class="backend-grid">
            {data.backends.map((b) => (
                <BackendCard
                    backend={b}
                    isDefault={b.id === data.defaultBackend}
                />
            ))}
        </div>
    </section>
);
