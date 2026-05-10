// SPEC-013-3-03 §Views — costs view component.
// SPEC-034-2-05 — voice/copy sweep: heading already sentence case;
// cost values rendered by `formatUsd` which uses `.toFixed(2)`.

import type { FC } from "hono/jsx";

import type { RenderProps } from "../../types/render";
import { CostChart } from "../fragments/cost-chart";

export const CostsView: FC<RenderProps["costs"]> = ({ series }) => (
    <section class="costs">
        <h1>Cost</h1>
        <CostChart points={series.points} budgetUsd={series.budgetUsd} />
    </section>
);
