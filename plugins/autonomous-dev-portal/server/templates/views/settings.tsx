// SPEC-036-4-01 §Settings view — five-tab redesign.
//
// Composes:
//   1. Page head        (delivered by ShellLayout via pageTitle)
//   2. Tab nav          (`SettingsTabs`)
//   3. Five panel sections in a fixed order — `general`, `variants`,
//      `standards`, `backends`, `agents`. The panel matching
//      `data.activeTab` renders without `hidden`; the other four carry
//      `hidden` so a JS-off browser still shows the deep-linked tab.
//   4. Top-level dialog modals (Inspect Agent, etc.) hoisted as
//      siblings of the panel sections per SPEC-036-4-01 AC-05.
//   5. Three module scripts: `settings-tabs.js`, `form-validation.js`,
//      `settings-modals.js`.
//
// SPEC-015-2-02 §SettingsEditor — the full editor exported here is kept
// for the existing POST /settings round-trip (server-side persistence
// path). The default `SettingsView` is the redesigned tabbed page.

import { asset } from "../../lib/plugin-version";
import type { FC } from "hono/jsx";
import { Topbar } from "../../components/topbar";

import { Btn, Card, Chip, CostRing } from "../../components/primitives";
import type { RenderProps, SettingsData, TabId } from "../../types/render";
import { AgentInspectModal, AgentTable } from "../fragments/agent-table";
import { AllowlistTable } from "../fragments/allowlist-table";
import { FieldError } from "../fragments/field-error";
import { NotificationsCard } from "../fragments/notifications-card";
import { SettingsSection } from "../fragments/settings-section";
import { SettingsTabs } from "../fragments/settings-tabs";
import { TrustOverridesTable } from "../fragments/trust-overrides-table";
import { VariantsPanel as VariantsFragment } from "../fragments/settings-variants";
import { BackendsPanel as BackendsFragment } from "../fragments/settings-backends";

// ---- Tab panel sub-views ---------------------------------------------------

// PLAN-038 polish — rewritten to match the kit's `<section class="sec">`
// pattern (Settings.jsx). Each section uses `.sec` for vertical spacing,
// `.sec-head` for the h2, and `.dim` for the description paragraph.

const TRUST_LEVEL_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
    { value: "L0", label: "L0 — paranoid (every gate human)" },
    { value: "L1", label: "L1 — automated tests" },
    { value: "L2", label: "L2 — automated PRD + cost" },
    { value: "L3", label: "L3 — only security gate human" },
];

const TrustCard: FC<{ data: SettingsData }> = ({ data }) => (
    <section class="sec" aria-labelledby="trust-heading">
        <div class="sec-head">
            <h2 id="trust-heading">Trust level</h2>
        </div>
        <p class="dim">
            Determines which gates require human approval. Per-repo overrides
            take precedence over the global default.
        </p>
        <form
            data-autosave
            hx-post="/settings"
            hx-swap="outerHTML"
            hx-target="closest section"
        >
{data.csrfToken && data.csrfToken.length > 0 && (
                <input type="hidden" name="_csrf" value={data.csrfToken} />
            )}
            <select
                class="input"
                name="trust-level"
                data-validate="trust-level"
            >
                {TRUST_LEVEL_OPTIONS.map((opt) => (
                    <option value={opt.value} selected={data.trustLevel === opt.value}>
                        {opt.label}
                    </option>
                ))}
            </select>
            <div class="form-actions">
                <span class="meta-mono dim">auto-saves on change</span>
            </div>
        </form>
    </section>
);

const TrustOverridesCard: FC<{ data: SettingsData }> = ({ data }) => {
    const allowlistPaths = data.allowlist.map((e) => e.path);
    return (
        <section class="sec" aria-labelledby="trust-overrides-heading">
            <div class="sec-head">
                <h2 id="trust-overrides-heading">Per-repo overrides</h2>
            </div>
            <p class="dim">
                Pin a different trust level for specific repos. Useful for
                experimental or low-stakes repositories.
            </p>
            <TrustOverridesTable
                overrides={data.trustOverrides}
                allowlist={allowlistPaths}
            />
            <datalist id="allowlist-datalist">
                {allowlistPaths.map((p) => (
                    <option value={p} />
                ))}
            </datalist>
        </section>
    );
};

