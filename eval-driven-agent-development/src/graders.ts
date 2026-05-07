// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0

/**
 * The eval, declaratively.
 *
 * Each scorecard column is a `Grader` object: a name, a kind (code-grader
 * vs LLM-judge), a one-line description, and a `compute` that turns a
 * prepared GraderContext into one number (or short string) for the table.
 *
 * The harness (grader.ts) builds the context once per deck — parsed pptx,
 * rendered JPGs, memoized judge calls — and runs every check against it.
 * Adding a metric = appending one object to GRADERS.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as fs from "node:fs/promises";
import { z } from "zod";
import type { ParsedPptx } from "./parse-pptx.js";

// ---------------------------------------------------------------- types

/**
 * One column in the scorecard. The harness runs every grader against every
 * task's output and prints the result as a table cell.
 *
 * Adding a metric to the eval = appending one of these to {@link GRADERS}.
 */
export interface Grader {
    /** Column header in the scorecard, e.g. "img%", "jLayout". */
    name: string;
    /** "code" = deterministic, "judge" = model call. Matches intro-deck vocabulary. */
    kind: "code" | "judge";
    /** One-line explanation for the room. */
    description: string;
    /** Compute the metric. String results are printed verbatim; numbers go through `format`. */
    compute(ctx: GraderContext): Promise<number | string>;
    /** Optional display formatter for numeric results (default: String(v)). */
    format?(v: number): string;
}

/**
 * One slide's scores from the aesthetic vision judge — four criteria, each
 * 0-5, plus a free-text comment.
 */
export interface JudgePerSlide {
    index: number;
    text: number;
    image: number;
    layout: number;
    color: number;
    comment: string;
}

/**
 * One slide's title↔body coherence score from the text-only judge: how well
 * the body delivers on what the title promises (0 = unrelated, 5 = squarely
 * on-topic).
 */
export interface CoherencePerSlide {
    index: number;
    title: string;
    body: string;
    coherence: number;
    comment: string;
}

/**
 * Everything a {@link Grader.compute} needs about one task's output. Built
 * once per task by the harness; the expensive parts (rendering, judge calls)
 * are prepared lazily and memoized so multiple graders share them.
 */
export interface GraderContext {
    taskId: string;
    /** Parsed pptx structure: per-slide shapes, text, fonts, title/body. */
    parsed: ParsedPptx;
    /** Rendered per-slide JPG paths (empty if pptx missing/invalid). */
    jpgs: string[];
    client: Anthropic;
    /** Memoized: one vision call per slide → all four aesthetic axes. */
    judgeSlides(): Promise<JudgePerSlide[]>;
    /** Memoized: one text call per slide → title/body coherence 0-5. */
    coherenceSlides(): Promise<CoherencePerSlide[]>;
}

// ------------------------------------------------------- code thresholds

const FONT_FLOOR_PT = 14;
const TEXT_DENSITY_THRESHOLD = 300;
const SHAPE_DENSITY_THRESHOLD = 20;

// ------------------------------------------------------------- the checks

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
type JudgeCriterion = "text" | "image" | "layout" | "color";

function judgeCriterion(name: string, criterion: JudgeCriterion, description: string): Grader {
    return {
        name,
        kind: "judge",
        description,
        format: (v) => v.toFixed(1),
        async compute(ctx) {
            const scored = await ctx.judgeSlides();
            return scored.length > 0 ? avg(scored.map((s) => s[criterion])) : "-";
        },
    };
}

