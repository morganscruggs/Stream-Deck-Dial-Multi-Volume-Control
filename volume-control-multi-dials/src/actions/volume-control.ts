import streamDeck, {
	action,
	DialAction,
	DialRotateEvent,
	DialUpEvent,
	DidReceiveSettingsEvent,
	FeedbackPayload,
	SendToPluginEvent,
	SingletonAction,
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
const DYNAMIC_ICON_DIR = path.join(PLUGIN_ROOT, "imgs", "actions", "volume", "dynamic");

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

		const stepSize = settings.stepSize ?? 1;
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
					return { value: session.name, label: prettifyAppName(session.name), icon: cached?.path };
				})
			);
			items.sort((a, b) => a.label.localeCompare(b.label));
		} catch (error) {
			streamDeck.logger.error("Failed to list audio sessions", error);
		}

		const known = Array.from(iconCache.values()).map((cached) => ({
			value: cached.exeName,
			label: prettifyAppName(cached.exeName),
			icon: cached.path
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
	/** Path to the saved PNG, relative to the plugin root, e.g. "imgs/actions/volume/dynamic/aces.exe.png". */
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
 * Generic mixer glyph shown on the dial when none of the configured apps are currently running - the
 * same speaker + fader-lines combo icon used as the action's main icon (see manifest.json), referenced
 * as a file rather than embedded base64 for the same redraw-reliability reason as dialIconPathCache.
 */
const DEFAULT_MIXER_ICON_PATH = "imgs/actions/volume/key@2x.png";

/**
 * Muted/inactive fill color for the dial's progress bar when none of the configured apps are running.
 */
const INACTIVE_BAR_COLOR = "#5a5a5a";

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
 * The title area supports three modes (see `VolumeSettings.titleMode`): a fixed custom title (default,
 * matching the original behaviour), the name of the top running app, or both joined on one line (the
 * dial only ever uses the built-in "$B1" layout here, which has a single title field, so "both" can't
 * be genuinely left/right-justified without a custom layout).
 */
function updateFeedback(action: DialAction<VolumeSettings>, settings: VolumeSettings): Promise<void> {
	const volume = settings.volume ?? 50;
	const barValue = settings.isMuted ? 0 : volume;
	const runningApp = findRunningApp(settings.applications);
	const appKey = runningApp?.toLowerCase();
	const iconPath = appKey ? iconCache.get(appKey)?.path : undefined;

	const titleMode = settings.titleMode ?? "custom";
	const customTitle = settings.customTitle || "Multi Volume";
	const appName = runningApp ? prettifyAppName(runningApp) : "No app running";

	let title: string;
	if (titleMode === "both") {
		title = `${settings.isMuted ? "Muted" : customTitle} – ${appName}`;
	} else {
		const base = titleMode === "app" ? appName : customTitle;
		title = settings.isMuted ? "Muted" : base;
	}

	const feedback: FeedbackPayload = {
		title,
		value: settings.isMuted ? "Muted" : `${volume}%`,
		indicator: runningApp ? barValue : { value: barValue, bar_fill_c: INACTIVE_BAR_COLOR },
		icon: iconPath ?? DEFAULT_MIXER_ICON_PATH
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
				return action.setFeedback({ ...feedback, icon: savedPath });
			})
			.catch((error) => streamDeck.logger.error(`Failed to load icon for ${runningApp}`, error))
			.finally(() => iconResolutionInFlight.delete(appKey));
	}

	return action.setFeedback(feedback);
}

/**
 * Writes an extracted icon (base64 data URI) to a file under the plugin's own imgs folder, returning
 * its path relative to the plugin root - suitable for use as a Pixmap layout item's value.
 */
function saveIconFile(appKey: string, dataUri: string): string | undefined {
	const match = /^data:image\/png;base64,(.+)$/.exec(dataUri);
	if (!match) return undefined;

	try {
		fs.mkdirSync(DYNAMIC_ICON_DIR, { recursive: true });
		const fileName = `${appKey.replace(/[^a-z0-9.-]/gi, "_")}.png`;
		fs.writeFileSync(path.join(DYNAMIC_ICON_DIR, fileName), Buffer.from(match[1], "base64"));
		return `imgs/actions/volume/dynamic/${fileName}`;
	} catch (error) {
		streamDeck.logger.error(`Failed to save icon file for ${appKey}`, error);
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
	/** What to show in the dial's title area. Defaults to "custom" (the original fixed "Multi Volume" title). */
	titleMode?: "custom" | "app" | "both";
	/** User-supplied title text, used when `titleMode` is "custom" or "both". Falls back to "Multi Volume". */
	customTitle?: string;
};
