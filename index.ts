//original version from https://github.com/evanw/esbuild/blob/plugins/docs/plugin-examples.md
import { preprocess, compile, compileModule, VERSION, ModuleCompileOptions } from "svelte/compiler";
import { dirname, basename, relative } from "path";
import { promisify } from "util";
import { readFile, statSync } from "fs";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";

import type { CompileOptions, Warning } from "svelte/compiler";
import type { PreprocessorGroup } from "svelte/types/compiler/preprocess";
import type { OnLoadResult, Plugin, PluginBuild, Location, PartialMessage } from "esbuild";

interface esbuildSvelteOptions {
    /**
     * Svelte compiler options
     */
    compilerOptions?: CompileOptions;

    /**
     * Svelte module compiler options
     */
    moduleCompileOptions?: ModuleCompileOptions;

    /**
     * The preprocessor(s) to run the Svelte code through before compiling
     */
    preprocess?: PreprocessorGroup | PreprocessorGroup[];

    /**
     * Attempts to cache compiled files if the mtime of the file hasn't changed since last run.
     * Only works with incremental or watch mode builds
     *
     * "overzealous" - be agressive about which files trigger a cache expiration
     */
    cache?: boolean | "overzealous";

    /**
     * Should esbuild-svelte create a binding to an html element for components given in the entryPoints list
     * Defaults to `false` for now until support is added
     */
    fromEntryFile?: boolean;

    /**
     * The regex filter to use when filtering files to compile
     * Defaults to `/\.svelte$/`
     */
    include?: RegExp;

    /**
     * A function to filter out warnings
     * Defaults to a constant function that returns `true`
     */
    filterWarnings?: (warning: Warning) => boolean;
}

interface CacheData {
    data: OnLoadResult;
    // path, last modified time
    dependencies: Map<string, Date>;
}

async function convertMessage(
    { message, start, end }: Warning,
    filename: string,
    source: string,
    sourcemap: any,
): Promise<PartialMessage> {
    let location: Partial<Location> | undefined;
    if (start && end) {
        let lineText = source.split(/\r\n|\r|\n/g)[start.line - 1];
        let lineEnd = start.line === end.line ? end.column : lineText.length;

        // Adjust the start and end positions based on what the preprocessors did so the positions are correct
        if (sourcemap) {
            sourcemap = new TraceMap(sourcemap);
            const pos = originalPositionFor(sourcemap, {
                line: start.line,
                column: start.column,
            });
            if (pos.source) {
                start.line = pos.line ?? start.line;
                start.column = pos.column ?? start.column;
            }
        }

        location = {
            file: filename,
            line: start.line,
            column: start.column,
            length: lineEnd - start.column,
            lineText,
        };
    }
    return { text: message, location };
}

//still support old incremental option if possible, but can still be overriden by cache option
const shouldCache = (
    build: PluginBuild & {
        initialOptions: {
            incremental?: boolean;
            watch?: boolean;
        };
    },
) => build.initialOptions?.incremental || build.initialOptions?.watch;

// TODO: Hot fix to replace broken e64enc function in svelte on node 16
const b64enc = Buffer
    ? (b: string) => Buffer.from(b).toString("base64")
    : (b: string) => btoa(encodeURIComponent(b));

function toUrl(data: string) {
    return "data:application/json;charset=utf-8;base64," + b64enc(data);
}

function getContents(js: { code: string; map: import("magic-string").SourceMap }): string {
    return js.code + `\n//# sourceMappingURL=` + toUrl(js.map.toString());
}

const SVELTE_FILTER = /\.svelte|\.js$/;
const FAKE_CSS_FILTER = /\.esbuild-svelte-fake-css$/;