export const GRADERS: Grader[] = [
    {
        name: "exec",
        kind: "code",
        description: "Did the agent produce a valid .pptx at all?",
        async compute(ctx) {
            const p = ctx.parsed;
            return !p.exists ? "MIS" : !p.validZip ? "INV" : "ok";
        },
    },
    {
        name: "slides",
        kind: "code",
        description: "Slide count in the deck.",
        async compute(ctx) {
            return ctx.parsed.slideCount;
        },
    },
    {
        name: "img%",
        kind: "code",
        description: "Share of slides containing at least one picture.",
        format: (v) => `${(v * 100).toFixed(0)}%`,
        async compute(ctx) {
            const s = ctx.parsed.perSlide;
            return s.length > 0 ? s.filter((x) => x.pictureCount > 0).length / s.length : 0;
        },
    },
    {
        name: "dense",
        kind: "code",
        description: `Slides with > ${TEXT_DENSITY_THRESHOLD} text chars (wall-of-text risk).`,
        async compute(ctx) {
            return ctx.parsed.perSlide.filter((s) => s.textChars > TEXT_DENSITY_THRESHOLD).length;
        },
    },
    {
        name: "shapes>20",
        kind: "code",
        description: `Slides with > ${SHAPE_DENSITY_THRESHOLD} shapes (clutter risk).`,
        async compute(ctx) {
            return ctx.parsed.perSlide.filter((s) => s.shapeCount > SHAPE_DENSITY_THRESHOLD).length;
        },
    },
    {
        name: "font<14",
        kind: "code",
        description: `Slides with any font run under ${FONT_FLOOR_PT}pt (readability floor).`,
        async compute(ctx) {
            return ctx.parsed.perSlide.filter(
                (s) => s.fontSizesPt.length > 0 && s.fontSizesPt[0]! < FONT_FLOOR_PT,
            ).length;
        },
    },
    {
        name: "emojis",
        kind: "code",
        description: "Total emoji glyphs across the deck.",
        async compute(ctx) {
            return ctx.parsed.perSlide.reduce((a, s) => a + s.emojiCount, 0);
        },
    },

    judgeCriterion("jText", "text", "Model judge — text quality, mean 0-5."),
    judgeCriterion("jImage", "image", "Model judge — image quality, mean 0-5."),
    judgeCriterion("jLayout", "layout", "Model judge — layout/alignment, mean 0-5."),
    judgeCriterion("jColor", "color", "Model judge — color/contrast, mean 0-5."),

    {
        name: "coherence",
        kind: "judge",
        description: "Does each slide's body deliver on its title? Mean 0-5.",
        format: (v) => v.toFixed(2),
        async compute(ctx) {
            const scored = await ctx.coherenceSlides();
            return scored.length > 0 ? avg(scored.map((s) => s.coherence)) : "-";
        },
    },
];

// --------------------------------------------------- per-slide judge calls
// Exported so the harness can wrap them in memoized GraderContext methods.
// Kept here (not in grader.ts) because the rubric *is* the check.

export const JUDGE_MODEL = "claude-opus-4-7";

const score = z.number().int().min(0).max(5);

export async function judgeSlideImage(
    client: Anthropic,
    index: number,
    jpgPath: string,
): Promise<JudgePerSlide | null> {
    const data = (await fs.readFile(jpgPath)).toString("base64");

    const resp = await client.messages.parse({
        model: JUDGE_MODEL,
        max_tokens: 256,
        system: `Please evaluate the slide based on each of the following criteria:

text: The title should be simple and clear to indicate the main point. For main content, avoid too many texts and keep words concise. Use a consistent and readable font size, style, and color.

image: Use high-quality images with a reasonable proportion. Do not penalize the slide if no image is involved.

layout: Elements should be aligned, do not overlap, and have sufficient margins to each other. All elements should not exceed the page.

color: Use high-contrast color especially between the text and the background. Avoid using high-glaring colors.

For each criterion, give an integer score between 0 and 5 (higher = better). Give scores across the full spectrum (0-5) instead of only good ones (3-5).`,
        output_config: {
            format: zodOutputFormat(
                z.object({
                    text: score,
                    image: score,
                    layout: score,
                    color: score,
                    comment: z.string(),
                }),
            ),
        },
        messages: [
            {
                role: "user",
                content: [
                    { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
                    { type: "text", text: "Score this slide on the four criteria." },
                ],
            },
        ],
    });

    return resp.parsed_output ? { index, ...resp.parsed_output } : null;
}

export async function judgeCoherence(
    client: Anthropic,
    index: number,
    title: string,
    body: string,
): Promise<CoherencePerSlide | null> {
    const resp = await client.messages.parse({
        model: JUDGE_MODEL,
        max_tokens: 256,
        system: `Score 0-5 how well this slide's body content delivers on what its title promises.
0 = title and body are on entirely different topics.
5 = body squarely answers / supports the title.`,
        output_config: {
            format: zodOutputFormat(
                z.object({ coherence: score, comment: z.string() }),
            ),
        },
        messages: [
            {
                role: "user",
                content: `Title: ${title || "(empty)"}\n\nBody:\n${body || "(empty)"}`,
            },
        ],
    });
    return resp.parsed_output ? { index, title, body, ...resp.parsed_output } : null;
}
