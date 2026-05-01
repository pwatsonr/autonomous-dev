// SPEC-013-3-03 §Views — costs view component.

import type { FC } from "hono/jsx";

import type { RenderProps } from "../../types/render";
import { CostChart } from "../fragments/cost-chart";

export const CostsView: FC<RenderProps["costs"]> = ({ series }) => (
    <section class="costs">
        <h1>Cost</h1>
        <CostChart points={series.points} budgetUsd={series.budgetUsd} />
    </section>
);
