// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0

import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pRetry from "p-retry";
import type Anthropic from "@anthropic-ai/sdk";
import type {
    FileListParams,
    FileMetadata,
} from "@anthropic-ai/sdk/resources/beta";
import tasksJson from "../tasks.json" with { type: "json" };

export const ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
);
export const RUNS_DIR = path.join(ROOT, "runs");

/**
 * One scenario in the eval's test set — a short id and the one-line prompt
 * sent to the agent. Loaded from `tasks.json`.
 */
export interface Task {
    id: string;
    prompt: string;
}

export const tasks: Task[] = tasksJson;

// Call only after the stream has reported the session is truly done.
// Retries the list call with exponential backoff until `ready(files)` returns
// true (default: at least one file). Returns [] if `ready` is never satisfied.
//
// Why a predicate: the Files API indexes session outputs in stages — the input
// (uploaded resource) often appears before the agent's outputs do. A naive
// "wait until non-empty" returns prematurely with just the input file. Each
// caller knows what it actually expects (a .pptx, ≥1 jpg, etc.).
export async function listOutputs(
    client: Anthropic,
    sessionId: string,
    ready: (files: FileMetadata[]) => boolean = (files) => files.length > 0,
): Promise<FileMetadata[]> {
    const params: FileListParams = {
        scope_id: sessionId,
        betas: ["managed-agents-2026-04-01"],
    };
    try {
        return await pRetry(
            async () => {
                const { data } = await client.beta.files.list(params);
                if (!ready(data)) throw new Error("not ready");
                return data;
            },
            { retries: 10, minTimeout: 1000, factor: 2, maxTimeout: 10000 },
        );
    } catch {
        return [];
    }
}

export async function downloadAll(
    client: Anthropic,
    files: FileMetadata[],
    outDir: string,
): Promise<string[]> {
    await fs.mkdir(outDir, { recursive: true });
    return Promise.all(
        files.map(async (f) => {
            const local = path.join(outDir, path.basename(f.filename));
            const resp = await client.beta.files.download(f.id);
            await fs.writeFile(local, Buffer.from(await resp.arrayBuffer()));
            console.log(`saved: ${local}`);
            return local;
        }),
    );
}
