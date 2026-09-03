import streamDeck, {
	action,
	DialAction,
	DialRotateEvent,
	DialUpEvent,
	DidReceiveSettingsEvent,
	FeedbackPayload,
	SendToPluginEvent,
	SingletonAction,
	TitleParametersDidChangeEvent,
	WillAppearEvent,
	WillDisappearEvent,
	TouchTapEvent
} from "@elgato/streamdeck";
import { NodeAudioVolumeMixer } from "node-audio-volume-mixer";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const AUDIO_APPS_DATASOURCE = "getAudioApps";

/**
 * Wraps NodeAudioVolumeMixer.getAudioSessionProcesses(), dropping the odd session Windows reports
 * with pid 0 (the reserved System Idle Process id, which no process can ever resolve a name for -
 * unrelated to any app, harmless, and not worth surfacing anywhere).
 */
function getNamedAudioSessions(): { pid: number; name: string }[] {
	return NodeAudioVolumeMixer.getAudioSessionProcesses().filter((session) => session.pid !== 0 && session.name);
}

// This file compiles to <sdPlugin>/bin/plugin.js, so the plugin's own root is one directory up.
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Where extracted app icons (and their cache index) are written - deliberately *outside* the plugin's
 * own installed folder, under the user's local app data. Marketplace-distributed plugins are installed
 * from a DRM-protected package, so the plugin's own folder can't be assumed writable at runtime; this
 * also keeps this dev machine's cached icons (aces.exe, chrome.exe, etc.) out of the packaged
 * `.streamDeckPlugin` file entirely, since they'd otherwise sit inside the bundled `.sdPlugin` folder
 * and ship to every user. `%APPDATA%` is always defined on Windows, which is this plugin's only
 * supported OS (see manifest.json).
 */
const DYNAMIC_ICON_DIR = path.join(process.env.APPDATA ?? PLUGIN_ROOT, "com.morgan-scruggs.volume-control-multi-dials", "icons");

/**
 * Action that controls the volume of one or more applications at once using a single dial.
 */
@action({ UUID: "com.morgan-scruggs.volume-control-multi-dials.volume" })
export class VolumeControl extends SingletonAction<VolumeSettings> {
	/**
	 * Tracks each visible dial's periodic refresh, keyed by action id, so a launched/closed app is
	 * picked up (icon, grey/active bar) without waiting for the user to touch the dial themselves.
	 */
	private pollIntervals = new Map<string, ReturnType<typeof setInterval>>();

	/**
	 * Last-known settings per visible dial (action id), used by the poll below instead of calling
	 * action.getSettings() on every tick. The only thing that actually needs to be "live" each tick is
	 * whether a configured app is currently running, which updateFeedback already re-checks fresh every
	 * call - the settings themselves (which apps, volume, mute) rarely change and are kept in sync here
	 * whenever we already have them from a real event.
	 */
	private lastSettings = new Map<string, VolumeSettings>();

	/**
	 * Initialize the dial display when it appears, and start polling it while it's visible.
	 */
	override onWillAppear(ev: WillAppearEvent<VolumeSettings>): void | Promise<void> {
		// This action is Encoder-only (see manifest.json), so ev.action is always a dial - but
		// WillAppearEvent is shared with key actions, so setFeedback needs this type guard.
		if (!ev.action.isDial()) return;

		const action = ev.action;
		this.lastSettings.set(action.id, ev.payload.settings);
		this.startPolling(action);

		return updateFeedback(action, ev.payload.settings);
	}

	/**
	 * Stops polling once the dial is no longer visible (navigated away from, unplugged, etc).
	 */
	override onWillDisappear(ev: WillDisappearEvent<VolumeSettings>): void {
		this.stopPolling(ev.action.id);
		this.lastSettings.delete(ev.action.id);
		nativeTitleByAction.delete(ev.action.id);
	}

	/**
	 * Tracks the title text the user has set via Stream Deck's own native title editor for this dial,
	 * so "Top Application Name"/"Both" title modes can restore or build on it (see {@link updateFeedback}
	 * and {@link nativeTitleByAction}). Fires only on the user's own edits, not on our own setFeedback
	 * calls, so this never becomes a feedback loop.
	 */
	override onTitleParametersDidChange(ev: TitleParametersDidChangeEvent<VolumeSettings>): void {
		nativeTitleByAction.set(ev.action.id, ev.payload.title);

		const settings = this.lastSettings.get(ev.action.id);
		if (settings && ev.action.isDial()) {
			updateFeedback(ev.action, settings).catch((error) =>
				streamDeck.logger.error("Failed to refresh dial feedback after title change", error)
			);
		}
	}