const CostCapsCard: FC<{ data: SettingsData }> = ({ data }) => (
    <section class="sec" id="cost-caps" aria-labelledby="cost-caps-heading">
        <div class="sec-head">
            <h2 id="cost-caps-heading">Cost caps</h2>
        </div>
        <p class="dim">
            Hard caps. Pipelines pause when reached until reset or override.
        </p>
        {data.capsFromConfig === false && (
            <p class="dim caps-source-note">
                Showing the daemon&#39;s defaults — no caps are set in your
                config. Saving writes these values into config.
            </p>
        )}
        <form
            data-autosave
            hx-post="/settings"
            hx-swap="outerHTML"
            hx-target="closest section"
        >
{data.csrfToken && data.csrfToken.length > 0 && (
                <input type="hidden" name="_csrf" value={data.csrfToken} />
            )}
            <div class="field" data-cost-cap-group>
                <label for="cost-cap-per-request">Per-request cap</label>
                <div class="input-money">
                <span class="prefix">$</span>
                <input
                    type="number"
                    id="cost-cap-per-request"
                    name="perRequest"
                    min="0"
                    step="0.01"
                    value={String(data.costCaps.perRequest)}
                    class="input"
                    data-validate="cost-cap"
                    data-cost-cap-field="perRequest"
                />
                </div>
                <FieldError field="perRequest" message={undefined} />
            </div>
            <div class="field" data-cost-cap-group>
                <label for="cost-cap-daily">Daily cap</label>
                <div class="input-money">
                <span class="prefix">$</span>
                <input
                    type="number"
                    id="cost-cap-daily"
                    name="daily"
                    min="0"
                    step="0.01"
                    value={String(data.costCaps.daily)}
                    class="input"
                    data-validate="cost-cap"
                    data-cost-cap-field="daily"
                />
                </div>
                <FieldError field="daily" message={undefined} />
            </div>
            <div class="field" data-cost-cap-group>
                <label for="cost-cap-monthly">Monthly cap</label>
                <div class="input-money">
                <span class="prefix">$</span>
                <input
                    type="number"
                    id="cost-cap-monthly"
                    name="monthly"
                    min="0"
                    step="0.01"
                    value={String(data.costCaps.monthly)}
                    class="input"
                    data-validate="cost-cap"
                    data-cost-cap-field="monthly"
                />
                </div>
                <FieldError field="monthly" message={undefined} />
            </div>

            <div class="form-actions">
                <span class="meta-mono dim">auto-saves on change</span>
                <Btn type="button" kind="ghost" data-action="reset-cost-caps">
                    Reset to defaults
                </Btn>
            </div>
        </form>

        <h4>Current spend</h4>
        <div class="cost-rings">
            <CostRing
                spent={data.currentSpend.today}
                cap={data.costCaps.daily}
                label="TODAY"
            />
            <CostRing
                spent={data.currentSpend.month}
                cap={data.costCaps.monthly}
                label="MONTH"
            />
        </div>
    </section>
);

const AllowlistCard: FC<{ data: SettingsData }> = ({ data }) => (
    <section class="sec" aria-labelledby="allowlist-heading">
        <div class="sec-head">
            <h2 id="allowlist-heading">Repo allowlist</h2>
        </div>
        <p class="dim">
            Only repositories on this list can be the target of a request.
        </p>
        <AllowlistTable
            entries={data.allowlist}
            csrfToken={data.csrfToken}
        />
    </section>
);

