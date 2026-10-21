import streamDeck, {
	action,
	DialAction,
	DialDownEvent,
	DialRotateEvent,
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
function getNamedAudioSessions(): AudioSession[] {
	return NodeAudioVolumeMixer.getAudioSessionProcesses().filter((session) => session.pid !== 0 && session.name);
}

type AudioSession = { pid: number; name: string };

/**
 * {@link getNamedAudioSessions}, but returning `undefined` instead of throwing if Windows' audio
 * session enumeration fails - for callers that just treat that as "nothing running right now".
 */
function tryGetNamedAudioSessions(): AudioSession[] | undefined {
	try {
		return getNamedAudioSessions();
	} catch {
		return undefined;
	}
}

/**
 * How often every visible dial is re-checked (see {@link VolumeControl.refreshAllDials}), so a
 * launched/closed app is picked up (icon, grey/active bar) without the user touching the dial.
 */
const DIAL_REFRESH_INTERVAL_MS = 2000;

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
	 * Shared timer that refreshes every visible dial at once (see {@link refreshAllDials}), rather than
	 * each dial running its own - so Windows' audio sessions are enumerated once per tick, not per dial.
	 */
	private dialRefreshInterval?: ReturnType<typeof setInterval>;

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
	 * Shared timer that polls the system's media sessions once for all dials at once (see
	 * {@link refreshMediaPolling}), rather than each "Play / Pause Media" dial spawning its own
	 * PowerShell process on its own schedule.
	 */
	private mediaPollInterval?: ReturnType<typeof setInterval>;

	/** Whether a media-session poll is still waiting on its answer (see {@link pollMediaSessions}). */
	private mediaPollInFlight = false;

	/** When this plugin last sent a play/pause press, for {@link MEDIA_PRESS_GRACE_MS}. */
	private lastMediaPressAt = 0;

	/**
	 * The last answer from {@link pollMediaSessions}, so dials are only redrawn when it changes. Cleared
	 * on a press, since the optimistic update there means the cached sessions no longer match it.
	 */
	private lastMediaSessionsJson?: string;

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
		// A dial that's (re)appearing has whatever Stream Deck shows by default, not our last feedback.
		lastFeedbackKeyByAction.delete(action.id);
		this.refreshDialPolling();
		this.refreshMediaPolling();

		return updateFeedback(action, ev.payload.settings);
	}

	/**
	 * Stops polling once the dial is no longer visible (navigated away from, unplugged, etc).
	 */
	override onWillDisappear(ev: WillDisappearEvent<VolumeSettings>): void {
		this.lastSettings.delete(ev.action.id);
		this.visibleActions.delete(ev.action.id);
		nativeTitleByAction.delete(ev.action.id);
		lastFeedbackKeyByAction.delete(ev.action.id);
		this.refreshDialPolling();
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
		// Stream Deck may have redrawn the title itself, so don't trust the last-sent feedback to match.
		lastFeedbackKeyByAction.delete(ev.action.id);

		const settings = this.lastSettings.get(ev.action.id);
		if (settings && ev.action.isDial()) {
			updateFeedback(ev.action, settings).catch((error) =>
				streamDeck.logger.error("Failed to refresh dial feedback after title change", error)
			);
		}
	}

	/**
	 * Starts the shared dial refresh while any dial is visible, and stops it once none are.
	 */
	private refreshDialPolling(): void {
		if (this.visibleActions.size > 0 && !this.dialRefreshInterval) {
			this.dialRefreshInterval = setInterval(() => this.refreshAllDials(), DIAL_REFRESH_INTERVAL_MS);
		} else if (this.visibleActions.size === 0 && this.dialRefreshInterval) {
			clearInterval(this.dialRefreshInterval);
			this.dialRefreshInterval = undefined;
		}
	}

	/**
	 * Re-checks every visible dial against one shared snapshot of Windows' audio sessions. Dials whose
	 * display hasn't changed aren't re-sent (see {@link sendFeedbackIfChanged}), so a quiet tick costs
	 * little more than that one enumeration.
	 */
	private refreshAllDials(filter?: (settings: VolumeSettings) => boolean): Promise<void> {
		const sessions = tryGetNamedAudioSessions();
		const updates: Promise<void>[] = [];
		for (const [actionId, action] of this.visibleActions) {
			const settings = this.lastSettings.get(actionId);
			if (!settings || (filter && !filter(settings))) continue;
			updates.push(
				updateFeedback(action, settings, sessions).catch((error) => {
					streamDeck.logger.error("Failed to refresh dial feedback", error);
				})
			);
		}
		return Promise.all(updates).then(() => undefined);
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
			this.mediaPollInterval = setInterval(() => this.pollMediaSessions(), MEDIA_POLL_INTERVAL_MS);
			this.pollMediaSessions();
		} else if (!needsPolling && this.mediaPollInterval) {
			clearInterval(this.mediaPollInterval);
			this.mediaPollInterval = undefined;
			stopMediaShell();
		}
	}

	/**
	 * Refreshes the cached media sessions (see {@link mediaSessions}) from Windows and pushes them out to
	 * every dial that displays them. This is the only source of truth correction for state changed
	 * elsewhere (a physical media key, pausing from within the app itself, etc.) - {@link handlePress}
	 * updates the cache optimistically and immediately for this plugin's own button presses, without
	 * waiting for this poll.
	 *
	 * Dials are only redrawn when the answer actually changes, so the frequent poll costs next to nothing
	 * the rest of the time. A poll is skipped while the previous one is still waiting on an answer, and a
	 * result is discarded if it was requested within {@link MEDIA_PRESS_GRACE_MS} of a press - otherwise
	 * a poll racing the press (or an app slow to report its new state) would briefly flip the overlay back.
	 */
	private async pollMediaSessions(): Promise<void> {
		if (this.mediaPollInFlight) return;
		this.mediaPollInFlight = true;

		try {
			const requestedAt = Date.now();
			const json = await queryMediaSessions();
			if (requestedAt < this.lastMediaPressAt + MEDIA_PRESS_GRACE_MS) return;
			if (json === this.lastMediaSessionsJson) return;

			this.lastMediaSessionsJson = json;
			streamDeck.logger.info(`[play/pause] media state: ${json}`); // TEMP diagnostics - remove once confirmed.
			applyMediaSessions(json);
			await this.refreshPlayPauseDials();
		} finally {
			this.mediaPollInFlight = false;
		}
	}

	/**
	 * Re-sends feedback for every visible dial currently in "Play / Pause Media" mode, so they pick up
	 * the latest {@link mediaSessions} (their paused-icon overlay) right away.
	 */
	private refreshPlayPauseDials(): Promise<void> {
		return this.refreshAllDials((settings) => settings.pushButtonAction === "playPause");
	}

	/**
	 * Applies and refreshes the dial's on-device display whenever settings change from the property
	 * inspector - e.g. dragging the Volume slider, or picking a different Application - so those take
	 * effect immediately instead of waiting for the next rotate/press.
	 */
	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<VolumeSettings>): Promise<void> {
		if (!ev.action.isDial()) return;
		this.applyToApps(ev.payload.settings);
		this.lastSettings.set(ev.action.id, ev.payload.settings);
		this.refreshMediaPolling();
		await updateFeedback(ev.action, ev.payload.settings);
	}

	/**
	 * Triggered when the dial is rotated.
	 */
	override async onDialRotate(ev: DialRotateEvent<VolumeSettings>): Promise<void> {
		const { settings } = ev.payload;

		// If currently muted, un-mute when rotating and restore the volume it had before muting.
		if (settings.isMuted) unmute(settings);

		const stepSize = settings.stepSize ?? 5;
		const currentVolume = settings.volume ?? 50;
		settings.volume = Math.max(0, Math.min(100, currentVolume + ev.payload.ticks * stepSize));

		await this.commitSettings(ev.action, settings);
	}

	/**
	 * Handle the dial's push button - either toggles mute or sends the media play/pause key,
	 * depending on the configured {@link VolumeSettings.pushButtonAction}. Fires on press rather than
	 * release, so it reacts the moment the dial goes down - nothing here uses a long-press.
	 */
	override async onDialDown(ev: DialDownEvent<VolumeSettings>): Promise<void> {
		await this.handlePress(ev);
	}

	/**
	 * Handle a touch screen tap - shares the same configurable action as the push button.
	 */
	override async onTouchTap(ev: TouchTapEvent<VolumeSettings>): Promise<void> {
		await this.handlePress(ev);
	}

	/**
	 * Shared press logic for both the dial's push button and its touch screen: plays/pauses the dial's
	 * apps if the user has configured that (see {@link togglePlayback}), otherwise falls back to the
	 * default mute toggle.
	 *
	 * The cached media sessions are updated optimistically by that press, rather than waiting for the
	 * next poll tick (up to {@link MEDIA_POLL_INTERVAL_MS} away), so the paused-icon overlay reacts the
	 * instant this plugin itself causes the change.
	 */
	private async handlePress(ev: DialDownEvent<VolumeSettings> | TouchTapEvent<VolumeSettings>): Promise<void> {
		if (ev.payload.settings.pushButtonAction === "playPause") {
			this.togglePlayback(ev.action.id, ev.payload.settings);
			this.lastMediaPressAt = Date.now();
			this.lastMediaSessionsJson = undefined;
			await this.refreshPlayPauseDials();
			return;
		}

		await this.toggleMute(ev);
	}

	/**
	 * Plays or pauses every configured app on the dial together, each directly in its own app (see
	 * {@link resolveDialMediaTargets}): if any of them is playing, every one that's playing is paused;
	 * otherwise whatever {@link getTargetsToResume} picks is resumed.
	 *
	 * A dial with no apps configured, or none of whose running apps can be targeted directly, sends the
	 * global Media Play/Pause key instead - acting on whichever app owns the system's current media
	 * session, exactly like a physical keyboard's media key. A press when that session's status isn't
	 * known yet is assumed to be pausing something that was playing, since that's the far more common
	 * reason to press this button.
	 */
	private togglePlayback(actionId: string, settings: VolumeSettings): void {
		const targets = resolveDialMediaTargets(settings, findRunningApp(settings.applications));

		if (!targets) {
			sendMediaPlayPause();
			const current = mediaSessions.find((session) => session.id === currentMediaSessionId);
			if (current) current.status = current.status === "paused" ? "playing" : "paused";
			return;
		}
		if (targets.length === 0) return;

		// TEMP diagnostics for the play/pause display - remove once confirmed.
		const describe = (list: MediaTarget[]) => list.map((target) => `${getMediaTargetId(target)} (${target.app})=${getMediaTargetStatus(target)}`).join(", ");
		streamDeck.logger.info(`[play/pause] targets: ${describe(targets)} | remembered: ${(pausedByDial.get(actionId) ?? []).join(", ") || "none"}`);

		const playing = targets.filter((target) => getMediaTargetStatus(target) === "playing");
		if (playing.length > 0) {
			setMediaTargetsPlayback(playing, "paused");
			pausedByDial.set(actionId, playing.map(getMediaTargetId));
			streamDeck.logger.info(`[play/pause] paused: ${describe(playing)} | now shows: ${resolveDialDisplay(actionId, settings).displayApp}`);
			return;
		}

		const toResume = getTargetsToResume(actionId, targets);
		setMediaTargetsPlayback(toResume, "playing");
		pausedByDial.delete(actionId);
		streamDeck.logger.info(`[play/pause] resumed: ${describe(toResume)} | now shows: ${resolveDialDisplay(actionId, settings).displayApp}`);
	}

	/**
	 * Shared mute-toggle logic for both the dial's push button and its touch screen.
	 */
	private async toggleMute(ev: DialDownEvent<VolumeSettings> | TouchTapEvent<VolumeSettings>): Promise<void> {
		const { settings } = ev.payload;

		if (settings.isMuted) {
			unmute(settings);
		} else {
			settings.isMuted = true;
			settings.previousVolume = settings.volume ?? 50;
		}

		await this.commitSettings(ev.action, settings);
	}

	/**
	 * Applies settings changed by the dial itself (rotate/mute) to the configured apps, then redraws
	 * the dial and saves them. The audible change goes first, so the dial doesn't feel like it lags
	 * behind saving/redrawing.
	 */
	private async commitSettings(action: DialAction<VolumeSettings>, settings: VolumeSettings): Promise<void> {
		this.applyToApps(settings);
		this.lastSettings.set(action.id, settings);
		await Promise.all([updateFeedback(action, settings), action.setSettings(settings)]);
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
 * Clears a dial's muted state, restoring the volume it had before it was muted.
 */
function unmute(settings: VolumeSettings): void {
	settings.isMuted = false;
	settings.volume = settings.previousVolume ?? 50;
	settings.previousVolume = undefined;
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
 * A compact fingerprint of the feedback last sent to each dial (action id), so an unchanged display
 * isn't re-sent to Stream Deck on every refresh tick - see {@link sendFeedbackIfChanged}. Cleared
 * whenever the on-device display may no longer match it (dial reappearing, native title edited).
 */
const lastFeedbackKeyByAction = new Map<string, string>();

/**
 * Sends feedback to a dial unless it's identical (by `key`) to what was last sent to it. If sending
 * fails the key is forgotten, so the next refresh retries rather than assuming it landed.
 */
function sendFeedbackIfChanged(action: DialAction<VolumeSettings>, key: string, feedback: FeedbackPayload): Promise<void> {
	if (lastFeedbackKeyByAction.get(action.id) === key) return Promise.resolve();
	lastFeedbackKeyByAction.set(action.id, key);
	return action.setFeedback(feedback).catch((error) => {
		if (lastFeedbackKeyByAction.get(action.id) === key) lastFeedbackKeyByAction.delete(action.id);
		throw error;
	});
}

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
	const cacheKey = `${iconAbsPath}|${overlaySvg}`;
	const cached = overlaidIconCache.get(cacheKey);
	if (cached) return cached;

	const dataUri = readIconAsDataUri(iconAbsPath);
	if (!dataUri) return undefined;

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100" width="100" height="100">
<image xlink:href="${dataUri}" href="${dataUri}" x="0" y="0" width="100" height="100" preserveAspectRatio="xMidYMid meet" />
${overlaySvg}
</svg>`;

	const result = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
	overlaidIconCache.set(cacheKey, result);
	return result;
}

/**
 * In-memory caches of icon files read back from disk ({@link readIconAsDataUri}) and of their overlaid
 * variants ({@link buildIconWithOverlay}), keyed by file path (plus overlay markup), so a muted/paused
 * dial or the app picker doesn't re-read and re-encode the same PNG on every refresh. Entries for a path
 * are dropped whenever {@link saveIconFile} rewrites that file.
 */
const iconDataUriCache = new Map<string, string>();
const overlaidIconCache = new Map<string, string>();

function invalidateIconCaches(filePath: string): void {
	iconDataUriCache.delete(filePath);
	for (const key of Array.from(overlaidIconCache.keys())) {
		if (key.startsWith(`${filePath}|`)) overlaidIconCache.delete(key);
	}
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
 * its apps are paused (see {@link getDialPlaybackStatus}).
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
 * Takes an already-fetched session list when the caller has one (e.g. a refresh covering several
 * dials), and only enumerates sessions itself otherwise.
 */
function findRunningApp(applications: string[] | undefined, sessions?: AudioSession[]): string | undefined {
	if (!applications || applications.length === 0) return undefined;

	sessions ??= tryGetNamedAudioSessions();
	if (!sessions) return undefined;

	const running = new Set(sessions.map((session) => session.name.toLowerCase()));
	return applications.find((app) => running.has(app.toLowerCase()));
}

/**
 * Works out which app a dial shows (its icon and name): its highest-priority running app (see
 * {@link findRunningApp}) - or, for a "Play / Pause Media" dial, the app a press would act on: its
 * highest-priority app that's actually playing, if any is, otherwise the highest-priority one a press
 * would resume (see {@link getTargetsToResume}) - so after a press pauses something, the dial keeps
 * showing that app, paused. Also returns what that was worked out from, for {@link updateFeedback} to
 * reuse.
 */
function resolveDialDisplay(actionId: string, settings: VolumeSettings, sessions?: AudioSession[]) {
	const runningApp = findRunningApp(settings.applications, sessions);
	const mediaTargets = settings.pushButtonAction === "playPause" ? resolveDialMediaTargets(settings, runningApp) : undefined;
	const playingApp = mediaTargets?.find((target) => getMediaTargetStatus(target) === "playing")?.app;
	const resumeApp = mediaTargets ? getTargetsToResume(actionId, mediaTargets)[0]?.app : undefined;
	return { runningApp, mediaTargets, displayApp: playingApp ?? resumeApp ?? runningApp };
}

/**
 * Refreshes the dial's on-device title/value/indicator/icon to match its current settings.
 *
 * The icon is resolved from the highest-priority configured app that's actually running right now
 * (falling through the list in order) - or playing, for a "Play / Pause Media" dial (see
 * {@link resolveDialDisplay}); if none are running, a generic mixer icon is shown instead and the
 * progress bar is greyed out, since there's nothing currently controllable. Icon extraction happens
 * off to the side rather than being awaited here, so a not-yet-cached icon never delays the rest of
 * the feedback update - once it resolves, feedback is sent again with the icon included.
 *
 * Title logic: the user's own text from Stream Deck's native title editor always wins when present -
 * this plugin doesn't touch the title at all in that case. Only when that native field is empty does
 * the plugin fill it in: the shown app's name, or "Multi Volume Dial" if nothing configured is
 * currently running. Muting still overrides all of that to "Muted", restoring the previous text once
 * unmuted (see {@link nativeTitleByAction}) rather than leaving "Muted" on screen forever.
 *
 * Note: Stream Deck only lets a plugin actually change the on-device title while the user hasn't typed
 * their own text into its native title editor - once they have, further plugin `setFeedback` calls for
 * "title" are silently ignored until the user edits it again (or clears it). So the app-name/fallback
 * text above only visibly takes effect while that native field is empty; this is a platform rule, not
 * something this plugin can override without abandoning the built-in "$B1" layout entirely.
 *
 * Nothing is sent if the result is identical to what this dial is already showing (see
 * {@link sendFeedbackIfChanged}), which is the common case on a periodic refresh.
 */
function updateFeedback(action: DialAction<VolumeSettings>, settings: VolumeSettings, sessions?: AudioSession[]): Promise<void> {
	const volume = settings.volume ?? 50;
	const barValue = settings.isMuted ? 0 : volume;
	const { runningApp, mediaTargets, displayApp } = resolveDialDisplay(action.id, settings, sessions);
	const appKey = displayApp?.toLowerCase();
	const iconPath = appKey ? iconCache.get(appKey)?.path : undefined;

	const appName = displayApp ? prettifyAppName(displayApp) : undefined;
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

	// Only a dial actually in "Play / Pause Media" mode shows the paused badge - a Mute/Unmute dial has
	// nothing to do with media playback.
	const isPaused = settings.pushButtonAction === "playPause" && getDialPlaybackStatus(mediaTargets) === "paused";
	const isMuted = settings.isMuted ?? false;

	// Everything the on-device display depends on, built from the icon's source path and overlay flags
	// rather than the (possibly large, base64) icon value itself.
	const feedbackKey = (iconSource: string) => JSON.stringify([title, volume, barValue, dimColor, iconSource, isMuted, isPaused]);

	const feedback: FeedbackPayload = {
		title,
		value: { value: `${volume}%`, color: dimColor },
		indicator: { value: barValue, bar_fill_c: dimColor }
	};

	if (displayApp && appKey && !iconPath && !iconResolutionInFlight.has(appKey)) {
		iconResolutionInFlight.add(appKey);
		resolveAppIcon(displayApp)
			.then((dataUri) => {
				if (!dataUri) return;
				const savedPath = saveIconFile(appKey, dataUri);
				if (!savedPath) return;
				iconCache.set(appKey, { exeName: displayApp, path: savedPath });
				persistIconCache();

				// The app that triggered this may have stopped running (or been replaced by a
				// higher-priority one) while extraction was in flight - re-check live rather than
				// blindly applying a stale snapshot, which would clobber a more recent, correct update.
				if (resolveDialDisplay(action.id, settings).displayApp !== displayApp) return;
				return sendFeedbackIfChanged(action, feedbackKey(savedPath), {
					...feedback,
					icon: resolveIconFeedbackValue(savedPath, isMuted, isPaused)
				});
			})
			.catch((error) => streamDeck.logger.error(`Failed to load icon for ${displayApp}`, error))
			.finally(() => iconResolutionInFlight.delete(appKey));
	}

	const iconSource = iconPath ?? DEFAULT_MIXER_ICON_ABS_PATH;
	return sendFeedbackIfChanged(action, feedbackKey(iconSource), { ...feedback, icon: resolveIconFeedbackValue(iconSource, isMuted, isPaused) });
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
		invalidateIconCaches(filePath);
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
	const cached = iconDataUriCache.get(filePath);
	if (cached) return cached;

	try {
		const dataUri = `data:image/png;base64,${fs.readFileSync(filePath).toString("base64")}`;
		iconDataUriCache.set(filePath, dataUri);
		return dataUri;
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
 * C# helper compiled into {@link mediaShell} (via `Add-Type`) for the parts of media control that need
 * raw Win32/COM calls PowerShell can't make directly:
 * - `PressPlayPause` simulates the hardware Media Play/Pause key. Windows routes that key globally to
 *   whatever app currently owns the system's media session, rather than to this action's own configured
 *   application list - so it's only the fallback for a dial with nothing of its own to target directly
 *   (see {@link VolumeControl.togglePlayback}).
 * - `GetAudioApps` lists every app with an audio session on any output device, and whether it's actually
 *   playing sound right now (its session "Active", rather than just open) - which is how a media player
 *   with no media session of its own is known to be playing or paused.
 * - `SendAppCommand` sends such a player a pause/play command (`WM_APPCOMMAND`, the message a media
 *   keyboard sends the focused window) straight to its own windows, focused or not - see
 *   {@link WINDOW_COMMAND_PLAYERS} for why only known players get one.
 */
const MEDIA_HELPER_TYPE = `
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class MediaHelper {
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extraInfo);

    public static void PressPlayPause() {
        keybd_event(0xB3 /* VK_MEDIA_PLAY_PAUSE */, 0, 0, UIntPtr.Zero);
        keybd_event(0xB3, 0, 2 /* KEYEVENTF_KEYUP */, UIntPtr.Zero);
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumerator {}

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator {
        void EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection {
        void GetCount(out int count);
        void Item(int index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice {
        void Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionManager2 {
        void GetAudioSessionControl(IntPtr sessionGuid, int flags, out IntPtr control);
        void GetSimpleAudioVolume(IntPtr sessionGuid, int flags, out IntPtr volume);
        void GetSessionEnumerator(out IAudioSessionEnumerator sessions);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionEnumerator {
        void GetCount(out int count);
        void GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object session);
    }

    // Only the methods up to GetProcessId are declared - COM interfaces are matched by vtable position.
    [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl2 {
        void GetState(out int state);
        void GetDisplayName(out IntPtr name);
        void SetDisplayName(IntPtr name, IntPtr eventContext);
        void GetIconPath(out IntPtr path);
        void SetIconPath(IntPtr path, IntPtr eventContext);
        void GetGroupingParam(out Guid groupingId);
        void SetGroupingParam(IntPtr groupingId, IntPtr eventContext);
        void RegisterAudioSessionNotification(IntPtr client);
        void UnregisterAudioSessionNotification(IntPtr client);
        void GetSessionIdentifier(out IntPtr id);
        void GetSessionInstanceIdentifier(out IntPtr id);
        [PreserveSig] int GetProcessId(out int pid);
    }

    delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr hwnd, out int pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, int flags, int timeout, out IntPtr result);

    // Lowercased exe name (without ".exe") of every running process, by pid.
    static Dictionary<int, string> GetProcessNames() {
        var names = new Dictionary<int, string>();
        foreach (var process in Process.GetProcesses()) {
            names[process.Id] = process.ProcessName.ToLowerInvariant();
            process.Dispose();
        }
        return names;
    }

    public static Dictionary<string, bool> GetAudioApps() {
        var apps = new Dictionary<string, bool>();
        var processNames = GetProcessNames();
        IMMDeviceCollection devices;
        ((IMMDeviceEnumerator)new MMDeviceEnumerator()).EnumAudioEndpoints(0 /* eRender */, 1 /* DEVICE_STATE_ACTIVE */, out devices);
        int deviceCount;
        devices.GetCount(out deviceCount);
        Guid managerId = typeof(IAudioSessionManager2).GUID;
        for (int i = 0; i < deviceCount; i++) {
            try {
                IMMDevice device;
                devices.Item(i, out device);
                object manager;
                device.Activate(ref managerId, 23 /* CLSCTX_ALL */, IntPtr.Zero, out manager);
                IAudioSessionEnumerator sessions;
                ((IAudioSessionManager2)manager).GetSessionEnumerator(out sessions);
                int sessionCount;
                sessions.GetCount(out sessionCount);
                for (int j = 0; j < sessionCount; j++) {
                    object session;
                    sessions.GetSession(j, out session);
                    var control = (IAudioSessionControl2)session;
                    int pid, state;
                    string name;
                    control.GetProcessId(out pid);
                    control.GetState(out state);
                    if (pid == 0 || !processNames.TryGetValue(pid, out name)) continue;
                    bool active;
                    apps.TryGetValue(name, out active);
                    apps[name] = active || state == 1 /* AudioSessionStateActive */;
                }
            } catch {}
        }
        return apps;
    }

    // Only each process's own visible, titled, unowned windows - its main window(s), not the hidden helper
    // windows (IME, tray, clipboard, etc) most apps also own, which would just pass the command on.
    public static void SendAppCommand(string[] names, int command) {
        var targets = new HashSet<string>(names);
        var pids = new HashSet<int>();
        foreach (var entry in GetProcessNames()) if (targets.Contains(entry.Value)) pids.Add(entry.Key);

        var windows = new List<IntPtr>();
        EnumWindows((hwnd, _) => {
            int pid;
            GetWindowThreadProcessId(hwnd, out pid);
            if (pids.Contains(pid) && IsWindowVisible(hwnd) && GetWindowTextLength(hwnd) > 0 && GetWindow(hwnd, 4 /* GW_OWNER */) == IntPtr.Zero) windows.Add(hwnd);
            return true;
        }, IntPtr.Zero);

        foreach (var hwnd in windows) {
            IntPtr result;
            SendMessageTimeout(hwnd, 0x0319 /* WM_APPCOMMAND */, hwnd, new IntPtr(command << 16), 2 /* SMTO_ABORTIFHUNG */, 500, out result);
        }
    }
}
`;

/**
 * `WM_APPCOMMAND` command ids for {@link MEDIA_HELPER_TYPE}'s `SendAppCommand` - explicit pause and play
 * rather than a play/pause toggle, so a player with more than one window can't end up toggled twice.
 */
const APPCOMMAND_MEDIA_PLAY = 46;
const APPCOMMAND_MEDIA_PAUSE = 47;

/**
 * Media players (lowercased exe name, without ".exe") known to act on a pause/play command sent straight
 * to their own window, for when they don't register with Windows' media controls at all (e.g. VLC 3) -
 * see {@link resolveDialMediaTargets}. Deliberately limited to players known to handle it: a window that
 * doesn't passes the command on to Windows, which then acts on whichever app currently owns the system's
 * media session, exactly like the global media key - possibly one that isn't on the dial at all.
 */
const WINDOW_COMMAND_PLAYERS = new Set(["vlc", "mpc-hc", "mpc-hc64", "mpc-be", "mpc-be64", "mpv"]);

/**
 * PowerShell for listing and controlling every app's System Media Transport Controls session. This is
 * the same WinRT API (`Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager`) that
 * backs the Windows lock-screen media controls - there's no simpler/native Node API for it. WinRT's
 * async methods return `IAsyncOperation`, which .NET/PowerShell can't `await` directly; `$asTask` is the
 * standard reflection-based trick (used throughout the PowerShell community) for bridging that to a
 * blocking `Task.Wait()` inside a synchronous script.
 *
 * Run once when {@link getMediaShell} starts, defining the functions each poll or press then calls:
 * - `Get-MediaSessions` answers with every session, plus {@link MEDIA_HELPER_TYPE}'s `GetAudioApps`, as
 *   one line of JSON (see {@link applyMediaSessions}). Windows only identifies a session by its app's
 *   AppUserModelID, which isn't always recognizable as the app's exe name (Firefox's is a hash of its
 *   install folder, a Store app's is its package name), so `Get-AumidNames` also looks up the app's Start
 *   menu name and, for a Store app, its packaged exe - once per id, since the Start menu lookup takes
 *   ~0.5s - for {@link mediaSessionBelongsTo} to match on.
 * - `Set-MediaPlayback` plays or pauses the sessions with the given ids, and `Send-PlayerCommand` the
 *   players with the given names (see {@link setMediaTargetsPlayback}) - both base64-encoded, so a value
 *   can't break out of the command it's embedded in.
 *
 * The session manager is cached after its first request, and that request's wait is capped at 3s so a
 * stuck WinRT call can't block the shell - and any presses queued behind it - indefinitely. Joined onto
 * one line since it's fed to a `-Command -` shell's stdin line by line, where a multi-line statement
 * wouldn't be parsed as one.
 */
const MEDIA_SESSION_HELPER = [
	"Add-Type -AssemblyName System.Runtime.WindowsRuntime",
	"$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]",
	"$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0].MakeGenericMethod($mgrType)",
	"$script:aumidNames = @{}",
	"function ConvertFrom-EncodedValues($encoded) { [string[]]@($encoded | ForEach-Object { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_)) }) }",
	"function Get-MediaManager { if (-not $script:mgr) { $t = $asTask.Invoke($null, @($mgrType::RequestAsync())); if (-not $t.Wait(3000)) { return $null }; $script:mgr = $t.Result }; $script:mgr }",
	"function Get-AumidNames($id) { if (-not $script:aumidNames.ContainsKey($id)) { $names = @(); try { if (-not $script:startApps) { $script:startApps = @(Get-StartApps) }; $names += @($script:startApps | Where-Object { $_.AppID -eq $id } | ForEach-Object { $_.Name }) } catch {}; if ($id.Contains('!')) { try { $pfn, $appId = $id -split '!', 2; $pkg = Get-AppxPackage -Name $pfn.Substring(0, $pfn.LastIndexOf('_')) | Where-Object { $_.PackageFamilyName -eq $pfn } | Select-Object -First 1; if ($pkg) { $names += @((Get-AppxPackageManifest $pkg).Package.Applications.Application | Where-Object { $_.Id -eq $appId } | ForEach-Object { Split-Path $_.Executable -Leaf }) } } catch {} }; $script:aumidNames[$id] = $names }; $script:aumidNames[$id] }",
	"function Get-MediaSessions { try { $current = $null; $list = @(); try { $m = Get-MediaManager; if ($m) { $cur = $m.GetCurrentSession(); if ($cur) { $current = $cur.SourceAppUserModelId }; $list = @(foreach ($s in $m.GetSessions()) { $id = $s.SourceAppUserModelId; [pscustomobject]@{ id = $id; names = @(Get-AumidNames $id); status = $s.GetPlaybackInfo().PlaybackStatus.ToString() } }) } } catch {}; $apps = @{}; try { $apps = [MediaHelper]::GetAudioApps() } catch {}; ConvertTo-Json -Compress -Depth 4 -InputObject ([pscustomobject]@{ current = $current; sessions = $list; apps = $apps }) } catch { '' } }",
	"function Set-MediaPlayback($action, $encodedIds) { try { $ids = ConvertFrom-EncodedValues $encodedIds; $m = Get-MediaManager; if (-not $m) { return }; foreach ($s in $m.GetSessions()) { if ($ids -contains $s.SourceAppUserModelId) { if ($action -eq 'pause') { $null = $s.TryPauseAsync() } else { $null = $s.TryPlayAsync() } } } } catch {} }",
	`function Send-PlayerCommand($action, $encodedNames) { try { [MediaHelper]::SendAppCommand((ConvertFrom-EncodedValues $encodedNames), $(if ($action -eq 'pause') { ${APPCOMMAND_MEDIA_PAUSE} } else { ${APPCOMMAND_MEDIA_PLAY} })) } catch {} }`
].join("; ");

/**
 * Long-lived PowerShell process that handles every media job: sending play/pause presses and answering
 * media-session polls. Spawning a fresh `powershell.exe` (and compiling {@link MEDIA_HELPER_TYPE} via
 * `Add-Type`) costs 1-2s, which made every press feel laggy and every poll needlessly expensive - so
 * that's paid once up front here, and each press or poll is just one line written to this shell's stdin.
 * Started while any dial is in "Play / Pause Media" mode (see {@link VolumeControl.refreshMediaPolling}),
 * and exits on its own if the plugin dies, since its stdin closes.
 */
let mediaShell: ChildProcessWithoutNullStreams | undefined;

/**
 * Media-session polls waiting on an answer from {@link mediaShell}, keyed by request id. Each request
 * echoes its id back (`MEDIA:<id>:<json>`), so an answer that arrives after its request already timed
 * out can't be mistaken for a later request's.
 */
const pendingMediaRequests = new Map<number, (json: string) => void>();
let nextMediaRequestId = 0;

function getMediaShell(): ChildProcessWithoutNullStreams {
	if (mediaShell && mediaShell.exitCode === null) return mediaShell;

	const shell = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command", "-"], { windowsHide: true });
	createInterface({ input: shell.stdout }).on("line", (line) => {
		const match = /^MEDIA:(\d+):(.*)$/.exec(line.trim());
		if (match) pendingMediaRequests.get(Number(match[1]))?.(match[2]);
	});
	shell.stderr.on("data", (data) => streamDeck.logger.error(`Media shell: ${String(data).trim()}`));
	shell.stdin.on("error", (error) => streamDeck.logger.error("Media shell stdin error", error));
	shell.on("error", (error) => streamDeck.logger.error("Media shell failed", error));
	shell.on("exit", () => {
		if (mediaShell === shell) mediaShell = undefined;
		for (const finish of Array.from(pendingMediaRequests.values())) finish("");
	});
	// The C# source goes over base64-encoded, so its many lines arrive as one stdin line (see MEDIA_SESSION_HELPER).
	const helperType = Buffer.from(MEDIA_HELPER_TYPE, "utf-8").toString("base64");
	shell.stdin.write(`Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${helperType}')))\n`);
	shell.stdin.write(`${MEDIA_SESSION_HELPER}\n`);

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
		getMediaShell().stdin.write("[MediaHelper]::PressPlayPause()\n");
	} catch (error) {
		streamDeck.logger.error("Failed to send media play/pause key", error);
	}
}

/**
 * Plays or pauses the given targets directly, each in its own app - unlike {@link sendMediaPlayPause},
 * regardless of which app currently owns the system's media session. Their cached status is updated to
 * match straight away, ahead of the next poll confirming it.
 */
function setMediaTargetsPlayback(targets: MediaTarget[], status: "playing" | "paused"): void {
	const sessions = targets.flatMap((target) => (target.kind === "session" ? [target.session] : []));
	const players = targets.flatMap((target) => (target.kind === "player" ? [target.player] : []));
	const action = status === "paused" ? "pause" : "play";
	const encode = (values: string[]) => values.map((value) => `'${Buffer.from(value, "utf-8").toString("base64")}'`).join(",");

	try {
		if (sessions.length > 0) getMediaShell().stdin.write(`Set-MediaPlayback '${action}' @(${encode(sessions.map((session) => session.id))})\n`);
		if (players.length > 0) getMediaShell().stdin.write(`Send-PlayerCommand '${action}' @(${encode(players)})\n`);
	} catch (error) {
		streamDeck.logger.error("Failed to send media play/pause", error);
	}

	for (const session of sessions) session.status = status;
	for (const player of players) audioAppActivity.set(player, status === "playing");
}

/**
 * How often the shared media-session poll (see {@link VolumeControl.refreshMediaPolling}) re-checks
 * Windows' System Media Transport Controls for every app's playback state. Each check is just a quick
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
 * How long a media-session poll waits for {@link mediaShell} to answer. Generous, since the very first
 * poll after the shell starts also waits behind its PowerShell startup and helper setup.
 */
const MEDIA_SESSIONS_TIMEOUT_MS = 10000;

/**
 * `undefined` means unknown - no clean "Playing"/"Paused" answer ("Stopped"/"Closed"/etc) - which is
 * deliberately distinct from "playing", so a dial doesn't show a paused overlay just because nothing is
 * playing at all.
 */
type MediaPlaybackStatus = "playing" | "paused" | undefined;

/** One app's System Media Transport Controls session, as last reported by {@link pollMediaSessions}. */
type MediaSession = {
	/** The app's AppUserModelID (e.g. "Chrome", "Spotify.exe") - also how a press targets this session. */
	id: string;
	/** Other names Windows knows the app by, for {@link mediaSessionBelongsTo} (see `Get-AumidNames`). */
	names: string[];
	status: MediaPlaybackStatus;
};

/**
 * Last-known media sessions of every app on the system, shared across every dial in "Play / Pause
 * Media" mode (see {@link VolumeControl.refreshMediaPolling}), along with the id of the one that
 * currently owns the system's media session - the one the global media key acts on.
 */
let mediaSessions: MediaSession[] = [];
let currentMediaSessionId: string | undefined;

/**
 * Every app with an audio session on any output device (lowercased exe name, without ".exe"), and
 * whether it's actually playing sound right now - see {@link MEDIA_HELPER_TYPE}'s `GetAudioApps`.
 */
let audioAppActivity = new Map<string, boolean>();

/**
 * One thing a "Play / Pause Media" dial plays/pauses (see {@link resolveDialMediaTargets}): an app's
 * media session, or a media player with none of its own (see {@link WINDOW_COMMAND_PLAYERS}). `app` is
 * the dial's own configured app (exe name) it belongs to.
 */
type MediaTarget = { app: string } & ({ kind: "session"; session: MediaSession } | { kind: "player"; player: string });

/** A stable id for a target, for {@link VolumeControl.togglePlayback} to remember what it paused. */
function getMediaTargetId(target: MediaTarget): string {
	return target.kind === "session" ? target.session.id : `player:${target.player}`;
}

/**
 * A session's own reported status, or for a player, whether its audio is actually playing - a paused
 * player's audio session stays open, but stops being "Active".
 */
function getMediaTargetStatus(target: MediaTarget): MediaPlaybackStatus {
	if (target.kind === "session") return target.session.status;
	return audioAppActivity.get(target.player) ? "playing" : "paused";
}

/**
 * Asks Windows for every app's media session, as `Get-MediaSessions`' raw JSON - an empty string if the
 * query fails or times out, which {@link applyMediaSessions} treats as there being no sessions at all.
 */
function queryMediaSessions(): Promise<string> {
	return new Promise((resolve) => {
		const id = nextMediaRequestId++;
		const timer = setTimeout(() => finish(""), MEDIA_SESSIONS_TIMEOUT_MS);
		function finish(json: string): void {
			clearTimeout(timer);
			pendingMediaRequests.delete(id);
			resolve(json);
		}
		pendingMediaRequests.set(id, finish);

		try {
			getMediaShell().stdin.write(`[Console]::Out.WriteLine('MEDIA:${id}:' + (Get-MediaSessions))\n`);
		} catch (error) {
			streamDeck.logger.error("Failed to read media sessions", error);
			finish("");
		}
	});
}

/**
 * Replaces the cached {@link mediaSessions} and {@link audioAppActivity} with a
 * {@link queryMediaSessions} answer.
 */
function applyMediaSessions(json: string): void {
	type RawMediaSessions = {
		current?: string | null;
		sessions?: { id?: string; names?: string[]; status?: string }[];
		apps?: Record<string, boolean>;
	};
	let raw: RawMediaSessions = {};
	try {
		raw = json ? (JSON.parse(json) as RawMediaSessions) : {};
	} catch (error) {
		streamDeck.logger.error("Failed to parse media sessions", error);
	}

	currentMediaSessionId = raw.current ?? undefined;
	mediaSessions = (Array.isArray(raw.sessions) ? raw.sessions : [])
		.filter((session) => typeof session.id === "string" && session.id)
		.map(
			(session): MediaSession => ({
				id: String(session.id),
				names: (Array.isArray(session.names) ? session.names : []).filter((name) => typeof name === "string"),
				status: session.status === "Playing" ? "playing" : session.status === "Paused" ? "paused" : undefined
			})
		);
	audioAppActivity = new Map(Object.entries(raw.apps && typeof raw.apps === "object" ? raw.apps : {}).map(([app, active]) => [app, active === true]));
}

/**
 * Whether a media session belongs to the given app (an exe name, e.g. "chrome.exe"). Most desktop apps'
 * session ids are some form of their exe's own name ("Spotify.exe", "Chrome", "MSEdge", "Chrome._crx_..."
 * for an installed web app, "{...}\VideoLAN\VLC\vlc.exe"), and for the rest the Start menu name or
 * packaged exe looked up alongside it usually is ("Firefox", "Microsoft.Media.Player.exe") - so this
 * matches if any of those, minus any folder and ".exe", is the app's own name, or contains it as a
 * whole word.
 */
function mediaSessionBelongsTo(session: MediaSession, app: string): boolean {
	const appName = app.toLowerCase().replace(/\.exe$/, "");
	if (!appName) return false;

	return [session.id, ...session.names].some((name) => {
		const lower = name.toLowerCase();
		const leaf = lower.slice(Math.max(lower.lastIndexOf("\\"), lower.lastIndexOf("/")) + 1).replace(/\.exe$/, "");
		return leaf === appName || lower.split(/[^a-z0-9]+/).includes(appName);
	});
}

/**
 * Everything a "Play / Pause Media" dial controls: every media session belonging to one of its
 * configured apps, plus any of them that's a known media player (see {@link WINDOW_COMMAND_PLAYERS})
 * with an audio session but no media session of its own. Any other app on the dial (a game, a voice chat
 * app) has nothing that can be paused, so it's left alone. Listed in the dial's own priority order (its
 * application list), so the first target belongs to its highest-priority app.
 *
 * An empty list means there's nothing to control right now (none of its apps are running), and
 * `undefined` means the dial falls back to the global media key instead (see
 * {@link VolumeControl.togglePlayback}) - when it has no apps configured at all, or one of them is
 * running but none of them can be targeted directly.
 */
function resolveDialMediaTargets(settings: VolumeSettings, runningApp: string | undefined): MediaTarget[] | undefined {
	const apps = (settings.applications ?? []).filter(Boolean);
	if (apps.length === 0) return undefined;

	const targets: MediaTarget[] = [];
	for (const app of apps) {
		const sessions = mediaSessions.filter((session) => mediaSessionBelongsTo(session, app));
		for (const session of sessions) {
			if (!targets.some((target) => target.kind === "session" && target.session === session)) targets.push({ app, kind: "session", session });
		}

		const player = app.toLowerCase().replace(/\.exe$/, "");
		const isTargetablePlayer = sessions.length === 0 && WINDOW_COMMAND_PLAYERS.has(player) && audioAppActivity.has(player);
		if (isTargetablePlayer && !targets.some((target) => target.kind === "player" && target.player === player)) {
			targets.push({ app, kind: "player", player });
		}
	}

	if (targets.length > 0) return targets;
	return runningApp ? undefined : [];
}

/**
 * What each "Play / Pause Media" dial (action id) last paused itself (see {@link getMediaTargetId}), so
 * its next press resumes just those - not every other app on the dial that happened to already be
 * sitting paused (e.g. a YouTube tab paused hours ago) - see {@link VolumeControl.togglePlayback}.
 */
const pausedByDial = new Map<string, string[]>();

/**
 * What a press of a "Play / Pause Media" dial with nothing playing resumes, in priority order: what it
 * last paused itself, if any of that's still around - or, if it has none (those apps closed, or were
 * paused some other way), just its highest-priority target, rather than everything on the dial at once.
 */
function getTargetsToResume(actionId: string, targets: MediaTarget[]): MediaTarget[] {
	const pausedHere = pausedByDial.get(actionId) ?? [];
	const resumable = targets.filter((target) => pausedHere.includes(getMediaTargetId(target)));
	return resumable.length > 0 ? resumable : targets.slice(0, 1);
}

/**
 * What a "Play / Pause Media" dial's paused-icon overlay reflects, given its
 * {@link resolveDialMediaTargets}: "playing" if any of its targets is, otherwise "paused" if any of them
 * is - or, for a dial on the global media key fallback, whatever the system's current media session is
 * doing.
 */
function getDialPlaybackStatus(targets: MediaTarget[] | undefined): MediaPlaybackStatus {
	if (!targets) return mediaSessions.find((session) => session.id === currentMediaSessionId)?.status;

	const statuses = targets.map(getMediaTargetStatus);
	if (statuses.includes("playing")) return "playing";
	return statuses.includes("paused") ? "paused" : undefined;
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