	private startPolling(action: DialAction<VolumeSettings>): void {
		this.stopPolling(action.id);
		this.pollIntervals.set(
			action.id,
			setInterval(() => {
				const settings = this.lastSettings.get(action.id);
				if (!settings) return;
				updateFeedback(action, settings).catch((error) =>
					streamDeck.logger.error("Failed to refresh dial feedback", error)
				);
			}, 2000)
		);
	}

	private stopPolling(actionId: string): void {
		const interval = this.pollIntervals.get(actionId);
		if (interval) {
			clearInterval(interval);
			this.pollIntervals.delete(actionId);
		}
	}

	/**
	 * Applies and refreshes the dial's on-device display whenever settings change from the property
	 * inspector - e.g. dragging the Volume slider, or picking a different Application - so those take
	 * effect immediately instead of waiting for the next rotate/press.
	 */
	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<VolumeSettings>): Promise<void> {
		if (!ev.action.isDial()) return;
		this.lastSettings.set(ev.action.id, ev.payload.settings);
		await updateFeedback(ev.action, ev.payload.settings);
		this.applyToApps(ev.payload.settings);
	}

	/**
	 * Triggered when the dial is rotated.
	 */
	override async onDialRotate(ev: DialRotateEvent<VolumeSettings>): Promise<void> {
		const { settings } = ev.payload;

		// If currently muted, un-mute when rotating and restore the volume it had before muting.
		if (settings.isMuted) {
			settings.isMuted = false;
			settings.volume = settings.previousVolume ?? 50;
			settings.previousVolume = undefined;
		}

		const stepSize = settings.stepSize ?? 5;
		const currentVolume = settings.volume ?? 50;
		settings.volume = Math.max(0, Math.min(100, currentVolume + ev.payload.ticks * stepSize));

		await ev.action.setSettings(settings);
		this.lastSettings.set(ev.action.id, settings);
		await updateFeedback(ev.action, settings);

		this.applyToApps(settings);
	}

	/**
	 * Toggle mute when the dial is pressed.
	 */
	override async onDialUp(ev: DialUpEvent<VolumeSettings>): Promise<void> {
		await this.toggleMute(ev);
	}

	/**
	 * Toggle mute when the touch screen is tapped.
	 */
	override async onTouchTap(ev: TouchTapEvent<VolumeSettings>): Promise<void> {
		await this.toggleMute(ev);
	}

	/**
	 * Shared mute-toggle logic for both the dial's push button and its touch screen.
	 */
	private async toggleMute(ev: DialUpEvent<VolumeSettings> | TouchTapEvent<VolumeSettings>): Promise<void> {
		const { settings } = ev.payload;

		if (settings.isMuted) {
			settings.isMuted = false;
			settings.volume = settings.previousVolume ?? 50;
			settings.previousVolume = undefined;
		} else {
			settings.isMuted = true;
			settings.previousVolume = settings.volume ?? 50;
		}

		await ev.action.setSettings(settings);
		this.lastSettings.set(ev.action.id, settings);
		await updateFeedback(ev.action, settings);

		this.applyToApps(settings);
	}

	/**
	 * Responds to the custom app picker's request for the running-apps list (see volume-control.html) -
	 * fired once when the property inspector opens, and again each time the picker is clicked.
	 */
	override onSendToPlugin(ev: SendToPluginEvent<any, VolumeSettings>): void {
		const payload = ev.payload as { event?: string } | undefined;
		if (payload?.event === AUDIO_APPS_DATASOURCE) {
			this.sendAudioApps();
		}
	}

	/**
	 * Sends the current list of apps with an active audio session to the property inspector, for the
	 * "Application" picker - each with its own icon, so the picker can show it next to the app's name.
	 * Only apps actively producing sound have a session (same as the Windows volume mixer), so a
	 * silent app won't show up until it plays something.
	 *
	 * Also sends `known`: every app ever cached, running or not, so the property inspector can still
	 * show the label/icon for an already-configured app even after it stops running (it just won't be
	 * offered as a new pick until it's producing audio again).
	 */
	private async sendAudioApps(): Promise<void> {
		let items: { value: string; label: string; icon?: string }[] = [];

		try {
			const sessions = getNamedAudioSessions();
			const seen = new Set<string>();
			const deduped = sessions.filter((session) => {
				const key = session.name.toLowerCase();
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});

			items = await Promise.all(
				deduped.map(async (session) => {
					const key = session.name.toLowerCase();
					let cached = iconCache.get(key);
					if (!cached) {
						const dataUri = await extractIconForPid(session.pid).catch(() => undefined);
						const savedPath = dataUri ? saveIconFile(key, dataUri) : undefined;
						if (savedPath) {
							cached = { exeName: session.name, path: savedPath };
							iconCache.set(key, cached);
							persistIconCache();
						}
					}
					return {
						value: session.name,
						label: prettifyAppName(session.name),
						icon: cached ? readIconAsDataUri(cached.path) : undefined
					};
				})
			);
			items.sort((a, b) => a.label.localeCompare(b.label));
		} catch (error) {
			streamDeck.logger.error("Failed to list audio sessions", error);
		}

		const known = Array.from(iconCache.values()).map((cached) => ({
			value: cached.exeName,
			label: prettifyAppName(cached.exeName),
			icon: readIconAsDataUri(cached.path)
		}));

		streamDeck.ui.sendToPropertyInspector({ event: AUDIO_APPS_DATASOURCE, items, known });
	}

	/**
	 * Applies the current volume/mute state to every audio session belonging to the configured apps.
	 *
	 * A single app (e.g. Chrome) can own several sessions at once - one per process that is actually
	 * producing sound - so we apply the change to all matching sessions, not just the first.
	 */
	private applyToApps(settings: VolumeSettings): void {
		const targets = (settings.applications ?? []).map((name) => name.toLowerCase());
		if (targets.length === 0) return;

		const isMuted = settings.isMuted ?? false;
		const volumeLevel = (settings.volume ?? 50) / 100;

		let sessions;
		try {
			sessions = getNamedAudioSessions();
		} catch (error) {
			streamDeck.logger.error("Failed to read audio sessions", error);
			return;
		}

		const matches = sessions.filter((session) => targets.includes(session.name.toLowerCase()));

		matches.forEach((session) => {
			try {
				NodeAudioVolumeMixer.setAudioSessionMute(session.pid, isMuted);
				NodeAudioVolumeMixer.setAudioSessionVolumeLevelScalar(session.pid, volumeLevel);
			} catch (error) {
				streamDeck.logger.error(`Failed to set volume for ${session.name} (pid ${session.pid})`, error);
			}
		});
	}
}

