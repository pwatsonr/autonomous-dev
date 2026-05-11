// SPEC-037-5-05 §Standards rule Edit modal + PUT route.
//
// Two endpoints back the Standards tab Edit modal:
//
//   GET /api/standards/:id/edit  → returns the Modal fragment with the
//                                  rule's description / severity /
//                                  applies predicate pre-populated.
//                                  Immutable rules render disabled
//                                  fields and the footer collapses to a
//                                  single Cancel button.
//   PUT /api/standards/:id       → form-encoded update; 403 when the
//                                  rule is immutable, 200 with the
//                                  re-rendered Standards table fragment
//                                  otherwise.
//
// The new rule modal (GET /api/standards/new) is a thin shell for the
// `+ Rule` button in the Standards sec-head; it reuses the Modal helper
// with empty defaults.

import { Hono } from "hono";

import type { StandardRule } from "../types/render";
import { loadSettingsData } from "../stubs/settings";
import { Modal } from "../templates/fragments/modal";
import { StandardsPanel } from "../templates/fragments/settings-standards";

const SEVERITIES: Array<StandardRule["severity"]> = [
    "blocking",
    "warn",
    "advisory",
];

export interface StandardsStore {
    /** Look up the rule by id, or `null` when not present. */
    get(id: string): Promise<StandardRule | null>;
    /** Persist a partial update; throws on validation failure. */
    update(
        id: string,
        patch: Partial<Pick<StandardRule, "desc" | "severity" | "applies">>,
    ): Promise<StandardRule[]>;
}

export interface StandardsActionDeps {
    store: StandardsStore;
}

interface EditFormProps {
    rule: StandardRule | null;
    immutable: boolean;
    creating: boolean;
}

function EditForm(props: EditFormProps): JSX.Element {
    const { rule, immutable, creating } = props;
    const id = rule?.id ?? "";
    const desc = rule?.desc ?? "";
    const applies = rule?.applies ?? "*";
    const severity = rule?.severity ?? "warn";
    const disabledAttr = immutable ? { disabled: true } : {};
    return (
        <div class="form-grid">
            <label class="field">
                <span>Description</span>
                <input
                    type="text"
                    class="input"
                    name="description"
                    value={desc}
                    {...disabledAttr}
                />
            </label>
            <label class="field">
                <span>Severity</span>
                <select
                    class="input"
                    name="severity"
                    {...disabledAttr}
                >
                    {SEVERITIES.map((s) => (
                        <option value={s} selected={severity === s}>
                            {s}
                        </option>
                    ))}
                </select>
            </label>
            <label class="field">
                <span>Applies (predicate)</span>
                <input
                    type="text"
                    class="input meta-mono"
                    name="applies"
                    value={applies}
                    {...disabledAttr}
                />
            </label>
            {immutable ? (
                <div class="dim small mt8">
                    🔒 This rule is org-immutable; only org admins can
                    edit.
                </div>
            ) : null}
            <input type="hidden" name="id" value={id} />
            <input
                type="hidden"
                name="_creating"
                value={creating ? "1" : "0"}
            />
        </div>
    );
}

function editFooter(rule: StandardRule | null): JSX.Element {
    if (rule && rule.immutable) {
        return (
            <>
                <button type="button" class="btn sm" data-modal-close>
                    Cancel
                </button>
            </>
        );
    }
    const id = rule?.id ?? "new";
    const target = rule ? `/api/standards/${id}` : "/api/standards";
    const method = rule ? "hx-put" : "hx-post";
    return (
        <>
            <button type="button" class="btn sm" data-modal-close>
                Cancel
            </button>
            <button
                type="button"
                class="btn sm primary"
                {...{ [method]: target }}
                hx-include="closest .modal"
                hx-target="#settings-root"
                hx-swap="outerHTML"
            >
                Save
            </button>
        </>
    );
}

/** Lookup helper using the canonical stub data when no store is supplied. */
async function defaultGet(id: string): Promise<StandardRule | null> {
    const data = await loadSettingsData();
    const rule = data.standards.find((r) => r.id === id);
    return rule ?? null;
}

/** Default in-process update — replaces the matching rule in the stub. */
async function defaultUpdate(
    id: string,
    patch: Partial<Pick<StandardRule, "desc" | "severity" | "applies">>,
): Promise<StandardRule[]> {
    const data = await loadSettingsData();
    const next = data.standards.map((r) =>
        r.id === id ? { ...r, ...patch } : r,
    );
    return next;
}

export function buildStandardsActionRoutes(
    deps?: StandardsActionDeps,
): Hono {
    const router = new Hono();
    const get = deps?.store.get ?? defaultGet;
    const update = deps?.store.update ?? defaultUpdate;

    router.get("/api/standards/new", (c) => {
        const body = (
            <EditForm rule={null} immutable={false} creating={true} />
        );
        const node = (
            <Modal
                title="New standard"
                eyebrow="STANDARDS / NEW"
                body={body}
                footer={editFooter(null)}
                wide
            />
        );
        return c.html(node);
    });

    router.get("/api/standards/:id/edit", async (c) => {
        const id = c.req.param("id");
        const rule = await get(id);
        if (!rule) {
            return c.html(
                <Modal
                    title={`Standard / ${id}`}
                    body={<p class="dim">Not found.</p>}
                    footer={
                        <button
                            type="button"
                            class="btn sm"
                            data-modal-close
                        >
                            Close
                        </button>
                    }
                />,
                404,
            );
        }
        const body = (
            <EditForm
                rule={rule}
                immutable={rule.immutable === true}
                creating={false}
            />
        );
        const node = (
            <Modal
                title={`Standard / ${rule.id}`}
                eyebrow={`STANDARDS / ${rule.severity.toUpperCase()}`}
                body={body}
                footer={editFooter(rule)}
                wide
            />
        );
        return c.html(node);
    });

    router.put("/api/standards/:id", async (c) => {
        const id = c.req.param("id");
        const rule = await get(id);
        if (!rule) return c.json({ error: "not-found" }, 404);
        if (rule.immutable === true) {
            return c.json({ error: "immutable" }, 403);
        }
        let form: Record<string, unknown> = {};
        try {
            form = (await c.req.parseBody()) as Record<string, unknown>;
        } catch {
            return c.json({ error: "invalid-body" }, 400);
        }
        const patch: Partial<
            Pick<StandardRule, "desc" | "severity" | "applies">
        > = {};
        if (typeof form.description === "string") {
            patch.desc = form.description;
        }
        if (typeof form.severity === "string") {
            const sev = form.severity as StandardRule["severity"];
            if (SEVERITIES.includes(sev)) patch.severity = sev;
        }
        if (typeof form.applies === "string") {
            patch.applies = form.applies;
        }
        const updated = await update(id, patch);
        const data = await loadSettingsData();
        data.standards = updated;
        // Return the StandardsPanel fragment so HTMX can re-skin the
        // panel without a full page reload.
        return c.html(<StandardsPanel data={data} />);
    });

    return router;
}
