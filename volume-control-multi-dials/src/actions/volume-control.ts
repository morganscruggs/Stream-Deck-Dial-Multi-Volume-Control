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
import { ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
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
	 * Visible dials, keyed by action id - needed (alongside {@link lastSettings}) so
	 * {@link refreshPlayPauseDials} can push a fresh icon to every dial in "Play / Pause Media" mode
	 * without waiting for that dial's own 2s poll tick.
	 */
	private visibleActions = new Map<string, DialAction<VolumeSettings>>();

	/**
	 * Shared timer that polls the system media session's playback status once for all dials at once
	 * (see {@link refreshMediaPolling}), rather than each "Play / Pause Media" dial spawning its own
	 * PowerShell process on its own schedule.
	 */
	private mediaPollInterval?: ReturnType<typeof setInterval>;

	/** Whether a media-status poll is still waiting on its answer (see {@link pollMediaPlaybackStatus}). */
	private mediaPollInFlight = false;

	/** When this plugin last sent a play/pause key press, for {@link MEDIA_PRESS_GRACE_MS}. */
	private lastMediaPressAt = 0;

	/**
	 * Initialize the dial display when it appears, and start polling it while it's visible.
	 */
	override onWillAppear(ev: WillAppearEvent<VolumeSettings>): void | Promise<void> {
		// This action is Encoder-only (see manifest.json), so ev.action is always a dial - but
		// WillAppearEvent is shared with key actions, so setFeedback needs this type guard.
		if (!ev.action.isDial()) return;

		const action = ev.action;
		this.lastSettings.set(action.id, ev.payload.settings);
		this.visibleActions.set(action.id, action);
		this.startPolling(action);
		this.refreshMediaPolling();

		return updateFeedback(action, ev.payload.settings);
	}

	/**
	 * Stops polling once the dial is no longer visible (navigated away from, unplugged, etc).
	 */
	override onWillDisappear(ev: WillDisappearEvent<VolumeSettings>): void {
		this.stopPolling(ev.action.id);
		this.lastSettings.delete(ev.action.id);
		this.visibleActions.delete(ev.action.id);
		nativeTitleByAction.delete(ev.action.id);
		this.refreshMediaPolling();
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
	 * Starts or stops the shared media-status poll based on whether any visible dial is currently
	 * configured for "Play / Pause Media" - so this never spawns a PowerShell process in the background
	 * for users who only ever use the default Mute/Unmute button. Called whenever visibility or settings
	 * change, since either can turn playPause mode on or off for a dial.
	 */
	private refreshMediaPolling(): void {
		const needsPolling = Array.from(this.lastSettings.values()).some((settings) => settings.pushButtonAction === "playPause");

		if (needsPolling && !this.mediaPollInterval) {
			this.mediaPollInterval = setInterval(() => this.pollMediaPlaybackStatus(), MEDIA_POLL_INTERVAL_MS);
			this.pollMediaPlaybackStatus();
		} else if (!needsPolling && this.mediaPollInterval) {
			clearInterval(this.mediaPollInterval);
			this.mediaPollInterval = undefined;
			stopMediaShell();
		}
	}

	/**
	 * Refreshes the cached playback status from Windows and pushes it out to every dial that displays
	 * it. This is the only source of truth correction for state changed elsewhere (a physical media key,
	 * pausing from within the app itself, etc.) - {@link handlePress} updates the cache optimistically
	 * and immediately for this plugin's own button presses, without waiting for this poll.
	 *
	 * Dials are only redrawn when the status actually changes, so the frequent poll costs next to nothing
	 * the rest of the time. A poll is skipped while the previous one is still waiting on an answer, and a
	 * result is discarded if it was requested within {@link MEDIA_PRESS_GRACE_MS} of a press - otherwise
	 * a poll racing the press (or an app slow to report its new state) would briefly flip the overlay back.
	 */
	private async pollMediaPlaybackStatus(): Promise<void> {
		if (this.mediaPollInFlight) return;
		this.mediaPollInFlight = true;

		try {
			const requestedAt = Date.now();
			const status = await getMediaPlaybackStatus();
			if (requestedAt < this.lastMediaPressAt + MEDIA_PRESS_GRACE_MS) return;
			if (status === cachedPlaybackStatus) return;

			cachedPlaybackStatus = status;
			await this.refreshPlayPauseDials();
		} finally {
			this.mediaPollInFlight = false;
		}
	}

	/**
	 * Re-sends feedback for every visible dial currently in "Play / Pause Media" mode, so they pick up
	 * the latest {@link cachedPlaybackStatus} (its paused-icon overlay) right away.
	 */
	private async refreshPlayPauseDials(): Promise<void> {
		for (const [actionId, action] of this.visibleActions) {
			const settings = this.lastSettings.get(actionId);
			if (settings?.pushButtonAction !== "playPause") continue;
			await updateFeedback(action, settings).catch((error) =>
				streamDeck.logger.error("Failed to refresh play/pause dial feedback", error)
			);
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
		this.refreshMediaPolling();
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
	 * Handle the dial's push button - either toggles mute or sends the media play/pause key,
	 * depending on the configured {@link VolumeSettings.pushButtonAction}.
	 */
	override async onDialUp(ev: DialUpEvent<VolumeSettings>): Promise<void> {
		await this.handlePress(ev);
	}

	/**
	 * Handle a touch screen tap - shares the same configurable action as the push button.
	 */
	override async onTouchTap(ev: TouchTapEvent<VolumeSettings>): Promise<void> {
		await this.handlePress(ev);
	}

	/**
	 * Shared press logic for both the dial's push button and its touch screen: sends the media
	 * play/pause key if the user has configured that, otherwise falls back to the default mute toggle.
	 *
	 * The cached playback status is flipped optimistically right here, rather than waiting for the next
	 * poll tick (up to {@link MEDIA_POLL_INTERVAL_MS} away), so the paused-icon overlay reacts the instant
	 * this plugin itself causes the change. A press when the status isn't known yet is assumed to be
	 * pausing something that was playing, since that's the far more common reason to press this button.
	 */
	private async handlePress(ev: DialUpEvent<VolumeSettings> | TouchTapEvent<VolumeSettings>): Promise<void> {
		if (ev.payload.settings.pushButtonAction === "playPause") {
			sendMediaPlayPause();
			this.lastMediaPressAt = Date.now();
			cachedPlaybackStatus = cachedPlaybackStatus === "paused" ? "playing" : "paused";
			await this.refreshPlayPauseDials();
			return;
		}

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
 * Color of the diagonal "muted" slash and the pause bars drawn over the icon.
 */
const MUTE_SLASH_COLOR = "#ff3b30";

/**
 * Outline color for both overlays, keeping them legible against icons that are themselves red or
 * otherwise low-contrast against the plain {@link MUTE_SLASH_COLOR}.
 */
const OVERLAY_OUTLINE_COLOR = "#000000";

/**
 * SVG markup for the two red pause bars drawn over the icon while playback is paused (see
 * {@link buildPausedIcon}) - no background badge, just the bars themselves, each a fully-rounded
 * capsule (`rx` set to half its own width) for a softer look than a sharp rectangle, with a thin black
 * outline (`stroke`) for contrast. Shares {@link MUTE_SLASH_COLOR} so both overlays use the same red.
 */
const PAUSE_OVERLAY_SVG = `
<rect x="29" y="18" width="14" height="64" rx="7" fill="${MUTE_SLASH_COLOR}" stroke="${OVERLAY_OUTLINE_COLOR}" stroke-width="4" />
<rect x="57" y="18" width="14" height="64" rx="7" fill="${MUTE_SLASH_COLOR}" stroke="${OVERLAY_OUTLINE_COLOR}" stroke-width="4" />
`;

/**
 * Builds a version of the given icon with an overlay drawn on top of it. Embeds the icon's own PNG
 * bytes as a data URI inside an `<image>` and draws the overlay markup over it, rather than needing to
 * pre-render and cache a separate variant per app per overlay. Encoded as a base64 `data:image/svg+xml`
 * URI - matching the SDK docs' own example for an SVG Pixmap value - rather than a bare `<svg>` string,
 * and declares `xlink:href` alongside the plain `href` on `<image>` for compatibility with SVG
 * 1.1-only renderers.
 */
function buildIconWithOverlay(iconAbsPath: string, overlaySvg: string): string | undefined {
	const dataUri = readIconAsDataUri(iconAbsPath);
	if (!dataUri) return undefined;

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100" width="100" height="100">
<image xlink:href="${dataUri}" href="${dataUri}" x="0" y="0" width="100" height="100" preserveAspectRatio="xMidYMid meet" />
${overlaySvg}
</svg>`;

	return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/**
 * Builds a version of the given icon with a red diagonal line through it (top-left to bottom-right), for
 * the dial's icon while muted. A line has no fill to apply an outline to, so the black outline is
 * faked by drawing a slightly wider black line first and the red line on top of it.
 */
function buildMutedIcon(iconAbsPath: string): string | undefined {
	return buildIconWithOverlay(
		iconAbsPath,
		`<line x1="6" y1="6" x2="94" y2="94" stroke="${OVERLAY_OUTLINE_COLOR}" stroke-width="17" stroke-linecap="round" />
<line x1="6" y1="6" x2="94" y2="94" stroke="${MUTE_SLASH_COLOR}" stroke-width="9" stroke-linecap="round" />`
	);
}

/**
 * Builds a version of the given icon with a paused badge over it, for a "Play / Pause Media" dial while
 * {@link cachedPlaybackStatus} is "paused".
 */
function buildPausedIcon(iconAbsPath: string): string | undefined {
	return buildIconWithOverlay(iconAbsPath, PAUSE_OVERLAY_SVG);
}

/**
 * Resolves the icon to actually hand to `setFeedback`: the plain file path normally, or an overlaid
 * version - the red mute slash taking priority over the paused badge, since a dial only ever has one
 * reason to show an overlay in practice (mute-mode dials never set `isPaused`, and vice versa) - falling
 * back to the plain path if reading the source file for the overlay fails for some reason.
 */
function resolveIconFeedbackValue(iconAbsPath: string, isMuted: boolean, isPaused: boolean): string {
	if (isMuted) return buildMutedIcon(iconAbsPath) ?? iconAbsPath;
	if (isPaused) return buildPausedIcon(iconAbsPath) ?? iconAbsPath;
	return iconAbsPath;
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

	// Only a dial actually in "Play / Pause Media" mode shows the paused badge - the cached status is
	// shared globally, but a Mute/Unmute dial has nothing to do with media playback.
	const isPaused = settings.pushButtonAction === "playPause" && cachedPlaybackStatus === "paused";

	const feedback: FeedbackPayload = {
		title,
		value: { value: `${volume}%`, color: dimColor },
		indicator: { value: barValue, bar_fill_c: dimColor },
		icon: resolveIconFeedbackValue(iconPath ?? DEFAULT_MIXER_ICON_ABS_PATH, settings.isMuted ?? false, isPaused)
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
				return action.setFeedback({ ...feedback, icon: resolveIconFeedbackValue(savedPath, settings.isMuted ?? false, isPaused) });
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
 * P/Invoke helper for simulating the hardware Media Play/Pause key. Windows routes that key globally
 * to whatever app currently owns the System Media Transport Controls session (Spotify, a browser tab
 * playing video, etc.) - there's no per-app "pause" API, so this deliberately mirrors a physical media
 * keyboard key rather than targeting this action's own configured application list.
 *
 * Kept on a single line since it's fed to a `-Command -` shell's stdin line by line (see
 * {@link getMediaShell}), where a multi-line here-string wouldn't be parsed as one statement.
 */
const MEDIA_KEY_HELPER_TYPE =
	"Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class MediaKey { " +
	'[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo); }\'';

const VK_MEDIA_PLAY_PAUSE = 0xb3;
const KEYEVENTF_KEYUP = 0x2;

const MEDIA_KEY_PRESS_COMMAND =
	`[MediaKey]::keybd_event(${VK_MEDIA_PLAY_PAUSE}, 0, 0, [UIntPtr]::Zero); ` +
	`[MediaKey]::keybd_event(${VK_MEDIA_PLAY_PAUSE}, 0, ${KEYEVENTF_KEYUP}, [UIntPtr]::Zero)`;

/**
 * PowerShell for reading the current System Media Transport Controls session's playback status. This is
 * the same WinRT API (`Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager`) that
 * backs the Windows lock-screen media controls - there's no simpler/native Node API for it. WinRT's
 * async methods return `IAsyncOperation`, which .NET/PowerShell can't `await` directly; `$asTask` is the
 * standard reflection-based trick (used throughout the PowerShell community) for bridging that to a
 * blocking `Task.Wait()` inside a synchronous script.
 *
 * Run once when {@link getMediaShell} starts, defining a `Get-MediaStatus` function that each poll then
 * calls. The session manager is cached after its first request, and that request's wait is capped at 3s
 * so a stuck WinRT call can't block the shell - and any key presses queued behind it - indefinitely.
 * Joined onto one line for the same reason as {@link MEDIA_KEY_HELPER_TYPE}.
 */
const MEDIA_STATUS_HELPER = [
	"Add-Type -AssemblyName System.Runtime.WindowsRuntime",
	"$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]",
	"$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0].MakeGenericMethod($mgrType)",
	"function Get-MediaStatus { try { if (-not $script:mgr) { $t = $asTask.Invoke($null, @($mgrType::RequestAsync())); if (-not $t.Wait(3000)) { return 'None' }; $script:mgr = $t.Result }; $s = $script:mgr.GetCurrentSession(); if ($s) { $s.GetPlaybackInfo().PlaybackStatus.ToString() } else { 'None' } } catch { 'None' } }"
].join("; ");

/**
 * Long-lived PowerShell process that handles both media jobs: sending play/pause key presses and
 * answering playback status polls. Spawning a fresh `powershell.exe` (and compiling
 * {@link MEDIA_KEY_HELPER_TYPE} via `Add-Type`) costs 1-2s, which made every press feel laggy and every
 * poll needlessly expensive - so that's paid once up front here, and each press or poll is just one
 * line written to this shell's stdin. Started while any dial is in "Play / Pause Media" mode (see
 * {@link VolumeControl.refreshMediaPolling}), and exits on its own if the plugin dies, since its stdin
 * closes.
 */
let mediaShell: ChildProcessWithoutNullStreams | undefined;

/**
 * Status polls waiting on an answer from {@link mediaShell}, keyed by request id. Each request echoes
 * its id back (`STATUS:<id>:<status>`), so an answer that arrives after its request already timed out
 * can't be mistaken for a later request's.
 */
const pendingStatusRequests = new Map<number, (status: string) => void>();
let nextStatusRequestId = 0;

function getMediaShell(): ChildProcessWithoutNullStreams {
	if (mediaShell && mediaShell.exitCode === null) return mediaShell;

	const shell = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command", "-"], { windowsHide: true });
	createInterface({ input: shell.stdout }).on("line", (line) => {
		const match = /^STATUS:(\d+):(.*)$/.exec(line.trim());
		if (match) pendingStatusRequests.get(Number(match[1]))?.(match[2]);
	});
	shell.stderr.on("data", (data) => streamDeck.logger.error(`Media shell: ${String(data).trim()}`));
	shell.stdin.on("error", (error) => streamDeck.logger.error("Media shell stdin error", error));
	shell.on("error", (error) => streamDeck.logger.error("Media shell failed", error));
	shell.on("exit", () => {
		if (mediaShell === shell) mediaShell = undefined;
		for (const finish of Array.from(pendingStatusRequests.values())) finish("None");
	});
	shell.stdin.write(`${MEDIA_KEY_HELPER_TYPE}\n${MEDIA_STATUS_HELPER}\n`);

	mediaShell = shell;
	return shell;
}

function stopMediaShell(): void {
	mediaShell?.stdin.end();
	mediaShell = undefined;
}

/**
 * Simulates a press of the Media Play/Pause key, toggling playback in whichever app currently owns
 * the system's media session - the same effect as a physical keyboard's play/pause media key.
 */
function sendMediaPlayPause(): void {
	try {
		getMediaShell().stdin.write(`${MEDIA_KEY_PRESS_COMMAND}\n`);
	} catch (error) {
		streamDeck.logger.error("Failed to send media play/pause key", error);
	}
}

/**
 * How often the shared media-status poll (see {@link VolumeControl.refreshMediaPolling}) re-checks
 * Windows' System Media Transport Controls for the current playback state. Each check is just a quick
 * call into the already-running {@link mediaShell}, and dials are only redrawn when the answer changes,
 * so this can be frequent - a change made elsewhere (a physical media key, pausing from inside the app
 * itself) shows up on the dial within about a second. This plugin's own button presses don't wait on
 * this poll at all - see the optimistic update in {@link VolumeControl.handlePress}.
 */
const MEDIA_POLL_INTERVAL_MS = 1000;

/**
 * How long after this plugin's own play/pause press poll results are ignored, giving the media app time
 * to report its new state before a poll is trusted over the optimistic update in
 * {@link VolumeControl.handlePress}.
 */
const MEDIA_PRESS_GRACE_MS = 1500;

/**
 * How long a status poll waits for {@link mediaShell} to answer. Generous, since the very first poll
 * after the shell starts also waits behind its PowerShell startup and helper setup.
 */
const MEDIA_STATUS_TIMEOUT_MS = 10000;

/**
 * Last-known playback status of whatever app currently owns the system media session, shared across
 * every dial in "Play / Pause Media" mode (see {@link VolumeControl.refreshMediaPolling}). `undefined`
 * means unknown or no active media session - deliberately distinct from "playing", so a dial doesn't
 * show a paused overlay just because nothing is playing at all.
 */
type MediaPlaybackStatus = "playing" | "paused" | undefined;
let cachedPlaybackStatus: MediaPlaybackStatus;

/**
 * Queries Windows for the playback status of whatever app currently owns the system media session.
 * Returns `undefined` for anything other than a clean "Playing"/"Paused" answer (no active session,
 * "Stopped"/"Closed"/etc, or the query failing or timing out) - those all mean "don't claim to know",
 * not "assume playing".
 */
function getMediaPlaybackStatus(): Promise<MediaPlaybackStatus> {
	return new Promise((resolve) => {
		const id = nextStatusRequestId++;
		const timer = setTimeout(() => finish("None"), MEDIA_STATUS_TIMEOUT_MS);
		function finish(status: string): void {
			clearTimeout(timer);
			pendingStatusRequests.delete(id);
			resolve(status === "Playing" ? "playing" : status === "Paused" ? "paused" : undefined);
		}
		pendingStatusRequests.set(id, finish);

		try {
			getMediaShell().stdin.write(`[Console]::Out.WriteLine('STATUS:${id}:' + (Get-MediaStatus))\n`);
		} catch (error) {
			streamDeck.logger.error("Failed to read media playback status", error);
			finish("None");
		}
	});
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
	/** What the dial's push button (and touch tap) does when pressed. Defaults to "mute" if unset. */
	pushButtonAction?: "mute" | "playPause";
};