const VariantsPlaceholder: FC<{ data: SettingsData }> = ({ data }) => (
    <section class="sec" aria-labelledby="variants-heading">
        <div class="sec-head">
            <h2 id="variants-heading">Pipeline variants</h2>
        </div>
        <p class="dim">
            Phase sequences that requests follow. The default variant is
            used when the request intake does not specify one.
        </p>
        <table class="tbl">
            <thead>
                <tr>
                    <th>ID</th>
                    <th>Label</th>
                    <th>Phases</th>
                </tr>
            </thead>
            <tbody>
                {data.variants.map((v) => (
                    <tr>
                        <td class="mono">{v.id}</td>
                        <td>{v.label}</td>
                        <td class="mono">{v.phases.join(" → ")}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    </section>
);

const StandardsPanel: FC<{ data: SettingsData }> = ({ data }) => (
    <section class="sec" aria-labelledby="standards-heading">
        <div class="sec-head">
            <h2 id="standards-heading">Engineering standards</h2>
        </div>
        <p class="dim">
            Rules are matched against requests via the <code>applies</code>
            predicate. Blocking rules pause the pipeline until satisfied
            or overridden.
        </p>
        <table class="tbl">
            <thead>
                <tr>
                    <th>ID</th>
                    <th>Severity</th>
                    <th>Description</th>
                    <th>Applies</th>
                    <th>Hits</th>
                </tr>
            </thead>
            <tbody>
                {data.standards.map((rule) => (
                    <tr>
                        <td class="mono">{rule.id}</td>
                        <td>
                            <Chip
                                variant="status"
                                tone={
                                    rule.severity === "blocking"
                                        ? "err"
                                        : rule.severity === "warn"
                                          ? "warn"
                                          : "muted"
                                }
                            >
                                {rule.severity}
                            </Chip>
                        </td>
                        <td>{rule.desc}</td>
                        <td class="mono">{rule.applies}</td>
                        <td class="mono">{rule.hits}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    </section>
);

const BackendsPlaceholder: FC<{ data: SettingsData }> = ({ data }) => (
    <section class="sec" aria-labelledby="backends-heading">
        <div class="sec-head">
            <h2 id="backends-heading">Deploy backends</h2>
        </div>
        <p class="dim">
            Bundled backends ship with autonomous-dev. Plugin backends
            require installation and credential bind.
        </p>
        <table class="tbl">
            <thead>
                <tr>
                    <th>ID</th>
                    <th>Label</th>
                    <th>Kind</th>
                    <th>Enabled</th>
                    <th>Health</th>
                </tr>
            </thead>
            <tbody>
                {data.backends.map((b) => (
                    <tr>
                        <td class="mono">{b.id}</td>
                        <td>{b.label}</td>
                        <td class="mono">{b.kind}</td>
                        <td>{b.enabled ? "yes" : "no"}</td>
                        <td>
                            <Chip variant="status" tone={b.health}>
                                {b.health}
                            </Chip>
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    </section>
);

// ---- Main view -------------------------------------------------------------

interface PanelProps {
    id: TabId;
    activeTab: TabId;
    children?: unknown;
}

const Panel: FC<PanelProps> = ({ id, activeTab, children }) => {
    const isActive = id === activeTab;
    if (isActive) {
        return (
            <section
                id={`settings-panel-${id}`}
                role="tabpanel"
                data-tab-panel={id}
                aria-labelledby={`settings-tab-${id}`}
            >
                {children}
            </section>
        );
    }
    return (
        <section
            id={`settings-panel-${id}`}
            role="tabpanel"
            data-tab-panel={id}
            aria-labelledby={`settings-tab-${id}`}
            hidden
        >
            {children}
        </section>
    );
};

export const SettingsView: FC<RenderProps["settings"]> = ({ data }) => {
    if (data === undefined) {
        // Backward-compatibility fallback for callers that still pass
        // only `{ config }` (legacy dispatcher seam). Render an empty
        // shell with the General tab active.
        return (
            <main class="settings settings-redesign">
                <h1>Settings</h1>
                <p class="meta">Loading…</p>
            </main>
        );
    }

    const activeTab = data.activeTab;
    // Cost caps + saved-config validity drives the "Send test
    // notification now" Btn — server is authoritative.
    const canSendTest = data.notifications.notifyDefault !== "none";

    // v3 Topbar; also: this was a nested <main> inside the shell's
    // <main class="main"> — invalid HTML, now a div.
    return (
        <div class="settings settings-redesign" data-page="settings">
            <Topbar title="Settings" subTitle="config & lifecycle" />
            <div class="main-inner">

            <SettingsTabs activeTab={activeTab} />

            <Panel id="general" activeTab={activeTab}>
                <TrustCard data={data} />
                <TrustOverridesCard data={data} />
                <CostCapsCard data={data} />
                <AllowlistCard data={data} />
                <NotificationsCard
                    config={data.notifications}
                    canSendTest={canSendTest}
                    csrfToken={data.csrfToken}
                />
            </Panel>

            <Panel id="variants" activeTab={activeTab}>
                <VariantsFragment data={data} />
            </Panel>

            <Panel id="standards" activeTab={activeTab}>
                <StandardsPanel data={data} />
            </Panel>

            <Panel id="backends" activeTab={activeTab}>
                <BackendsFragment data={data} />
            </Panel>

            <Panel id="agents" activeTab={activeTab}>
                <section class="sec" aria-labelledby="agents-heading">
                    <div class="sec-head">
                        <h2 id="agents-heading">Agent factory</h2>
                    </div>
                    <p class="dim">
                        Reviewers and executors that participate in the
                        pipeline. Inspect any row to promote, shadow, or
                        freeze the agent.
                    </p>
                    <AgentTable agents={data.agents} />
                </section>
            </Panel>

            {/* Top-level dialogs — hoisted out of [hidden] panels per
                SPEC-036-4-01 AC-05. */}
            {data.agents.map((agent) => (
                <AgentInspectModal agent={agent} />
            ))}

            <script type="module" src={asset("/static/js/settings-tabs.js")}></script>
            <script src={asset("/static/js/settings-autosave.js")} defer></script>
            <script type="module" src={asset("/static/js/form-validation.js")}></script>
            <script type="module" src={asset("/static/js/settings-modals.js")}></script>
        </div>
        </div>
    );
};

// ---- Legacy SettingsEditor kept for the existing POST /settings flow ------
// (Untouched; PLAN-036-4 is re-skin only — persistence layer unchanged.)

export interface RepositorySummary {
    slug: string;
    name: string;
}

export type TrustLevel = "untrusted" | "basic" | "trusted";

export interface SettingsEditorProps {
    settings: {
        costCaps?: { daily?: number | null; monthly?: number | null };
        trustLevels?: Record<string, string>;
        allowlist?: string[];
        notifications?: {
            slack?: { webhook?: string };
            email?: { to?: string };
        };
    };
    repositories: RepositorySummary[];
    fieldErrors?: Record<string, string>;
    warnings?: string[];
    successMessage?: string;
    serviceError?: string;
    csrfToken?: string;
}

const TRUST_OPTIONS: readonly TrustLevel[] = ["untrusted", "basic", "trusted"];

function fieldClass(
    base: string,
    fieldErrors: Record<string, string> | undefined,
    field: string,
): string {
    if (fieldErrors && fieldErrors[field]) return `${base} error`;
    return base;
}

function valueOrEmpty(v: unknown): string {
    if (v === null || v === undefined) return "";
    return String(v);
}

export const SettingsEditor: FC<SettingsEditorProps> = ({
    settings,
    repositories,
    fieldErrors,
    warnings,
    successMessage,
    serviceError,
    csrfToken,
}) => {
    const fe = fieldErrors ?? {};
    return (
        <form
            id="settings-form"
            class="settings-editor"
            method="post"
            action="/settings"
            hx-post="/settings"
            hx-target="this"
            hx-swap="outerHTML"
        >
            <h1>Settings</h1>

            {csrfToken && csrfToken.length > 0 && (
                <input type="hidden" name="_csrf" value={csrfToken} />
            )}

            {successMessage ? (
                <div
                    class="success-message"
                    role="status"
                    data-kind="success"
                >
                    {successMessage}
                </div>
            ) : null}
            {serviceError ? (
                <div class="service-error" role="alert" data-kind="service">
                    {serviceError}
                </div>
            ) : null}
            {warnings && warnings.length > 0 ? (
                <ul class="warnings" role="status" aria-label="Warnings">
                    {warnings.map((w) => (
                        <li class="warning">{w}</li>
                    ))}
                </ul>
            ) : null}

            <SettingsSection id="cost" title="Cost management">
                <div class="field">
                    <label for="cost-daily">Daily cap (USD)</label>
                    <input
                        type="number"
                        id="cost-daily"
                        name="costCaps.daily"
                        min="0"
                        step="1"
                        value={valueOrEmpty(settings.costCaps?.daily)}
                        class={fieldClass("input", fe, "costCaps.daily")}
                    />
                    <FieldError
                        field="costCaps.daily"
                        message={fe["costCaps.daily"]}
                    />
                </div>
                <div class="field">
                    <label for="cost-monthly">Monthly cap (USD)</label>
                    <input
                        type="number"
                        id="cost-monthly"
                        name="costCaps.monthly"
                        min="0"
                        step="1"
                        value={valueOrEmpty(settings.costCaps?.monthly)}
                        class={fieldClass("input", fe, "costCaps.monthly")}
                    />
                    <FieldError
                        field="costCaps.monthly"
                        message={fe["costCaps.monthly"]}
                    />
                </div>
            </SettingsSection>

            <SettingsSection id="trust" title="Trust levels">
                {repositories.length === 0 ? (
                    <p class="empty">No repositories registered.</p>
                ) : (
                    repositories.map((repo) => {
                        const fieldKey = `trustLevels.${repo.slug}`;
                        const current =
                            settings.trustLevels?.[repo.slug] ?? "untrusted";
                        return (
                            <div class="field">
                                <label for={`trust-${repo.slug}`}>
                                    {repo.name}
                                </label>
                                <select
                                    id={`trust-${repo.slug}`}
                                    name={fieldKey}
                                    class={fieldClass("input", fe, fieldKey)}
                                >
                                    {TRUST_OPTIONS.map((opt) => (
                                        <option
                                            value={opt}
                                            selected={current === opt}
                                        >
                                            {opt}
                                        </option>
                                    ))}
                                </select>
                                <FieldError
                                    field={fieldKey}
                                    message={fe[fieldKey]}
                                />
                            </div>
                        );
                    })
                )}
            </SettingsSection>

            <SettingsSection id="allowlist" title="Repository allowlist">
                <p class="settings-section__description">
                    One git repository path per line.
                </p>
                {(settings.allowlist ?? []).map((p, i) => (
                    <div class="field">
                        <label for={`allowlist-${i}`}>Path {i + 1}</label>
                        <input
                            type="text"
                            id={`allowlist-${i}`}
                            name="allowlist[]"
                            value={p}
                            class={fieldClass(
                                "input",
                                fe,
                                `allowlist[${i}]`,
                            )}
                        />
                        <FieldError
                            field={`allowlist[${i}]`}
                            message={fe[`allowlist[${i}]`]}
                        />
                    </div>
                ))}
                <div class="field">
                    <label for="allowlist-new">Add path</label>
                    <input
                        type="text"
                        id="allowlist-new"
                        name="allowlist[]"
                        value=""
                        class="input"
                    />
                </div>
            </SettingsSection>

            <div class="form-actions">
                <button type="submit" class="btn primary">
                    Save settings
                </button>
            </div>
        </form>
    );
};

// Card / placeholder import keeps the symbol used so tree-shakers don't
// drop the SettingsSection import paths during typecheck-only builds.
export const _ensureCardImportUsed = Card;