/**
 * An icon already extracted and saved to disk for one app, keyed by lowercased exe name.
 */
type CachedIcon = {
	/** The exe name in its original casing, e.g. "aces.exe" - used as the picker's `value`. */
	exeName: string;
	/** Absolute path to the saved PNG under {@link DYNAMIC_ICON_DIR}. */
	path: string;
};

/**
 * Persisted (disk-backed) cache of extracted app icons, keyed by lowercased exe name. Used both for the
 * dial's on-device feedback and the property inspector's app picker, so an icon is only ever extracted
 * once per app - and, being file-backed rather than in-memory, survives both the app closing (so a
 * previously-picked app keeps showing its icon even once it's no longer running) and the plugin process
 * itself restarting (build/deploy, Stream Deck relaunch, etc).
 */
const ICON_CACHE_FILE = path.join(DYNAMIC_ICON_DIR, "icon-cache.json");

function loadIconCache(): Map<string, CachedIcon> {
	try {
		const raw = fs.readFileSync(ICON_CACHE_FILE, "utf-8");
		return new Map(Object.entries(JSON.parse(raw) as Record<string, CachedIcon>));
	} catch {
		return new Map();
	}
}

function persistIconCache(): void {
	try {
		fs.mkdirSync(DYNAMIC_ICON_DIR, { recursive: true });
		fs.writeFileSync(ICON_CACHE_FILE, JSON.stringify(Object.fromEntries(iconCache), null, 2));
	} catch (error) {
		streamDeck.logger.error("Failed to persist icon cache", error);
	}
}

