// SPEC-036-2-04 §FR-4 — plugin-chain visualization.
//
// Renders 5 columns (CORE → REVIEWERS → VARIANTS → DEPLOY → ORG)
// joined by `›` arrow separators. The column header is rendered even
// when `packages: []` so an empty category does not collapse the layout.

import type { FC } from "hono/jsx";

import type { PluginChainCategory } from "../../types/render";

export interface PluginChainProps {
    categories: PluginChainCategory[];
}

export const PluginChain: FC<PluginChainProps> = ({ categories }) => (
    <div class="plugin-chain">
        {categories.map((c, i) => (
            <>
                {i > 0 && <div class="chain-arrow">›</div>}
                <div class="chain-col">
                    <div class="chain-head">{c.name}</div>
                    {c.packages.length === 0 ? (
                        <div class="chain-pkg empty meta-mono dim">—</div>
                    ) : (
                        c.packages.map((pkg) => (
                            <div
                                class={
                                    c.accent
                                        ? `chain-pkg ${c.accent}`
                                        : "chain-pkg"
                                }
                            >
                                {pkg}
                            </div>
                        ))
                    )}
                </div>
            </>
        ))}
    </div>
);
