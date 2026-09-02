import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const isWatching = !!process.env.ROLLUP_WATCH;
const sdPlugin = "com.morgan-scruggs.volume-control-multi-dials.sdPlugin";

// Native modules ship a compiled .node binary and can't be bundled by rollup; keep them external
// and copy the package into the plugin's own node_modules so `require`/`import` can find it at runtime.
const nativeModules = ["node-audio-volume-mixer"];

/**
 * @type {import('rollup').RollupOptions}
 */
const config = {
	input: "src/plugin.ts",
	external: nativeModules,
	output: {
		file: `${sdPlugin}/bin/plugin.js`,
		sourcemap: isWatching,
		sourcemapPathTransform: (relativeSourcePath, sourcemapPath) => {
			return url.pathToFileURL(path.resolve(path.dirname(sourcemapPath), relativeSourcePath)).href;
		}
	},
	plugins: [
		{
			name: "watch-externals",
			buildStart: function () {
				this.addWatchFile(`${sdPlugin}/manifest.json`);
			},
		},
		{
			name: "copy-native-modules",
			writeBundle() {
				// The native .node binary gets OS-locked while Stream Deck has the plugin running, so a
				// build while it's live can't replace it. That's fine - the binary is static across builds
				// (only our TS changes, not this dependency, are what's being rebuilt) - so on EPERM we
				// just keep the copy that's already there instead of failing the whole build.
				for (const moduleName of nativeModules) {
					const src = path.join("node_modules", moduleName);
					const dest = path.join(sdPlugin, "bin", "node_modules", moduleName);
					try {
						fs.rmSync(dest, { recursive: true, force: true });
						fs.cpSync(src, dest, { recursive: true });
					} catch (error) {
						console.warn(`Skipped updating ${moduleName} (likely locked by the running plugin): ${error.message}`);
					}
				}
			}
		},
		{
			// Stream Deck runs its own copy of the plugin from its Plugins folder, not from this
			// project. If that folder is a symlink back to this project, Stream Deck already sees
			// every build - skip copying (copying a folder onto itself would error). Otherwise,
			// mirror the freshly built plugin into it so a plain `npm run build` stays the only
			// step ever needed.
			name: "sync-to-streamdeck",
			writeBundle() {
				const appData = process.env.APPDATA;
				if (!appData) return;

				const installed = path.join(appData, "Elgato", "StreamDeck", "Plugins", sdPlugin);
				if (!fs.existsSync(path.dirname(installed))) return;

				try {
					if (fs.existsSync(installed) && fs.lstatSync(installed).isSymbolicLink()) return;
					fs.cpSync(sdPlugin, installed, { recursive: true });
					console.log(`Synced plugin to ${installed}`);
				} catch (error) {
					console.warn(`Could not sync plugin to Stream Deck's Plugins folder: ${error.message}`);
				}
			}
		},
		typescript({
			mapRoot: isWatching ? "./" : undefined
		}),
		nodeResolve({
			browser: false,
			exportConditions: ["node"],
			preferBuiltins: true
		}),
		commonjs(),
		!isWatching && terser(),
		{
			name: "emit-module-package-file",
			generateBundle() {
				this.emitFile({ fileName: "package.json", source: `{ "type": "module" }`, type: "asset" });
			}
		}
	]
};

export default config;