const iconCache = loadIconCache();
const iconResolutionInFlight = new Set<string>();

/**
 * Last-known text of each dial's *native* Stream Deck title (the one the user edits directly in the
 * Stream Deck app, with its own font/color/alignment options - distinct from this plugin's own
 * settings). Populated only by {@link VolumeControl.onTitleParametersDidChange}, which fires on the
 * user's own edits; there's no way to read this value up front (e.g. on `willAppear`), so a dial whose
 * native title was set before ever hitting this code path - and never touched again - stays unknown
 * (treated as blank) until the user edits it at least once.
 */
const nativeTitleByAction = new Map<string, string>();

/**
 * Generic mixer glyph shown on the dial when none of the configured apps are currently running - the
 * same speaker + fader-lines combo icon used as the action's main icon (see manifest.json). Referenced
 * as a file path (rather than embedded base64) since Stream Deck's device rendering doesn't reliably
 * redraw the icon layer when repeatedly fed different base64 blobs via setFeedback, but does update
 * correctly when given a file path.
 */
const DEFAULT_MIXER_ICON_PATH = "imgs/actions/volume/key@2x.png";
const DEFAULT_MIXER_ICON_ABS_PATH = path.join(PLUGIN_ROOT, DEFAULT_MIXER_ICON_PATH);

/**
 * Muted/inactive fill color for the dial's progress bar when none of the configured apps are running.
 */
const INACTIVE_BAR_COLOR = "#5a5a5a";

/**
 * Color of the diagonal "muted" slash drawn over the icon.
 */
const MUTE_SLASH_COLOR = "#ff3b30";

/**
 * Builds a version of the given icon with a red diagonal line through it (top-left to bottom-right), for
 * the dial's icon while muted. Embeds the icon's own PNG bytes as a data URI inside an `<image>` and
 * draws the slash on top of it, rather than needing to pre-render and cache a separate "-muted" PNG
 * variant per app. Encoded as a base64 `data:image/svg+xml` URI - matching the SDK docs' own example
 * for an SVG Pixmap value - rather than a bare `<svg>` string, and declares `xlink:href` alongside the
 * plain `href` on `<image>` for compatibility with SVG 1.1-only renderers.
 */
