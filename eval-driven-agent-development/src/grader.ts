// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0

/**
 * Grader harness.
 *
 * For each task: build a GraderContext (parse the .pptx, render JPGs,
 * wire up memoized judge calls), run every check in GRADERS against it,
 * write runs/<task>/score.json, and print the scorecard table.
 *
 * The metrics themselves live in graders.ts — this file is just the runner.
 */

import Anthropic from "@anthropic-ai/sdk";
import * as fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
    GRADERS,
    judgeCoherence,
    judgeSlideImage,
    type CoherencePerSlide,
    type Grader,
    type GraderContext,
    type JudgePerSlide,
} from "./graders.js";
import { RUNS_DIR, tasks, type Task } from "./lib.js";
import { parsePptx } from "./parse-pptx.js";
import { renderPptx } from "./render.js";

/** One row of the scorecard — a task id and its value for every grader. */
interface TaskResult {
    taskId: string;
    /** Parallel to {@link GRADERS} — `values[i]` is the result of `GRADERS[i]`. */
    values: (number | string)[];
    ctx: GraderContext;
}

async function buildContext(client: Anthropic, task: Task): Promise<GraderContext> {
    const taskDir = path.join(RUNS_DIR, task.id);
    const pptxPath = path.join(taskDir, "output.pptx");

    const parsed = await parsePptx(pptxPath);

    let jpgs: string[] = [];
    if (parsed.exists && parsed.validZip) {
        const renderDir = path.join(taskDir, "render");
        // Always re-render — a stale render/ from a previous output.pptx would
        // mean the judge scores the old deck.
        await fs.rm(renderDir, { recursive: true, force: true });
        console.log("rendering...");
        jpgs = await renderPptx(pptxPath, renderDir);
    }

    // Memoized judge passes — many checks read these, but the model calls
    // happen at most once per deck.
    let judgeCache: Promise<JudgePerSlide[]> | undefined;
    let coherenceCache: Promise<CoherencePerSlide[]> | undefined;

    const judgeSlides = () =>
        (judgeCache ??= Promise.all(
            jpgs.map((jpg, i) => judgeSlideImage(client, i + 1, jpg)),
        ).then((rs) =>
            rs.filter((r): r is JudgePerSlide => {
                if (r === null) console.warn(`  ${task.id}: judge returned no tool call`);
                return r !== null;
            }),
        ));

    const coherenceSlides = () =>
        (coherenceCache ??= Promise.all(
            (parsed.validZip ? parsed.slideTexts : []).map((st) =>
                judgeCoherence(client, st.index, st.title, st.body),
            ),
        ).then((rs) =>
            rs.filter((r): r is CoherencePerSlide => {
                if (r === null) console.warn(`  ${task.id}: coherence judge returned no tool call`);
                return r !== null;
            }),
        ));

    return { taskId: task.id, parsed, jpgs, client, judgeSlides, coherenceSlides };
}

async function gradeTask(client: Anthropic, task: Task): Promise<TaskResult> {
    console.log(`\n=== grading ${task.id} ===`);
    const taskDir = path.join(RUNS_DIR, task.id);
    const ctx = await buildContext(client, task);

    const values = await Promise.all(GRADERS.map((c) => c.compute(ctx)));

    // Per-slide detail (judge caches are already populated by the checks above).
    const score = {
        taskId: task.id,
        checks: Object.fromEntries(GRADERS.map((c, i) => [c.name, values[i]])),
        perSlide: ctx.parsed.perSlide,
        slideTexts: ctx.parsed.slideTexts,
        judgePerSlide: await ctx.judgeSlides(),
        coherencePerSlide: await ctx.coherenceSlides(),
    };
    await fs.writeFile(path.join(taskDir, "score.json"), JSON.stringify(score, null, 2));

    return { taskId: task.id, values, ctx };
}

function display(check: Grader, v: number | string): string {
    if (typeof v === "string") return v;
    return check.format ? check.format(v) : String(v);
}

function summarize(results: TaskResult[]): string {
    const cells = results.map((r) => GRADERS.map((c, i) => display(c, r.values[i]!)));
    const widths = GRADERS.map((c, i) =>
        Math.max(c.name.length, ...cells.map((row) => row[i]!.length)),
    );

    const lines: string[] = ["", "=== scorecard ==="];
    lines.push(
        ["task".padEnd(16), ...GRADERS.map((c, i) => c.name.padStart(widths[i]!))].join(" | "),
    );
    lines.push(["-".repeat(16), ...widths.map((w) => "-".repeat(w))].join("-+-"));
    for (let r = 0; r < results.length; r++) {
        // Row must start with `${taskId} ` — batch shell loops grep for that.
        lines.push(
            [
                results[r]!.taskId.padEnd(16),
                ...cells[r]!.map((v, i) => v.padStart(widths[i]!)),
            ].join(" | "),
        );
    }

    // Aggregate every judge-kind check across tasks.
    const judgeAvgs = GRADERS.flatMap((c, i) => {
        if (c.kind !== "judge") return [];
        const nums = results.map((r) => r.values[i]).filter((v): v is number => typeof v === "number");
        if (nums.length === 0) return [];
        return [`${c.name}=${(nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2)}`];
    });
    if (judgeAvgs.length > 0) {
        lines.push("");
        lines.push(`overall judge avg: ${judgeAvgs.join(" ")}`);
    }
    return lines.join("\n");
}

// ------------------------------------------------------------------- CLI

const { values, positionals } = parseArgs({
    options: { all: { type: "boolean" } },
    allowPositionals: true,
});

const available = tasks.map((t) => t.id).join(", ");
let selected: Task[];
if (values.all) {
    selected = tasks;
} else {
    const found = positionals[0] ? tasks.find((t) => t.id === positionals[0]) : undefined;
    if (!found) {
        console.error(
            positionals[0]
                ? `unknown task: ${positionals[0]}\navailable: ${available}`
                : `usage: tsx grader.ts <task_id> | --all\navailable: ${available}`,
        );
        process.exit(1);
    }
    selected = [found];
}

const client = new Anthropic();
// Render + judge per task is independent — fan out across tasks. Each
// task spawns its own render and parallel judge calls; total wall time
// is roughly max(per-task), not sum.
const results = await Promise.all(selected.map((task) => gradeTask(client, task)));
console.log(summarize(results));
