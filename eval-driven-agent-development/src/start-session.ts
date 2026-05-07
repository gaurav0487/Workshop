// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0

/**
 * Starts a session against the slide-generation agent for one task (or --all)
 * and downloads the produced .pptx into runs/<task-id>/.
 */

import Anthropic from "@anthropic-ai/sdk";
import path from "node:path";
import { parseArgs } from "node:util";
import { RUNS_DIR, type Task, downloadAll, listOutputs, tasks } from "./lib.js";

// Paste the IDs returned by `ant beta:environments create` /
// `ant beta:agents create` here. The underlying definitions live in
// resources/*.yaml; iterate via `ant beta:agents update < file.yaml`.
const ENVIRONMENT_ID = "";
const AGENT_ID = "";
const WORKSPACE_ID = "default";

async function runTask(
    client: Anthropic,
    task: Task,
    verbose: boolean,
): Promise<string | null> {
    const log = (msg: string) => console.log(`[${task.id}] ${msg}`);

    if (verbose) {
        console.log(`\n=== ${task.id} ===`);
        console.log(`prompt: ${task.prompt}`);
    }

    const session = await client.beta.sessions.create({
        agent: { type: "agent", id: AGENT_ID },
        environment_id: ENVIRONMENT_ID,
        title: `workshop-${task.id}`,
    });
    const consoleUrl = `https://platform.claude.com/workspaces/${WORKSPACE_ID}/sessions/${session.id}`;
    if (verbose) {
        console.log(`session: ${session.id}`);
        console.log(`console: ${consoleUrl}`);
    } else {
        log(`started ${session.id} → ${consoleUrl}`);
    }

    const stream = await client.beta.sessions.events.stream(session.id);
    await client.beta.sessions.events.send(session.id, {
        events: [
            {
                type: "user.message",
                content: [{ type: "text", text: task.prompt }],
            },
        ],
    });

    streamLoop: for await (const event of stream) {
        switch (event.type) {
            case "agent.message":
                if (!verbose) break;
                for (const block of event.content) {
                    if (block.type === "text") process.stdout.write(block.text);
                }
                break;
            case "agent.tool_use":
                if (verbose) process.stdout.write(`\n[tool] ${event.name}\n`);
                break;
            case "session.status_idle":
                // requires_action = transient idle waiting on tool confirmation; keep streaming.
                if (event.stop_reason.type === "requires_action") break;
                if (verbose) {
                    console.log(`\n--- done (${event.stop_reason.type}) ---`);
                }
                break streamLoop;
            case "session.status_terminated":
                (verbose ? console.log : log)("terminated");
                return null;
        }
    }

    const files = await listOutputs(client, session.id, (fs) =>
        fs.some((f) => f.filename.endsWith(".pptx")),
    );
    if (files.length === 0) {
        (verbose ? console.log : log)("no output files indexed");
        return null;
    }

    const saved = await downloadAll(
        client,
        files,
        path.join(RUNS_DIR, task.id),
    );
    const pptx = saved.find((p) => p.endsWith(".pptx")) ?? null;
    if (!verbose)
        log(
            pptx
                ? `done → ${path.relative(process.cwd(), pptx)}`
                : "done (no pptx)",
        );
    return pptx;
}

const { values, positionals } = parseArgs({
    options: { all: { type: "boolean" } },
    allowPositionals: true,
});

const available = tasks.map((t) => t.id).join(", ");
let selected: Task[];
if (values.all) {
    selected = tasks;
} else {
    const found = positionals[0]
        ? tasks.find((t) => t.id === positionals[0])
        : undefined;
    if (!found) {
        console.error(
            positionals[0]
                ? `unknown task: ${positionals[0]}\navailable: ${available}`
                : `usage: tsx src/start-session.ts <task_id> | --all\navailable: ${available}`,
        );
        process.exit(1);
    }
    selected = [found];
}

const client = new Anthropic();
if (values.all) {
    // Tasks are independent CMA sessions; run them concurrently. Per-task
    // streaming is suppressed so output stays readable — one start line
    // and one done line each.
    await Promise.all(selected.map((task) => runTask(client, task, false)));
} else {
    await runTask(client, selected[0]!, true);
}