function buildMutedIcon(iconAbsPath: string): string | undefined {
	const dataUri = readIconAsDataUri(iconAbsPath);
	if (!dataUri) return undefined;

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100" width="100" height="100">
<image xlink:href="${dataUri}" href="${dataUri}" x="0" y="0" width="100" height="100" preserveAspectRatio="xMidYMid meet" />
<line x1="6" y1="6" x2="94" y2="94" stroke="${MUTE_SLASH_COLOR}" stroke-width="9" stroke-linecap="round" />
</svg>`;

	return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/**
 * Resolves the icon to actually hand to `setFeedback`: the plain file path when unmuted, or the
 * slashed-icon SVG (see {@link buildMutedIcon}) when muted - falling back to the plain path if reading
 * the source file for the overlay fails for some reason.
 */
function resolveIconFeedbackValue(iconAbsPath: string, isMuted: boolean): string {
	if (!isMuted) return iconAbsPath;
	return buildMutedIcon(iconAbsPath) ?? iconAbsPath;
}

/**
 * Finds the first configured app (in list order) that's currently running/has an audio session.
 */
function findRunningApp(applications: string[] | undefined): string | undefined {
	if (!applications || applications.length === 0) return undefined;

	let sessions;
	try {
		sessions = getNamedAudioSessions();
	} catch {
		return undefined;
	}

	const running = new Set(sessions.map((session) => session.name.toLowerCase()));
	return applications.find((app) => running.has(app.toLowerCase()));
}

/**
 * Refreshes the dial's on-device title/value/indicator/icon to match its current settings.
 *
 * The icon is resolved from the highest-priority configured app that's actually running right now
 * (falling through the list in order); if none are running, a generic mixer icon is shown instead
 * and the progress bar is greyed out, since there's nothing currently controllable. Icon extraction
 * happens off to the side rather than being awaited here, so a not-yet-cached icon never delays the
 * rest of the feedback update - once it resolves, feedback is sent again with the icon included.
 *
 * Title logic: the user's own text from Stream Deck's native title editor always wins when present -
 * this plugin doesn't touch the title at all in that case. Only when that native field is empty does
 * the plugin fill it in: the top running app's name, or "Multi Volume Dial" if nothing configured is
 * currently running. Muting still overrides all of that to "Muted", restoring the previous text once
 * unmuted (see {@link nativeTitleByAction}) rather than leaving "Muted" on screen forever.
 *
 * Note: Stream Deck only lets a plugin actually change the on-device title while the user hasn't typed
 * their own text into its native title editor - once they have, further plugin `setFeedback` calls for
 * "title" are silently ignored until the user edits it again (or clears it). So the app-name/fallback
 * text above only visibly takes effect while that native field is empty; this is a platform rule, not
 * something this plugin can override without abandoning the built-in "$B1" layout entirely.
 */
function updateFeedback(action: DialAction<VolumeSettings>, settings: VolumeSettings): Promise<void> {
	const volume = settings.volume ?? 50;
	const barValue = settings.isMuted ? 0 : volume;
	const runningApp = findRunningApp(settings.applications);
	const appKey = runningApp?.toLowerCase();
	const iconPath = appKey ? iconCache.get(appKey)?.path : undefined;

	const appName = runningApp ? prettifyAppName(runningApp) : undefined;
	const nativeTitle = nativeTitleByAction.get(action.id) ?? "";

	let title: string;
	if (settings.isMuted) {
		title = "Muted";
	} else if (nativeTitle) {
		title = nativeTitle;
	} else {
		title = appName ?? "Multi Volume Dial";
	}

	// The bar and % text are dimmed to the same grey both when muted and when nothing is running - in
	// both cases the number on screen isn't the audible volume, so it shouldn't read as "active".
	//
	// Both are always sent as full objects (never a bare string/number) so the color/bar_fill_c is
	// explicitly asserted every time, including back to "active" - Stream Deck only updates the field(s)
	// present in a given setFeedback call, so a bare value here would leave a previous dimmed color
	// stuck on screen instead of resetting it once unmuted.
	const isDimmed = settings.isMuted || !runningApp;
	const dimColor = isDimmed ? INACTIVE_BAR_COLOR : "white";

	const feedback: FeedbackPayload = {
		title,
		value: { value: `${volume}%`, color: dimColor },
		indicator: { value: barValue, bar_fill_c: dimColor },
		icon: resolveIconFeedbackValue(iconPath ?? DEFAULT_MIXER_ICON_ABS_PATH, settings.isMuted ?? false)
	};

	if (runningApp && appKey && !iconPath && !iconResolutionInFlight.has(appKey)) {
		iconResolutionInFlight.add(appKey);
		resolveAppIcon(runningApp)
			.then((dataUri) => {
				if (!dataUri) return;
				const savedPath = saveIconFile(appKey, dataUri);
				if (!savedPath) return;
				iconCache.set(appKey, { exeName: runningApp, path: savedPath });
				persistIconCache();

				// The app that triggered this may have stopped running (or been replaced by a
				// higher-priority one) while extraction was in flight - re-check live rather than
				// blindly applying a stale snapshot, which would clobber a more recent, correct update.
				if (findRunningApp(settings.applications) !== runningApp) return;
				return action.setFeedback({ ...feedback, icon: resolveIconFeedbackValue(savedPath, settings.isMuted ?? false) });
			})
			.catch((error) => streamDeck.logger.error(`Failed to load icon for ${runningApp}`, error))
			.finally(() => iconResolutionInFlight.delete(appKey));
	}

	return action.setFeedback(feedback);
}

/**
 * Writes an extracted icon (base64 data URI) to a file under {@link DYNAMIC_ICON_DIR}, returning its
 * absolute path - suitable for use as a Pixmap layout item's value.
 */
function saveIconFile(appKey: string, dataUri: string): string | undefined {
	const match = /^data:image\/png;base64,(.+)$/.exec(dataUri);
	if (!match) return undefined;

	try {
		fs.mkdirSync(DYNAMIC_ICON_DIR, { recursive: true });
		const fileName = `${appKey.replace(/[^a-z0-9.-]/gi, "_")}.png`;
		const filePath = path.join(DYNAMIC_ICON_DIR, fileName);
		fs.writeFileSync(filePath, Buffer.from(match[1], "base64"));
		return filePath;
	} catch (error) {
		streamDeck.logger.error(`Failed to save icon file for ${appKey}`, error);
		return undefined;
	}
}

/**
 * Reads a previously-saved icon file back as a base64 data URI, for handing to the property inspector
 * (a browser context, where a data URI is simpler and more portable than a filesystem path).
 */
function readIconAsDataUri(filePath: string): string | undefined {
	try {
		return `data:image/png;base64,${fs.readFileSync(filePath).toString("base64")}`;
	} catch (error) {
		streamDeck.logger.error(`Failed to read cached icon file ${filePath}`, error);
		return undefined;
	}
}

/**
 * Finds the running process behind an app name and extracts its own icon.
 */
async function resolveAppIcon(appName: string): Promise<string | undefined> {
	let sessions;
	try {
		sessions = getNamedAudioSessions();
	} catch {
		return undefined;
	}

	const match = sessions.find((session) => session.name.toLowerCase() === appName.toLowerCase());
	if (!match) return undefined;

	return extractIconForPid(match.pid);
}

/**
 * Resolves a process's own executable path via the Win32 QueryFullProcessImageName API, requesting
 * only PROCESS_QUERY_LIMITED_INFORMATION - the same low-privilege access Task Manager and the Windows
 * Volume Mixer use to show a name/icon for processes they otherwise can't inspect. This succeeds for
 * anti-cheat-protected games (e.g. War Thunder's BattlEye-guarded `aces.exe`) where `Get-Process`'s
 * `.Path`/`.MainModule` and CIM's `Win32_Process.ExecutablePath` both come back empty, because those
 * need to open the process with PROCESS_VM_READ/enumerate its modules - a much higher bar that such
 * anti-tamper protection specifically blocks. Confirmed against a live `aces.exe`: this call resolved
 * its real path while both of those alternatives returned nothing.
 */
const PROC_PATH_HELPER_TYPE = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ProcPath {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool QueryFullProcessImageName(IntPtr hProcess, uint flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr hObject);
    public static string GetPath(int pid) {
        IntPtr h = OpenProcess(0x1000, false, pid);
        if (h == IntPtr.Zero) return null;
        try {
            var sb = new StringBuilder(1024);
            int size = sb.Capacity;
            if (!QueryFullProcessImageName(h, 0, sb, ref size)) return null;
            return sb.ToString();
        } finally { CloseHandle(h); }
    }
}
'@
`.trim();

/**
 * Extracts the icon associated with a running process's executable, as a base64 PNG data URI.
 * Shells out to PowerShell/System.Drawing since there's no native Node API for this on Windows.
 */
async function extractIconForPid(pid: number): Promise<string | undefined> {
	const script = [
		PROC_PATH_HELPER_TYPE,
		"Add-Type -AssemblyName System.Drawing",
		`$path = [ProcPath]::GetPath(${pid})`,
		`if (-not $path) { $path = (Get-Process -Id ${pid} -ErrorAction Stop).Path }`,
		'if (-not $path) { throw "Could not resolve executable path" }',
		"$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($path)",
		"$bmp = $icon.ToBitmap()",
		"$ms = New-Object System.IO.MemoryStream",
		"$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)",
		"[Convert]::ToBase64String($ms.ToArray())"
	].join("\n");

	try {
		const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
			timeout: 5000,
			maxBuffer: 10 * 1024 * 1024
		});
		const base64 = stdout.trim();
		return base64 ? `data:image/png;base64,${base64}` : undefined;
	} catch (error) {
		streamDeck.logger.error(`Icon extraction failed for pid ${pid}`, error);
		return undefined;
	}
}

/**
 * Turns an executable name like "chrome.exe" into a friendlier label like "Chrome" for the app picker.
 */
function prettifyAppName(exeName: string): string {
	const base = exeName.replace(/\.exe$/i, "");
	return base.charAt(0).toUpperCase() + base.slice(1);
}

export type VolumeSettings = {
	volume?: number;
	applications?: string[];
	stepSize?: number;
	isMuted?: boolean;
	previousVolume?: number;
};
