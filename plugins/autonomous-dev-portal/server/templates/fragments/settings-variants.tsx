// SPEC-037-5-03 §Settings Variants Panel — `.variant-grid` of
// `.variant-card`s for the Pipeline Variants tab. Each card shows the
// phase pipeline (coloured `.phase-tag p-{phase}` chips separated by `→`)
// and a reviewer chain row per phase (`.rev-line`).
//
// CSS is provided by `app.css:556-578` (`.variant-grid`, `.phase-tag.*`).
// Editing the reviewer chain is out of scope here; the Edit button stub
// carries `data-todo="edit-variant"` so a follow-up spec can wire a modal.

import type { FC } from "hono/jsx";

import type { PipelineVariant, SettingsData } from "../../types/render";

interface Props {
    data: SettingsData;
}

interface CardProps {
    variant: PipelineVariant;
    isDefault: boolean;
}

const VariantCard: FC<CardProps> = ({ variant, isDefault }) => {
    const reviewers = variant.reviewers ?? {};
    return (
        <div
            class={isDefault ? "variant-card on" : "variant-card"}
            data-variant={variant.id}
        >
            <div class="variant-top">
                <div class="variant-name">{variant.label}</div>
                {isDefault ? (
                    <span class="chip ok sm">default</span>
                ) : null}
            </div>
            <div class="variant-desc">{variant.desc}</div>
            <div class="variant-pipe">
                {variant.phases.map((phase, i) => (
                    <>
                        <span class={`phase-tag p-${phase}`}>{phase}</span>
                        {i < variant.phases.length - 1 ? (
                            <span class="arrow">→</span>
                        ) : null}
                    </>
                ))}
            </div>
            <div class="variant-rev">
                {Object.entries(reviewers).map(([phase, names]) => (
                    <div class="rev-line">
                        <span class="rev-phase meta-mono">{phase}:</span>
                        <span>{names.join(" · ")}</span>
                    </div>
                ))}
            </div>
            <div class="variant-actions">
                <button
                    type="button"
                    class="btn sm"
                    data-todo="edit-variant"
                    data-variant-edit={variant.id}
                >
                    Edit
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
                        hx-post="/api/settings/default-variant"
                        hx-vals={JSON.stringify({ id: variant.id })}
                        hx-target="#settings-root"
                        hx-swap="outerHTML"
                    >
                        Set default
                    </button>
                )}
            </div>
        </div>
    );
};

export const VariantsPanel: FC<Props> = ({ data }) => {
    const sorted = [...data.variants].sort((a, b) =>
        a.id.localeCompare(b.id),
    );
    return (
        <section class="sec">
            <div class="sec-head">
                <h2>Pipeline variants</h2>
                <span class="meta-mono dim">PRD-011</span>
            </div>
            <div class="variant-grid">
                {sorted.map((v) => (
                    <VariantCard
                        variant={v}
                        isDefault={v.id === data.defaultVariant}
                    />
                ))}
            </div>
        </section>
    );
};
