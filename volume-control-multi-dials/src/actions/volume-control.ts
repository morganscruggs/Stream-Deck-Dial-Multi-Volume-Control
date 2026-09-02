import streamDeck, {
	action,
	DialAction,
	DialRotateEvent,
	DialUpEvent,
	DidReceiveSettingsEvent,
	SendToPluginEvent,
	SingletonAction,
	WillAppearEvent,
	TouchTapEvent
} from "@elgato/streamdeck";
import { NodeAudioVolumeMixer } from "node-audio-volume-mixer";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const AUDIO_APPS_DATASOURCE = "getAudioApps";

/**
 * Action that controls the volume of one or more applications at once using a single dial.
 */
@action({ UUID: "com.morgan-scruggs.volume-control-multi-dials.volume" })
export class VolumeControl extends SingletonAction<VolumeSettings> {
	/**
	 * Initialize the dial display when it appears.
	 */
	override onWillAppear(ev: WillAppearEvent<VolumeSettings>): void | Promise<void> {
		// This action is Encoder-only (see manifest.json), so ev.action is always a dial - but
		// WillAppearEvent is shared with key actions, so setFeedback needs this type guard.
		if (!ev.action.isDial()) return;
		return updateFeedback(ev.action, ev.payload.settings);
	}

	/**
	 * Applies and refreshes the dial's on-device display whenever settings change from the property
	 * inspector - e.g. dragging the Volume slider, or picking a different Application - so those take
	 * effect immediately instead of waiting for the next rotate/press.
	 */
	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<VolumeSettings>): Promise<void> {
		if (!ev.action.isDial()) return;
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
	 */
	private async sendAudioApps(): Promise<void> {
		let items: { value: string; label: string; icon?: string }[] = [];

		try {
			const sessions = NodeAudioVolumeMixer.getAudioSessionProcesses();
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
					let icon = iconCache.get(key);
					if (!icon) {
						icon = await extractIconForPid(session.pid).catch(() => undefined);
						if (icon) iconCache.set(key, icon);
					}
					return { value: session.name, label: prettifyAppName(session.name), icon };
				})
			);
			items.sort((a, b) => a.label.localeCompare(b.label));
		} catch (error) {
			streamDeck.logger.error("Failed to list audio sessions", error);
		}

		streamDeck.ui.sendToPropertyInspector({ event: AUDIO_APPS_DATASOURCE, items });
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
			sessions = NodeAudioVolumeMixer.getAudioSessionProcesses();
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
 * Caches each app's extracted icon (as a base64 data URI) by lowercased exe name, so it's only
 * extracted once per app per plugin session rather than on every rotate/press.
 */
const iconCache = new Map<string, string>();
const iconResolutionInFlight = new Set<string>();

/**
 * Refreshes the dial's on-device title/value/indicator/icon to match its current settings.
 *
 * The icon is resolved from the first configured app's own executable (same as how apps show their
 * own icon in the Windows volume mixer) - with several apps controlled by one dial, that first app
 * stands in for the group. Extraction happens off to the side rather than being awaited here, so a
 * not-yet-cached icon never delays the rest of the feedback update - once it resolves, feedback is
 * sent again with the icon included.
 */
function updateFeedback(action: DialAction<VolumeSettings>, settings: VolumeSettings): Promise<void> {
	const volume = settings.volume ?? 50;
	const primaryApp = settings.applications?.[0];
	const appKey = primaryApp?.toLowerCase();
	const icon = appKey ? iconCache.get(appKey) : undefined;

	const feedback: Record<string, string | number> = {
		title: settings.isMuted ? "Muted" : "Multi Volume",
		value: settings.isMuted ? "Muted" : `${volume}%`,
		indicator: settings.isMuted ? 0 : volume
	};
	if (icon) feedback.icon = icon;

	if (appKey && primaryApp && !icon && !iconResolutionInFlight.has(appKey)) {
		iconResolutionInFlight.add(appKey);
		resolveAppIcon(primaryApp)
			.then((dataUri) => {
				if (!dataUri) return;
				iconCache.set(appKey, dataUri);
				return action.setFeedback({ ...feedback, icon: dataUri });
			})
			.catch((error) => streamDeck.logger.error(`Failed to load icon for ${primaryApp}`, error))
			.finally(() => iconResolutionInFlight.delete(appKey));
	}

	return action.setFeedback(feedback);
}

/**
 * Finds the running process behind an app name and extracts its own icon.
 */
async function resolveAppIcon(appName: string): Promise<string | undefined> {
	let sessions;
	try {
		sessions = NodeAudioVolumeMixer.getAudioSessionProcesses();
	} catch {
		return undefined;
	}

	const match = sessions.find((session) => session.name.toLowerCase() === appName.toLowerCase());
	if (!match) return undefined;

	return extractIconForPid(match.pid);
}

/**
 * Extracts the icon associated with a running process's executable, as a base64 PNG data URI.
 * Shells out to PowerShell/System.Drawing since there's no native Node API for this on Windows.
 */
async function extractIconForPid(pid: number): Promise<string | undefined> {
	const script = [
		"Add-Type -AssemblyName System.Drawing",
		`$p = Get-Process -Id ${pid} -ErrorAction Stop`,
		"$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($p.Path)",
		"$bmp = $icon.ToBitmap()",
		"$ms = New-Object System.IO.MemoryStream",
		"$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)",
		"[Convert]::ToBase64String($ms.ToArray())"
	].join("; ");

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
