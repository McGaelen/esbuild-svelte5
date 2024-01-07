import { test } from "uvu";
import * as assert from "uvu/assert";
import { build as _build } from "esbuild";
import sveltePlugin from "../dist/index.mjs";
import commonOptions from "./commonOptions.js";

test("Svelte 5", async () => {
    //Try a simple esbuild build
    const results = await _build({
        ...commonOptions,
        entryPoints: ["./example-js-svelte5/entry.js"],
        outdir: "./example-js-svelte5/dist",
        plugins: [
            sveltePlugin({
                moduleCompileOptions: {
                    dev: true,
                    generate: "client",
                },
            }),
        ],
    });

    assert.equal(results.errors.length, 0, "Non-zero number of errors");
    assert.equal(results.warnings.length, 0, "Non-zero number of warnings");
    assert.equal(results.outputFiles.length, 2, "Non-expected number of output files");
});

test.run();