export default function sveltePlugin(options?: esbuildSvelteOptions): Plugin {
    const svelteFilter = options?.include ?? SVELTE_FILTER;
    const svelteVersion = VERSION.split(".").map((v) => parseInt(v))[0];
    return {
        name: "esbuild-svelte",
        setup(build) {
            if (!options) {
                options = {};
            }
            // see if we are incrementally building or watching for changes and enable the cache
            // also checks if it has already been defined and ignores this if it has
            if (options.cache == undefined && shouldCache(build)) {
                options.cache = true;
            }

            // disable entry file generation by default
            if (options.fromEntryFile == undefined) {
                options.fromEntryFile = false;
            }

            // by default all warnings are enabled
            if (options.filterWarnings == undefined) {
                options.filterWarnings = () => true;
            }

            //Store generated css code for use in fake import
            const cssCode = new Map<string, string>();
            const fileCache = new Map<string, CacheData>();

            //check and see if trying to load svelte files directly
            build.onResolve({ filter: svelteFilter }, ({ path, kind }) => {
                if (kind === "entry-point" && options?.fromEntryFile) {
                    return { path, namespace: "esbuild-svelte-direct-import" };
                }
            });

            //main loader
            build.onLoad(
                { filter: svelteFilter, namespace: "esbuild-svelte-direct-import" },
                async (args) => {
                    return {
                        errors: [
                            {
                                text: "esbuild-svelte does not support creating entry files yet",
                            },
                        ],
                    };
                },
            );

            //main loader
            build.onLoad({ filter: svelteFilter }, async (args) => {
                let cachedFile = null;
                let previousWatchFiles: string[] = [];

                // if told to use the cache, check if it contains the file,
                // and if the modified time is not greater than the time when it was cached
                // if so, return the cached data
                if (options?.cache === true && fileCache.has(args.path)) {
                    cachedFile = fileCache.get(args.path) || {
                        dependencies: new Map(),
                        data: null,
                    }; // should never hit the null b/c of has check
                    let cacheValid = true;

                    //for each dependency check if the mtime is still valid
                    //if an exception is generated (file was deleted or something) then cache isn't valid
                    try {
                        cachedFile.dependencies.forEach((time, path) => {
                            if (statSync(path).mtime > time) {
                                cacheValid = false;
                            }
                        });
                    } catch {
                        cacheValid = false;
                    }

                    if (cacheValid) {
                        return cachedFile.data;
                    } else {
                        fileCache.delete(args.path); //can remove from cache if no longer valid
                    }
                }

                //reading files
                let originalSource = await promisify(readFile)(args.path, "utf8");
                let filename = relative(process.cwd(), args.path);
                let isJs = filename.endsWith(".js");

                //file modification time storage
                const dependencyModifcationTimes = new Map<string, Date>();
                dependencyModifcationTimes.set(args.path, statSync(args.path).mtime); // add the target file

                let result: OnLoadResult = {};
                let source = originalSource;

                //actually compile file
                if (isJs) {
                    if (args.path.includes("node_modules")) {
                        return {};
                    }
                    console.log(args.path);
                    let moduleCompileOptions: ModuleCompileOptions = {
                        ...options?.moduleCompileOptions,
                        filename,
                    };
                    // console.log('doing module stuff', {...options?.moduleCompileOptions, filename })

                    try {
                        const { js, warnings } = compileModule(source, moduleCompileOptions);
                        result = {
                            contents: getContents(js),
                            warnings: await Promise.all(
                                warnings.map(
                                    async (e) => await convertMessage(e, args.path, source, null),
                                ),
                            ),
                        };
                    } catch (e: any) {
                        result.errors = [await convertMessage(e, args.path, originalSource, null)];
                        // only provide if context API is supported or we are caching
                        if (build.esbuild?.context !== undefined || shouldCache(build)) {
                            result.watchFiles = previousWatchFiles;
                        }
                    }
                } else {
                    let compilerOptions: CompileOptions = {
                        css: "external",
                        ...options?.compilerOptions,
                    };
                    try {
                        //do preprocessor stuff if it exists
                        if (options?.preprocess) {
                            let preprocessResult = null;

                            try {
                                preprocessResult = await preprocess(
                                    originalSource,
                                    options.preprocess,
                                    {
                                        filename,
                                    },
                                );
                            } catch (e: any) {
                                // if preprocess failed there are chances that an external dependency caused exception
                                // to avoid stop watching those files, we keep the previous dependencies if available
                                if (cachedFile) {
                                    previousWatchFiles = Array.from(cachedFile.dependencies.keys());
                                }
                                throw e;
                            }

                            if (preprocessResult.map) {
                                // normalize the sourcemap 'source' entrys to all match if they are the same file
                                // needed because of differing handling of file names in preprocessors
                                let fixedMap = preprocessResult.map as { sources: Array<string> };
                                for (let index = 0; index < fixedMap?.sources.length; index++) {
                                    if (fixedMap.sources[index] == filename) {
                                        fixedMap.sources[index] = basename(filename);
                                    }
                                }
                                compilerOptions.sourcemap = fixedMap;
                            }
                            source = preprocessResult.code;

                            // if caching then we need to store the modifcation times for all dependencies
                            if (options?.cache === true) {
                                preprocessResult.dependencies?.forEach((entry) => {
                                    dependencyModifcationTimes.set(entry, statSync(entry).mtime);
                                });
                            }
                        }

                        let { js, css, warnings } = compile(source, {
                            ...compilerOptions,
                            filename,
                        });

                        //esbuild doesn't seem to like sourcemaps without "sourcesContent" which Svelte doesn't provide
                        //so attempt to populate that array if we can find filename in sources
                        if (compilerOptions.sourcemap) {
                            if (js.map.sourcesContent == undefined) {
                                js.map.sourcesContent = [];
                            }

                            for (let index = 0; index < js.map.sources.length; index++) {
                                const element = js.map.sources[index];
                                if (element == basename(filename)) {
                                    js.map.sourcesContent[index] = originalSource;
                                    index = Infinity; //can break out of loop
                                }
                            }
                        }

                        let contents = getContents(js);

                        //if svelte emits css seperately, then store it in a map and import it from the js
                        if (compilerOptions.css === "external" && css?.code) {
                            let cssPath = args.path
                                .replace(".svelte", ".esbuild-svelte-fake-css") //TODO append instead of replace to support different svelte filters
                                .replace(/\\/g, "/");
                            cssCode.set(
                                cssPath,
                                css.code + `/*# sourceMappingURL=${toUrl(css.map.toString())} */`,
                            );
                            contents = contents + `\nimport "${cssPath}";`;
                        }

                        if (options?.filterWarnings) {
                            warnings = warnings.filter(options.filterWarnings);
                        }

                        result = {
                            contents,
                            warnings: await Promise.all(
                                warnings.map(
                                    async (e) =>
                                        await convertMessage(
                                            e,
                                            args.path,
                                            source,
                                            compilerOptions.sourcemap,
                                        ),
                                ),
                            ),
                        };

                        // if we are told to cache, then cache
                        if (options?.cache === true) {
                            fileCache.set(args.path, {
                                data: result,
                                dependencies: dependencyModifcationTimes,
                            });
                        }

                        // make sure to tell esbuild to watch any additional files used if supported
                        // only provide if context API is supported or we are caching
                        if (build.esbuild?.context !== undefined || shouldCache(build)) {
                            result.watchFiles = Array.from(dependencyModifcationTimes.keys());
                        }

                        // return result;
                    } catch (e: any) {
                        result.errors = [
                            await convertMessage(
                                e,
                                args.path,
                                originalSource,
                                compilerOptions.sourcemap,
                            ),
                        ];
                        // only provide if context API is supported or we are caching
                        if (build.esbuild?.context !== undefined || shouldCache(build)) {
                            result.watchFiles = previousWatchFiles;
                        }
                    }
                }

                return result;
            });

            //if the css exists in our map, then output it with the css loader
            build.onResolve({ filter: FAKE_CSS_FILTER }, ({ path }) => {
                return { path, namespace: "fakecss" };
            });

            build.onLoad({ filter: FAKE_CSS_FILTER, namespace: "fakecss" }, ({ path }) => {
                const css = cssCode.get(path);
                return css ? { contents: css, loader: "css", resolveDir: dirname(path) } : null;
            });

            // code in this section can use esbuild features >= 0.11.15 because of `onEnd` check
            // this enables the cache at the end of the build. The cache is disabled by default,
            // but if this plugin instance is used agian, then the cache will be enabled (because
            // we can be confident that the build is incremental or watch).
            // This saves enabling caching on every build, which would be a performance hit but
            // also makes sure incremental performance is increased.
            if (typeof build.onEnd === "function") {
                build.onEnd(() => {
                    if (!options) {
                        options = {};
                    }
                    if (options.cache === undefined) {
                        options.cache = true;
                    }
                });
            }

            // code in this section can use esbuild features >= 0.11.15 because of `onEnd` check
            // TODO long term overzealous should be deprecated and removed (technically it doesn't work beyond the 0.17.0 context API changes)
            if (
                shouldCache(build) &&
                options?.cache == "overzealous" &&
                typeof build.onEnd === "function"
            ) {
                build.initialOptions.metafile = true; // enable the metafile to get the required information

                build.onEnd((result) => {
                    for (let fileName in result.metafile?.inputs) {
                        if (SVELTE_FILTER.test(fileName)) {
                            // only run on svelte files
                            let file = result.metafile?.inputs[fileName];
                            file?.imports?.forEach((i) => {
                                // for each import from a svelte file
                                // if import is a svelte file then we make note of it
                                if (SVELTE_FILTER.test(i.path)) {
                                    // update file cache with the new dependency
                                    let fileCacheEntry = fileCache.get(fileName);
                                    if (fileCacheEntry != undefined) {
                                        fileCacheEntry?.dependencies.set(
                                            i.path,
                                            statSync(i.path).mtime,
                                        );
                                        fileCache.set(fileName, fileCacheEntry);
                                    }
                                }
                            });
                        }
                    }
                });
            }
        },
    };
}
