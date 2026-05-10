// SPEC-036-3-04 §Deploy pipeline — sibling of pipeline-vis for deploy stages.
//
// Renders only when `request.currentPhase === "deploy"`. Mirrors the
// pipeline-vis pattern (horizontal flex strip; `done` / `now` / `pending`
// states) keyed off the request's `deployStage`. Reuses the `pipe-step`
// styling token namespace so theme changes flow through from one place.

import type { FC } from "hono/jsx";

const DEPLOY_STAGES: string[] = [
    "preflight",
    "build",
    "push",
    "deploy",
    "health-check",
    "observe",
];

interface Props {
    deployStage: string;
    deployTarget?: string;
}

export const DeployPipeline: FC<Props> = ({ deployStage, deployTarget }) => {
    const cur = Math.max(0, DEPLOY_STAGES.indexOf(deployStage));
    return (
        <section class="sec deploy-pipeline-section">
            <div class="sec-head">
                <h2>Deploy{deployTarget ? ` · ${deployTarget}` : ""}</h2>
                <span class="meta-mono dim">stage: {deployStage}</span>
            </div>
            <div class="deploy-pipe">
                {DEPLOY_STAGES.map((stage, i) => {
                    const state =
                        i < cur
                            ? "done"
                            : i === cur
                              ? "now"
                              : "pending";
                    return (
                        <div
                            class={`deploy-step ${state}`}
                            data-stage={stage}
                            data-state={state}
                        >
                            <span class="deploy-name">{stage}</span>
                            <span class="deploy-state meta-mono">{state}</span>
                        </div>
                    );
                })}
            </div>
        </section>
    );
};
